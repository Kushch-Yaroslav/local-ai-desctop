//! Transcript-first local agent loop.
//!
//! The runtime owns transport, capability safety, durable planning and bounded
//! recovery. It does not certify evidence, decide exploration coverage, or make
//! semantic completion decisions for the model.

use crate::agent::{
    events::{Event, TailCandidateAttempt},
    policy::{self, Reasoning, RunPolicy},
    state::AgentState,
    transcript::{validate_calls, CompactionPlan, Transcript, ValidatedCall},
};
use crate::context::projection::project;
use crate::protocol::emit;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::OpenOptions;
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
    pub task_memory: Option<Value>,
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
- For substantial tasks, reason about an approach before acting, adapt as you learn, use tools for concrete evidence, avoid broad rereads, and continue until the user's task is complete.
- Respond and narrate visible reasoning/progress in the user's language. Keep code, identifiers, paths, commands, APIs, and quoted source in their original language.
- Task Memory = durable semantic continuity for this task. Record meaningful findings, decisions, blockers, and next actions. After compaction, trust a precise Task Memory finding from an unchanged inspected file; reread only for a missing fact, ambiguity, possible change, exact detail, or targeted verification.
- Project Knowledge = reusable observations already derived from this project. Use relevant fresh knowledge before broad rereading; source remains authoritative when exact current code or an unresolved detail is needed. It is project-level; Task Memory is task-level.
- After compaction: use the continuation brief, Task Memory, then relevant Project Knowledge; read source only for genuinely new or verification-specific information.
- Do not call tools merely because they are available. Stop naturally when the requested work is complete.
"#;

const SUMMARY_GUIDANCE: &str = r#"Write one dense factual continuation brief for the same task. Preserve the user's goal and constraints; decisions; concrete findings with important files and their roles; meaningful commands and tool outcomes; completed work; the current focus or line of investigation; meaningful unresolved work or questions; blockers or approval-required operations; relevant Task Memory references; relevant Project Knowledge availability; and the next useful action. Distinguish verified facts from hypotheses. Do not repeat raw tool output, runtime mechanics, token counts, cache protocols, generic encouragement, or an activity log. Write only the continuation brief."#;

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

