//! Transcript-first local agent loop.
//!
//! The runtime owns transport, capability safety, durable planning and bounded
//! recovery. It does not certify evidence, decide exploration coverage, or make
//! semantic completion decisions for the model.

use crate::agent::{
    events::Event,
    policy::{self, Reasoning, RunPolicy},
    state::AgentState,
    todo::GoalPlan,
    transcript::{validate_calls, Transcript, ValidatedCall},
};
use crate::context::projection::project;
use crate::protocol::emit;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

pub struct Config {
    pub run_id: String,
    pub endpoint: String,
    pub model: String,
    pub system: String,
    pub user: String,
    pub root: Option<String>,
    pub context_limit: usize,
    pub reasoning_mode: String,
    pub policy: RunPolicy,
    pub history: Vec<Value>,
    pub plan: Option<Value>,
    pub provider_max_output: Option<usize>,
    pub cancelled: Arc<AtomicBool>,
    pub steering: Arc<Mutex<Vec<String>>>,
}

/// Initial values follow Jan's shape but are deliberately configurable at the
/// helper boundary rather than pretending every local model has one window.
pub const DEFAULT_COMPACTION_RATIO: f64 = 0.80;
pub const DEFAULT_KEEP_RECENT: usize = 8;
pub const SAFETY_RESERVE_TOKENS: usize = 1_024;
pub const PREFERRED_OUTPUT_HEADROOM_TOKENS: usize = 1_024;
pub const MIN_USEFUL_OUTPUT_TOKENS: usize = 32;
pub const APPLICATION_MAX_OUTPUT_TOKENS: usize = 32_768;
pub const MAX_COMPACTION_ATTEMPTS: usize = 4;
pub const MAX_CONTINUATION_TURNS: usize = 32;
pub const MAX_LOGICAL_FINAL_CHARS: usize = 1_000_000;
pub const PLAN_NUDGE_ACTION_THRESHOLD: usize = 12;
pub const PLAN_NUDGE_MAX_PER_RUN: usize = 2;
pub const SUMMARY_INPUT_CHARS: usize = 48_000;
pub const SUMMARY_MAX_OUTPUT_TOKENS: usize = 1_024;
pub const MIN_SUMMARY_OUTPUT_TOKENS: usize = 64;
const SUMMARY_MAX_CHARS: usize = 3_072;

const AGENT_GUIDANCE: &str = r#"
# Local AI Desktop Agent
- Work directly from the conversation and tool results. A tool-free response normally finishes the current agent run.
- Use the plan when a task has several substantial stages. Keep it concise and update it honestly, but do not create a detailed Work Plan before you understand the active milestone.
- Goal Plan milestones are stable user-request stages. Work Plan tasks belong only to the active milestone. Existing IDs are canonical: refine, append, split, complete, or drop them instead of replacing completed history.
- After modifying project files, run the most relevant available validation before finishing when practical. Prefer targeted existing project commands. Inspect the diff when practical. If validation is unavailable, say why; never invent commands just to satisfy this guideline.
- Tool output is evidence in the transcript. Do not reread unchanged files merely because old raw output was compacted.
- Do not call a tool only because tools are available. Decide yourself when the task has enough information.
"#;

const SUMMARY_GUIDANCE: &str = "Summarize the earlier agent transcript as a dense factual handoff. Preserve the user's goals and constraints, decisions, relevant files, commands and outcomes, unresolved questions, and current implementation state. Omit pleasantries and redundant raw output. Write only the summary.";

#[derive(Clone, Copy, Debug)]
pub struct CompactionBudget {
    pub context_window: usize,
    pub ratio: f64,
    pub reserve_tokens: usize,
}

impl CompactionBudget {
    pub fn trigger_tokens(self) -> usize {
        let ratio = self.ratio.clamp(0.10, 0.99);
        let by_ratio = (self.context_window as f64 * ratio) as usize;
        let by_reserve = self.context_window.saturating_sub(self.reserve_tokens);
        by_ratio.min(by_reserve)
    }
}

/// Computes a ceiling, not an instruction to use all available output.
pub fn dynamic_output_limit(
    context_window: usize,
    projected_input_tokens: usize,
    safety_reserve: usize,
    provider_max_output: Option<usize>,
    app_max_output: usize,
) -> usize {
    let available =
        context_window.saturating_sub(projected_input_tokens.saturating_add(safety_reserve));
    available
        .min(provider_max_output.unwrap_or(app_max_output))
        .min(app_max_output)
}

fn request_reasoning(config: &Config) -> Value {
    match policy::reasoning(&config.reasoning_mode, "agent") {
        Reasoning::Off => json!({"chat_template_kwargs":{"enable_thinking":false}}),
        Reasoning::Low => json!({"reasoning_effort":"low"}),
        Reasoning::Deep => json!({"reasoning_effort":"xhigh"}),
    }
}

fn request_payload(
    config: &Config,
    messages: &[Value],
    schemas: &[Value],
    continuation_only: bool,
    max_tokens: usize,
) -> Value {
    let mut payload = json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
        "stream_options": {"include_usage": true},
        "max_tokens": max_tokens,
    });
    if !continuation_only {
        payload["tools"] = json!(turn_tools(schemas, false));
        payload["tool_choice"] = json!("auto");
    }
    payload.as_object_mut().expect("request payload").extend(
        request_reasoning(config)
            .as_object()
            .expect("reasoning payload")
            .clone(),
    );
    payload
}

fn estimate_tokens(value: &Value) -> usize {
    // Conservative enough for JSON-heavy local tool prompts. Provider-reported
    // usage remains authoritative telemetry.
    serde_json::to_string(value)
        .unwrap_or_default()
        .chars()
        .count()
        / 3
        + 8
}

#[derive(Clone, Copy, Debug, Default)]
struct RequestBudget {
    projected_input_tokens: usize,
    stable_prefix_tokens: usize,
    tool_schemas_tokens: usize,
    transcript_history_tokens: usize,
    dynamic_tail_tokens: usize,
}

fn request_budget(
    config: &Config,
    messages: &[Value],
    schemas: &[Value],
    continuation_only: bool,
) -> RequestBudget {
    let payload = request_payload(config, messages, schemas, continuation_only, 0);
    let mut transcript = Vec::new();
    let mut dynamic = Vec::new();
    for message in messages.iter().skip(1) {
        let content = message.get("content").and_then(Value::as_str).unwrap_or("");
        if content.starts_with("[RUNTIME GUIDANCE — NOT USER CONTENT]")
            || content.starts_with("[RUNTIME SUMMARY — NOT USER CONTENT]")
            || content.starts_with("[IMPORTED SYSTEM CONTEXT — NOT USER CONTENT]")
        {
            dynamic.push(message.clone());
        } else {
            transcript.push(message.clone());
        }
    }
    RequestBudget {
        projected_input_tokens: estimate_tokens(&payload),
        stable_prefix_tokens: messages
            .first()
            .map_or(0, |message| estimate_tokens(&json!([message]))),
        tool_schemas_tokens: if continuation_only {
            0
        } else {
            estimate_tokens(&Value::Array(schemas.to_vec()))
        },
        transcript_history_tokens: estimate_tokens(&Value::Array(transcript)),
        dynamic_tail_tokens: estimate_tokens(&Value::Array(dynamic)),
    }
}

fn summary_size_tokens(transcript: &Transcript) -> usize {
    transcript
        .latest_summary()
        .map_or(0, |(summary, _)| estimate_tokens(&json!(summary)))
}

fn summary_size_chars(transcript: &Transcript) -> usize {
    transcript
        .latest_summary()
        .map_or(0, |(summary, _)| summary.chars().count())
}

fn cap_summary(summary: &str) -> String {
    let summary = summary.trim();
    if summary.chars().count() <= SUMMARY_MAX_CHARS {
        return summary.to_owned();
    }
    let bounded = summary.chars().take(SUMMARY_MAX_CHARS).collect::<String>();
    format!("{bounded}\n[summary truncated to preserve context budget]")
}

fn retained_tail_tokens(messages: &[Value]) -> usize {
    let retained = messages
        .iter()
        .skip(1)
        .filter(|message| {
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            !content.starts_with("[RUNTIME GUIDANCE — NOT USER CONTENT]")
                && !content.starts_with("[RUNTIME SUMMARY — NOT USER CONTENT]")
                && !content.starts_with("[IMPORTED SYSTEM CONTEXT — NOT USER CONTENT]")
        })
        .cloned()
        .collect::<Vec<_>>();
    estimate_tokens(&Value::Array(retained))
}

