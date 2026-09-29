//! Transcript-first local agent loop.
//!
//! The runtime owns transport, capability safety, durable planning and bounded
//! recovery. It does not certify evidence, decide exploration coverage, or make
//! semantic completion decisions for the model.

use crate::agent::{
    events::{Event, TailCandidateAttempt},
    policy::{self, Reasoning, RunPolicy},
    state::AgentState,
    todo::GoalPlan,
    transcript::{validate_calls, CompactionPlan, Transcript, ValidatedCall},
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
/// A 32K run needs room for several productive tool turns after a handoff.
/// The target is deliberately below the 80% trigger and is evaluated against
/// the complete provider payload, including schemas and volatile state.
pub const DEFAULT_COMPACTION_TARGET_RATIO: f64 = 0.55;
pub const SAFETY_RESERVE_TOKENS: usize = 1_024;
pub const PREFERRED_OUTPUT_HEADROOM_TOKENS: usize = 1_024;
pub const MIN_USEFUL_OUTPUT_TOKENS: usize = 32;
pub const APPLICATION_MAX_OUTPUT_TOKENS: usize = 32_768;
pub const MAX_COMPACTION_ATTEMPTS: usize = 4;
pub const MAX_CONTINUATION_TURNS: usize = 32;
pub const MAX_LOGICAL_FINAL_CHARS: usize = 1_000_000;
pub const SUMMARY_INPUT_CHARS: usize = 48_000;
pub const SUMMARY_MAX_OUTPUT_TOKENS: usize = 1_024;
pub const MIN_SUMMARY_OUTPUT_TOKENS: usize = 64;
const MIN_CONTINUATION_OVERLAP_CHARS: usize = 32;
const MIN_FULL_RESTART_PREFIX_CHARS: usize = 96;
const MAX_CONTINUATION_OVERLAP_CHARS: usize = 24_000;
const SUMMARY_FIT_RESERVE_CHARS: usize = SUMMARY_MAX_OUTPUT_TOKENS * 3;
const TOOL_RESULT_TRUNCATION_MARKER: &str =
    "\n[… tool result projection truncated to fit the provider context …]\n";

const AGENT_GUIDANCE: &str = r#"
# Local AI Desktop Agent
- Work directly from the conversation and tool results. A tool-free response normally completes the run.
- For code changes, read before writing, make targeted changes, and run the most relevant practical validation or readback. Adapt after errors; do not invent checks.
- For read-only analysis, use tools for concrete evidence, avoid broad rereads, and synthesize when the active Todo has enough evidence.
- Project knowledge is persistent in `.ai-framework`. Its compact catalog is supplementary; retrieve a named document with project_knowledge_read when it is useful, and treat current source as authoritative.
- Do not call tools merely because they are available. Stop naturally when the requested work is complete.
"#;

const SUMMARY_GUIDANCE: &str = r#"Write one dense factual continuation brief for the same task. Preserve the user's goal and constraints; decisions; concrete findings with important files and their roles; meaningful commands and tool outcomes; completed work; the current active Todo direction; unresolved questions; and the next useful action. Distinguish verified facts from hypotheses. Do not repeat raw tool output, runtime mechanics, token counts, cache protocols, generic encouragement, or an activity log. Write only the continuation brief."#;

#[derive(Clone, Copy, Debug)]
pub struct CompactionBudget {
    pub context_window: usize,
    pub ratio: f64,
    /// Mirrors Jan: an explicit reserve overrides the ratio. Local normally
    /// uses the 80% ratio and separately computes a dynamic output ceiling.
    pub reserve_tokens: Option<usize>,
}

impl CompactionBudget {
    pub fn trigger_tokens(self) -> usize {
        let ratio = self.ratio.clamp(0.10, 0.99);
        let by_ratio = (self.context_window as f64 * ratio) as usize;
        self.reserve_tokens.map_or(by_ratio, |reserve| {
            self.context_window.saturating_sub(reserve)
        })
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

fn is_ollama_native_endpoint(endpoint: &str) -> bool {
    endpoint.trim_end_matches('/').ends_with("/api/chat")
}

fn ollama_native_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .cloned()
        .map(|mut message| {
            let Some(object) = message.as_object_mut() else {
                return message;
            };
            // Ollama's native tool protocol identifies historic results by
            // order/name and expects function arguments as JSON values rather
            // than OpenAI's JSON string convention.
            object.remove("tool_call_id");
            if object.get("role").and_then(Value::as_str) == Some("tool") {
                object.remove("name");
            }
            if let Some(calls) = object.get_mut("tool_calls").and_then(Value::as_array_mut) {
                for call in calls {
                    if let Some(call) = call.as_object_mut() {
                        call.remove("id");
                        call.remove("type");
                        let arguments = call
                            .get("function")
                            .and_then(|function| function.get("arguments"))
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        if let Some(arguments) = arguments {
                            if let Ok(parsed) = serde_json::from_str::<Value>(&arguments) {
                                if let Some(function) =
                                    call.get_mut("function").and_then(Value::as_object_mut)
                                {
                                    function.insert("arguments".into(), parsed);
                                }
                            }
                        }
                    }
                }
            }
            message
        })
        .collect()
}

fn ollama_native_think(config: &Config) -> Value {
    match policy::reasoning(&config.reasoning_mode, "agent") {
        Reasoning::Off => json!(false),
        Reasoning::Low => json!("low"),
        Reasoning::Deep => json!("high"),
    }
}

fn request_payload(
    config: &Config,
    messages: &[Value],
    schemas: &[Value],
    max_tokens: usize,
) -> Value {
    if is_ollama_native_endpoint(&config.endpoint) {
        return json!({
            "model": config.model,
            "messages": ollama_native_messages(messages),
            "stream": true,
            "tools": schemas,
            "think": ollama_native_think(config),
            "options": {"num_ctx": config.context_limit, "num_predict": max_tokens},
        });
    }
    let mut payload = json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
        "stream_options": {"include_usage": true},
        "max_tokens": max_tokens,
    });
    payload["tools"] = json!(schemas);
    payload["tool_choice"] = json!("auto");
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
    summary_tokens: usize,
    dynamic_tail_tokens: usize,
}