fn dynamic_tail(state: &AgentState, root: Option<&str>) -> String {
    let mut tail = Vec::new();
    let memory = state.task_memory.prompt();
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
        json!({"type":"function","function":{"name":"task_memory","description":"Durable semantic memory for the current task across compaction. Record/update meaningful findings, decisions, blockers, or unresolved questions; view reads it; invalidate needs id. Record/update requires finding and may include evidence, implication, next, id, supersedes. Trust precise unchanged-file memory; reread only for a concrete missing, ambiguous, changed, exact-detail, or verification need.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["record","update","invalidate","view"]},"id":{"type":"string"},"finding":{"type":"string"},"evidence":{"type":"string"},"implication":{"type":"string"},"next":{"type":"string"},"supersedes":{"type":"string"}},"required":["action"]}}}),
    ];
    if has_project_root {
        tools.extend([
            json!({"type":"function","function":{"name":"apply_patch","description":"Apply a project patch.","parameters":{"type":"object","properties":{"patch":{"type":"string"}},"required":["patch"]}}}),
            json!({"type":"function","function":{"name":"create_file","description":"Create a new project file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}),
            json!({"type":"function","function":{"name":"delete_file","description":"Delete a project file when allowed.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}),
            json!({"type":"function","function":{"name":"list_directory","description":"List a project directory.","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}),
            json!({"type":"function","function":{"name":"read_file","description":"Read a project file. Use a line range only when it helps answer a specific question.","parameters":{"type":"object","properties":{"path":{"type":"string"},"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1}},"required":["path"]}}}),
            json!({"type":"function","function":{"name":"project_knowledge_index","description":"Read the small .ai-framework manifest index and source freshness map. Use it before repeating broad project orientation.","parameters":{"type":"object","properties":{}}}}),
            json!({"type":"function","function":{"name":"project_knowledge_read","description":"Read selected reusable project observations from .ai-framework: paths is required. Prefer relevant fresh knowledge before broad rereads; do not reread unchanged source only to reconstruct context. Read source for exact current code or a concrete unresolved/verification detail.","parameters":{"type":"object","properties":{"paths":{"type":"array","items":{"type":"string"}}},"required":["paths"]}}}),
            json!({"type":"function","function":{"name":"project_knowledge_update","description":"Optionally persist durable, reusable semantic project knowledge in .ai-framework. This is never required for normal work. Only use project/, modules/, sources/, or tasks/ markdown paths.","parameters":{"type":"object","properties":{"updates":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"},"mode":{"type":"string","enum":["replace","merge"]}},"required":["path","content"]}},"source_paths":{"type":"array","items":{"type":"string"}}},"required":["updates"]}}}),
            json!({"type":"function","function":{"name":"run_terminal","description":"Run an existing relevant project command. After code changes, prefer a focused test, typecheck, lint, build, or check when available.","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout_ms":{"type":"integer","minimum":1}},"required":["command"]}}}),
            json!({"type":"function","function":{"name":"write_file","description":"Write a project file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}),
        ]);
    }
    tools.sort_by(|left, right| tool_name(left).cmp(tool_name(right)));
    tools
}
/// A constrained/read-only run does not advertise mutations and therefore
/// cannot strand the model behind an approval-only capability. Task Memory and
/// explicit knowledge reads remain available so analysis has a complete
/// working contract.
fn tool_schemas_for_policy(has_project_root: bool, policy: RunPolicy) -> Vec<Value> {
    let mut tools = tool_schemas(has_project_root);
    if policy == RunPolicy::Safe {
        tools.retain(|tool| {
            matches!(
                tool_name(tool),
                "task_memory"
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
        .ok_or_else(|| format!("missing required field: {key}"))
}

fn write_task_memory(
    memory: &mut crate::agent::task_memory::TaskMemory,
    value: &Value,
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
    memory.upsert(
        value.get("id").and_then(Value::as_str),
        finding,
        evidence,
        implication,
        next,
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
            json!({"task_memory": state.task_memory, "updated": false}),
            false,
        ));
    }
    if action == "invalidate" {
        state
            .task_memory
            .invalidate(required_text(arguments, "id")?.as_str())?;
    } else if action == "record" || action == "update" {
        write_task_memory(&mut state.task_memory, arguments)?;
    } else {
        return Err("unsupported task_memory action".into());
    }
    Ok((
        json!({"task_memory": state.task_memory, "updated": true}),
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

/// Opt-in forensic trace for a real provider run. It stays outside the
/// transcript and is disabled unless the operator supplies a path, so it
/// cannot affect prompt construction or persisted chat history.
fn trace_forensics(run_id: &str, kind: &str, data: Value) {
    let Ok(path) = std::env::var("LOCAL_AI_AGENT_TRACE_PATH") else {
        return;
    };
    let record = json!({"run_id":run_id,"kind":kind,"data":data});
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{record}");
    }
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
    trace_forensics(
        run_id,
        "provider_request",
        json!({
            "payload_chars":body.len(),
            "message_roles":payload.pointer("/messages").and_then(Value::as_array).map(|messages| messages.iter().filter_map(|message| message.get("role").and_then(Value::as_str)).collect::<Vec<_>>()),
            "tool_choice":payload.get("tool_choice"),
            "tool_names":payload.get("tools").and_then(Value::as_array).map(|tools| tools.iter().map(tool_name).collect::<Vec<_>>()),
            "max_tokens":payload.get("max_tokens"),
        }),
    );
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
    trace_forensics(
        run_id,
        "assembled_turn",
        json!({
            "reasoning_chars":turn.reasoning.chars().count(),
            "content_chars":turn.content.chars().count(),
            "calls":turn.calls.values().cloned().collect::<Vec<_>>(),
            "finish_reason":turn.finish_reason,
        }),
    );
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
            trace_forensics(run_id, "raw_sse", json!({"data":line}));
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
                trace_forensics(
                    run_id,
                    "parsed_reasoning_delta",
                    json!({"content":reasoning}),
                );
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
                trace_forensics(run_id, "parsed_content_delta", json!({"content":content}));
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
                trace_forensics(run_id, "parsed_tool_delta", json!({"calls":calls}));
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
    // Compaction has one responsibility: construct a factual handoff. Task
    // Memory remains independent runtime state and is never rewritten by a
    // summary model.
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
    _state: &AgentState,
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
    // This is the final fallback after structural selection.  Its job is not
    // merely to avoid an HTTP context error: it must restore the same
    // low-water target used by selection, leaving useful room for the next
    // model turn.  The previous physical-ceiling limit could emit a 64,480
    // token request into a 65,536-token server and immediately force another
    // compaction.
    let target = compaction_target_tokens(config.context_limit);
    let initial = request_budget(config, messages, schemas);
    if initial.projected_input_tokens <= target {
        return None;
    }

    let mut diagnostic = None;
    while request_budget(config, messages, schemas).projected_input_tokens > target {
        let (index, original) = messages
            .iter()
            .enumerate()
            .filter(|(_, message)| message.get("role").and_then(Value::as_str) == Some("tool"))
            .filter_map(|(index, message)| {
                message
                    .get("content")
                    .and_then(Value::as_str)
                    .filter(|content| content != &TOOL_RESULT_TRUNCATION_MARKER)
                    .map(|content| (index, content.to_owned()))
            })
            .max_by_key(|(_, content)| content.chars().count())?;
        let original_chars = original.chars().count();
        let original_tokens = estimate_tokens(&json!(original));
        // First try to retain as much as possible from this largest result.
        // If it alone cannot bring the projection under the target, collapse
        // it and continue with the next largest result.  Tool messages stay
        // in place, so no assistant-call/result pair is ever split.
        let mut low = 0_usize;
        let mut high = original_chars;
        let mut best = None;
        while low <= high {
            let middle = low + (high - low) / 2;
            let candidate = truncate_tool_result_content(&original, middle);
            messages[index]["content"] = Value::String(candidate.clone());
            if request_budget(config, messages, schemas).projected_input_tokens <= target {
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
        diagnostic = Some(EmergencyToolResultTruncation {
            original_tokens,
            original_chars,
            projected_tokens: estimate_tokens(&json!(projected.clone())),
            projected_chars: projected.chars().count(),
            source: tool_result_source(&original),
        });
    }

    let diagnostic = diagnostic?;
    Some(EmergencyToolResultTruncation {
        original_tokens: diagnostic.original_tokens,
        original_chars: diagnostic.original_chars,
        projected_tokens: diagnostic.projected_tokens,
        projected_chars: diagnostic.projected_chars,
        source: diagnostic.source,
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
        "task_memory" => {
            let (value, changed) = apply_task_memory(state, &tool.arguments)?;
            if changed {
                emit(
                    &config.run_id,
                    Event::TaskMemoryUpdate {
                        memory: serde_json::to_value(&state.task_memory)
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
                let _ = crate::tools::knowledge::observe_tool(
                    &PathBuf::from(root),
                    &config.run_id,
                    &config.user,
                    None,
                    None,
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
                let _ = crate::tools::knowledge::observe_tool(
                    &PathBuf::from(root),
                    &config.run_id,
                    &config.user,
                    None,
                    None,
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
    state.task_memory = config
        .task_memory
        .as_ref()
        .and_then(|memory| serde_json::from_value(memory.clone()).ok())
        .unwrap_or_default();
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
        let request_schemas = &schemas;
        let dynamic = dynamic_tail(&state, config.root.as_deref());
        let pending_tail = transcript.pending_tail(&dynamic);
        let sent_tail = if transcript.has_active_prompt_tail(&pending_tail) {
            String::new()
        } else {
            pending_tail
        };
        let mut messages = pending_fitted_projection
            .take()
            .unwrap_or_else(|| project(&transcript, &stable, &sent_tail));
        let before_budget = request_budget(&config, &messages, request_schemas);
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
                request_schemas,
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
        let payload = request_payload(&config, &messages, request_schemas, output_limit);
        trace_forensics(
            &config.run_id,
            "agent_request_state",
            json!({
                "turn":turn + 1,
                "projected_input_tokens":projected,
                "dynamic_tail":dynamic,
                "task_memory":state.task_memory.prompt(),
                "compaction_boundary":transcript.compaction_boundary(),
                "message_shape":request_shape(&messages),
            }),
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
        let canonical_content = streamed.content.clone();
        transcript.assistant_tool_turn(streamed.content, &calls);
        trace_forensics(
            &config.run_id,
            "canonical_assistant_tool_turn",
            json!({"content":canonical_content,"calls":calls.iter().map(ValidatedCall::wire).collect::<Vec<_>>() }),
        );
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

    #[test]
    fn experimental_toolset_excludes_todo_and_keeps_production_capabilities() {
        let schemas = tool_schemas(true);
        let names = schemas.iter().map(tool_name).collect::<Vec<_>>();
        assert!(!names.contains(&"todo"));
        for name in [
            "task_memory",
            "read_file",
            "list_directory",
            "run_terminal",
            "project_knowledge_index",
            "project_knowledge_read",
            "project_knowledge_update",
        ] {
            assert!(names.contains(&name), "{name}");
        }
        let memory = schemas
            .iter()
            .find(|tool| tool_name(tool) == "task_memory")
            .unwrap();
        assert!(!memory.to_string().to_ascii_lowercase().contains("todo"));
        assert!(memory
            .pointer("/function/parameters/properties/task")
            .is_none());
    }

    #[test]
    fn dynamic_tail_contains_memory_and_knowledge_without_plan_state() {
        let state = AgentState::default();
        let tail = dynamic_tail(&state, None);
        assert!(!tail.to_ascii_lowercase().contains("todo"));
        assert!(!tail.contains("model_todo"));
    }

    #[test]
    fn compaction_keeps_meaningful_output_headroom_in_a_physical_64k_context() {
        let target = compaction_target_tokens(65_536);
        assert!(target < 65_536 - PREFERRED_OUTPUT_HEADROOM_TOKENS);
        assert!(
            dynamic_output_limit(
                65_536,
                target,
                SAFETY_RESERVE_TOKENS,
                None,
                APPLICATION_MAX_OUTPUT_TOKENS
            ) >= PREFERRED_OUTPUT_HEADROOM_TOKENS
        );
    }
}