fn has_minimum_useful_output(output_tokens: usize) -> bool {
    output_tokens >= MIN_USEFUL_OUTPUT_TOKENS
}

fn budget_error(
    config: &Config,
    before: RequestBudget,
    after: RequestBudget,
    summary_tokens: usize,
    summary_chars: usize,
    retained_tokens: usize,
    attempts: usize,
    requested_max_output: usize,
    available_output: usize,
) -> String {
    format!(
        "Context budget cannot fit minimum useful output: context_window={}, projected_input_tokens_before_compaction={}, projected_input_tokens_after_compaction={}, stable_prefix_estimate_before={}, stable_prefix_estimate_after={}, tool_schemas_estimate_before={}, tool_schemas_estimate_after={}, transcript_history_estimate_before={}, transcript_history_estimate_after={}, dynamic_tail_estimate_before={}, dynamic_tail_estimate_after={}, safety_reserve={}, requested_max_output={}, dynamic_max_output={}, preferred_output_headroom={}, minimum_useful_output={}, compaction_summary_tokens={}, compaction_summary_chars={}, retained_tail_tokens={}, compaction_attempts={}",
        config.context_limit,
        before.projected_input_tokens,
        after.projected_input_tokens,
        before.stable_prefix_tokens,
        after.stable_prefix_tokens,
        before.tool_schemas_tokens,
        after.tool_schemas_tokens,
        before.transcript_history_tokens,
        after.transcript_history_tokens,
        before.dynamic_tail_tokens,
        after.dynamic_tail_tokens,
        SAFETY_RESERVE_TOKENS,
        requested_max_output,
        available_output,
        PREFERRED_OUTPUT_HEADROOM_TOKENS,
        MIN_USEFUL_OUTPUT_TOKENS,
        summary_tokens,
        summary_chars,
        retained_tokens,
        attempts,
    )
}

fn stable_prefix(config: &Config) -> String {
    let mut prefix = format!("{}\n{}", config.system.trim(), AGENT_GUIDANCE.trim());
    if let Some(root) = &config.root {
        prefix.push_str("\n<working_directory>");
        prefix.push_str(root);
        prefix.push_str("</working_directory>");
    }
    prefix
}

fn dynamic_tail(state: &AgentState) -> String {
    let mut tail = Vec::new();
    if !state.plan.milestones.is_empty() {
        tail.push(format!(
            "<planning_state>{}</planning_state>",
            serde_json::to_string(&state.plan).unwrap_or_default()
        ));
    }
    tail.join("\n")
}