fn request_budget(config: &Config, messages: &[Value], schemas: &[Value]) -> RequestBudget {
    let payload = request_payload(config, messages, schemas, 0);
    let mut transcript = Vec::new();
    let mut summaries = Vec::new();
    let mut dynamic = Vec::new();
    for message in messages.iter().skip(1) {
        let content = message.get("content").and_then(Value::as_str).unwrap_or("");
        if content.starts_with("[COMPACTION SUMMARY]") {
            summaries.push(message.clone());
        } else if content.starts_with("[RUNTIME GUIDANCE — NOT USER CONTENT]")
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
        tool_schemas_tokens: estimate_tokens(&Value::Array(schemas.to_vec())),
        transcript_history_tokens: estimate_tokens(&Value::Array(transcript)),
        summary_tokens: estimate_tokens(&Value::Array(summaries)),
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

fn retained_tail_tokens(messages: &[Value]) -> usize {
    let retained = messages
        .iter()
        .skip(1)
        .filter(|message| {
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            !content.starts_with("[RUNTIME GUIDANCE — NOT USER CONTENT]")
                && !content.starts_with("[COMPACTION SUMMARY]")
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
        "Context budget cannot fit minimum useful output: context_window={}, projected_input_tokens_before_compaction={}, projected_input_tokens_after_compaction={}, stable_prefix_estimate_before={}, stable_prefix_estimate_after={}, tool_schemas_estimate_before={}, tool_schemas_estimate_after={}, transcript_history_estimate_before={}, transcript_history_estimate_after={}, summary_prompt_estimate_before={}, summary_prompt_estimate_after={}, dynamic_tail_estimate_before={}, dynamic_tail_estimate_after={}, safety_reserve={}, requested_max_output={}, dynamic_max_output={}, preferred_output_headroom={}, minimum_useful_output={}, compaction_summary_tokens={}, compaction_summary_chars={}, retained_tail_tokens={}, compaction_attempts={}",
        config.context_limit,
        before.projected_input_tokens,
        after.projected_input_tokens,
        before.stable_prefix_tokens,
        after.stable_prefix_tokens,
        before.tool_schemas_tokens,
        after.tool_schemas_tokens,
        before.transcript_history_tokens,
        after.transcript_history_tokens,
        before.summary_tokens,
        after.summary_tokens,
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

const EAGER_TODO_GUIDANCE: &str = "For substantial multi-step work, create one short Todo when useful. Keep it flat and high-level; begin useful investigation without waiting on planning.";
const TODO_UPKEEP_GUIDANCE: &str = "Todo is lightweight orientation, not a gate. When a meaningful subtask is complete, mark it done and attach one concise handoff memory if it preserves a finding or next action. Continue useful work even if Todo is slightly stale.";

fn is_multi_step_request(user: &str) -> bool {
    let lower = user.to_ascii_lowercase();
    user.chars().count() > 220
        || [
            "audit",
            "analy",
            "implement",
            "migrate",
            "review",
            "investigat",
            "architecture",
            "report",
            "multiple",
            "several",
            "then ",
            "phase",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn dynamic_tail(state: &AgentState, root: Option<&str>, eager_todo: bool) -> String {
    let mut tail = Vec::new();
    if eager_todo && state.plan.model_todo.is_empty() {
        tail.push(EAGER_TODO_GUIDANCE.to_owned());
    } else if !state.plan.model_todo.is_empty() {
        tail.push(format!(
            "<model_todo>\n{}\n</model_todo>\n{}",
            state.plan.model_todo.prompt(),
            TODO_UPKEEP_GUIDANCE,
        ));
    }
    let active = state
        .plan
        .model_todo
        .active()
        .map(|(_, item)| item.id.as_str());
    let memory = state.plan.task_memory.prompt(active);
    if !memory.is_empty() {
        tail.push(format!("<task_memory>\n{memory}\n</task_memory>"));
    }
    let knowledge = crate::tools::knowledge::prompt_catalog(root);
    if !knowledge.is_empty() {
        tail.push(knowledge);
    }
    tail.join("\n")
}

fn emit_knowledge_diagnostics(config: &Config, state: &AgentState) {
    let Some(root) = config.root.as_deref() else {
        return;
    };
    let index = crate::tools::knowledge::index(&PathBuf::from(root)).ok();
    let stats = index.as_ref().and_then(|value| value.get("stats"));
    let injected = crate::tools::knowledge::prompt_catalog(Some(root));
    emit(
        &config.run_id,
        Event::KnowledgeCache {
            exists: index.is_some(),
            manifest_version: index
                .as_ref()
                .and_then(|value| value.get("version"))
                .and_then(Value::as_u64)
                .map(|value| value as u32),
            total_files: stats
                .and_then(|value| value.get("totalFiles"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
            approximate_bytes: stats
                .and_then(|value| value.get("approximateBytes"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            knowledge_reads: state.knowledge_reads,
            knowledge_writes: state.knowledge_writes,
            cache_hits: state.knowledge_cache_hits,
            stale_source_entries: stats
                .and_then(|value| value.get("staleSourceEntries"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
            bytes_injected: injected.len(),
        },
    );
}

fn tool_schemas(has_project_root: bool) -> Vec<Value> {
    let mut tools = vec![
        json!({"type":"function","function":{"name":"todo","description":"Maintain a small flat working Todo. It is optional guidance, never a completion gate. `done` may include one compact memory handoff; the next pending item becomes active automatically.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["init","append","start","done","drop","view"]},"list":{"type":"array","description":"For init: [{items:[\"concise task\"]}]. Phase is accepted only for older clients and is UI-only.","items":{"type":"object","properties":{"phase":{"type":"string"},"items":{"type":"array","items":{"type":"string"}}},"required":["items"]}},"task":{"type":"string"},"phase":{"type":"string"},"content":{"type":"string"},"memory":{"type":"object","description":"Optional durable handoff when completing a Todo.","properties":{"finding":{"type":"string"},"evidence":{"type":"string"},"implication":{"type":"string"},"next":{"type":"string"}},"required":["finding"]}},"required":["action"]}}}),
        json!({"type":"function","function":{"name":"task_memory","description":"Record, correct, or invalidate a concise durable task finding. Use only for meaningful conclusions, decisions, blockers, or test outcomes; never after every read.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["record","update","invalidate","view"]},"id":{"type":"string"},"task":{"type":"string"},"finding":{"type":"string"},"evidence":{"type":"string"},"implication":{"type":"string"},"next":{"type":"string"},"supersedes":{"type":"string"}},"required":["action"]}}}),
    ];
    if has_project_root {
        tools.extend([
            json!({"type":"function","function":{"name":"apply_patch","description":"Apply a project patch.","parameters":{"type":"object","properties":{"patch":{"type":"string"}},"required":["patch"]}}}),
            json!({"type":"function","function":{"name":"create_file","description":"Create a new project file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}),
            json!({"type":"function","function":{"name":"delete_file","description":"Delete a project file when allowed.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}),
            json!({"type":"function","function":{"name":"list_directory","description":"List a project directory.","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}),
            json!({"type":"function","function":{"name":"read_file","description":"Read a project file. Use a line range only when it helps answer a specific question.","parameters":{"type":"object","properties":{"path":{"type":"string"},"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1}},"required":["path"]}}}),
            json!({"type":"function","function":{"name":"project_knowledge_index","description":"Read the small .ai-framework manifest index and source freshness map. Use it before repeating broad project orientation.","parameters":{"type":"object","properties":{}}}}),
            json!({"type":"function","function":{"name":"project_knowledge_read","description":"Read bounded semantic project knowledge from .ai-framework. Cached knowledge is supplementary; source files remain authoritative.","parameters":{"type":"object","properties":{"paths":{"type":"array","items":{"type":"string"}}},"required":["paths"]}}}),
            json!({"type":"function","function":{"name":"project_knowledge_update","description":"Optionally persist durable, reusable semantic project knowledge in .ai-framework. This is never required for normal work. Only use project/, modules/, sources/, or tasks/ markdown paths.","parameters":{"type":"object","properties":{"updates":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"},"mode":{"type":"string","enum":["replace","merge"]}},"required":["path","content"]}},"source_paths":{"type":"array","items":{"type":"string"}}},"required":["updates"]}}}),
            json!({"type":"function","function":{"name":"run_terminal","description":"Run an existing relevant project command. After code changes, prefer a focused test, typecheck, lint, build, or check when available.","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout_ms":{"type":"integer","minimum":1}},"required":["command"]}}}),
            json!({"type":"function","function":{"name":"write_file","description":"Write a project file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}),
        ]);
    }
    tools.sort_by(|left, right| tool_name(left).cmp(tool_name(right)));
    tools
}

/// A constrained/read-only run does not advertise mutations and therefore
/// cannot strand the model behind an approval-only capability. `todo` and
/// explicit knowledge reads remain available so analysis has a complete
/// working contract.
fn tool_schemas_for_policy(has_project_root: bool, policy: RunPolicy) -> Vec<Value> {
    let mut tools = tool_schemas(has_project_root);
    if policy == RunPolicy::Safe {
        tools.retain(|tool| {
            matches!(
                tool_name(tool),
                "todo"
                    | "task_memory"
                    | "read_file"
                    | "list_directory"
                    | "project_knowledge_index"
                    | "project_knowledge_read"
            )
        });
    }
    tools
}

fn tool_name(tool: &Value) -> &str {
    tool.pointer("/function/name")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn required_text(arguments: &Value, key: &str) -> Result<String, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("todo requires {key}"))
}

fn todo_init_phases(arguments: &Value) -> Result<Vec<(String, Vec<String>)>, String> {
    let list = arguments
        .get("list")
        .and_then(Value::as_array)
        .ok_or_else(|| "todo init requires list".to_owned())?;
    list.iter()
        .map(|phase| {
            let name = phase
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or("Work")
                .to_owned();
            let items = phase
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| "each Todo phase requires items".to_owned())?
                .iter()
                .map(|item| {
                    item.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| "Todo items must be strings".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok((name, items))
        })
        .collect()
}

fn apply_todo(state: &mut AgentState, arguments: &Value) -> Result<(Value, bool), String> {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| "todo requires action".to_owned())?;
    if action == "view" {
        return Ok((
            json!({"todo": state.plan.model_todo, "updated": false}),
            false,
        ));
    }
    match action {
        "init" => state.plan.model_todo.init(todo_init_phases(arguments)?)?,
        "append" => state.plan.model_todo.append(
            arguments.get("phase").and_then(Value::as_str),
            required_text(arguments, "content")?,
        )?,
        "start" => state
            .plan
            .model_todo
            .start(&required_text(arguments, "task")?)?,
        "done" => {
            let task = required_text(arguments, "task")?;
            let todo_id = state.plan.model_todo.id_for(&task);
            state.plan.model_todo.finish(&task, false)?;
            if let Some(memory) = arguments.get("memory") {
                let memory_id = write_task_memory(&mut state.plan, memory, todo_id)?;
                state.plan.model_todo.attach_memory(&task, memory_id)?;
            }
        }
        "drop" => state
            .plan
            .model_todo
            .finish(&required_text(arguments, "task")?, true)?,
        _ => return Err("unsupported todo action".into()),
    }
    state.plan.sync_from_model_todo();
    Ok((
        json!({"todo": state.plan.model_todo, "updated": true}),
        true,
    ))
}

fn write_task_memory(
    plan: &mut GoalPlan,
    value: &Value,
    todo_id: Option<String>,
) -> Result<String, String> {
    let finding = value
        .get("finding")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let evidence = value
        .get("evidence")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let implication = value
        .get("implication")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let next = value
        .get("next")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    plan.task_memory.upsert(
        value.get("id").and_then(Value::as_str),
        finding,
        evidence,
        implication,
        next,
        todo_id,
        value
            .get("supersedes")
            .and_then(Value::as_str)
            .map(str::to_owned),
    )
}

fn apply_task_memory(state: &mut AgentState, arguments: &Value) -> Result<(Value, bool), String> {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("record");
    if action == "view" {
        return Ok((
            json!({"task_memory": state.plan.task_memory, "updated": false}),
            false,
        ));
    }
    if action == "invalidate" {
        state
            .plan
            .task_memory
            .invalidate(required_text(arguments, "id")?.as_str())?;
    } else if action == "record" || action == "update" {
        let todo_id = arguments
            .get("task")
            .and_then(Value::as_str)
            .and_then(|task| state.plan.model_todo.id_for(task));
        write_task_memory(&mut state.plan, arguments, todo_id)?;
    } else {
        return Err("unsupported task_memory action".into());
    }
    Ok((
        json!({"task_memory": state.plan.task_memory, "updated": true}),
        true,
    ))
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

fn continuation_reminder(content: &str) -> String {
    format!(
        "Continue immediately after the exact ending below. Do not restart, repeat headings, summarize, or reproduce earlier text. If more investigation is needed, use the available tools normally.\n<previous_tail>\n{}\n</previous_tail>",
        continuation_tail(content)
    )
}

fn append_final_text(accumulator: &mut String, delta: &str) {
    accumulator.push_str(delta);
}

#[derive(Default)]
struct NormalizedText {
    chars: Vec<char>,
    byte_ends: Vec<usize>,
}

fn normalize_for_overlap(text: &str) -> NormalizedText {
    let mut normalized = NormalizedText::default();
    for (index, ch) in text.char_indices() {
        if ch.is_whitespace() {
            if normalized.chars.last() != Some(&' ') && !normalized.chars.is_empty() {
                normalized.chars.push(' ');
                normalized.byte_ends.push(index + ch.len_utf8());
            }
        } else {
            normalized.chars.push(ch);
            normalized.byte_ends.push(index + ch.len_utf8());
        }
    }
    if normalized.chars.last() == Some(&' ') {
        normalized.chars.pop();
        normalized.byte_ends.pop();
    }
    normalized
}

fn longest_prefix_suffix_overlap(prefix: &[char], text: &[char], limit: usize) -> usize {
    let pattern = prefix.iter().take(limit).copied().collect::<Vec<_>>();
    if pattern.is_empty() {
        return 0;
    }
    let mut failure = vec![0; pattern.len()];
    for index in 1..pattern.len() {
        let mut matched = failure[index - 1];
        while matched > 0 && pattern[index] != pattern[matched] {
            matched = failure[matched - 1];
        }
        if pattern[index] == pattern[matched] {
            matched += 1;
        }
        failure[index] = matched;
    }

    let start = text.len().saturating_sub(limit);
    let mut matched = 0;
    for ch in &text[start..] {
        while matched > 0 && (matched == pattern.len() || *ch != pattern[matched]) {
            matched = failure[matched - 1];
        }
        if *ch == pattern[matched] {
            matched += 1;
        }
    }
    matched
}

fn longest_common_prefix(left: &[char], right: &[char], limit: usize) -> usize {
    left.iter()
        .zip(right)
        .take(limit)
        .take_while(|(left, right)| left == right)
        .count()
}

fn repeated_heading_prefix(existing: &str, continuation: &str) -> Option<usize> {
    let previous_heading = existing
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())?
        .trim();
    let first_line_end = continuation.find('\n').unwrap_or(continuation.len());
    let first_line = continuation[..first_line_end].trim();
    if previous_heading.starts_with('#')
        && first_line == previous_heading
        && first_line.starts_with('#')
    {
        Some(if first_line_end < continuation.len() {
            first_line_end + 1
        } else {
            first_line_end
        })
    } else {
        None
    }
}

fn continuation_text_to_append(existing: &str, continuation: &str) -> String {
    if existing.is_empty() || continuation.is_empty() {
        return continuation.to_owned();
    }
    if let Some(overlap) = repeated_heading_prefix(existing, continuation) {
        return continuation[overlap..].to_owned();
    }

    let existing_normalized = normalize_for_overlap(existing);
    let continuation_normalized = normalize_for_overlap(continuation);
    let restart_overlap = longest_common_prefix(
        &existing_normalized.chars,
        &continuation_normalized.chars,
        MAX_CONTINUATION_OVERLAP_CHARS,
    );
    let suffix_overlap = longest_prefix_suffix_overlap(
        &continuation_normalized.chars,
        &existing_normalized.chars,
        MAX_CONTINUATION_OVERLAP_CHARS,
    );

    let is_restart = restart_overlap >= MIN_FULL_RESTART_PREFIX_CHARS;
    let overlap = if is_restart {
        restart_overlap
    } else if suffix_overlap >= MIN_CONTINUATION_OVERLAP_CHARS {
        suffix_overlap
    } else {
        return continuation.to_owned();
    };
    let mut end = continuation_normalized
        .byte_ends
        .get(overlap.saturating_sub(1))
        .copied();
    if is_restart {
        end = end.and_then(|end| continuation[..end].rfind('\n').map(|line_end| line_end + 1));
    }
    end.map_or_else(
        || continuation.to_owned(),
        |end| continuation[end..].to_owned(),
    )
}

fn append_continuation_text(accumulator: &mut String, continuation: &str) -> String {
    let accepted = continuation_text_to_append(accumulator, continuation);
    accumulator.push_str(&accepted);
    accepted
}

fn needs_compaction(budget: CompactionBudget, projected_input_tokens: usize) -> bool {
    projected_input_tokens > budget.trigger_tokens()
}

fn compaction_target_tokens(context_window: usize) -> usize {
    ((context_window as f64 * DEFAULT_COMPACTION_TARGET_RATIO) as usize)
        .max(SAFETY_RESERVE_TOKENS + MIN_USEFUL_OUTPUT_TOKENS)
}

fn retry_keep_recent(attempt: usize) -> usize {
    // Jan's reactive retry sequence is 8 -> 4 -> 2. Do not silently reduce
    // the retained structural tail to one message during ordinary recovery.
    (DEFAULT_KEEP_RECENT >> attempt).max(2)
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
    let native_ollama = is_ollama_native_endpoint(endpoint);
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
            consume_transport_buffer(&mut buffer, &mut turn, run_id, emit_visible, native_ollama)?;
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
            consume_transport_buffer(&mut buffer, &mut turn, run_id, emit_visible, native_ollama)?;
        }
    }
    // Some OpenAI-compatible local servers close the connection immediately
    // after the final data frame without a trailing blank event separator.
    // Treat that final complete frame as SSE rather than silently losing its
    // usage or finish reason.
    if !buffer.trim().is_empty() {
        if native_ollama {
            if !buffer.ends_with('\n') {
                buffer.push('\n');
            }
        } else if buffer.ends_with('\n') {
            buffer.push('\n');
        } else {
            buffer.push_str("\n\n");
        }
        consume_transport_buffer(&mut buffer, &mut turn, run_id, emit_visible, native_ollama)?;
    }
    Ok(turn)
}

fn consume_transport_buffer(
    buffer: &mut String,
    turn: &mut StreamedTurn,
    run_id: &str,
    emit_visible: bool,
    native_ollama: bool,
) -> Result<(), String> {
    if native_ollama {
        consume_ollama_ndjson(buffer, turn, run_id, emit_visible)
    } else {
        consume_sse(buffer, turn, run_id, emit_visible)
    }
}

fn consume_ollama_ndjson(
    buffer: &mut String,
    turn: &mut StreamedTurn,
    run_id: &str,
    emit_visible: bool,
) -> Result<(), String> {
    while let Some(end) = buffer.find('\n') {
        let line = buffer[..end].trim().to_owned();
        buffer.drain(..end + 1);
        if line.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&line)
            .map_err(|error| format!("invalid Ollama NDJSON: {error}"))?;
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            return Err(format!("Ollama error: {error}"));
        }
        turn.prompt_tokens = value
            .get("prompt_eval_count")
            .and_then(Value::as_u64)
            .or(turn.prompt_tokens);
        turn.completion_tokens = value
            .get("eval_count")
            .and_then(Value::as_u64)
            .or(turn.completion_tokens);
        if let Some(reasoning) = value.pointer("/message/thinking").and_then(Value::as_str) {
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
        if let Some(content) = value.pointer("/message/content").and_then(Value::as_str) {
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
        if let Some(calls) = value
            .pointer("/message/tool_calls")
            .and_then(Value::as_array)
        {
            for (index, call) in calls.iter().enumerate() {
                let entry = turn.calls.entry(index).or_insert_with(|| {
                    // Native Ollama tool calls do not carry an OpenAI call id.
                    // The id is persisted by the Electron bridge, so it must be
                    // stable for streaming updates and unique across Agent runs.
                    json!({"id":format!("ollama-{run_id}-{index}"),"type":"function","function":{"name":"","arguments":""}})
                });
                if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                    entry["function"]["name"] = json!(name);
                }
                if let Some(arguments) = call.pointer("/function/arguments") {
                    let encoded = if let Some(arguments) = arguments.as_str() {
                        arguments.to_owned()
                    } else {
                        arguments.to_string()
                    };
                    entry["function"]["arguments"] = json!(encoded);
                }
            }
        }
        if value.get("done").and_then(Value::as_bool) == Some(true) {
            turn.finish_reason = value
                .get("done_reason")
                .and_then(Value::as_str)
                .unwrap_or("stop")
                .to_owned();
        }
    }
    Ok(())
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

struct SummaryResult {
    text: String,
    input_tokens: usize,
    output_tokens: usize,
}

fn summarize_span(config: &Config, plan: &CompactionPlan) -> SummaryResult {
    // Summary generation is also a provider turn. Keep its input small enough
    // to leave meaningful output headroom on the selected local context size.
    let summary_input_chars = SUMMARY_INPUT_CHARS.min(
        config
            .context_limit
            .saturating_sub(SAFETY_RESERVE_TOKENS + MIN_SUMMARY_OUTPUT_TOKENS)
            .saturating_mul(2),
    );
    // Compaction has one responsibility: construct a factual handoff. Todo
    // and Task Memory are independent runtime state and are never repeatedly
    // rewritten by a summary model.
    let summary_source = summary_source(plan, summary_input_chars);
    if summary_source.trim().is_empty() {
        return SummaryResult {
            text: "Earlier conversation was omitted to fit the selected context window.".into(),
            input_tokens: 0,
            output_tokens: 0,
        };
    }
    let messages = vec![
        json!({"role":"system", "content": SUMMARY_GUIDANCE}),
        json!({"role":"user", "content": summary_source}),
    ];
    let input_tokens = estimate_tokens(&Value::Array(messages.clone()));
    let max_tokens = dynamic_output_limit(
        config.context_limit,
        estimate_tokens(&Value::Array(messages.clone())),
        SAFETY_RESERVE_TOKENS,
        config.provider_max_output,
        SUMMARY_MAX_OUTPUT_TOKENS,
    );
    if max_tokens < MIN_SUMMARY_OUTPUT_TOKENS {
        return SummaryResult {
            text: "Earlier conversation was compacted; the current prompt contains the usable summary and retained recent transcript.".into(),
            input_tokens,
            output_tokens: 0,
        };
    }
    let payload = json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
        "max_tokens": max_tokens,
    });
    match stream_call(&config.endpoint, &payload, &config.run_id, &config.cancelled, false) {
        Ok(turn) if !turn.content.trim().is_empty() => {
            let text = turn.content.trim().to_owned();
            SummaryResult {
                output_tokens: turn
                    .completion_tokens
                    .map_or_else(|| estimate_tokens(&json!(text)), |tokens| tokens as usize),
                text,
                input_tokens,
            }
        }
        _ => SummaryResult {
            text: "Earlier conversation was compacted; the current prompt contains the usable summary and retained recent transcript.".into(),
            input_tokens,
            output_tokens: 0,
        },
    }
}

fn summary_source(plan: &CompactionPlan, max_chars: usize) -> String {
    plan.render(max_chars)
}

struct CompactionReport {
    before: RequestBudget,
    after: RequestBudget,
    messages: Vec<Value>,
    boundary_event_index: usize,
    events_summarized: usize,
    events_retained: usize,
    messages_summarized: usize,
    messages_retained: usize,
    estimated_retained_tokens: usize,
    summary_input_tokens: usize,
    summary_output_tokens: usize,
    summary_output_chars: usize,
    preferred_tail_messages: usize,
    selected_tail_messages: usize,
    tail_candidate_attempts: Vec<TailCandidateAttempt>,
    emergency_tool_result_truncation: Option<EmergencyToolResultTruncation>,
}

#[derive(Debug)]
struct EmergencyToolResultTruncation {
    original_tokens: usize,
    original_chars: usize,
    projected_tokens: usize,
    projected_chars: usize,
    source: Option<String>,
}

fn emit_compaction_diagnostics(
    config: &Config,
    state: &AgentState,
    compaction_index: usize,
    trigger_reason: &str,
    report: &CompactionReport,
) {
    let available_before = dynamic_output_limit(
        config.context_limit,
        report.before.projected_input_tokens,
        SAFETY_RESERVE_TOKENS,
        config.provider_max_output,
        APPLICATION_MAX_OUTPUT_TOKENS,
    );
    let available_after = dynamic_output_limit(
        config.context_limit,
        report.after.projected_input_tokens,
        SAFETY_RESERVE_TOKENS,
        config.provider_max_output,
        APPLICATION_MAX_OUTPUT_TOKENS,
    );
    emit(
        &config.run_id,
        Event::CompactionDiagnostics {
            compaction_index,
            trigger_reason: trigger_reason.to_owned(),
            context_window: config.context_limit,
            projected_input_before: report.before.projected_input_tokens,
            projected_input_after: report.after.projected_input_tokens,
            stable_prefix_tokens: report.after.stable_prefix_tokens,
            tool_schema_tokens: report.after.tool_schemas_tokens,
            transcript_tokens_before: report.before.transcript_history_tokens,
            summary_prompt_tokens: report.after.summary_tokens,
            runtime_tail_tokens: report.after.dynamic_tail_tokens,
            model_todo_tokens: estimate_tokens(&json!(state.plan.model_todo.prompt())),
            memory_catalog_tokens: estimate_tokens(&json!(
                crate::tools::knowledge::prompt_catalog(config.root.as_deref())
            )),
            compaction_target_tokens: compaction_target_tokens(config.context_limit),
            preferred_output_tokens: PREFERRED_OUTPUT_HEADROOM_TOKENS,
            available_output_before: available_before,
            available_output_after: available_after,
            selected_max_output_tokens: available_after,
            boundary_event_index: report.boundary_event_index,
            events_summarized: report.events_summarized,
            events_retained: report.events_retained,
            messages_summarized: report.messages_summarized,
            messages_retained: report.messages_retained,
            estimated_retained_tokens: report.estimated_retained_tokens,
            summary_input_tokens: report.summary_input_tokens,
            summary_output_tokens: report.summary_output_tokens,
            summary_output_chars: report.summary_output_chars,
            preferred_tail_messages: report.preferred_tail_messages,
            selected_tail_messages: report.selected_tail_messages,
            tail_candidate_attempts: report.tail_candidate_attempts.clone(),
            emergency_tool_result_truncation: report.emergency_tool_result_truncation.is_some(),
            emergency_tool_result_original_tokens: report
                .emergency_tool_result_truncation
                .as_ref()
                .map(|entry| entry.original_tokens),
            emergency_tool_result_original_chars: report
                .emergency_tool_result_truncation
                .as_ref()
                .map(|entry| entry.original_chars),
            emergency_tool_result_projected_tokens: report
                .emergency_tool_result_truncation
                .as_ref()
                .map(|entry| entry.projected_tokens),
            emergency_tool_result_projected_chars: report
                .emergency_tool_result_truncation
                .as_ref()
                .map(|entry| entry.projected_chars),
            emergency_tool_result_source: report
                .emergency_tool_result_truncation
                .as_ref()
                .and_then(|entry| entry.source.clone()),
            active_todo: state.plan.model_todo.active_label().map(str::to_owned),
        },
    );
}

fn compact_once(
    config: &Config,
    transcript: &mut Transcript,
    schemas: &[Value],
    before: usize,
    keep_recent: usize,
    reason: &str,
    dynamic_tail: &str,
) -> Option<CompactionReport> {
    let (plan, tail_candidate_attempts) =
        select_fit_aware_compaction_plan(config, transcript, schemas, keep_recent, dynamic_tail)?;
    let covers = plan.covers;
    let before_budget = request_budget(
        config,
        &project(transcript, &stable_prefix(config), dynamic_tail),
        schemas,
    );
    let entries_before = transcript.entries().len();
    let messages_summarized = plan.message_count();
    let messages_retained = plan.retained_message_count();
    let summary = summarize_span(config, &plan);
    let summary_output_chars = summary.text.chars().count();
    transcript.compact(summary.text, covers);
    let mut messages = project(transcript, &stable_prefix(config), dynamic_tail);
    let emergency_tool_result_truncation =
        truncate_retained_tool_result_to_fit(config, schemas, &mut messages);
    let after_budget = request_budget(config, &messages, schemas);
    let after = after_budget.projected_input_tokens;
    let estimated_retained_tokens = retained_tail_tokens(&messages);
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
    Some(CompactionReport {
        before: before_budget,
        after: after_budget,
        messages,
        boundary_event_index: covers,
        events_summarized: covers,
        events_retained: entries_before.saturating_sub(covers),
        messages_summarized,
        messages_retained,
        estimated_retained_tokens,
        summary_input_tokens: summary.input_tokens,
        summary_output_tokens: summary.output_tokens,
        summary_output_chars,
        preferred_tail_messages: keep_recent,
        selected_tail_messages: plan.retained_message_count(),
        tail_candidate_attempts,
        emergency_tool_result_truncation,
    })
}

/// Select a structural tail before the one semantic compaction call. The
/// candidate must fit a real 32K low-water target, not merely leave one token
/// of output. A giant structural pair remains valid and is projection-truncated
/// only as the final physical-safety fallback.
fn select_fit_aware_compaction_plan(
    config: &Config,
    transcript: &Transcript,
    schemas: &[Value],
    preferred_keep_recent: usize,
    dynamic_tail: &str,
) -> Option<(CompactionPlan, Vec<TailCandidateAttempt>)> {
    let candidates = (1..=preferred_keep_recent.max(1)).rev().collect::<Vec<_>>();
    let mut attempts = Vec::new();
    let mut smallest_plan = None;

    for keep_recent in candidates {
        let Some(plan) = transcript.compaction_plan(keep_recent) else {
            continue;
        };
        let mut projected_transcript = transcript.clone();
        projected_transcript.compact(summary_fit_reserve(), plan.covers);
        let messages = project(&projected_transcript, &stable_prefix(config), dynamic_tail);
        let budget = request_budget(config, &messages, schemas);
        let fits = budget.projected_input_tokens <= compaction_target_tokens(config.context_limit);
        attempts.push(TailCandidateAttempt {
            message_count: plan.retained_message_count(),
            estimated_tokens: retained_tail_tokens(&messages),
            projected_request_tokens: budget.projected_input_tokens,
            fits,
        });
        if fits {
            return Some((plan, attempts));
        }
        smallest_plan = Some(plan);
    }
    // A giant single tool result can make even the smallest valid structural
    // tail fail. Keep the canonical pair intact, summarize once, then reduce
    // only its provider projection as a last-resort compatibility measure.
    smallest_plan.map(|plan| (plan, attempts))
}

fn summary_fit_reserve() -> String {
    // The actual summary is normally much smaller, but selection must leave
    // room for the configured summary ceiling without issuing trial summaries.
    "s".repeat(SUMMARY_FIT_RESERVE_CHARS)
}

fn truncate_retained_tool_result_to_fit(
    config: &Config,
    schemas: &[Value],
    messages: &mut [Value],
) -> Option<EmergencyToolResultTruncation> {
    let usable_input = config
        .context_limit
        .saturating_sub(SAFETY_RESERVE_TOKENS + MIN_USEFUL_OUTPUT_TOKENS);
    let initial = request_budget(config, messages, schemas);
    if initial.projected_input_tokens <= usable_input {
        return None;
    }

    let (index, original) = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| message.get("role").and_then(Value::as_str) == Some("tool"))
        .filter_map(|(index, message)| {
            message
                .get("content")
                .and_then(Value::as_str)
                .map(|content| (index, content.to_owned()))
        })
        .max_by_key(|(_, content)| content.chars().count())?;
    let original_chars = original.chars().count();
    let original_tokens = estimate_tokens(&json!(original));
    // Choose the largest head+tail projection that fits the full request,
    // rather than applying a blanket cap or guessing from character counts.
    let mut low = 0_usize;
    let mut high = original_chars;
    let mut best = None;
    while low <= high {
        let middle = low + (high - low) / 2;
        let candidate = truncate_tool_result_content(&original, middle);
        messages[index]["content"] = Value::String(candidate.clone());
        if request_budget(config, messages, schemas).projected_input_tokens <= usable_input {
            best = Some(candidate);
            low = middle.saturating_add(1);
        } else if middle == 0 {
            break;
        } else {
            high = middle - 1;
        }
    }
    let projected = best.unwrap_or_else(|| truncate_tool_result_content(&original, 0));
    messages[index]["content"] = Value::String(projected.clone());

    let projected_chars = projected.chars().count();
    let projected_tokens = estimate_tokens(&json!(projected));
    let source = tool_result_source(&original);
    Some(EmergencyToolResultTruncation {
        original_tokens,
        original_chars,
        projected_tokens,
        projected_chars,
        source,
    })
}

fn truncate_tool_result_content(content: &str, target_chars: usize) -> String {
    if content.chars().count() <= target_chars {
        return content.to_owned();
    }
    let marker_chars = TOOL_RESULT_TRUNCATION_MARKER.chars().count();
    if target_chars <= marker_chars {
        return TOOL_RESULT_TRUNCATION_MARKER.to_owned();
    }
    let preserved = target_chars.saturating_sub(marker_chars);
    let head = preserved / 2;
    let tail = preserved.saturating_sub(head);
    let chars = content.chars().collect::<Vec<_>>();
    format!(
        "{}{}{}",
        chars[..head].iter().collect::<String>(),
        TOOL_RESULT_TRUNCATION_MARKER,
        chars[chars.len().saturating_sub(tail)..]
            .iter()
            .collect::<String>()
    )
}

fn tool_result_source(content: &str) -> Option<String> {
    serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|value| {
            value
                .get("path")
                .or_else(|| value.pointer("/data/path"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
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
        "project_knowledge_index" => {
            let root = config
                .root
                .as_ref()
                .ok_or_else(|| "no project scope".to_owned())?;
            let value = crate::tools::knowledge::index(&PathBuf::from(root))?;
            state.record_knowledge_read();
            emit_knowledge_diagnostics(config, state);
            Ok((value, None))
        }
        "project_knowledge_read" => {
            let root = config
                .root
                .as_ref()
                .ok_or_else(|| "no project scope".to_owned())?;
            let revision = crate::tools::knowledge::revision(&PathBuf::from(root));
            if let Some(path) = tool
                .arguments
                .get("paths")
                .and_then(Value::as_array)
                .and_then(|paths| paths.first())
                .and_then(Value::as_str)
            {
                if state.knowledge_missing_paths.get(path) == Some(&revision) {
                    return Ok((
                        json!({"entries":[{"status":"missing","stillMissing":true,"path":path,"cacheRevision":revision,"message":"This knowledge document is still missing. Do not retry alternate path spellings; continue source research or wait for cache revision change."}]}),
                        None,
                    ));
                }
            }
            let value = crate::tools::knowledge::read(&PathBuf::from(root), &tool.arguments)?;
            if let Some(entries) = value.get("entries").and_then(Value::as_array) {
                for entry in entries {
                    if entry.get("status").and_then(Value::as_str) == Some("missing") {
                        if let Some(path) = entry.get("path").and_then(Value::as_str) {
                            state
                                .knowledge_missing_paths
                                .insert(path.to_owned(), revision);
                        }
                    }
                }
            }
            state.record_knowledge_read();
            emit_knowledge_diagnostics(config, state);
            Ok((value, None))
        }
        "project_knowledge_update" => {
            let root = config
                .root
                .as_ref()
                .ok_or_else(|| "no project scope".to_owned())?;
            let value = crate::tools::knowledge::update(&PathBuf::from(root), &tool.arguments)?;
            state.record_knowledge_write();
            emit_knowledge_diagnostics(config, state);
            Ok((value, None))
        }
        "todo" => {
            let (value, changed) = apply_todo(state, &tool.arguments)?;
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
        "task_memory" => {
            let (value, changed) = apply_task_memory(state, &tool.arguments)?;
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
            if matches!(name, "read_file" | "list_directory") {
                let active = state.plan.model_todo.active_label();
                let _ = crate::tools::knowledge::observe_tool(
                    &PathBuf::from(root),
                    &config.run_id,
                    &config.user,
                    None,
                    active,
                    name,
                    &tool.arguments,
                    &result.0,
                );
            }
            if mutation_tool(name) {
                state.record_mutation();
            }
            Ok(result)
        }
    }
}

fn safe_read_only_tool(name: &str) -> bool {
    matches!(
        name,
        "read_file" | "list_directory" | "project_knowledge_index" | "project_knowledge_read"
    )
}

/// Executes only deterministic inspection tools. Runtime-owned observation
/// writes and diagnostics are deliberately applied after the concurrent reads
/// complete, in original call order.
fn run_safe_read_tool(
    config: &Config,
    tool: &ValidatedCall,
) -> Result<(Value, Option<String>), String> {
    let root = config
        .root
        .as_ref()
        .ok_or_else(|| "no project scope".to_owned())?;
    match tool.name.as_str() {
        "project_knowledge_index" => {
            crate::tools::knowledge::index(&PathBuf::from(root)).map(|value| (value, None))
        }
        "project_knowledge_read" => {
            crate::tools::knowledge::read(&PathBuf::from(root), &tool.arguments)
                .map(|value| (value, None))
        }
        "read_file" | "list_directory" => {
            crate::tools::filesystem::execute(&PathBuf::from(root), &tool.name, &tool.arguments)
        }
        _ => Err(format!("{} is not a safe read-only tool", tool.name)),
    }
}

fn record_safe_read_effect(
    config: &Config,
    state: &mut AgentState,
    tool: &ValidatedCall,
    value: &Value,
) {
    match tool.name.as_str() {
        "project_knowledge_index" | "project_knowledge_read" => {
            if tool.name == "project_knowledge_read" {
                if let Some(root) = config.root.as_deref() {
                    let revision = crate::tools::knowledge::revision(&PathBuf::from(root));
                    for entry in value
                        .get("entries")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if entry.get("status").and_then(Value::as_str) == Some("missing") {
                            if let Some(path) = entry.get("path").and_then(Value::as_str) {
                                state
                                    .knowledge_missing_paths
                                    .insert(path.to_owned(), revision);
                            }
                        }
                    }
                }
            }
            state.record_knowledge_read();
            emit_knowledge_diagnostics(config, state);
        }
        "read_file" | "list_directory" => {
            if let Some(root) = config.root.as_deref() {
                let active = state.plan.model_todo.active_label();
                let _ = crate::tools::knowledge::observe_tool(
                    &PathBuf::from(root),
                    &config.run_id,
                    &config.user,
                    None,
                    active,
                    &tool.name,
                    &tool.arguments,
                    value,
                );
                emit_knowledge_diagnostics(config, state);
            }
        }
        _ => {}
    }
}

fn concise_tool_error(message: &str) -> String {
    let trimmed = message.trim();
    let bounded = trimmed.chars().take(1_200).collect::<String>();
    json!({"error":bounded}).to_string()
}

fn add_soft_closeout_if_needed(state: &mut AgentState, transcript: &mut Transcript) -> bool {
    let needs_validation = state.workspace_mutated_since_validation && !state.verification_nudged;
    if !needs_validation {
        return false;
    }
    if needs_validation {
        state.verification_nudged = true;
        transcript.remind("You changed project files but no meaningful validation has been observed since the latest mutation. Run the most relevant available check, or state why validation is unavailable. Inspect the diff when practical.".into());
    }
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
    state.plan.ensure_model_todo();
    if let Some(root) = config.root.as_deref() {
        let _ = crate::tools::knowledge::bootstrap(&PathBuf::from(root));
    }
    let budget = CompactionBudget {
        context_window: config.context_limit,
        ratio: DEFAULT_COMPACTION_RATIO,
        reserve_tokens: None,
    };
    let stable = stable_prefix(&config);
    let schemas = tool_schemas_for_policy(config.root.is_some(), config.policy);
    let mut final_content = String::new();
    let mut continuation_count = 0_usize;
    let mut continuation_pending = false;
    let mut overflow_attempts = 0_usize;
    let mut compaction_index = 0_usize;
    let mut last_compaction: Option<(usize, usize)> = None;
    let mut tool_result_tokens_since_compaction = 0_usize;
    // An emergency tool-result reduction belongs only to the next provider
    // projection. The append-only transcript remains verbatim.
    let mut pending_fitted_projection: Option<Vec<Value>> = None;

    emit(
        &config.run_id,
        Event::AgentStarted {
            run_id: config.run_id.clone(),
        },
    );
    emit_knowledge_diagnostics(&config, &state);
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
        let eager_todo =
            turn == 0 && state.plan.model_todo.is_empty() && is_multi_step_request(&config.user);
        let dynamic = dynamic_tail(&state, config.root.as_deref(), eager_todo);
        let pending_tail = transcript.pending_tail(&dynamic);
        let sent_tail = if transcript.has_active_prompt_tail(&pending_tail) {
            String::new()
        } else {
            pending_tail
        };
        let mut messages = pending_fitted_projection
            .take()
            .unwrap_or_else(|| project(&transcript, &stable, &sent_tail));
        let before_budget = request_budget(&config, &messages, &schemas);
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
        let should_compact = needs_compaction(budget, current_budget.projected_input_tokens);
        let mut compaction_attempts = 0;
        if should_compact {
            // Jan preflights once, then sends the request. Local's dynamic
            // output budget handles a smaller useful answer without using it
            // as a reason to discard additional transcript.
            let current_dynamic = sent_tail.as_str();
            if let Some(report) = compact_once(
                &config,
                &mut transcript,
                &schemas,
                current_budget.projected_input_tokens,
                DEFAULT_KEEP_RECENT,
                "proactive_threshold",
                current_dynamic,
            ) {
                let fitted_messages = report.messages.clone();
                if let Some((previous_after, previous_turn)) = last_compaction {
                    let new_turns = turn.saturating_sub(previous_turn);
                    if new_turns <= 3 {
                        emit(
                            &config.run_id,
                            Event::RapidRecompaction {
                                previous_after_tokens: previous_after,
                                current_before_tokens: report.before.projected_input_tokens,
                                new_turns,
                                new_tool_result_tokens: tool_result_tokens_since_compaction,
                            },
                        );
                    }
                }
                compaction_index += 1;
                emit_compaction_diagnostics(
                    &config,
                    &state,
                    compaction_index,
                    "proactive_threshold",
                    &report,
                );
                last_compaction = Some((report.after.projected_input_tokens, turn));
                tool_result_tokens_since_compaction = 0;
                compaction_attempts += 1;
                messages = fitted_messages;
                current_budget = report.after;
                output_limit = dynamic_output_limit(
                    config.context_limit,
                    current_budget.projected_input_tokens,
                    SAFETY_RESERVE_TOKENS,
                    config.provider_max_output,
                    APPLICATION_MAX_OUTPUT_TOKENS,
                );
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
        let mut payload = request_payload(&config, &messages, &schemas, output_limit);
        if eager_todo {
            payload["tool_choice"] = json!({"type":"function","function":{"name":"todo"}});
        }
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
                phase: "agent".into(),
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

        let mut streamed = match stream_call(
            &config.endpoint,
            &payload,
            &config.run_id,
            &config.cancelled,
            !continuation_pending,
        ) {
            Ok(streamed) => {
                overflow_attempts = 0;
                if !sent_tail.is_empty() {
                    transcript.record_prompt_tail(&sent_tail);
                }
                transcript.clear_reminders();
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
                let keep = retry_keep_recent(overflow_attempts.saturating_sub(1));
                let Some(report) = compact_once(
                    &config,
                    &mut transcript,
                    &schemas,
                    before,
                    keep,
                    "context_overflow_retry",
                    &sent_tail,
                ) else {
                    emit(
                        &config.run_id,
                        Event::AgentError {
                            code: "context_overflow".into(),
                            message: error,
                        },
                    );
                    return;
                };
                if let Some((previous_after, previous_turn)) = last_compaction {
                    let new_turns = turn.saturating_sub(previous_turn);
                    if new_turns <= 3 {
                        emit(
                            &config.run_id,
                            Event::RapidRecompaction {
                                previous_after_tokens: previous_after,
                                current_before_tokens: report.before.projected_input_tokens,
                                new_turns,
                                new_tool_result_tokens: tool_result_tokens_since_compaction,
                            },
                        );
                    }
                }
                compaction_index += 1;
                emit_compaction_diagnostics(
                    &config,
                    &state,
                    compaction_index,
                    "context_overflow_retry",
                    &report,
                );
                last_compaction = Some((report.after.projected_input_tokens, turn));
                tool_result_tokens_since_compaction = 0;
                pending_fitted_projection = Some(report.messages);
                {
                    if continuation_pending {
                        transcript.remind(continuation_reminder(&final_content));
                    }
                    continue;
                }
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
        let was_continuation = continuation_pending;
        if was_continuation {
            let accepted = append_continuation_text(&mut final_content, &streamed.content);
            streamed.content = accepted.clone();
            if !accepted.is_empty() {
                emit(&config.run_id, Event::ContentDelta { content: accepted });
            }
            continuation_pending = false;
        }
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
        if calls.is_empty() {
            if streamed.finish_reason == "length" {
                if !was_continuation {
                    append_final_text(&mut final_content, &streamed.content);
                }
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
                continuation_pending = true;
                transcript.remind(continuation_reminder(&final_content));
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
            if !was_continuation {
                append_final_text(&mut final_content, &streamed.content);
            }
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
        let mut call_index = 0_usize;
        while call_index < calls.len() {
            if safe_read_only_tool(&calls[call_index].name)
                && schemas
                    .iter()
                    .any(|schema| tool_name(schema) == calls[call_index].name)
            {
                let start = call_index;
                while call_index < calls.len()
                    && safe_read_only_tool(&calls[call_index].name)
                    && schemas
                        .iter()
                        .any(|schema| tool_name(schema) == calls[call_index].name)
                {
                    call_index += 1;
                }
                let batch = &calls[start..call_index];
                for tool in batch {
                    emit(
                        &config.run_id,
                        Event::ToolCallStarted {
                            id: tool.id.clone(),
                            name: tool.name.clone(),
                            arguments: tool.arguments.clone(),
                        },
                    );
                }
                // Jan runs independent auto-allowed reads concurrently. Join in
                // call order so transcript pairing and visible tool cards stay
                // deterministic even when filesystem work finishes out of order.
                let results = std::thread::scope(|scope| {
                    let handles = batch
                        .iter()
                        .map(|tool| scope.spawn(|| run_safe_read_tool(&config, tool)))
                        .collect::<Vec<_>>();
                    handles
                        .into_iter()
                        .map(|handle| {
                            handle
                                .join()
                                .unwrap_or_else(|_| Err("read-only tool worker panicked".into()))
                        })
                        .collect::<Vec<_>>()
                });
                for (tool, result) in batch.iter().zip(results) {
                    if config.cancelled.load(Ordering::Relaxed) {
                        transcript.tool_result(
                            &tool.id,
                            &tool.name,
                            concise_tool_error("generation cancelled"),
                        );
                        continue;
                    }
                    match result {
                        Ok((value, diff)) => {
                            record_safe_read_effect(&config, &mut state, tool, &value);
                            let content = value.to_string();
                            tool_result_tokens_since_compaction =
                                tool_result_tokens_since_compaction
                                    .saturating_add(estimate_tokens(&json!(content)));
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
                            transcript.tool_result(
                                &tool.id,
                                &tool.name,
                                concise_tool_error(&message),
                            );
                        }
                    }
                }
                continue;
            }

            let tool = &calls[call_index];
            call_index += 1;
            emit(
                &config.run_id,
                Event::ToolCallStarted {
                    id: tool.id.clone(),
                    name: tool.name.clone(),
                    arguments: tool.arguments.clone(),
                },
            );
            if config.cancelled.load(Ordering::Relaxed) {
                transcript.tool_result(
                    &tool.id,
                    &tool.name,
                    concise_tool_error("generation cancelled"),
                );
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
                transcript.tool_result(&tool.id, &tool.name, concise_tool_error(&message));
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
                transcript.tool_result(
                    &tool.id,
                    &tool.name,
                    concise_tool_error("approval required"),
                );
                continue;
            }
            emit(
                &config.run_id,
                Event::RunState {
                    state: "working".into(),
                },
            );
            match run_tool(&config, &mut state, tool) {
                Ok((value, diff)) => {
                    let content = value.to_string();
                    tool_result_tokens_since_compaction = tool_result_tokens_since_compaction
                        .saturating_add(estimate_tokens(&json!(content)));
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
                    transcript.tool_result(&tool.id, &tool.name, concise_tool_error(&message));
                }
            }
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
            vec!["task_memory", "todo"]
        );
    }

    #[test]
    fn safe_policy_advertises_a_complete_read_only_tool_contract() {
        let schemas = tool_schemas_for_policy(true, RunPolicy::Safe);
        let names = schemas.iter().map(tool_name).collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "list_directory",
                "project_knowledge_index",
                "project_knowledge_read",
                "read_file",
                "task_memory",
                "todo",
            ]
        );
    }

    #[test]
    fn todo_is_canonical_and_promotes_the_next_item_into_the_ui_adapter() {
        let mut state = AgentState::default();
        let (_, changed) = apply_todo(
            &mut state,
            &json!({
                "action":"init",
                "list":[
                    {"phase":"Research","items":["Understand project orientation", "Analyze product flow"]},
                    {"phase":"Synthesis","items":["Produce final report"]}
                ]
            }),
        )
        .unwrap();
        assert!(changed);
        assert_eq!(
            state.plan.model_todo.active_label(),
            Some("Understand project orientation")
        );
        assert_eq!(state.plan.milestones.len(), 1);
        apply_todo(
            &mut state,
            &json!({"action":"done","task":"Understand project orientation"}),
        )
        .unwrap();
        assert_eq!(
            state.plan.model_todo.active_label(),
            Some("Analyze product flow")
        );
        assert_eq!(
            state.plan.milestones[0].work_plan.tasks[0].status,
            crate::agent::todo::Status::Completed
        );
        assert_eq!(
            state.plan.milestones[0].work_plan.tasks[1].status,
            crate::agent::todo::Status::InProgress
        );
    }

    #[test]
    fn todo_snapshot_drives_plan_update_without_exposing_ui_schema_to_the_model() {
        let mut state = AgentState::default();
        apply_todo(&mut state, &json!({"action":"init","list":[{"phase":"Audit","items":["Inspect runtime", "Write report"]}]})).unwrap();
        let emitted = serde_json::to_value(Event::PlanUpdate {
            plan: serde_json::to_value(&state.plan).unwrap(),
        })
        .unwrap();
        assert_eq!(emitted["type"], "plan_update");
        let tail = dynamic_tail(&state, None, false);
        assert!(tail.contains("[active] todo-1: Inspect runtime"));
        assert!(!tail.contains("milestones"));
        assert!(!tail.contains("work_plan"));
    }

    #[test]
    fn todo_schema_and_stable_prefix_are_compact_and_explicit() {
        let schema = tool_schemas(false)
            .into_iter()
            .find(|tool| tool_name(tool) == "todo")
            .unwrap();
        let description = schema
            .pointer("/function/description")
            .unwrap()
            .as_str()
            .unwrap();
        assert!(description.contains("small flat working Todo"));
        assert!(description.contains("next pending item becomes active"));
        assert_eq!(
            schema.pointer("/function/parameters/required"),
            Some(&json!(["action"]))
        );
        let config = test_config(Some("/project"));
        assert_eq!(stable_prefix(&config), stable_prefix(&config));
        assert!(!stable_prefix(&config).contains("model_todo"));
    }

    #[test]
    fn completed_todo_handoff_survives_multiple_compactions_without_reinvestigation() {
        let mut state = AgentState::default();
        apply_todo(&mut state, &json!({"action":"init","list":[{"items":["Investigate GLM context bug", "Implement GLM context fix"]}]})).unwrap();
        apply_todo(&mut state, &json!({"action":"done","task":"Investigate GLM context bug","memory":{"finding":"summarize_span auxiliary Ollama request omits options.num_ctx","evidence":"rust-agent/src/agent/loop_runtime.rs summarize_span","implication":"auxiliary generation can reload model-native context","next":"patch request path and add regression test"}})).unwrap();
        assert_eq!(
            state.plan.model_todo.active_label(),
            Some("Implement GLM context fix")
        );
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"user","content":"Investigate the GLM bug"}));
        transcript.push_message(
            json!({"role":"assistant","content":"raw exploration that may be discarded"}),
        );
        transcript
            .push_message(json!({"role":"assistant","content":"recent implementation handoff"}));
        let plan = transcript.compaction_plan(1).unwrap();
        transcript.compact("compact factual location only".into(), plan.covers);
        transcript.compact("later compact factual location only".into(), 0);
        let tail = dynamic_tail(&state, None, false);
        assert!(tail.contains("[done] todo-1: Investigate GLM context bug -> tm-001"));
        assert!(tail.contains("[active] todo-2: Implement GLM context fix"));
        assert!(tail.contains("summarize_span auxiliary Ollama request omits options.num_ctx"));
        assert_eq!(state.plan.task_memory.entries.len(), 1);
    }

    #[test]
    fn task_memory_can_supersede_a_wrong_finding() {
        let mut state = AgentState::default();
        apply_task_memory(
            &mut state,
            &json!({"action":"record","finding":"old conclusion"}),
        )
        .unwrap();
        apply_task_memory(
            &mut state,
            &json!({"action":"record","finding":"correct conclusion","supersedes":"tm-001"}),
        )
        .unwrap();
        let prompt = state.plan.task_memory.prompt(None);
        assert!(!prompt.contains("old conclusion"));
        assert!(prompt.contains("correct conclusion"));
    }

    #[test]
    fn automatic_project_knowledge_is_a_catalog_not_materialized_document_bodies() {
        let root = unique_temp_root("knowledge-catalog");
        fs::create_dir_all(&root).unwrap();
        crate::tools::knowledge::bootstrap(&root).unwrap();
        crate::tools::knowledge::update(
            &root,
            &json!({"updates":[{"path":"project/overview.md","content":"SENTINEL_RAW_OVERVIEW_BODY","mode":"replace"}]}),
        )
        .unwrap();
        let state = AgentState::default();
        let tail = dynamic_tail(&state, root.to_str(), false);
        assert!(tail.contains("project_knowledge_catalog"));
        assert!(tail.contains("project overview"));
        assert!(!tail.contains("SENTINEL_RAW_OVERVIEW_BODY"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn safe_read_classification_excludes_mutations_and_terminal_work() {
        for name in [
            "read_file",
            "list_directory",
            "project_knowledge_index",
            "project_knowledge_read",
        ] {
            assert!(safe_read_only_tool(name), "{name}");
        }
        for name in [
            "write_file",
            "apply_patch",
            "delete_file",
            "run_terminal",
            "todo",
        ] {
            assert!(!safe_read_only_tool(name), "{name}");
        }
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
            summary_tokens: 0,
            dynamic_tail_tokens: 300,
        };
        let after = RequestBudget {
            projected_input_tokens: 32_000,
            stable_prefix_tokens: 500,
            tool_schemas_tokens: 1_200,
            transcript_history_tokens: 30_000,
            summary_tokens: 128,
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
            "summary_prompt_estimate_after=128",
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
    fn summary_is_bounded_by_provider_max_tokens_without_a_second_char_truncation() {
        assert_eq!(SUMMARY_MAX_OUTPUT_TOKENS, 1_024);
        assert!(MIN_SUMMARY_OUTPUT_TOKENS <= SUMMARY_MAX_OUTPUT_TOKENS);
    }

    #[test]
    fn jan_style_summary_source_is_the_dropped_transcript_only() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({
            "role":"user",
            "content":"Audit routing and report concrete findings."
        }));
        transcript.push_message(json!({
            "role":"assistant",
            "content":"App.tsx uses BrowserRouter and renders PurchaseToast, AppRoutes, and ScrollToTopButton. Routes.tsx uses LangGate plus ProductShell and routes product/:id, products-page, confirm, and legal pages."
        }));
        transcript.push_message(json!({"role":"assistant","content":"Keep the next investigation focused on the API boundary."}));
        let plan = transcript.compaction_plan(1).unwrap();
        let source = summary_source(&plan, SUMMARY_INPUT_CHARS);
        assert!(SUMMARY_GUIDANCE.contains("factual continuation brief"));
        assert!(!SUMMARY_GUIDANCE.contains("project_knowledge_updates"));
        assert!(source.contains("App.tsx uses BrowserRouter"));
        assert!(source.contains("Routes.tsx uses LangGate"));
    }

    #[test]
    fn mocked_compaction_returns_a_semantic_handoff_not_an_activity_log() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_mock_request(&mut stream);
            let source = request["messages"][1]["content"].as_str().unwrap();
            assert!(source.contains("App.tsx uses BrowserRouter"));
            assert!(source.contains("Routes.tsx uses LangGate"));
            let response = json!({"choices":[{"delta":{"content":"App.tsx uses BrowserRouter and renders PurchaseToast, AppRoutes, and ScrollToTopButton. Routes.tsx composes LangGate with ProductShell and defines product/:id, products-page, confirm, and legal routes. These are verified source findings; finish checking api.php and robots.txt."},"finish_reason":"stop"}]});
            stream
                .write_all(sse_response(&[response]).as_bytes())
                .unwrap();
        });
        let mut config = test_config(None);
        config.endpoint = endpoint;
        let mut plan = GoalPlan::default();
        plan.init(vec!["Audit routing".into(), "Inspect API and SEO".into()])
            .unwrap();
        plan.init_work(vec!["Trace route composition".into()])
            .unwrap();
        let mut transcript = Transcript::default();
        transcript.push_message(
            json!({"role":"user","content":"Audit route architecture and endpoints."}),
        );
        transcript.push_message(json!({"role":"assistant","content":"App.tsx uses BrowserRouter and renders PurchaseToast, AppRoutes, and ScrollToTopButton."}));
        transcript.push_message(json!({"role":"assistant","content":"Routes.tsx uses LangGate plus ProductShell and defines product/:id and legal routes."}));
        transcript.push_message(
            json!({"role":"assistant","content":"Need inspect api.php, .htaccess, robots.txt."}),
        );
        let compaction_plan = transcript.compaction_plan(1).unwrap();
        let summary = summarize_span(&config, &compaction_plan);
        transcript.compact(summary.text, compaction_plan.covers);
        let projected = project(
            &transcript,
            &stable_prefix(&config),
            &dynamic_tail(
                &AgentState {
                    plan,
                    ..AgentState::default()
                },
                None,
                false,
            ),
        );
        let summary_message = projected
            .iter()
            .find(|message| {
                message["content"]
                    .as_str()
                    .is_some_and(|content| content.starts_with("[COMPACTION SUMMARY]"))
            })
            .unwrap();
        let handoff = summary_message["content"].as_str().unwrap();
        assert!(handoff.contains("App.tsx uses BrowserRouter"));
        assert!(handoff.contains("product/:id"));
        assert!(handoff.contains("verified source findings"));
        server.join().unwrap();
    }

    #[test]
    fn continuation_appends_exact_next_text_without_modification() {
        let mut final_text = String::from("Earlier findings end here.");
        let accepted = append_continuation_text(&mut final_text, " Next finding starts here.");
        assert_eq!(accepted, " Next finding starts here.");
        assert_eq!(
            final_text,
            "Earlier findings end here. Next finding starts here."
        );
    }

    #[test]
    fn continuation_strips_substantial_suffix_overlap_once() {
        let repeated = "Verified finding from the route audit. ".repeat(5);
        let mut final_text = format!("Earlier text. {repeated}");
        let continuation = format!("{repeated}New finding.");
        let accepted = append_continuation_text(&mut final_text, &continuation);
        assert_eq!(accepted, " New finding.");
        assert!(final_text.ends_with("New finding."));
        assert_eq!(final_text.matches("Verified finding").count(), 5);
    }

    #[test]
    fn continuation_strips_a_restart_from_the_answer_beginning() {
        let beginning = "## 1. Scope\n".to_owned() + &"Concrete route finding.\n".repeat(12);
        let already_emitted = format!("{beginning}## 7. Summary\nPartial ending.");
        let restarted = format!("{beginning}## 2. API findings\nAdditional details.");
        assert_eq!(
            continuation_text_to_append(&already_emitted, &restarted),
            "## 2. API findings\nAdditional details."
        );
    }

    #[test]
    fn continuation_strips_a_repeated_markdown_heading_only() {
        let existing = "Prior section details.\n## 7. Architecture\n";
        assert_eq!(
            continuation_text_to_append(existing, "## 7. Architecture\nNew details."),
            "New details."
        );
    }

    #[test]
    fn continuation_without_overlap_is_preserved() {
        let existing = "Earlier answer about routing.";
        let new = "A distinct database finding.";
        assert_eq!(continuation_text_to_append(existing, new), new);
    }

    #[test]
    fn multiple_continuations_form_one_deduplicated_final_string() {
        let first = "Opening. ".to_owned() + &"Repeated audit phrase. ".repeat(5);
        let second_novel = "Second continuation adds verified details.";
        let third_novel = "Third continuation closes the report.";
        let repeated_second = format!(
            "{}{}",
            first
                .chars()
                .rev()
                .take(80)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>(),
            second_novel
        );
        let mut final_text = first;
        let accepted_second = append_continuation_text(&mut final_text, &repeated_second);
        let repeated_third = format!("{second_novel}{third_novel}");
        let accepted_third = append_continuation_text(&mut final_text, &repeated_third);
        assert!(accepted_second.contains(second_novel));
        assert_eq!(accepted_third, third_novel);
        assert_eq!(final_text.matches(second_novel).count(), 1);
        assert_eq!(final_text.matches(third_novel).count(), 1);
    }

    #[test]
    fn low_remaining_context_compacts_before_a_tiny_output_budget() {
        let budget = CompactionBudget {
            context_window: 16_384,
            ratio: DEFAULT_COMPACTION_RATIO,
            reserve_tokens: None,
        };
        assert!(needs_compaction(budget, 14_500));
        assert!(!needs_compaction(budget, 4_000));
    }

    #[test]
    fn jan_retry_tail_policy_is_eight_then_four_then_two() {
        assert_eq!(retry_keep_recent(0), 8);
        assert_eq!(retry_keep_recent(1), 4);
        assert_eq!(retry_keep_recent(2), 2);
        assert_eq!(retry_keep_recent(3), 2);
        assert_eq!(retry_keep_recent(MAX_COMPACTION_ATTEMPTS), 2);
    }

    fn fit_selection_fixture(
        large_tail_messages: usize,
        large_chars: usize,
    ) -> (Config, Transcript, Vec<Value>, String) {
        let mut config = test_config(None);
        config.context_limit = 32_768;
        // These approximate the real failure's stable prefix, schemas, and
        // dynamic tail without depending on a provider or real files.
        config.system = "s".repeat(900);
        let schemas = vec![json!({"type":"function","description":"t".repeat(1_000)})];
        let dynamic = "d".repeat(2_000);
        let mut transcript = Transcript::default();
        for index in 0..8 {
            transcript
                .push_message(json!({"role":"assistant","content":format!("old finding {index}")}));
        }
        for index in 0..large_tail_messages {
            transcript.push_message(json!({
                "role":"assistant",
                "content": format!("large finding {index}: {}", "x".repeat(large_chars)),
            }));
        }
        transcript.push_run_user(json!({"role":"user","content":"continue the audit"}));
        (config, transcript, schemas, dynamic)
    }

    #[test]
    fn preflight_tail_selection_retries_eight_four_two_before_summary() {
        let (config, transcript, schemas, dynamic) = fit_selection_fixture(8, 20_000);
        let (plan, attempts) = select_fit_aware_compaction_plan(
            &config,
            &transcript,
            &schemas,
            DEFAULT_KEEP_RECENT,
            &dynamic,
        )
        .unwrap();

        assert!(attempts[0].estimated_tokens >= 46_000);
        assert_eq!(attempts[0].message_count, 8);
        assert!(!attempts[0].fits);
        assert!(attempts.len() > 1);
        assert!(plan.retained_message_count() <= 4);
        let mut compacted = transcript.clone();
        compacted.compact("verified handoff".into(), plan.covers);
        let post_compaction = request_budget(
            &config,
            &project(&compacted, &stable_prefix(&config), &dynamic),
            &schemas,
        );
        assert!(
            post_compaction.projected_input_tokens
                <= compaction_target_tokens(config.context_limit)
        );
    }

    #[test]
    fn fit_selection_keeps_eight_when_it_fits() {
        let (config, transcript, schemas, dynamic) = fit_selection_fixture(1, 20_000);
        let (plan, attempts) = select_fit_aware_compaction_plan(
            &config,
            &transcript,
            &schemas,
            DEFAULT_KEEP_RECENT,
            &dynamic,
        )
        .unwrap();
        assert_eq!(attempts.len(), 1);
        assert!(attempts[0].fits);
        assert_eq!(plan.retained_message_count(), 8);
    }

    #[test]
    fn fit_selection_uses_two_when_eight_and_four_do_not_fit() {
        let (config, transcript, schemas, dynamic) = fit_selection_fixture(8, 35_000);
        let (plan, attempts) = select_fit_aware_compaction_plan(
            &config,
            &transcript,
            &schemas,
            DEFAULT_KEEP_RECENT,
            &dynamic,
        )
        .unwrap();
        assert_eq!(attempts[0].message_count, 8);
        assert!(!attempts[0].fits);
        assert!(attempts.len() > 1);
        assert!(plan.retained_message_count() <= 2);
    }

    #[test]
    fn real_failure_sized_preflight_selects_smaller_tail_and_dispatches() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_mock_request(&mut stream);
                let is_summary =
                    request["messages"][0]["content"]
                        .as_str()
                        .is_some_and(|content| {
                            content.contains("Write one dense factual continuation brief")
                        });
                let response = if is_summary {
                    json!({"choices":[{"delta":{"content":"Verified earlier findings."},"finish_reason":"stop"}]})
                } else {
                    json!({"choices":[{"delta":{"content":"Continue with the fitted request."},"finish_reason":"stop"}]})
                };
                requests.push(request);
                stream
                    .write_all(sse_response(&[response]).as_bytes())
                    .unwrap();
            }
            requests
        });
        let (mut config, transcript, _schemas, _dynamic) = fit_selection_fixture(8, 20_000);
        config.endpoint = endpoint;
        config.user = "continue the audit".into();
        config.history = transcript
            .entries()
            .iter()
            .filter_map(|entry| match entry {
                crate::agent::transcript::Entry::Message(message) => Some(message.clone()),
                _ => None,
            })
            .collect();

        run(config);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        let agent = requests
            .iter()
            .find(|request| {
                request["messages"][0]["content"]
                    .as_str()
                    .is_some_and(|content| content.starts_with("s"))
            })
            .expect("a model request is dispatched after the one summary request");
        assert!(agent["max_tokens"].as_u64().unwrap() >= MIN_USEFUL_OUTPUT_TOKENS as u64);
        assert_eq!(
            agent["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] == "user"
                    && message["content"] == "continue the audit")
                .count(),
            1
        );
    }

    #[test]
    fn giant_retained_tool_result_is_truncated_only_in_projection() {
        let mut config = test_config(None);
        config.context_limit = 32_768;
        let schemas = tool_schemas(true);
        let giant = json!({"path":"src/giant.rs","content":"z".repeat(140_000)}).to_string();
        let mut messages = vec![
            json!({"role":"system","content":stable_prefix(&config)}),
            json!({"role":"assistant","content":"I will inspect the file.","tool_calls":[{"id":"read-1","type":"function","function":{"name":"read_file","arguments":"{\\\"path\\\":\\\"src/giant.rs\\\"}"}}]}),
            json!({"role":"tool","tool_call_id":"read-1","name":"read_file","content":giant}),
            json!({"role":"user","content":"continue"}),
        ];
        let canonical = messages.clone();
        let diagnostic = truncate_retained_tool_result_to_fit(&config, &schemas, &mut messages)
            .expect("the giant retained result needs an emergency projection");
        assert_eq!(messages[1], canonical[1]);
        assert_eq!(messages[2]["tool_call_id"], "read-1");
        assert_ne!(messages[2]["content"], canonical[2]["content"]);
        assert!(messages[2]["content"]
            .as_str()
            .unwrap()
            .contains("tool result projection truncated"));
        assert_eq!(diagnostic.source.as_deref(), Some("src/giant.rs"));
        assert!(
            request_budget(&config, &messages, &schemas).projected_input_tokens
                <= config.context_limit - SAFETY_RESERVE_TOKENS - MIN_USEFUL_OUTPUT_TOKENS
        );
        // The caller owns the canonical transcript; its value was never edited.
        assert!(canonical[2]["content"]
            .as_str()
            .unwrap()
            .contains("src/giant.rs"));
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
            let boundary = transcript.compaction_plan(keep_recent).unwrap().covers;
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
        assert_eq!(retained, vec![8, 4, 2, 2]);
    }

    #[test]
    fn structural_eight_message_compaction_leaves_32k_room_for_multiple_turns() {
        let mut config = test_config(Some("/project"));
        config.context_limit = 32_768;
        let schemas = tool_schemas(true);
        let stable = stable_prefix(&config);
        let mut transcript = Transcript::default();
        let large_turn = "source detail ".repeat(480);
        for turn in 0..10 {
            transcript.push_message(
                json!({"role":"user","content":format!("request {turn}: {large_turn}")}),
            );
            transcript.push_message(
                json!({"role":"assistant","content":format!("finding {turn}: {large_turn}")}),
            );
        }
        transcript.push_run_user(json!({"role":"user","content":"current audit request"}));
        let budget = CompactionBudget {
            context_window: config.context_limit,
            ratio: DEFAULT_COMPACTION_RATIO,
            reserve_tokens: None,
        };
        let before = request_budget(&config, &project(&transcript, &stable, ""), &schemas);
        assert!(needs_compaction(budget, before.projected_input_tokens));

        let plan = transcript.compaction_plan(DEFAULT_KEEP_RECENT).unwrap();
        transcript.compact("dense verified handoff ".repeat(300), plan.covers);
        let after = request_budget(&config, &project(&transcript, &stable, ""), &schemas);
        assert!(
            after.projected_input_tokens < budget.trigger_tokens(),
            "after={} trigger={}",
            after.projected_input_tokens,
            budget.trigger_tokens()
        );

        for turn in 0..4 {
            transcript.push_message(json!({"role":"assistant","content":format!("new analysis {turn}: {}", "detail ".repeat(100))}));
            transcript.push_message(json!({"role":"tool","tool_call_id":format!("t-{turn}"),"name":"read_file","content":"new file result ".repeat(100)}));
        }
        let later = request_budget(&config, &project(&transcript, &stable, ""), &schemas);
        assert!(
            !needs_compaction(budget, later.projected_input_tokens),
            "several ordinary post-compaction turns should fit: later={} trigger={}",
            later.projected_input_tokens,
            budget.trigger_tokens()
        );
    }

    #[test]
    fn long_32k_transcript_compacts_once_then_leaves_room_for_the_next_request() {
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
                            content.contains("Write one dense factual continuation brief")
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
        let long_turn = "transcript detail ".repeat(400);
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
                        content.contains("Write one dense factual continuation brief")
                    })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary_requests.len(),
            1,
            "Jan preflights once before dispatch"
        );
        assert!(
            summary_requests[0]["max_tokens"].as_u64().unwrap() <= SUMMARY_MAX_OUTPUT_TOKENS as u64
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
    fn compaction_preserves_agent_tool_capabilities_on_the_next_request() {
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
                            content.contains("Write one dense factual continuation brief")
                        });
                let response = if requests.is_empty() {
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"large-read","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"large.txt\"}"}}]},"finish_reason":"tool_calls"}]})
                } else if is_summary {
                    json!({"choices":[{"delta":{"content":"Preserve prior findings and active task."},"finish_reason":"stop"}]})
                } else {
                    json!({"choices":[{"delta":{"content":"Continuing with tools available."},"finish_reason":"stop"}]})
                };
                requests.push(request);
                stream
                    .write_all(sse_response(&[response]).as_bytes())
                    .unwrap();
                if !requests.is_empty() && !is_summary && requests.len() > 1 {
                    return requests;
                }
            }
        });
        let root = unique_temp_root("post-compaction-tools");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("large.txt"),
            "verified source result ".repeat(1_600),
        )
        .unwrap();
        let mut config = test_config(Some(root.to_str().unwrap()));
        config.endpoint = endpoint;
        config.context_limit = 32_768;
        config.history = (0..12)
            .map(|index| {
                json!({
                    "role": if index % 2 == 0 {"user"} else {"assistant"},
                    "content": format!("prior turn {index}")
                })
            })
            .collect();
        config
            .history
            .push(json!({"role":"user","content":"x".repeat(72_000)}));
        let initial_transcript = {
            let mut transcript = Transcript::default();
            for message in config.history.clone() {
                transcript.push_message(message);
            }
            transcript.push_run_user(json!({"role":"user","content":config.user}));
            transcript
        };
        let initial_messages = project(&initial_transcript, &stable_prefix(&config), "");
        let initial_budget =
            request_budget(&config, &initial_messages, &tool_schemas(true)).projected_input_tokens;
        assert!(initial_budget < 32_768 * 80 / 100);
        assert!(
            dynamic_output_limit(
                config.context_limit,
                initial_budget,
                SAFETY_RESERVE_TOKENS,
                config.provider_max_output,
                APPLICATION_MAX_OUTPUT_TOKENS
            ) >= PREFERRED_OUTPUT_HEADROOM_TOKENS
        );

        run(config);
        let requests = server.join().unwrap();
        let agent_requests = requests
            .iter()
            .filter(|request| {
                request["messages"][0]["content"]
                    .as_str()
                    .is_some_and(|content| content.starts_with("base system"))
            })
            .collect::<Vec<_>>();
        assert!(agent_requests.len() >= 2);
        assert!(requests.iter().any(|request| {
            request["messages"][0]["content"]
                .as_str()
                .is_some_and(|content| {
                    content.contains("Write one dense factual continuation brief")
                })
        }));
        let first_agent = agent_requests[0];
        let after_compaction = agent_requests.last().unwrap();
        assert_eq!(first_agent["tools"], after_compaction["tools"]);
        assert_eq!(agent_requests[0]["tool_choice"], "auto");
        assert_eq!(after_compaction["tool_choice"], "auto");
        let names = after_compaction["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(tool_name)
            .collect::<Vec<_>>();
        assert!(names.contains(&"read_file"));
        assert!(names.contains(&"run_terminal"));
        assert!(names.contains(&"todo"));
        assert!(after_compaction["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|message| message["role"].as_str())
            .enumerate()
            .all(|(index, role)| role != "system" || index <= 1));
        assert!(after_compaction["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|message| message["content"].as_str())
            .all(|content| !content.contains("Do not call tools")));
        assert!(requests.iter().any(|request| {
            request["messages"].as_array().is_some_and(|messages| {
                messages.iter().any(|message| {
                    message["role"] == "tool" && message["tool_call_id"] == "large-read"
                })
            })
        }));
        fs::remove_dir_all(root).unwrap();
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
            request_budget(&config, &messages, &tool_schemas(false)).projected_input_tokens;
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
        let boundary = transcript.compaction_plan(1).unwrap().covers;
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
    fn completed_todo_allows_final_and_follow_up_without_bookkeeping() {
        let mut state = AgentState::default();
        apply_todo(
            &mut state,
            &json!({"action":"init","list":[{"items":["Investigate", "Implement", "Verify"]}]}),
        )
        .unwrap();
        apply_todo(&mut state, &json!({"action":"done","task":"Investigate","memory":{"finding":"confirmed root cause"}})).unwrap();
        apply_todo(&mut state, &json!({"action":"done","task":"Implement"})).unwrap();
        apply_todo(&mut state, &json!({"action":"done","task":"Verify"})).unwrap();
        assert!(!state.plan.model_todo.has_open());
        let mut transcript = Transcript::default();
        // This is the branch taken for a normal tool-free final answer. A
        // completed Todo and existing handoff must not turn it into another
        // planning turn; a simple follow-up uses the same no-gate path.
        assert!(!add_soft_closeout_if_needed(&mut state, &mut transcript));
        assert!(!add_soft_closeout_if_needed(&mut state, &mut transcript));
        assert_eq!(
            state.plan.task_memory.entries[0].finding,
            "confirmed root cause"
        );
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
    fn continuation_is_deduplicated_and_has_a_bounded_tail() {
        let mut final_text = String::from("first part ");
        append_final_text(&mut final_text, "second part");
        assert_eq!(final_text, "first part second part");
        let long = "x".repeat(13_000);
        assert_eq!(continuation_tail(&long).chars().count(), 12_000);
        assert_eq!(
            request_payload(
                &test_config(Some("/project")),
                &[],
                &tool_schemas(true),
                1_000
            )["tools"]
                .as_array()
                .unwrap()
                .len(),
            tool_schemas(true).len()
        );
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
    fn length_continuation_keeps_one_logical_response_and_preserves_tools() {
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
        assert_eq!(requests[1]["tools"], requests[0]["tools"]);
        assert_eq!(requests[1]["tool_choice"], "auto");
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