fn tool_schemas(has_project_root: bool) -> Vec<Value> {
    let mut tools = vec![
        json!({"type":"function","function":{"name":"task_plan","description":"Manage two separate planning layers. For scope=goal, init requires milestones only and creates the active milestone with an empty Work Plan; do not send tasks. For scope=work, init requires milestone_id (the active milestone ID) and tasks; work append also requires milestone_id and label. Work tasks are planned only after orientation. Use view to read the canonical snapshot and stable IDs. Goal and Work Plan IDs returned by view are canonical. Completed history is retained.","parameters":{"type":"object","properties":{"scope":{"type":"string","enum":["goal","work"],"description":"Required: goal manages milestones; work manages tasks for the active milestone."},"action":{"type":"string","enum":["init","append","refine","split","start","done","drop","view"]},"milestones":{"type":"array","description":"Goal init creates milestones only; do not include Work Plan tasks here.","items":{"oneOf":[{"type":"string"},{"type":"object","properties":{"label":{"type":"string"}},"required":["label"]}]}},"tasks":{"type":"array","description":"Work init creates tasks for the active milestone; used separately after Goal init.","items":{"oneOf":[{"type":"string"},{"type":"object","properties":{"label":{"type":"string"}},"required":["label"]}]}},"milestone_id":{"type":"string","description":"Required for Work Plan mutations; must identify the active milestone."},"task_id":{"type":"string"},"label":{"type":"string"},"after_id":{"type":"string"}},"required":["scope","action"]}}}),
    ];
    if has_project_root {
        tools.extend([
            json!({"type":"function","function":{"name":"apply_patch","description":"Apply a project patch.","parameters":{"type":"object","properties":{"patch":{"type":"string"}},"required":["patch"]}}}),
            json!({"type":"function","function":{"name":"create_file","description":"Create a new project file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}),
            json!({"type":"function","function":{"name":"delete_file","description":"Delete a project file when allowed.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}),
            json!({"type":"function","function":{"name":"list_directory","description":"List a project directory.","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}),
            json!({"type":"function","function":{"name":"read_file","description":"Read a project file. Use a line range only when it helps answer a specific question.","parameters":{"type":"object","properties":{"path":{"type":"string"},"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1}},"required":["path"]}}}),
            json!({"type":"function","function":{"name":"run_terminal","description":"Run an existing relevant project command. After code changes, prefer a focused test, typecheck, lint, build, or check when available.","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout_ms":{"type":"integer","minimum":1}},"required":["command"]}}}),
            json!({"type":"function","function":{"name":"write_file","description":"Write a project file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}),
        ]);
    }
    tools.sort_by(|left, right| tool_name(left).cmp(tool_name(right)));
    tools
}

fn tool_name(tool: &Value) -> &str {
    tool.pointer("/function/name")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn plan_labels(arguments: &Value, key: &str) -> Result<Vec<String>, String> {
    let values = arguments
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("task_plan {key} must be an array"))?;
    values
        .iter()
        .map(|value| match value {
            Value::String(label) => Ok(label.clone()),
            Value::Object(_) => value
                .get("label")
                .or_else(|| value.get("content"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("each {key} item needs label")),
            _ => Err(format!("each {key} item must be a string or object")),
        })
        .collect()
}

fn required_id(arguments: &Value, key: &str) -> Result<String, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("task_plan requires {key}"))
}

fn required_label(arguments: &Value) -> Result<String, String> {
    arguments
        .get("label")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "task_plan requires label".into())
}

fn require_active_milestone(state: &AgentState, arguments: &Value) -> Result<(), String> {
    let requested = required_id(arguments, "milestone_id")?;
    let active = state
        .plan
        .active_milestone()
        .ok_or_else(|| "there is no active milestone".to_owned())?;
    if requested != active.id {
        return Err(format!(
            "Work Plan mutations require the active milestone ID {}; got {requested}",
            active.id
        ));
    }
    Ok(())
}

fn apply_plan(state: &mut AgentState, arguments: &Value) -> Result<(Value, bool), String> {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| "task_plan requires action".to_owned())?;
    let scope = arguments
        .get("scope")
        .and_then(Value::as_str)
        .ok_or_else(|| "task_plan requires scope (goal or work)".to_owned())?;
    if !matches!(scope, "goal" | "work") {
        return Err("task_plan scope must be goal or work".into());
    }
    if action == "view" {
        return Ok((json!({"plan": state.plan, "updated": false}), false));
    }
    if scope == "work" && action != "view" {
        require_active_milestone(state, arguments)?;
    }
    match (scope, action) {
        ("goal", "init") => {
            if arguments.get("tasks").is_some() {
                return Err(
                    "Goal Plan init accepts milestones only; initialize Work Plan tasks separately"
                        .into(),
                );
            }
            state.plan.init(plan_labels(arguments, "milestones")?)?;
        }
        ("goal", "append") => state.plan.append_milestone(
            required_label(arguments)?,
            arguments.get("after_id").and_then(Value::as_str),
        )?,
        ("goal", "refine") => state.plan.refine_milestone(
            &required_id(arguments, "milestone_id")?,
            required_label(arguments)?,
        )?,
        ("goal", "done") => state
            .plan
            .finish_milestone(&required_id(arguments, "milestone_id")?, false)?,
        ("goal", "drop") => state
            .plan
            .drop_milestone(&required_id(arguments, "milestone_id")?)?,
        ("work", "init") => state.plan.init_work(plan_labels(arguments, "tasks")?)?,
        ("work", "append") => state.plan.append_work(
            required_label(arguments)?,
            arguments.get("after_id").and_then(Value::as_str),
        )?,
        ("work", "refine") => state.plan.refine_work(
            &required_id(arguments, "task_id")?,
            required_label(arguments)?,
        )?,
        ("work", "split") => state.plan.split_work(
            &required_id(arguments, "task_id")?,
            plan_labels(arguments, "tasks")?,
        )?,
        ("work", "start") => state.plan.start_work(&required_id(arguments, "task_id")?)?,
        ("work", "done") => state
            .plan
            .finish_work(&required_id(arguments, "task_id")?, false)?,
        ("work", "drop") => state
            .plan
            .finish_work(&required_id(arguments, "task_id")?, true)?,
        _ => return Err("unsupported task_plan scope/action combination".into()),
    }
    state.plan_touched();
    Ok((json!({"plan": state.plan, "updated": true}), true))
}

fn mutation_tool(name: &str) -> bool {
    matches!(
        name,
        "write_file" | "create_file" | "apply_patch" | "delete_file"
    )
}

fn validation_command(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    [
        " test",
        "test ",
        "cargo test",
        "cargo check",
        "typecheck",
        "type-check",
        " lint",
        "lint ",
        " build",
        "build ",
        " compile",
        "compile ",
        "clippy",
        "vitest",
        "jest",
    ]
    .iter()
    .any(|needle| command.contains(needle))
}

fn continuation_tail(content: &str) -> String {
    const TAIL: usize = 12_000;
    let chars = content.chars().collect::<Vec<_>>();
    if chars.len() <= TAIL {
        content.to_owned()
    } else {
        chars[chars.len() - TAIL..].iter().collect()
    }
}

fn append_final_text(accumulator: &mut String, delta: &str) {
    accumulator.push_str(delta);
}

fn needs_compaction(
    budget: CompactionBudget,
    projected_input_tokens: usize,
    available_output: usize,
) -> bool {
    projected_input_tokens > budget.trigger_tokens()
        || available_output < PREFERRED_OUTPUT_HEADROOM_TOKENS
}

fn retry_keep_recent(attempt: usize) -> usize {
    (DEFAULT_KEEP_RECENT >> attempt).max(1)
}

fn turn_tools(schemas: &[Value], continuation_only: bool) -> Vec<Value> {
    if continuation_only {
        Vec::new()
    } else {
        schemas.to_vec()
    }
}

#[derive(Default)]
struct StreamedTurn {
    content: String,
    reasoning: String,
    thinking_started: bool,
    reasoning_delta_count: usize,
    calls: BTreeMap<usize, Value>,
    finish_reason: String,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
    cached_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
    prompt_ms: Option<f64>,
    predicted_ms: Option<f64>,
    predicted_per_second: Option<f64>,
}

/// Dependency-free OpenAI-compatible SSE transport. Visible content is emitted
/// at the delta boundary; finalization never becomes the first visible output.
fn stream_call(
    endpoint: &str,
    payload: &Value,
    run_id: &str,
    cancelled: &AtomicBool,
    emit_visible: bool,
) -> Result<StreamedTurn, String> {
    let without = endpoint.trim_start_matches("http://");
    let (host_port, path) = without
        .split_once('/')
        .unwrap_or((without, "v1/chat/completions"));
    let path = format!("/{path}");
    let mut stream = TcpStream::connect(host_port).map_err(|error| error.to_string())?;
    let body = payload.to_string();
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host_port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(), body
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    // Install the timeout before status/header parsing too. Otherwise Stop
    // cannot interrupt a provider that accepts the socket but never sends its
    // first response byte.
    stream
        .set_read_timeout(Some(std::time::Duration::from_millis(100)))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => return Err("upstream closed before HTTP status".into()),
            Ok(_) => break,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) && cancelled.load(Ordering::Relaxed) =>
            {
                return Err("cancelled".into())
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    if !line.contains(" 200 ") {
        let status = line.trim().to_owned();
        let mut response = String::new();
        let _ = reader.read_to_string(&mut response);
        return Err(format!("model HTTP status: {status}; {}", response.trim()));
    }
    let mut chunked = false;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => return Err("upstream closed while reading HTTP headers".into()),
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) && cancelled.load(Ordering::Relaxed) =>
            {
                return Err("cancelled".into())
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue
            }
            Err(error) => return Err(error.to_string()),
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if line
            .to_ascii_lowercase()
            .starts_with("transfer-encoding: chunked")
        {
            chunked = true;
        }
    }
    let mut turn = StreamedTurn::default();
    let mut buffer = String::new();
    if chunked {
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            line.clear();
            match reader.read_line(&mut line) {
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    continue
                }
                Err(error) => return Err(error.to_string()),
            }
            let size = usize::from_str_radix(line.trim(), 16)
                .map_err(|error| format!("invalid chunk size: {error}"))?;
            if size == 0 {
                break;
            }
            let mut bytes = vec![0; size];
            reader
                .read_exact(&mut bytes)
                .map_err(|error| error.to_string())?;
            let mut crlf = [0; 2];
            reader
                .read_exact(&mut crlf)
                .map_err(|error| error.to_string())?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));
            consume_sse(&mut buffer, &mut turn, run_id, emit_visible)?;
        }
    } else {
        let mut bytes = [0_u8; 8192];
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let count = match reader.read(&mut bytes) {
                Ok(count) => count,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    continue
                }
                Err(error) => return Err(error.to_string()),
            };
            if count == 0 {
                break;
            }
            buffer.push_str(&String::from_utf8_lossy(&bytes[..count]));
            consume_sse(&mut buffer, &mut turn, run_id, emit_visible)?;
        }
    }
    // Some OpenAI-compatible local servers close the connection immediately
    // after the final data frame without a trailing blank event separator.
    // Treat that final complete frame as SSE rather than silently losing its
    // usage or finish reason.
    if !buffer.trim().is_empty() {
        if buffer.ends_with('\n') {
            buffer.push('\n');
        } else {
            buffer.push_str("\n\n");
        }
        consume_sse(&mut buffer, &mut turn, run_id, emit_visible)?;
    }
    Ok(turn)
}

fn consume_sse(
    buffer: &mut String,
    turn: &mut StreamedTurn,
    run_id: &str,
    emit_visible: bool,
) -> Result<(), String> {
    while let Some(end) = buffer.find("\n\n") {
        let block = buffer[..end].replace('\r', "");
        buffer.drain(..end + 2);
        for line in block
            .lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
        {
            if line == "[DONE]" {
                continue;
            }
            let value: Value =
                serde_json::from_str(line).map_err(|error| format!("invalid SSE JSON: {error}"))?;
            if let Some(usage) = value.get("usage") {
                turn.prompt_tokens = usage
                    .get("prompt_tokens")
                    .and_then(Value::as_u64)
                    .or(turn.prompt_tokens);
                turn.completion_tokens = usage
                    .get("completion_tokens")
                    .and_then(Value::as_u64)
                    .or(turn.completion_tokens);
                turn.total_tokens = usage
                    .get("total_tokens")
                    .and_then(Value::as_u64)
                    .or(turn.total_tokens);
                turn.cached_tokens = usage
                    .pointer("/prompt_tokens_details/cached_tokens")
                    .and_then(Value::as_u64)
                    .or_else(|| usage.get("cache_read_input_tokens").and_then(Value::as_u64))
                    .or(turn.cached_tokens);
                turn.cache_write_tokens = usage
                    .get("cache_creation_input_tokens")
                    .and_then(Value::as_u64)
                    .or_else(|| {
                        usage
                            .pointer("/prompt_tokens_details/cache_creation_tokens")
                            .and_then(Value::as_u64)
                    })
                    .or(turn.cache_write_tokens);
            }
            if let Some(timings) = value.get("timings") {
                turn.prompt_tokens = timings
                    .get("prompt_n")
                    .and_then(Value::as_u64)
                    .or(turn.prompt_tokens);
                turn.completion_tokens = timings
                    .get("predicted_n")
                    .and_then(Value::as_u64)
                    .or(turn.completion_tokens);
                turn.prompt_ms = timings
                    .get("prompt_ms")
                    .and_then(Value::as_f64)
                    .or(turn.prompt_ms);
                turn.predicted_ms = timings
                    .get("predicted_ms")
                    .and_then(Value::as_f64)
                    .or(turn.predicted_ms);
                turn.predicted_per_second = timings
                    .get("predicted_per_second")
                    .and_then(Value::as_f64)
                    .or(turn.predicted_per_second);
            }
            let choice = value.pointer("/choices/0");
            let delta = choice.and_then(|choice| choice.get("delta"));
            if let Some(reasoning) = delta.and_then(|delta| {
                ["reasoning_content", "reasoning", "thinking"]
                    .iter()
                    .find_map(|field| delta.get(*field).and_then(Value::as_str))
            }) {
                if !turn.thinking_started {
                    turn.thinking_started = true;
                    if emit_visible {
                        emit(run_id, Event::ThinkingStarted);
                    }
                }
                turn.reasoning.push_str(reasoning);
                turn.reasoning_delta_count += 1;
                if emit_visible {
                    emit(
                        run_id,
                        Event::ThinkingDelta {
                            content: reasoning.to_owned(),
                        },
                    );
                }
            }
            if let Some(content) = delta
                .and_then(|delta| delta.get("content"))
                .and_then(Value::as_str)
            {
                turn.content.push_str(content);
                if emit_visible {
                    emit(
                        run_id,
                        Event::ContentDelta {
                            content: content.to_owned(),
                        },
                    );
                }
            }
            if let Some(calls) = delta
                .and_then(|delta| delta.get("tool_calls"))
                .and_then(Value::as_array)
            {
                for call in calls {
                    let index = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or_default() as usize;
                    let entry = turn.calls.entry(index).or_insert_with(
                        || json!({"id":"","type":"function","function":{"name":"","arguments":""}}),
                    );
                    if let Some(id) = call.get("id") {
                        entry["id"] = id.clone();
                    }
                    if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                        entry["function"]["name"] = json!(name);
                    }
                    if let Some(part) = call.pointer("/function/arguments").and_then(Value::as_str)
                    {
                        let before = entry
                            .pointer("/function/arguments")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        entry["function"]["arguments"] = json!(format!("{before}{part}"));
                    }
                }
            }
            if let Some(reason) = choice
                .and_then(|choice| choice.get("finish_reason"))
                .and_then(Value::as_str)
            {
                turn.finish_reason = reason.to_owned();
            }
        }
    }
    Ok(())
}

fn summarize_span(config: &Config, transcript: &Transcript, covers: usize) -> String {
    // Summary generation is also a provider turn. Keep its input small enough
    // to leave meaningful output headroom on the selected local context size.
    let summary_input_chars = SUMMARY_INPUT_CHARS.min(
        config
            .context_limit
            .saturating_sub(SAFETY_RESERVE_TOKENS + MIN_SUMMARY_OUTPUT_TOKENS)
            .saturating_mul(2),
    );
    let dropped = transcript.render_span(covers, summary_input_chars);
    if dropped.trim().is_empty() {
        return "Earlier conversation was omitted to fit the selected context window.".into();
    }
    let messages = vec![
        json!({"role":"system", "content": SUMMARY_GUIDANCE}),
        json!({"role":"user", "content": dropped}),
    ];
    let max_tokens = dynamic_output_limit(
        config.context_limit,
        estimate_tokens(&Value::Array(messages.clone())),
        SAFETY_RESERVE_TOKENS,
        config.provider_max_output,
        SUMMARY_MAX_OUTPUT_TOKENS,
    );
    if max_tokens < MIN_SUMMARY_OUTPUT_TOKENS {
        return "Earlier conversation was compacted. Retained recent transcript and current planning state remain available.".into();
    }
    let payload = json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
        "max_tokens": max_tokens,
    });
    match stream_call(&config.endpoint, &payload, &config.run_id, &config.cancelled, false) {
        Ok(turn) if !turn.content.trim().is_empty() => cap_summary(&turn.content),
        _ => "Earlier conversation was compacted. Retained recent transcript and current planning state remain available.".into(),
    }
}

fn compact_once(
    config: &Config,
    transcript: &mut Transcript,
    schemas: &[Value],
    continuation_only: bool,
    before: usize,
    keep_recent: usize,
    reason: &str,
    dynamic_tail: &str,
) -> bool {
    let Some(covers) = transcript.compaction_plan(keep_recent) else {
        return false;
    };
    let summary = summarize_span(config, transcript, covers);
    transcript.compact(summary, covers);
    let messages = project(transcript, &stable_prefix(config), dynamic_tail);
    let after =
        request_budget(config, &messages, schemas, continuation_only).projected_input_tokens;
    emit(
        &config.run_id,
        Event::ContextOptimized {
            before,
            after,
            trigger_reason: reason.to_owned(),
            removed_transcript_tokens: before.saturating_sub(after),
            retained_suffix_tokens: after,
        },
    );
    true
}

fn request_shape(messages: &[Value]) -> Vec<String> {
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("?");
            let tool = message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .map_or(String::new(), |id| format!(" result={id}"));
            format!("{index}:{role}{tool}")
        })
        .collect()
}

fn run_tool(
    config: &Config,
    state: &mut AgentState,
    tool: &ValidatedCall,
) -> Result<(Value, Option<String>), String> {
    match tool.name.as_str() {
        "task_plan" => {
            let (value, changed) = apply_plan(state, &tool.arguments)?;
            if changed {
                emit(
                    &config.run_id,
                    Event::PlanUpdate {
                        plan: serde_json::to_value(&state.plan)
                            .map_err(|error| error.to_string())?,
                    },
                );
            }
            Ok((value, None))
        }
        "run_terminal" => {
            let root = config
                .root
                .as_ref()
                .ok_or_else(|| "no project scope".to_owned())?;
            let command = tool
                .arguments
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let value = crate::tools::shell::execute(
                &PathBuf::from(root),
                &tool.arguments,
                || config.cancelled.load(Ordering::Relaxed),
                |pid, pgid, session_id, started_at| {
                    emit(
                        &config.run_id,
                        Event::ToolProcessStarted {
                            id: tool.id.clone(),
                            command: command.clone(),
                            cwd: root.clone(),
                            pid,
                            pgid,
                            session_id,
                            started_at,
                        },
                    )
                },
                |stream, content| {
                    emit(
                        &config.run_id,
                        Event::ToolOutputDelta {
                            id: tool.id.clone(),
                            stream: stream.into(),
                            content: content.into(),
                        },
                    )
                },
            )?;
            let failed = value
                .get("exit_code")
                .and_then(Value::as_i64)
                .is_some_and(|code| code != 0)
                || value
                    .get("timed_out")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                || value
                    .get("cancelled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            if failed {
                return Err(value.to_string());
            }
            if validation_command(&command) {
                state.record_validation();
            }
            Ok((value, None))
        }
        name => {
            let root = config
                .root
                .as_ref()
                .ok_or_else(|| "no project scope".to_owned())?;
            let result =
                crate::tools::filesystem::execute(&PathBuf::from(root), name, &tool.arguments)?;
            if mutation_tool(name) {
                state.record_mutation();
            }
            Ok(result)
        }
    }
}

fn add_soft_closeout_if_needed(state: &mut AgentState, transcript: &mut Transcript) -> bool {
    let plan_open = state.plan.has_open_work();
    let needs_validation = state.workspace_mutated_since_validation && !state.verification_nudged;
    let needs_plan = plan_open && !state.closeout_nudged;
    if !needs_validation && !needs_plan {
        return false;
    }
    let mut reminder = Vec::new();
    if needs_plan {
        state.closeout_nudged = true;
        reminder.push(format!("Before you stop, update the plan: complete finished work, drop work that is no longer needed, or continue the task. {}", state.plan.open_summary().unwrap_or_default()));
    }
    if needs_validation {
        state.verification_nudged = true;
        reminder.push("You changed project files but no meaningful validation has been observed since the latest mutation. Run the most relevant available check, or state why validation is unavailable. Inspect the diff when practical.".into());
    }
    transcript.remind(reminder.join("\n\n"));
    true
}

pub fn run(config: Config) {
    let mut transcript = Transcript::default();
    for message in config.history.clone() {
        transcript.push_message(message);
    }
    transcript.push_run_user(json!({"role":"user", "content":config.user}));
    let mut state = AgentState::default();
    state.plan = config
        .plan
        .as_ref()
        .and_then(|plan| serde_json::from_value::<GoalPlan>(plan.clone()).ok())
        .unwrap_or_default();
    state.plan.normalize_active();
    let budget = CompactionBudget {
        context_window: config.context_limit,
        ratio: DEFAULT_COMPACTION_RATIO,
        reserve_tokens: SAFETY_RESERVE_TOKENS + PREFERRED_OUTPUT_HEADROOM_TOKENS,
    };
    let stable = stable_prefix(&config);
    let schemas = tool_schemas(config.root.is_some());
    let mut final_content = String::new();
    let mut continuation_count = 0_usize;
    let mut overflow_attempts = 0_usize;

    emit(
        &config.run_id,
        Event::AgentStarted {
            run_id: config.run_id.clone(),
        },
    );
    for turn in 0..128_usize {
        if config.cancelled.load(Ordering::Relaxed) {
            emit(
                &config.run_id,
                Event::AgentStopped {
                    reason: "cancelled".into(),
                },
            );
            return;
        }
        if let Ok(mut steering) = config.steering.lock() {
            for content in steering.drain(..) {
                transcript.push_steering(content);
            }
        }
        let continuation_only = continuation_count > 0;
        let dynamic = if continuation_only {
            String::new()
        } else {
            dynamic_tail(&state)
        };
        let mut messages = project(&transcript, &stable, &dynamic);
        // The just-projected reminder expires before the following turn.
        transcript.clear_reminders();
        let before_budget = request_budget(&config, &messages, &schemas, continuation_only);
        let requested_max_output = config
            .provider_max_output
            .unwrap_or(APPLICATION_MAX_OUTPUT_TOKENS)
            .min(APPLICATION_MAX_OUTPUT_TOKENS);
        let mut current_budget = before_budget;
        let mut output_limit = dynamic_output_limit(
            config.context_limit,
            current_budget.projected_input_tokens,
            SAFETY_RESERVE_TOKENS,
            config.provider_max_output,
            APPLICATION_MAX_OUTPUT_TOKENS,
        );
        let should_compact =
            needs_compaction(budget, current_budget.projected_input_tokens, output_limit);
        let mut compaction_attempts = 0;
        if should_compact {
            for attempt in 0..MAX_COMPACTION_ATTEMPTS {
                let keep_recent = if attempt == 0 {
                    DEFAULT_KEEP_RECENT
                } else {
                    retry_keep_recent(attempt)
                };
                let current_dynamic = if continuation_only {
                    String::new()
                } else {
                    dynamic_tail(&state)
                };
                if !compact_once(
                    &config,
                    &mut transcript,
                    &schemas,
                    continuation_only,
                    current_budget.projected_input_tokens,
                    keep_recent,
                    if attempt == 0 {
                        "proactive_threshold"
                    } else {
                        "output_headroom_retry"
                    },
                    &current_dynamic,
                ) {
                    break;
                }
                compaction_attempts += 1;
                messages = project(&transcript, &stable, &current_dynamic);
                current_budget = request_budget(&config, &messages, &schemas, continuation_only);
                output_limit = dynamic_output_limit(
                    config.context_limit,
                    current_budget.projected_input_tokens,
                    SAFETY_RESERVE_TOKENS,
                    config.provider_max_output,
                    APPLICATION_MAX_OUTPUT_TOKENS,
                );
                if output_limit >= PREFERRED_OUTPUT_HEADROOM_TOKENS {
                    break;
                }
            }
        }
        if !has_minimum_useful_output(output_limit) {
            let message = budget_error(
                &config,
                before_budget,
                current_budget,
                summary_size_tokens(&transcript),
                summary_size_chars(&transcript),
                retained_tail_tokens(&messages),
                compaction_attempts,
                requested_max_output,
                output_limit,
            );
            emit(
                &config.run_id,
                Event::AgentError {
                    code: "context_budget".into(),
                    message,
                },
            );
            return;
        }
        let projected = current_budget.projected_input_tokens;
        // A prose continuation is deliberately tool-free. It receives the
        // exact visible tail as a one-turn reminder and can only append text.
        let payload = request_payload(
            &config,
            &messages,
            &schemas,
            continuation_only,
            output_limit,
        );
        let payload_messages = payload
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        emit(&config.run_id, Event::TurnStarted { index: turn + 1 });
        emit(
            &config.run_id,
            Event::RunState {
                state: "thinking".into(),
            },
        );
        emit(
            &config.run_id,
            Event::RequestShape {
                turn: turn + 1,
                message_count: payload_messages.len(),
                roles: payload_messages
                    .iter()
                    .filter_map(|message| {
                        message
                            .get("role")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .collect(),
                current_user_index: payload_messages.iter().rposition(|message| {
                    message.get("role").and_then(Value::as_str) == Some("user")
                        && message.get("content").and_then(Value::as_str)
                            == Some(config.user.as_str())
                }),
                system_first: payload_messages
                    .first()
                    .and_then(|message| message.get("role"))
                    .and_then(Value::as_str)
                    == Some("system"),
                entries: request_shape(&payload_messages),
                compaction_boundary: transcript.compaction_boundary(),
            },
        );
        emit(
            &config.run_id,
            Event::RequestPolicy {
                turn: turn + 1,
                phase: if continuation_only {
                    "continuation".into()
                } else {
                    "agent".into()
                },
                reasoning_effort: payload
                    .get("reasoning_effort")
                    .and_then(Value::as_str)
                    .unwrap_or("thinking_off")
                    .to_owned(),
                tool_choice: payload
                    .get("tool_choice")
                    .cloned()
                    .unwrap_or_else(|| json!("none")),
                tools: payload
                    .get("tools")
                    .and_then(Value::as_array)
                    .map(|tools| tools.iter().map(tool_name).map(str::to_owned).collect())
                    .unwrap_or_default(),
                max_tokens: output_limit,
                context_limit: config.context_limit,
                projected_input_tokens: projected,
                reserved_output_tokens: output_limit,
            },
        );
        emit(
            &config.run_id,
            Event::ContextStats {
                used: projected,
                limit: config.context_limit,
            },
        );

        let streamed = match stream_call(
            &config.endpoint,
            &payload,
            &config.run_id,
            &config.cancelled,
            true,
        ) {
            Ok(streamed) => {
                overflow_attempts = 0;
                streamed
            }
            Err(error) if error == "cancelled" => {
                emit(
                    &config.run_id,
                    Event::AgentStopped {
                        reason: "cancelled".into(),
                    },
                );
                return;
            }
            Err(error)
                if is_context_overflow(&error) && overflow_attempts < MAX_COMPACTION_ATTEMPTS =>
            {
                overflow_attempts += 1;
                let before = projected;
                let keep = retry_keep_recent(overflow_attempts);
                if compact_once(
                    &config,
                    &mut transcript,
                    &schemas,
                    continuation_only,
                    before,
                    keep,
                    "context_overflow_retry",
                    &dynamic,
                ) {
                    continue;
                }
                emit(
                    &config.run_id,
                    Event::AgentError {
                        code: "context_overflow".into(),
                        message: error,
                    },
                );
                return;
            }
            Err(error) => {
                emit(
                    &config.run_id,
                    Event::AgentError {
                        code: "upstream".into(),
                        message: error,
                    },
                );
                return;
            }
        };
        if streamed.thinking_started {
            emit(&config.run_id, Event::ThinkingFinished);
        }
        emit(
            &config.run_id,
            Event::TurnReasoning {
                turn: turn + 1,
                started: streamed.thinking_started,
                delta_count: streamed.reasoning_delta_count,
                chars: streamed.reasoning.chars().count(),
            },
        );
        emit(
            &config.run_id,
            Event::TurnUsage {
                prompt_tokens: streamed.prompt_tokens,
                completion_tokens: streamed.completion_tokens,
                total_tokens: streamed.total_tokens.or_else(|| {
                    streamed
                        .prompt_tokens
                        .zip(streamed.completion_tokens)
                        .map(|(prompt, completion)| prompt + completion)
                }),
                cached_tokens: streamed.cached_tokens,
                cache_write_tokens: streamed.cache_write_tokens,
                prompt_ms: streamed.prompt_ms,
                predicted_ms: streamed.predicted_ms,
                predicted_per_second: streamed.predicted_per_second,
                finish_reason: streamed.finish_reason.clone(),
            },
        );
        let raw_calls = streamed.calls.into_values().collect::<Vec<_>>();
        let calls = match validate_calls(&raw_calls, Some(&streamed.finish_reason)) {
            Ok(calls) => calls,
            Err(error) => {
                if !streamed.content.is_empty() {
                    transcript.assistant_message(streamed.content);
                }
                emit(
                    &config.run_id,
                    Event::ToolError {
                        id: "protocol".into(),
                        name: "tool_protocol".into(),
                        message: error.clone(),
                    },
                );
                transcript.remind(format!("The previous tool call was not executed because it was incomplete or malformed: {error}. Emit one complete valid tool call, or answer without tools."));
                continue;
            }
        };
        if continuation_only && !calls.is_empty() {
            emit(
                &config.run_id,
                Event::ToolError {
                    id: "continuation".into(),
                    name: "tool_protocol".into(),
                    message: "a prose continuation cannot execute tools".into(),
                },
            );
            transcript.remind("Continue the previous visible prose only. Do not call tools, restart, or add a new plan.".into());
            continue;
        }
        if calls.is_empty() {
            if streamed.finish_reason == "length" {
                append_final_text(&mut final_content, &streamed.content);
                transcript.assistant_message(streamed.content);
                if continuation_count >= MAX_CONTINUATION_TURNS
                    || final_content.chars().count() >= MAX_LOGICAL_FINAL_CHARS
                {
                    emit(
                        &config.run_id,
                        Event::Final {
                            complete: false,
                            continuation_count,
                            chars: final_content.chars().count(),
                            finish_reason: "length".into(),
                        },
                    );
                    return;
                }
                continuation_count += 1;
                transcript.remind(format!(
                    "Continue exactly from the previous emitted tail. Do not restart, summarize, repeat headings, plan, or investigate.\n<previous_tail>\n{}\n</previous_tail>",
                    continuation_tail(&final_content)
                ));
                emit(
                    &config.run_id,
                    Event::FinalContinuation {
                        continuation: continuation_count,
                        prior_chars: final_content.chars().count(),
                        finish_reason: "length".into(),
                        next_max_tokens: output_limit,
                    },
                );
                continue;
            }
            append_final_text(&mut final_content, &streamed.content);
            if add_soft_closeout_if_needed(&mut state, &mut transcript) {
                transcript.assistant_message(streamed.content);
                continue;
            }
            transcript.assistant_message(streamed.content);
            emit(
                &config.run_id,
                Event::Final {
                    complete: true,
                    continuation_count,
                    chars: final_content.chars().count(),
                    finish_reason: streamed.finish_reason,
                },
            );
            return;
        }
        transcript.assistant_tool_turn(streamed.content, &calls);
        for tool in calls {
            // Emit only after tool-call aggregation and validation, so every
            // activity has the provider's actual id and complete arguments.
            emit(
                &config.run_id,
                Event::ToolCallStarted {
                    id: tool.id.clone(),
                    name: tool.name.clone(),
                    arguments: tool.arguments.clone(),
                },
            );
            if config.cancelled.load(Ordering::Relaxed) {
                transcript.tool_result(&tool.id, &tool.name, "ERROR: generation cancelled".into());
                continue;
            }
            if !schemas.iter().any(|schema| tool_name(schema) == tool.name) {
                let message = format!("tool '{}' is unavailable", tool.name);
                emit(
                    &config.run_id,
                    Event::ToolError {
                        id: tool.id.clone(),
                        name: tool.name.clone(),
                        message: message.clone(),
                    },
                );
                transcript.tool_result(&tool.id, &tool.name, format!("ERROR: {message}"));
                continue;
            }
            if policy::requires_approval(config.policy, &tool.name, &tool.arguments) {
                emit(
                    &config.run_id,
                    Event::ApprovalRequired {
                        id: tool.id.clone(),
                        category: if tool.name == "run_terminal" {
                            "session_system".into()
                        } else {
                            "destructive".into()
                        },
                        detail: tool
                            .arguments
                            .get("command")
                            .and_then(Value::as_str)
                            .unwrap_or(&tool.name)
                            .to_owned(),
                    },
                );
                transcript.tool_result(&tool.id, &tool.name, "ERROR: approval required".into());
                continue;
            }
            emit(
                &config.run_id,
                Event::RunState {
                    state: "working".into(),
                },
            );
            match run_tool(&config, &mut state, &tool) {
                Ok((value, diff)) => {
                    let content = value.to_string();
                    emit(
                        &config.run_id,
                        Event::ToolResult {
                            id: tool.id.clone(),
                            name: tool.name.clone(),
                            content: content.clone(),
                            is_error: false,
                            diff,
                        },
                    );
                    transcript.tool_result(&tool.id, &tool.name, content);
                    if tool.name != "task_plan" {
                        state.action_completed();
                    }
                }
                Err(message) => {
                    emit(
                        &config.run_id,
                        Event::ToolError {
                            id: tool.id.clone(),
                            name: tool.name.clone(),
                            message: message.clone(),
                        },
                    );
                    transcript.tool_result(&tool.id, &tool.name, format!("ERROR: {message}"));
                }
            }
        }
        if state.plan.has_open_work()
            && state.meaningful_actions_since_plan_update >= PLAN_NUDGE_ACTION_THRESHOLD
            && state.plan_nudges < PLAN_NUDGE_MAX_PER_RUN
        {
            state.plan_nudges += 1;
            state.meaningful_actions_since_plan_update = 0;
            transcript.remind(format!("The plan still has open work. Update it if a task or milestone is complete or no longer needed; otherwise continue working. {}", state.plan.open_summary().unwrap_or_default()));
        }
    }
    emit(
        &config.run_id,
        Event::AgentError {
            code: "turn_limit".into(),
            message: "agent turn safeguard reached; transcript and partial output were preserved"
                .into(),
        },
    );
}

fn is_context_overflow(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("context") || error.contains("token limit") || error.contains("too many tokens")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::todo::GoalPlan;
    use std::{
        fs,
        net::{TcpListener, TcpStream},
        sync::mpsc,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    fn sse_response(events: &[Value]) -> String {
        let body = events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .chain(std::iter::once("data: [DONE]\n\n".to_owned()))
            .collect::<String>();
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
        )
    }

    fn read_mock_request(stream: &mut TcpStream) -> Value {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let mut content_length = 0_usize;
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" || line == "\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    content_length = value.trim().parse().unwrap();
                }
            }
        }
        let mut body = vec![0_u8; content_length];
        reader.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn unique_temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("local-ai-agent-{name}-{nonce}"))
    }

    fn test_config(root: Option<&str>) -> Config {
        Config {
            run_id: "test".into(),
            endpoint: "http://127.0.0.1:1".into(),
            model: "test-model".into(),
            system: "base system".into(),
            user: "task".into(),
            root: root.map(str::to_owned),
            context_limit: 16_384,
            reasoning_mode: "fast".into(),
            policy: RunPolicy::Auto,
            history: Vec::new(),
            plan: None,
            provider_max_output: Some(APPLICATION_MAX_OUTPUT_TOKENS),
            cancelled: Arc::new(AtomicBool::new(false)),
            steering: Arc::new(Mutex::new(Vec::new())),
        }
    }

    #[test]
    fn deterministic_tool_ordering() {
        let first = tool_schemas(true);
        let second = tool_schemas(true);
        assert_eq!(first, second);
        let names = first.iter().map(tool_name).collect::<Vec<_>>();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
        assert_eq!(
            tool_schemas(false)
                .iter()
                .map(tool_name)
                .collect::<Vec<_>>(),
            vec!["task_plan"]
        );
    }

    #[test]
    fn goal_and_work_plan_initialization_are_separate_and_return_stable_ids() {
        let mut state = AgentState::default();
        let (goal_snapshot, changed) = apply_plan(
            &mut state,
            &json!({
                "scope":"goal",
                "action":"init",
                "milestones":["Inspect","Implement"]
            }),
        )
        .unwrap();
        assert!(changed);
        assert_eq!(
            state.plan.active_milestone_id.as_deref(),
            Some("milestone-1")
        );
        assert!(state
            .plan
            .active_milestone()
            .unwrap()
            .work_plan
            .tasks
            .is_empty());
        assert_eq!(
            goal_snapshot["plan"]["milestones"][0]["work_plan"]["tasks"],
            json!([])
        );
        assert!(apply_plan(
            &mut AgentState::default(),
            &json!({"scope":"goal","action":"init","milestones":["Inspect"],"tasks":["Lost task"]}),
        )
        .is_err());

        let first_work = apply_plan(
            &mut state,
            &json!({
                "scope":"work",
                "action":"init",
                "milestone_id":"milestone-1",
                "tasks":["Read entry point","Trace request"]
            }),
        )
        .unwrap()
        .0;
        let first_id = first_work["plan"]["milestones"][0]["work_plan"]["tasks"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(first_id, "task-1");

        apply_plan(
            &mut state,
            &json!({
                "scope":"work",
                "action":"append",
                "milestone_id":"milestone-1",
                "label":"Verify behavior"
            }),
        )
        .unwrap();
        let (view, changed) =
            apply_plan(&mut state, &json!({"scope":"goal","action":"view"})).unwrap();
        assert!(!changed);
        let tasks = view["plan"]["milestones"][0]["work_plan"]["tasks"]
            .as_array()
            .unwrap();
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0]["id"], first_id);
        assert_eq!(tasks[0]["label"], "Read entry point");
        assert_eq!(tasks[2]["id"], "task-3");
        assert_eq!(tasks[2]["label"], "Verify behavior");
    }

    #[test]
    fn task_plan_schema_explains_separate_goal_and_work_scopes() {
        let schema = tool_schemas(false)
            .into_iter()
            .find(|tool| tool_name(tool) == "task_plan")
            .unwrap();
        let description = schema
            .pointer("/function/description")
            .unwrap()
            .as_str()
            .unwrap();
        assert!(description.contains("milestones only"));
        assert!(description.contains("milestone_id"));
        assert!(description.contains("do not send tasks"));
        assert_eq!(
            schema.pointer("/function/parameters/required"),
            Some(&json!(["scope", "action"]))
        );
    }

    #[test]
    fn stable_prefix_is_byte_stable_and_plan_stays_in_the_dynamic_tail() {
        let config = test_config(Some("/project"));
        assert_eq!(stable_prefix(&config), stable_prefix(&config));
        let mut state = AgentState::default();
        state.plan.init(vec!["Inspect".into()]).unwrap();
        assert!(!stable_prefix(&config).contains("planning_state"));
        assert!(dynamic_tail(&state).contains("planning_state"));
    }

    #[test]
    fn dynamic_output_uses_real_remaining_context() {
        assert_eq!(
            dynamic_output_limit(32_768, 4_000, 1_024, Some(20_000), 32_768),
            20_000
        );
        assert_eq!(
            dynamic_output_limit(16_384, 15_000, 1_024, None, 32_768),
            360
        );
    }

    #[test]
    fn useful_smaller_output_is_accepted_below_preferred_headroom() {
        let output =
            dynamic_output_limit(32_768, 30_944, SAFETY_RESERVE_TOKENS, Some(8_000), 8_000);
        assert_eq!(output, 800);
        assert!(output < PREFERRED_OUTPUT_HEADROOM_TOKENS);
        assert!(has_minimum_useful_output(output));
        assert!(!has_minimum_useful_output(MIN_USEFUL_OUTPUT_TOKENS - 1));
    }

    #[test]
    fn impossible_budget_error_reports_component_estimates() {
        let before = RequestBudget {
            projected_input_tokens: 40_000,
            stable_prefix_tokens: 500,
            tool_schemas_tokens: 1_200,
            transcript_history_tokens: 38_000,
            dynamic_tail_tokens: 300,
        };
        let after = RequestBudget {
            projected_input_tokens: 32_000,
            stable_prefix_tokens: 500,
            tool_schemas_tokens: 1_200,
            transcript_history_tokens: 30_000,
            dynamic_tail_tokens: 300,
        };
        let error = budget_error(
            &test_config(None),
            before,
            after,
            128,
            384,
            29_000,
            4,
            8_000,
            0,
        );
        for expected in [
            "context_window=16384",
            "projected_input_tokens_before_compaction=40000",
            "projected_input_tokens_after_compaction=32000",
            "stable_prefix_estimate_after=500",
            "tool_schemas_estimate_after=1200",
            "transcript_history_estimate_after=30000",
            "dynamic_tail_estimate_after=300",
            "safety_reserve=1024",
            "requested_max_output=8000",
            "dynamic_max_output=0",
            "minimum_useful_output=32",
            "compaction_summary_tokens=128",
            "compaction_summary_chars=384",
            "retained_tail_tokens=29000",
            "compaction_attempts=4",
        ] {
            assert!(error.contains(expected), "missing {expected} from {error}");
        }
    }

    #[test]
    fn summary_output_is_bounded_before_it_returns_to_the_transcript() {
        let bounded = cap_summary(&"s".repeat(SUMMARY_MAX_CHARS + 5_000));
        assert!(bounded.chars().count() <= SUMMARY_MAX_CHARS + 64);
        assert!(bounded.ends_with("[summary truncated to preserve context budget]"));
        assert_eq!(cap_summary(" concise summary "), "concise summary");
    }

    #[test]
    fn low_remaining_context_compacts_before_a_tiny_output_budget() {
        let budget = CompactionBudget {
            context_window: 16_384,
            ratio: DEFAULT_COMPACTION_RATIO,
            reserve_tokens: SAFETY_RESERVE_TOKENS + PREFERRED_OUTPUT_HEADROOM_TOKENS,
        };
        assert!(needs_compaction(budget, 14_500, 500));
        assert!(!needs_compaction(budget, 4_000, 2_000));
    }

    #[test]
    fn overflow_recovery_shrinks_tail_and_stays_bounded() {
        assert_eq!(retry_keep_recent(1), 4);
        assert_eq!(retry_keep_recent(2), 2);
        assert_eq!(retry_keep_recent(3), 1);
        assert_eq!(retry_keep_recent(MAX_COMPACTION_ATTEMPTS), 1);
    }

    #[test]
    fn retained_tail_decreases_across_bounded_compaction_attempts() {
        let mut transcript = Transcript::default();
        for turn in 0..10 {
            transcript.push_message(json!({"role":"user","content":format!("request {turn}")}));
            transcript
                .push_message(json!({"role":"assistant","content":format!("response {turn}")}));
        }
        transcript.push_run_user(json!({"role":"user","content":"current request"}));

        let mut retained = Vec::new();
        for keep_recent in [
            DEFAULT_KEEP_RECENT,
            retry_keep_recent(1),
            retry_keep_recent(2),
            retry_keep_recent(3),
        ] {
            let boundary = transcript.compaction_plan(keep_recent).unwrap();
            retained.push(
                transcript.entries()[boundary..]
                    .iter()
                    .filter(|entry| {
                        matches!(
                            entry,
                            crate::agent::transcript::Entry::Message(_)
                                | crate::agent::transcript::Entry::RunUser(_)
                        )
                    })
                    .count(),
            );
        }
        assert_eq!(retained, vec![8, 4, 2, 1]);
    }

    #[test]
    fn long_32k_transcript_recompacts_then_sends_the_next_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            loop {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_mock_request(&mut stream);
                let is_summary =
                    request["messages"][0]["content"]
                        .as_str()
                        .is_some_and(|content| {
                            content.contains("Summarize the earlier agent transcript")
                        });
                requests.push(request);
                let response = if is_summary {
                    json!({"choices":[{"delta":{"content":"Compact handoff."},"finish_reason":"stop"}]})
                } else {
                    json!({"choices":[{"delta":{"content":"Request continued after compaction."},"finish_reason":"stop"}]})
                };
                stream
                    .write_all(sse_response(&[response]).as_bytes())
                    .unwrap();
                if !is_summary {
                    return requests;
                }
            }
        });

        let mut config = test_config(None);
        config.endpoint = endpoint;
        config.context_limit = 32_768;
        config.provider_max_output = Some(1_600);
        config.user = "current request".into();
        let long_turn = "transcript detail ".repeat(1_100);
        for turn in 0..10 {
            config
                .history
                .push(json!({"role":"user","content":format!("request {turn}: {long_turn}")}));
            config.history.push(
                json!({"role":"assistant","content":format!("response {turn}: {long_turn}")}),
            );
        }

        run(config);
        let requests = server.join().unwrap();
        let summary_requests = requests
            .iter()
            .filter(|request| {
                request["messages"][0]["content"]
                    .as_str()
                    .is_some_and(|content| {
                        content.contains("Summarize the earlier agent transcript")
                    })
            })
            .collect::<Vec<_>>();
        assert!(
            summary_requests.len() >= 2,
            "expected normal and aggressive compaction"
        );
        let agent_request = requests.last().unwrap();
        assert_eq!(agent_request["max_tokens"], 1_600);
        let messages = agent_request["messages"].as_array().unwrap();
        let systems = messages
            .iter()
            .enumerate()
            .filter_map(|(index, message)| (message["role"] == "system").then_some(index))
            .collect::<Vec<_>>();
        assert_eq!(systems, vec![0]);
        assert_eq!(
            messages
                .iter()
                .filter(
                    |message| message["role"] == "user" && message["content"] == "current request"
                )
                .count(),
            1
        );
    }

    #[test]
    fn smaller_provider_output_budget_is_sent_instead_of_failing() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_mock_request(&mut stream);
            let final_turn =
                json!({"choices":[{"delta":{"content":"short answer"},"finish_reason":"stop"}]});
            stream
                .write_all(sse_response(&[final_turn]).as_bytes())
                .unwrap();
            request
        });
        let mut config = test_config(None);
        config.endpoint = endpoint;
        config.provider_max_output = Some(700);

        run(config);
        let request = server.join().unwrap();
        assert_eq!(request["max_tokens"], 700);
    }

    #[test]
    fn smaller_dynamic_output_budget_is_sent_when_current_turn_cannot_be_compacted() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_mock_request(&mut stream);
            let final_turn =
                json!({"choices":[{"delta":{"content":"brief answer"},"finish_reason":"stop"}]});
            stream
                .write_all(sse_response(&[final_turn]).as_bytes())
                .unwrap();
            request
        });

        let mut config = test_config(None);
        config.endpoint = endpoint;
        config.user = "current turn ".repeat(9_000);
        let messages = project(
            &{
                let mut transcript = Transcript::default();
                transcript.push_run_user(json!({"role":"user","content":config.user}));
                transcript
            },
            &stable_prefix(&config),
            "",
        );
        let projected =
            request_budget(&config, &messages, &tool_schemas(false), false).projected_input_tokens;
        config.context_limit = projected + SAFETY_RESERVE_TOKENS + 600;

        run(config);
        let request = server.join().unwrap();
        let max_tokens = request["max_tokens"].as_u64().unwrap() as usize;
        assert!(max_tokens >= MIN_USEFUL_OUTPUT_TOKENS);
        assert!(max_tokens < PREFERRED_OUTPUT_HEADROOM_TOKENS);
    }

    #[test]
    fn aggressive_compaction_leaves_tool_call_result_pairs_valid() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"inspect"}));
        for index in 0..6 {
            let id = format!("tool-{index}");
            transcript.push_message(json!({
                "role":"assistant",
                "content":"",
                "tool_calls":[{"id":id,"type":"function","function":{"name":"read_file","arguments":"{}"}}]
            }));
            transcript.tool_result(&id, "read_file", "result".into());
        }
        let boundary = transcript.compaction_plan(1).unwrap();
        assert!(matches!(
            &transcript.entries()[boundary],
            crate::agent::transcript::Entry::Message(message)
                if message["role"] == "assistant" && message["tool_calls"][0]["id"] == "tool-5"
        ));
        let projected = project(&transcript, "stable", "");
        let call = projected
            .iter()
            .position(|message| {
                message["role"] == "assistant" && message["tool_calls"][0]["id"] == "tool-5"
            })
            .unwrap();
        let result = projected
            .iter()
            .position(|message| message["role"] == "tool" && message["tool_call_id"] == "tool-5")
            .unwrap();
        assert!(call < result);
    }

    #[test]
    fn one_combined_soft_reminder_is_bounded() {
        let mut state = AgentState::default();
        state.plan = GoalPlan::default();
        state.plan.init(vec!["Implement".into()]).unwrap();
        state.workspace_mutated_since_validation = true;
        let mut transcript = Transcript::default();
        assert!(add_soft_closeout_if_needed(&mut state, &mut transcript));
        assert!(!add_soft_closeout_if_needed(&mut state, &mut transcript));
    }

    #[test]
    fn a_tool_free_response_normally_needs_no_gate() {
        let mut state = AgentState::default();
        let mut transcript = Transcript::default();
        assert!(!add_soft_closeout_if_needed(&mut state, &mut transcript));
    }

    #[test]
    fn validation_clears_verification_requirement() {
        let mut state = AgentState::default();
        state.record_mutation();
        state.record_validation();
        let mut transcript = Transcript::default();
        assert!(!add_soft_closeout_if_needed(&mut state, &mut transcript));
    }

    #[test]
    fn continuation_is_append_only_and_has_a_bounded_tail() {
        let mut final_text = String::from("first part ");
        append_final_text(&mut final_text, "second part");
        assert_eq!(final_text, "first part second part");
        let long = "x".repeat(13_000);
        assert_eq!(continuation_tail(&long).chars().count(), 12_000);
        assert!(turn_tools(&tool_schemas(true), true).is_empty());
    }

    #[test]
    fn tool_call_result_is_replayed_on_the_next_model_turn() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            {
                let (mut first, _) = listener.accept().unwrap();
                requests.push(read_mock_request(&mut first));
                let tool_turn = json!({
                    "choices":[{"delta":{"tool_calls":[{
                        "index":0,
                        "id":"directory-1",
                        "type":"function",
                        "function":{"name":"list_directory","arguments":"{\"path\":\".\"}"}
                    }]},"finish_reason":"tool_calls"}]
                });
                first
                    .write_all(sse_response(&[tool_turn]).as_bytes())
                    .unwrap();
            }

            let (mut second, _) = listener.accept().unwrap();
            requests.push(read_mock_request(&mut second));
            let final_turn = json!({
                "choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]
            });
            second
                .write_all(sse_response(&[final_turn]).as_bytes())
                .unwrap();
            requests
        });
        let root = unique_temp_root("tool-loop");
        fs::create_dir_all(&root).unwrap();
        let mut config = test_config(Some(root.to_str().unwrap()));
        config.endpoint = endpoint;
        run(config);
        let requests = server.join().unwrap();
        let second_messages = requests[1]["messages"].as_array().unwrap();
        assert!(second_messages.iter().any(|message| {
            message["role"] == "assistant"
                && message["tool_calls"]
                    .as_array()
                    .is_some_and(|calls| calls[0]["id"] == "directory-1")
        }));
        assert!(second_messages.iter().any(|message| {
            message["role"] == "tool"
                && message["tool_call_id"] == "directory-1"
                && message["content"]
                    .as_str()
                    .is_some_and(|content| content.contains("entries"))
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn provider_request_contains_each_actual_user_turn_once_in_order() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_mock_request(&mut stream);
            let final_turn = json!({
                "choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]
            });
            stream
                .write_all(sse_response(&[final_turn]).as_bytes())
                .unwrap();
            request
        });
        let mut config = test_config(None);
        config.endpoint = endpoint;
        config.user = "current request".into();
        config.history = vec![
            json!({"role":"user","content":"first request"}),
            json!({"role":"assistant","content":"first answer"}),
            json!({"role":"user","content":"second request"}),
            json!({"role":"assistant","content":"second answer"}),
        ];

        run(config);
        let request = server.join().unwrap();
        let messages = request["messages"].as_array().unwrap();
        let user_turns = messages
            .iter()
            .filter(|message| message["role"] == "user")
            .filter_map(|message| message["content"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            user_turns,
            vec!["first request", "second request", "current request"]
        );
    }

    #[test]
    fn length_continuation_keeps_one_logical_response_and_hides_tools() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            {
                let (mut first, _) = listener.accept().unwrap();
                requests.push(read_mock_request(&mut first));
                let prefix = json!({
                    "choices":[{"delta":{"content":"First visible prefix. "},"finish_reason":"length"}]
                });
                first.write_all(sse_response(&[prefix]).as_bytes()).unwrap();
            }
            let (mut second, _) = listener.accept().unwrap();
            requests.push(read_mock_request(&mut second));
            let suffix = json!({
                "choices":[{"delta":{"content":"Second visible suffix."},"finish_reason":"stop"}]
            });
            second
                .write_all(sse_response(&[suffix]).as_bytes())
                .unwrap();
            requests
        });
        let mut config = test_config(None);
        config.endpoint = endpoint;
        run(config);
        let requests = server.join().unwrap();
        assert!(requests[0].get("tools").is_some());
        assert!(requests[1].get("tools").is_none());
        assert!(requests[1].get("tool_choice").is_none());
        let second_messages = requests[1]["messages"].as_array().unwrap();
        let systems = second_messages
            .iter()
            .enumerate()
            .filter_map(|(index, message)| (message["role"] == "system").then_some(index))
            .collect::<Vec<_>>();
        assert_eq!(systems, vec![0]);
        assert!(second_messages
            .iter()
            .any(|message| message["role"] == "assistant"
                && message["content"] == "First visible prefix. "));
        assert!(second_messages.iter().any(|message| {
            message["role"] == "user"
                && message["content"].as_str().is_some_and(|content| {
                    content.contains("[RUNTIME GUIDANCE — NOT USER CONTENT]")
                        && content.contains("<previous_tail>")
                })
        }));
    }

    #[test]
    fn cancellation_interrupts_an_active_stream_read() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let (request_started, request_received) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_mock_request(&mut stream);
            request_started.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(700));
        });
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut config = test_config(None);
        config.endpoint = endpoint;
        config.cancelled = Arc::clone(&cancelled);
        let (finished, done) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            run(config);
            finished.send(()).unwrap();
        });
        request_received
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        let cancelled_at = Instant::now();
        cancelled.store(true, Ordering::Relaxed);
        done.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(cancelled_at.elapsed() < Duration::from_millis(500));
        worker.join().unwrap();
        server.join().unwrap();
    }
}
