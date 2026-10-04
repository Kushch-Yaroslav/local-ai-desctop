//! Transcript-first local agent loop.
//!
//! The runtime owns transport, capability safety, durable evidence and bounded
//! recovery. It does not certify evidence, decide exploration coverage, or make
//! semantic completion decisions for the model; see
//! `docs/architecture/agent-investigation-state.md`.

use crate::agent::{
    events::{Event, TailCandidateAttempt},
    evidence::classify_source_read,
    ledger::{Ledger, ProjectIndex},
    policy::{self, Reasoning, RunPolicy},
    reads::repeated_file_read_decision,
    state::AgentState,
    strategy::{self, Strategy},
    transcript::{validate_calls, CompactionPlan, ToolResultPolicy, Transcript, ValidatedCall},
};
use crate::context::evidence_projection::{
    apply_folds, attach_historical_index, fold_to_budget, folded_ids,
};
use crate::context::projection::project;
use crate::protocol::emit;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Clone)]
pub struct Config {
    pub run_id: String,
    pub endpoint: String,
    pub model: String,
    pub system: String,
    pub user: String,
    pub root: Option<String>,
    pub secondary_root: Option<String>,
    pub context_limit: usize,
    pub reasoning_mode: String,
    pub supports_reasoning: bool,
    pub reasoning_options: Option<Value>,
    pub policy: RunPolicy,
    pub history: Vec<Value>,
    pub evidence_dir: Option<String>,
    pub task_memory: Option<Value>,
    pub provider_max_output: Option<usize>,
    pub cancelled: Arc<AtomicBool>,
    pub steering: Arc<Mutex<Vec<String>>>,
    pub steering_closed: Arc<AtomicBool>,
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
/// Provider turns available for investigation. When they are exhausted the run
/// does not end in an error: tools are withdrawn and the next turns are
/// synthesis-only, so the user always receives an answer.
pub const MAX_INVESTIGATION_TURNS: usize = 128;
/// Room for a long synthesized answer to continue after `length` stops plus a
/// few protocol misfires, without ever consuming the investigation budget.
/// Empty provider responses in a row before tools are withdrawn so the next
/// turns can only be an answer.
pub const MAX_CONSECUTIVE_EMPTY_TURNS: usize = 3;
pub const MAX_SYNTHESIS_TURNS: usize = MAX_CONTINUATION_TURNS + 8;
pub const MAX_CONTINUATION_TURNS: usize = 32;
pub const MAX_LOGICAL_FINAL_CHARS: usize = 1_000_000;
pub const SUMMARY_INPUT_CHARS: usize = 48_000;
pub const SUMMARY_MAX_OUTPUT_TOKENS: usize = 2_048;
pub const MIN_SUMMARY_OUTPUT_TOKENS: usize = 64;
const MIN_CONTINUATION_OVERLAP_CHARS: usize = 32;
const MIN_FULL_RESTART_PREFIX_CHARS: usize = 96;
const MAX_CONTINUATION_OVERLAP_CHARS: usize = 24_000;
const SUMMARY_FIT_RESERVE_CHARS: usize = SUMMARY_MAX_OUTPUT_TOKENS * 3;
const TOOL_RESULT_TRUNCATION_MARKER: &str =
    "\n[… tool result projection truncated to fit the provider context …]\n";

const AGENT_GUIDANCE: &str = r#"
# Local AI Desktop Agent
- Work directly from the conversation and tool results. A tool-free response completes the run; there is no separate step to request before answering.
- For code changes, read before writing, make targeted changes, and run the most relevant practical validation or readback. Adapt after errors; do not invent checks.
- For substantial tasks, reason about an approach before acting, adapt as you learn, use tools for concrete evidence, avoid broad rereads, and continue until the user's task is complete.
- Use the latest user's language for all user-visible natural-language text: streamed reasoning/progress, tool preambles, brief status updates, and the final answer. Follow an explicit language request if present. Keep code, paths, identifiers, commands, API/tool syntax, and literal source quotations in their original form. Do not translate protocol fields.
- For non-trivial architecture relationships, use a compact multiline Mermaid flowchart when it improves readability, or a properly indented multiline tree. Do not compress a diagram into one long arrow chain; avoid decorative box art.
- Task Memory = durable semantic continuity for this task. Record meaningful findings, decisions, blockers, and next actions, and cite the observation IDs (obs-…) a finding rests on in its evidence field. After compaction, trust a precise Task Memory finding from an unchanged inspected file; reread only for a missing fact, ambiguity, possible change, exact detail, or targeted verification.
- Set Task Memory status and evidence as JSON fields, not prose inside finding. Confirmed entries require evidence containing an observation ID or exact inspected source path from this transcript. A valid reference does not prove the claim; use inferred or unknown for unverified conclusions.
- Investigation state = a mechanical inventory the runtime keeps of this run's tool observations: files read with their observation IDs, listed entries and local files referenced by sources you read that were not opened yet, failed operations, and commands run. It is not a task list and nothing in it is required. Use it to avoid rereading and to notice code you have not seen; follow a reference only when what you are about to claim depends on it. Recover an exact stored body with observation_read.
- Ground claims in what you observed. Keep observed facts, inferences and unknowns apart, and mark inferences as inferences. Something you did not open is unknown, not absent. State that something does not exist only for a scope you actually covered (a complete directory listing, a complete file read, or a search whose scope you can name) and name that scope; otherwise say it was not found in what you inspected. A failed or approval-blocked operation is a blocker, not evidence.
- When the request lists areas or questions, answer each from something you inspected or report it as not inspected. Do not spend further tool calls only to re-verify what you have already read.
- In the final answer, answer the user's sections directly, distinguish facts from hypotheses, prioritize concrete effects over generic advice, state what remained unexamined, and avoid duplicate points or meta-progress narration. Refer to sources by file path (and line or quoted text), never by observation ID: IDs are internal to this run. Treat claims about how the code was produced conservatively; style alone is weak evidence.
- For project archaeology with run_terminal, prefer one scoped read-only command such as git -C <project> log --oneline; avoid compound shell wrappers and unsafe pipelines that require approval.
- Project Knowledge = reusable observations already derived from this project. Use relevant fresh knowledge before broad rereading; source remains authoritative when exact current code or an unresolved detail is needed. It is project-level; Task Memory is task-level.
- After compaction: use the continuation brief, Task Memory, then relevant Project Knowledge; read source only for genuinely new or verification-specific information.
- Do not call tools merely because they are available. Stop naturally when the requested work is complete.
"#;

const SUMMARY_GUIDANCE: &str = r#"Create an AGENT CONTINUATION CHECKPOINT, not a generic conversation summary. Use these concise headings: Established work; Current focus; Findings and evidence (cite obs-… IDs); Blocked or failed operations; Not yet inspected or unresolved; Next useful intent. Preserve explicit user constraints and distinguish verified facts from hypotheses. Do not invent a plan, task IDs, lifecycle, or checklist. Do not repeat raw tool output, token counts, runtime mechanics, generic encouragement, or an activity log."#;

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

/// SAFETY FALLBACK, not the fix for any loop: once the runtime has withdrawn
/// tools, the model's configured finalization options are used for the answer.
/// The primary contract (reasoning is recorded and replayed with the turn that
/// produced it) is in `Transcript::assistant_*_with_reasoning`.
fn request_reasoning(config: &Config, finalizing: bool) -> Option<Value> {
    if !config.supports_reasoning {
        return None;
    }
    if let Some(options) = config.reasoning_options.as_ref().and_then(|options| {
        let key = if finalizing {
            "final"
        } else {
            match policy::reasoning(&config.reasoning_mode, "agent") {
                Reasoning::Off | Reasoning::Low => "fast",
                Reasoning::Deep => "deep",
            }
        };
        options.get(key).filter(|value| value.is_object())
    }) {
        return Some(options.clone());
    }
    Some(
        match if finalizing {
            Reasoning::Off
        } else {
            policy::reasoning(&config.reasoning_mode, "agent")
        } {
            Reasoning::Off => json!({"chat_template_kwargs":{"enable_thinking":false}}),
            Reasoning::Low => json!({"reasoning_effort":"low"}),
            Reasoning::Deep => json!({"reasoning_effort":"xhigh"}),
        },
    )
}

fn wire_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .cloned()
        .map(|mut message| {
            if let Some(object) = message.as_object_mut() {
                object.remove("_observation_id");
                object.remove("_result_policy");
                object.remove("_rehydration");
            }
            message
        })
        .collect()
}

fn request_payload(
    config: &Config,
    messages: &[Value],
    schemas: &[Value],
    max_tokens: usize,
) -> Value {
    request_payload_for_phase(config, messages, schemas, max_tokens, false)
}

/// A provider that does not reason has no use for replayed reasoning, and a
/// strict one may reject the field. This is a projection decision: the record
/// keeps the reasoning.
fn without_replayed_reasoning(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .cloned()
        .map(|mut message| {
            if let Some(object) = message.as_object_mut() {
                object.remove("reasoning_content");
            }
            message
        })
        .collect()
}

fn request_payload_for_phase(
    config: &Config,
    messages: &[Value],
    schemas: &[Value],
    max_tokens: usize,
    finalizing: bool,
) -> Value {
    let stripped;
    let messages = if config.supports_reasoning {
        messages
    } else {
        stripped = without_replayed_reasoning(messages);
        stripped.as_slice()
    };
    let wire_messages = wire_messages(messages);
    let mut payload = json!({
        "model": config.model,
        "messages": wire_messages,
        "stream": true,
        "stream_options": {"include_usage": true},
        "max_tokens": max_tokens,
    });
    if !schemas.is_empty() {
        payload["tools"] = json!(schemas);
        payload["tool_choice"] = json!("auto");
    }
    if let Some(reasoning) = request_reasoning(config, finalizing) {
        payload
            .as_object_mut()
            .expect("request payload")
            .extend(reasoning.as_object().expect("reasoning payload").clone());
    }
    payload
}

thread_local! {
    /// Actual-over-estimated prompt size, learned from the provider's own
    /// usage report for this run's previous request. The character-based
    /// estimate is deliberately pessimistic for JSON-escaped tool output; left
    /// uncorrected it makes a 64K window behave like a 40K one, so evidence is
    /// folded away early, the cached prefix is rewritten, and the model rereads.
    static TOKEN_CALIBRATION: std::cell::Cell<f64> = const { std::cell::Cell::new(1.0) };
}

const CALIBRATION_MIN: f64 = 0.4;
const CALIBRATION_MAX: f64 = 1.6;

fn calibrate_estimate(estimated: usize) -> usize {
    ((estimated as f64) * TOKEN_CALIBRATION.with(std::cell::Cell::get)).ceil() as usize
}

/// `estimated` is the (already calibrated) projection of the request the
/// provider just answered; `actual` is the prompt size it reported for it.
fn learn_token_calibration(estimated: usize, actual: usize) {
    if estimated == 0 || actual == 0 {
        return;
    }
    let observed = TOKEN_CALIBRATION.with(std::cell::Cell::get) * actual as f64 / estimated as f64;
    let learned = (0.5 * TOKEN_CALIBRATION.with(std::cell::Cell::get) + 0.5 * observed)
        .clamp(CALIBRATION_MIN, CALIBRATION_MAX);
    TOKEN_CALIBRATION.with(|cell| cell.set(learned));
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
        projected_input_tokens: calibrate_estimate(estimate_tokens(&payload)),
        stable_prefix_tokens: calibrate_estimate(
            messages
                .first()
                .map_or(0, |message| estimate_tokens(&json!([message]))),
        ),
        tool_schemas_tokens: calibrate_estimate(estimate_tokens(&Value::Array(schemas.to_vec()))),
        transcript_history_tokens: calibrate_estimate(estimate_tokens(&Value::Array(transcript))),
        summary_tokens: calibrate_estimate(estimate_tokens(&Value::Array(summaries))),
        dynamic_tail_tokens: calibrate_estimate(estimate_tokens(&Value::Array(dynamic))),
    }
}

fn project_evidence(
    config: &Config,
    transcript: &Transcript,
    stable: &str,
    dynamic: &str,
) -> Vec<Value> {
    let mut messages = project(transcript, stable, dynamic);
    for message in &mut messages {
        let Some(id) = message.get("_observation_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(meta) = transcript.observation(id) else {
            continue;
        };
        let Some(body) = message.get("content").and_then(Value::as_str) else {
            continue;
        };
        if body.starts_with("[historical tool observation]") {
            continue;
        }
        message["content"] = json!(format!("{body}\n[observation id={} source={} historical_revision={}; cite this ID in Task Memory evidence or recover it with observation_read]", meta.id, meta.source.as_deref().unwrap_or("none"), meta.source_revision.as_deref().unwrap_or("unknown")));
    }
    attach_historical_index(
        transcript,
        &mut messages,
        config.context_limit.saturating_div(20).clamp(1_200, 4_000),
    );
    messages
}

fn fold_evidence_to_target(
    config: &Config,
    transcript: &Transcript,
    schemas: &[Value],
    messages: &mut [Value],
) -> Vec<String> {
    let target = compaction_target_tokens(config.context_limit);
    fold_to_budget(transcript, messages, target, |candidate| {
        request_budget(config, candidate, schemas).projected_input_tokens
    })
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
    prefix.push('\n');
    prefix.push_str(
        Strategy::from_mode(&config.reasoning_mode)
            .guidance()
            .trim(),
    );
    prefix.push_str(&format!(
        "\nPreferred visible prose language for this run: {}.",
        crate::agent::transcript::preferred_visible_language(&config.user)
    ));
    if let Some(root) = &config.root {
        prefix.push_str("\n<working_directory>");
        prefix.push_str(root);
        prefix.push_str("</working_directory>");
        prefix.push_str(&format!(
            "\nProject 1 root: {root}. Project tools accept project=1 (default)."
        ));
    }
    if let Some(root) = &config.secondary_root {
        prefix.push_str(&format!("\nProject 2 root: {root}. Use project=2 for its tools. Roots are distinct identities; attribute findings to the selected project and do not infer one project's content from the other."));
    }
    prefix
}

fn lifecycle_label(transcript: &Transcript) -> &'static str {
    if transcript.is_finalizing() {
        "finalizing"
    } else {
        "investigating"
    }
}

fn dynamic_tail(
    state: &AgentState,
    root: Option<&str>,
    objective: &str,
    transcript: &Transcript,
    investigation: &str,
) -> String {
    let mut tail = Vec::new();
    let memory = if transcript.is_finalizing() {
        state.task_memory.prompt_for_closeout(objective)
    } else {
        state.task_memory.prompt_for(objective)
    };
    if !memory.is_empty() {
        tail.push(format!("<task_memory>\n{memory}\n</task_memory>"));
    }
    if !investigation.is_empty() {
        tail.push(investigation.to_owned());
    }
    if state.strategy.is_deep() && !transcript.is_finalizing() {
        let unknowns = strategy::open_unknowns_text(&state.task_memory);
        if !unknowns.is_empty() {
            tail.push(unknowns);
        }
        if strategy::checkpoint_due(state.strategy, state.calls_since_memory) {
            tail.push(strategy::checkpoint_text(state.calls_since_memory));
        }
    }
    if !transcript.is_finalizing() && !user_requests_read_only(objective) {
        let knowledge = crate::tools::knowledge::prompt_catalog(root);
        if !knowledge.is_empty() {
            tail.push(knowledge);
        }
    }
    tail.join("\n")
}

fn emit_knowledge_diagnostics(config: &Config, state: &AgentState) {
    if user_requests_read_only(&config.user) {
        return;
    }
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
    // Native tool grammars enumerate object-root properties, not union roots.
    // Action-specific requirements are enforced transactionally at dispatch.
    let mut tools = vec![
        json!({"type":"function","function":{"name":"task_memory","description":"Durable semantic memory for the current task across compaction. Record/update meaningful findings, decisions, blockers, or unresolved questions; view reads it; invalidate needs id. Record/update requires finding and may include evidence, implication, next, id, supersedes, status. Trust precise unchanged-file memory; reread only for a concrete missing, ambiguous, changed, exact-detail, or verification need.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["record","update","invalidate","view"]},"id":{"type":"string"},"finding":{"type":"string"},"evidence":{"type":"string"},"implication":{"type":"string"},"next":{"type":"string"},"supersedes":{"type":"string"},"status":{"type":"string","enum":["confirmed","inferred","unknown","contradicted"],"description":"How well established the finding is: confirmed (observed, cited), inferred (reasoned, not observed), unknown (open; put the resolving step in next), contradicted (evidence disagrees)."}},"required":["action"]}}}),
        json!({"type":"function","function":{"name":"observation_index","description":"List historical tool observations by stable ID, with source path and outcome metadata. Use source to select the raw observation for the needed file. If more=true, continue at the returned next_offset. Observation IDs start with obs-.","parameters":{"type":"object","properties":{"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}}}}}),
        json!({"type":"function","function":{"name":"observation_read","description":"Recover a bounded exact slice of a stored historical tool result by observation ID. The response distinguishes historical evidence from current source and reports whether the source changed.","parameters":{"type":"object","properties":{"id":{"type":"string"},"offset_chars":{"type":"integer","minimum":0},"max_chars":{"type":"integer","minimum":1,"maximum":16000}},"required":["id"]}}}),
    ];
    if has_project_root {
        tools.extend([
            json!({"type":"function","function":{"name":"apply_patch","description":"Apply a project patch.","parameters":{"type":"object","properties":{"patch":{"type":"string"}},"required":["patch"]}}}),
            json!({"type":"function","function":{"name":"create_file","description":"Create a new project file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}),
            json!({"type":"function","function":{"name":"delete_file","description":"Delete a project file when allowed.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}),
            json!({"type":"function","function":{"name":"list_directory","description":"List a project directory. complete=true means all directory entries are represented; false means internal runtime entries were omitted.","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}),
            json!({"type":"function","function":{"name":"read_file","description":"Read up to 64 KiB of a project file. A truncated result provides next_offset_chars; use that offset or a specific line range for more.","parameters":{"type":"object","properties":{"path":{"type":"string"},"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1},"offset_chars":{"type":"integer","minimum":0}},"required":["path"]}}}),
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
                    | "observation_index"
                    | "observation_read"
                    | "read_file"
                    | "list_directory"
                    | "project_knowledge_index"
                    | "project_knowledge_read"
            )
        });
    }
    tools
}

fn is_project_side_effect_tool(name: &str) -> bool {
    matches!(
        name,
        "apply_patch"
            | "create_file"
            | "delete_file"
            | "project_knowledge_index"
            | "project_knowledge_read"
            | "project_knowledge_update"
            | "write_file"
    )
}

fn user_requests_read_only(user: &str) -> bool {
    let user = user.to_lowercase();
    [
        "не изменяй файлы",
        "не изменяйте файлы",
        "не изменять файлы",
        "не меняй файлы",
        "не меняйте файлы",
        "не редактируй файлы",
        "не изменяй код",
        "ничего не меняй",
        "ничего не изменяй",
        "read-only",
        "read only",
        "do not modify",
        "don't modify",
        "do not edit",
        "don't edit",
        "do not change files",
        "don't change files",
        "no file changes",
    ]
    .iter()
    .any(|marker| user.contains(marker))
}

fn tool_schemas_for_request(has_project_root: bool, policy: RunPolicy, user: &str) -> Vec<Value> {
    let mut tools = tool_schemas_for_policy(has_project_root, policy);
    if user_requests_read_only(user) {
        tools.retain(|tool| !is_project_side_effect_tool(tool_name(tool)));
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
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .filter(|status| !status.trim().is_empty())
        .map(crate::agent::task_memory::Status::parse)
        .transpose()?;
    memory.upsert_with_status(
        value.get("id").and_then(Value::as_str),
        finding,
        evidence,
        implication,
        next,
        value
            .get("supersedes")
            .and_then(Value::as_str)
            .map(str::to_owned),
        status,
    )
}

fn task_memory_conflict(
    state: &AgentState,
    transcript: &Transcript,
    arguments: &Value,
) -> Option<String> {
    let replacing = arguments
        .get("supersedes")
        .or_else(|| arguments.get("id"))
        .and_then(Value::as_str)?;
    let prior = state
        .task_memory
        .entries
        .iter()
        .find(|e| e.id == replacing && !e.invalidated)?;
    let cited = transcript
        .observations()
        .iter()
        .find(|o| prior.evidence.contains(&o.id))?;
    let new_evidence = arguments
        .get("evidence")
        .and_then(Value::as_str)
        .unwrap_or("");
    if transcript.observations().iter().any(|o| {
        new_evidence.contains(&o.id)
            || o.source
                .as_deref()
                .is_some_and(|source| new_evidence == source)
    }) {
        return None;
    }
    Some(format!("Potential evidence conflict: {} cites exact historical observation {}. Retrieve that observation with observation_read and cite a verified observation before replacing this finding.", prior.id, cited.id))
}

fn validate_confirmed_memory(
    entry: &crate::agent::task_memory::TaskMemoryEntry,
    transcript: &Transcript,
) -> Result<(), String> {
    use crate::agent::task_memory::Status;
    if entry.status != Some(Status::Confirmed) {
        return Ok(());
    }
    let reference_character = |character: char| {
        character.is_alphanumeric() || matches!(character, '-' | '_' | '.' | '/' | '\\')
    };
    let tokens = entry
        .evidence
        .split(|character| !reference_character(character))
        .flat_map(|token| token.split(".."))
        .map(|token| token.trim_matches('.'));
    let mut found = transcript.observations().iter().any(|observation| {
        observation.source.as_deref().is_some_and(|source| {
            !source.is_empty()
                && entry
                    .evidence
                    .match_indices(source)
                    .any(|(start, matched)| {
                        let end = start + matched.len();
                        !entry.evidence[..start]
                            .chars()
                            .next_back()
                            .is_some_and(reference_character)
                            && !entry.evidence[end..]
                                .chars()
                                .next()
                                .is_some_and(reference_character)
                    })
        })
    });
    for token in tokens.filter(|token| !token.is_empty()) {
        if token.starts_with("obs-") {
            if transcript.observation(token).is_none() {
                return Err(format!("Confirmed Task Memory cites unknown observation '{token}'. Use observation_index to find a valid reference and retry; no memory was changed."));
            }
            found = true;
        }
    }
    if !found {
        return Err("Confirmed Task Memory requires nonempty evidence referencing an observation ID or exact source path inspected in this transcript. Use observation_index and retry with evidence, or explicitly use inferred/unknown when unverified; no memory was changed.".into());
    }
    Ok(())
}

fn restore_task_memory(
    value: Option<&Value>,
    transcript: &Transcript,
) -> Result<crate::agent::task_memory::TaskMemory, String> {
    let memory: crate::agent::task_memory::TaskMemory = match value {
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|error| format!("Invalid saved Task Memory: {error}"))?,
        None => return Ok(Default::default()),
    };
    for entry in memory.entries.iter().filter(|entry| !entry.invalidated) {
        validate_confirmed_memory(entry, transcript)
            .map_err(|error| format!("Invalid saved Task Memory entry '{}': {error}", entry.id))?;
    }
    Ok(memory)
}

fn apply_task_memory(
    state: &mut AgentState,
    arguments: &Value,
    transcript: &Transcript,
) -> Result<(Value, bool), String> {
    let action = required_text(arguments, "action")?;
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
        if state.memory_writes_this_turn >= strategy::MAX_MEMORY_WRITES_PER_TURN {
            return Err(format!("Task Memory accepts at most {} writes per turn. Merge the remaining findings into one entry (update an existing id) instead of one entry per fact.", strategy::MAX_MEMORY_WRITES_PER_TURN));
        }
        let mut candidate = state.task_memory.clone();
        let id = write_task_memory(&mut candidate, arguments)?;
        let entry = candidate
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "Task Memory write did not create an entry".to_owned())?;
        validate_confirmed_memory(entry, transcript)?;
        state.task_memory = candidate;
        state.memory_writes_this_turn += 1;
    } else {
        return Err("unsupported task_memory action".into());
    }
    state.calls_since_memory = 0;
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
        "Continue immediately after the exact ending below. Do not restart, repeat headings, summarize, or reproduce earlier text. Finalization is in progress; use a tool only for a specific unresolved contradiction or critical missing fact.\n<previous_tail>\n{}\n</previous_tail>",
        continuation_tail(content)
    )
}

fn append_final_text(accumulator: &mut String, delta: &str) {
    accumulator.push_str(delta);
}

fn emit_accepted_final_content(run_id: &str, content: &str) {
    if !content.is_empty() {
        emit(
            run_id,
            Event::ContentDelta {
                content: content.to_owned(),
            },
        );
    }
}

fn present_answer(
    content: &str,
    prefix: &str,
    transcript: &Transcript,
    state: &AgentState,
) -> String {
    let mut references = BTreeMap::new();
    for observation in transcript.observations() {
        let source = observation
            .source
            .clone()
            .unwrap_or_else(|| format!("{} result", observation.tool));
        references.insert(observation.id.clone(), source.clone());
        if let Some(number) = observation
            .id
            .strip_prefix("obs-")
            .and_then(|id| id.parse::<u64>().ok())
        {
            references.insert(format!("obs-{number}"), source);
        }
    }
    for entry in &state.task_memory.entries {
        let source = entry
            .evidence
            .split(|character: char| {
                !character.is_ascii_alphanumeric() && !matches!(character, '-' | '_')
            })
            .find_map(|reference| references.get(reference).cloned());
        references.insert(
            entry.id.clone(),
            source.unwrap_or_else(|| {
                crate::agent::presentation::project_answer(
                    &entry.finding.chars().take(120).collect::<String>(),
                    &references,
                )
            }),
        );
    }
    crate::agent::presentation::project_answer_with_prefix(content, prefix, &references)
}

fn emit_status(run_id: &str, content: &str) {
    if !content.trim().is_empty() {
        emit(
            run_id,
            Event::AgentStatus {
                content: content.to_owned(),
            },
        );
    }
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

/// A provider may put its tool syntax in ordinary content without emitting a
/// structured call. That text is neither an executable call nor a final
/// answer. Reasoning text is deliberately excluded: a valid structured call
/// can coexist with a redundant textual rendering in reasoning.
fn unstructured_tool_call_content(content: &str) -> bool {
    content.trim_start().starts_with("<tool_call>")
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

const REASONING_TOOL_OPEN: &str = "<tool_call>";
const REASONING_TOOL_CLOSE: &str = "</tool_call>";

#[derive(Default)]
struct ReasoningMarkupFilter {
    pending: String,
    inside_tool_call: bool,
    hid_markup: bool,
}

impl ReasoningMarkupFilter {
    // Retain possible marker prefixes between deltas so split tags cannot leak.
    fn push(&mut self, input: &str, flush: bool) -> String {
        self.pending.push_str(input);
        let mut visible = String::new();
        loop {
            let lower = self.pending.to_ascii_lowercase();
            if self.inside_tool_call {
                if let Some(end) = lower.find(REASONING_TOOL_CLOSE) {
                    self.pending.drain(..end + REASONING_TOOL_CLOSE.len());
                    self.inside_tool_call = false;
                    continue;
                }
                let keep = suffix_prefix_length(&lower, REASONING_TOOL_CLOSE);
                self.pending = if keep == 0 {
                    String::new()
                } else {
                    self.pending[self.pending.len() - keep..].to_owned()
                };
                break;
            }
            if let Some(start) = lower.find(REASONING_TOOL_OPEN) {
                visible.push_str(&self.pending[..start]);
                self.pending.drain(..start + REASONING_TOOL_OPEN.len());
                self.inside_tool_call = true;
                self.hid_markup = true;
                continue;
            }
            let keep = suffix_prefix_length(&lower, REASONING_TOOL_OPEN);
            let safe = self.pending.len() - keep;
            visible.push_str(&self.pending[..safe]);
            self.pending = self.pending[safe..].to_owned();
            break;
        }
        if flush {
            // A held-back fragment that never became a tag is ordinary text; an
            // unterminated call body stays hidden.
            if !self.inside_tool_call {
                visible.push_str(&self.pending);
            }
            self.pending.clear();
            self.inside_tool_call = false;
        }
        visible
    }
}

fn suffix_prefix_length(value: &str, marker: &str) -> usize {
    (1..marker.len())
        .rev()
        .find(|length| value.as_bytes().ends_with(&marker.as_bytes()[..*length]))
        .unwrap_or(0)
}

#[derive(Default)]
struct StreamedTurn {
    content: String,
    /// What the UI shows: reasoning with provider tool-call markup removed.
    reasoning: String,
    /// Exactly what the provider streamed as reasoning. This, not the display
    /// text, is the canonical record that is replayed on the next request.
    reasoning_raw: String,
    reasoning_markup_filter: ReasoningMarkupFilter,
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

fn append_reasoning(turn: &mut StreamedTurn, run_id: &str, reasoning: &str, emit_visible: bool) {
    turn.reasoning_raw.push_str(reasoning);
    let visible = turn.reasoning_markup_filter.push(reasoning, false);
    if visible.is_empty() {
        return;
    }
    if !turn.thinking_started {
        turn.thinking_started = true;
        if emit_visible {
            emit(run_id, Event::ThinkingStarted);
        }
    }
    turn.reasoning.push_str(&visible);
    turn.reasoning_delta_count += 1;
    if emit_visible {
        emit(run_id, Event::ThinkingDelta { content: visible });
    }
}

fn flush_reasoning(turn: &mut StreamedTurn, run_id: &str, emit_visible: bool) {
    let visible = turn.reasoning_markup_filter.push("", true);
    if visible.is_empty() {
        return;
    }
    if !turn.thinking_started {
        turn.thinking_started = true;
        if emit_visible {
            emit(run_id, Event::ThinkingStarted);
        }
    }
    turn.reasoning.push_str(&visible);
    turn.reasoning_delta_count += 1;
    if emit_visible {
        emit(run_id, Event::ThinkingDelta { content: visible });
    }
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

fn trace_projection(run_id: &str, transcript: &Transcript, messages: &[Value], tokens: usize) {
    let recoveries = messages.iter().filter(|m| ToolResultPolicy::from_message(m) == ToolResultPolicy::Rehydrated)
        .map(|m| json!({"source_observation_id":m.pointer("/_rehydration/id"),
            "tool_call_id":m.get("tool_call_id"),"visible_exact_chars":m.get("content").and_then(Value::as_str).map(|s| s.chars().count())}))
        .collect::<Vec<_>>();
    let decisions = transcript
        .observations()
        .iter()
        .map(|o| {
            let result = messages.iter().find(|m| {
                m.get("role").and_then(Value::as_str) == Some("tool")
                    && m.get("_observation_id").and_then(Value::as_str) == Some(o.id.as_str())
            });
            let disposition = if let Some(m) = result {
                let content = m.get("content").and_then(Value::as_str).unwrap_or("");
                if content.starts_with("[historical tool observation]") {
                    "receipt"
                } else if content.contains("tool result projection truncated") {
                    "truncated"
                } else {
                    "verbatim"
                }
            } else if messages.iter().any(|m| {
                m.get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.contains(&o.id))
            }) {
                "index"
            } else {
                "covered_index_page"
            };
            json!({"event_id":o.event_id,"observation_id":o.id,"tool_call_id":o.call_id,
            "tool":o.tool,"source":o.source,"revision":o.source_revision,"disposition":disposition})
        })
        .collect::<Vec<_>>();
    trace_forensics(
        run_id,
        "projection_decisions",
        json!({"estimated_tokens":tokens,"observations":decisions,"rehydrated_results":recoveries,
        "compaction_boundary":transcript.compaction_boundary()}),
    );
}

fn record_read_evidence(config: &Config, transcript: &Transcript, tool: &ValidatedCall) {
    if tool.name == "observation_read" {
        trace_forensics(
            &config.run_id,
            "evidence_replayed",
            json!({
                "id":tool.arguments.get("id"),"offset_chars":tool.arguments.get("offset_chars"),
                "recoverable":tool.arguments.get("id").and_then(Value::as_str).is_some_and(|id| transcript.read_observation(id,0,1).is_ok())
            }),
        );
        return;
    }
    if tool.name != "read_file" {
        return;
    }
    let Some(current) = transcript.observation_for_call(&tool.id) else {
        return;
    };
    let prior = transcript
        .observations()
        .iter()
        .position(|observation| observation.id == current.id)
        .unwrap_or(0);
    let kind = classify_source_read(current, transcript.observations()[..prior].iter());
    trace_forensics(
        &config.run_id,
        "source_read",
        json!({"observation_id":current.id,"source":current.source,
        "revision":current.source_revision,"range":current.requested_range,"kind":kind}),
    );
}

/// Dependency-free OpenAI-compatible SSE transport. Visible content is emitted
/// at the delta boundary; finalization never becomes the first visible output.
fn stream_call(
    endpoint: &str,
    payload: &Value,
    run_id: &str,
    turn_index: usize,
    cancelled: &AtomicBool,
    emit_visible: bool,
    emit_content: bool,
) -> Result<StreamedTurn, String> {
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
            "payload":payload,
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
            consume_sse(&mut buffer, &mut turn, run_id, emit_visible, emit_content)?;
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
            consume_sse(&mut buffer, &mut turn, run_id, emit_visible, emit_content)?;
        }
    }
    // Some OpenAI-compatible local servers close the connection immediately
    // after the final data frame without a trailing blank event separator.
    // Treat that final complete frame as SSE rather than silently losing its
    // usage or finish reason.
    if !buffer.trim().is_empty() {
        if !buffer.ends_with("\n\n") && buffer.ends_with('\n') {
            buffer.push('\n');
        } else if !buffer.ends_with("\n\n") {
            buffer.push_str("\n\n");
        }
        consume_sse(&mut buffer, &mut turn, run_id, emit_visible, emit_content)?;
    }
    flush_reasoning(&mut turn, run_id, emit_visible);
    trace_forensics(
        run_id,
        "assembled_turn",
        json!({
            "turn":turn_index,
            "reasoning_chars":turn.reasoning.chars().count(),
            "content_chars":turn.content.chars().count(),
            "reasoning":turn.reasoning,
            "content":turn.content,
            "calls":turn.calls.values().cloned().collect::<Vec<_>>(),
            "finish_reason":turn.finish_reason,
            "prompt_tokens":turn.prompt_tokens,
            "completion_tokens":turn.completion_tokens,
        }),
    );
    Ok(turn)
}

fn consume_sse(
    buffer: &mut String,
    turn: &mut StreamedTurn,
    run_id: &str,
    emit_visible: bool,
    emit_content: bool,
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
            // This trace is explicitly opt-in. Keep the exact frame: lengths
            // alone cannot distinguish textual tool markup from a structured
            // tool-call delta in a historical protocol failure.
            trace_forensics(run_id, "raw_sse_frame", json!({"frame":line}));
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
                // `prompt_n` counts only the tokens evaluated for this request;
                // the reused prefix is `cache_n`. Their sum is the real input
                // size when the usage block did not report it.
                let evaluated = timings.get("prompt_n").and_then(Value::as_u64);
                let reused = timings.get("cache_n").and_then(Value::as_u64);
                if turn.prompt_tokens.is_none() {
                    turn.prompt_tokens = evaluated.map(|n| n + reused.unwrap_or(0));
                }
                if turn.cached_tokens.is_none() {
                    turn.cached_tokens = reused;
                }
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
                    json!({"chars":reasoning.chars().count()}),
                );
                append_reasoning(turn, run_id, reasoning, emit_visible);
            }
            if let Some(content) = delta
                .and_then(|delta| delta.get("content"))
                .and_then(Value::as_str)
            {
                trace_forensics(
                    run_id,
                    "parsed_content_delta",
                    json!({"chars":content.chars().count()}),
                );
                turn.content.push_str(content);
                if emit_content {
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
                trace_forensics(
                    run_id,
                    "parsed_tool_delta",
                    json!({"calls":calls.len(),"names":calls.iter().filter_map(|call| call.pointer("/function/name").and_then(Value::as_str)).collect::<Vec<_>>()}),
                );
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
                flush_reasoning(turn, run_id, emit_visible);
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
    let payload = summary_payload(config, &messages, max_tokens);
    match stream_call(
        &config.endpoint,
        &payload,
        &config.run_id,
        0,
        &config.cancelled,
        false,
        false,
    ) {
        Ok(turn) if !turn.content.trim().is_empty() => {
            let text = mark_if_cut_at_output_limit(turn.content.trim(), &turn.finish_reason);
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

/// A checkpoint that stopped at the output limit is incomplete, and its last
/// headings ("Not yet inspected", "Next useful intent") are the ones lost. The
/// provider said so with `finish_reason: length`; the model must be told too.
fn mark_if_cut_at_output_limit(text: &str, finish_reason: &str) -> String {
    if finish_reason == "length" {
        format!("{text}\n[This checkpoint was cut at its output limit; later sections are missing. Recover exact details with observation_read.]")
    } else {
        text.to_owned()
    }
}

/// The summary call is a provider turn like any other and must use the same
/// context and model capability options. Reasoning is disabled for this
/// handoff-writing phase.
fn summary_payload(config: &Config, messages: &[Value], max_tokens: usize) -> Value {
    request_payload_for_phase(config, messages, &[], max_tokens, true)
}

fn summary_source(plan: &CompactionPlan, max_chars: usize) -> String {
    plan.render(max_chars)
}

fn continuation_checkpoint(transcript: &Transcript, generated: String) -> String {
    let objective = transcript
        .entries()
        .iter()
        .rev()
        .find_map(|entry| match entry {
            crate::agent::transcript::Entry::RunUser(message) => {
                message.get("content").and_then(Value::as_str)
            }
            _ => None,
        })
        .unwrap_or("Continue the current user task.");
    let objective_length = objective.chars().count();
    let objective = if objective_length > 12_000 {
        format!(
            "{}\n[Checkpoint excerpt: {} of {} characters. The exact objective is separately projected as the current user message.]",
            objective.chars().take(12_000).collect::<String>(),
            12_000,
            objective_length
        )
    } else {
        objective.to_owned()
    };
    let headings = [
        "Established work",
        "Current focus",
        "Findings and evidence",
        "Blocked or failed operations",
        "Not yet inspected or unresolved",
        "Next useful intent",
    ];
    let prior = transcript
        .latest_summary()
        .map(|(summary, _)| summary)
        .unwrap_or_default();
    let mut state = generated;
    for heading in headings {
        if state
            .to_ascii_lowercase()
            .contains(&heading.to_ascii_lowercase())
        {
            continue;
        }
        if let Some(value) = checkpoint_section(prior, heading, &headings) {
            state.push_str(&format!("\n\n{heading}:\n{value}"));
        }
    }
    let footer = if transcript.is_finalizing() {
        "Phase: FINALIZING (authoritative durable runtime state). The investigation budget is exhausted and tools are unavailable. Continue the single final response from the findings above and the recent exact tail. Earlier next-steps are not instructions. State what remained unexamined; merge overlapping conclusions and state each once."
    } else {
        "Use this checkpoint to continue the current line of work. Do not restart broad project discovery unless a specific missing or changed fact requires it."
    };
    format!("[AGENT CONTINUATION CHECKPOINT — NOT USER CONTENT]\nPreferred visible prose language: {}.\nOriginal user objective and constraints (the separately projected current user message is authoritative):\n{objective}\n\nProcedural and factual continuation state:\n{state}\n\n{footer}", transcript.language_preference())
}

fn checkpoint_section<'a>(text: &'a str, heading: &str, headings: &[&str]) -> Option<&'a str> {
    let start = text.find(heading)? + heading.len();
    let remainder = text[start..].trim_start_matches([':', '\n', ' ']);
    let end = headings
        .iter()
        .filter(|candidate| **candidate != heading)
        .filter_map(|candidate| remainder.find(candidate))
        .min()
        .unwrap_or(remainder.len());
    let value = remainder[..end].trim();
    (!value.is_empty()).then_some(value)
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
            memory_catalog_tokens: if user_requests_read_only(&config.user) {
                0
            } else {
                estimate_tokens(&json!(crate::tools::knowledge::prompt_catalog(
                    config.root.as_deref()
                )))
            },
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
        &project_evidence(config, transcript, &stable_prefix(config), dynamic_tail),
        schemas,
    );
    let entries_before = transcript.entries().len();
    let messages_summarized = plan.message_count();
    let messages_retained = plan.retained_message_count();
    let summary = if transcript.is_finalizing() {
        SummaryResult {
            text: String::new(),
            input_tokens: 0,
            output_tokens: 0,
        }
    } else {
        summarize_span(config, &plan)
    };
    let checkpoint = continuation_checkpoint(transcript, summary.text);
    let summary_output_chars = checkpoint.chars().count();
    trace_forensics(
        &config.run_id,
        "compaction_checkpoint",
        json!({
            "covered_entries": covers,
            "summarized_messages": messages_summarized,
            "retained_messages": messages_retained,
            "checkpoint_chars": summary_output_chars,
            "summary_input_tokens": summary.input_tokens,
            "summary_output_tokens": summary.output_tokens,
            "target_tokens": compaction_target_tokens(config.context_limit),
            "lifecycle_before":lifecycle_label(transcript),
        }),
    );
    transcript.compact(checkpoint, covers);
    trace_forensics(
        &config.run_id,
        "compaction_lifecycle",
        json!({"lifecycle_after":lifecycle_label(transcript),"boundary":covers}),
    );
    let mut messages = project_evidence(config, transcript, &stable_prefix(config), dynamic_tail);
    let folded = fold_evidence_to_target(config, transcript, schemas, &mut messages);
    trace_forensics(
        &config.run_id,
        "projection_folding",
        json!({"observations":folded,"reason":"after_semantic_compaction"}),
    );
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
        let mut messages = project(&projected_transcript, &stable_prefix(config), dynamic_tail);
        attach_historical_index(
            transcript,
            &mut messages,
            config.context_limit.saturating_div(2).min(32_000),
        );
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
            .filter(|(_, message)| {
                ToolResultPolicy::from_message(message) != ToolResultPolicy::Rehydrated
            })
            .filter_map(|(index, message)| {
                message
                    .get("content")
                    .and_then(Value::as_str)
                    .filter(|content| !content.starts_with(TOOL_RESULT_TRUNCATION_MARKER))
                    .map(|content| (index, content.to_owned()))
            })
            .max_by_key(|(_, content)| content.chars().count())?;
        let original_chars = original.chars().count();
        let original_tokens = estimate_tokens(&json!(original));
        let recovery = messages[index]
            .get("_observation_id")
            .and_then(Value::as_str)
            .map(|id| format!("\nExact historical result: observation_read(id=\"{id}\")."))
            .unwrap_or_default();
        // First try to retain as much as possible from this largest result.
        // If it alone cannot bring the projection under the target, collapse
        // it and continue with the next largest result.  Tool messages stay
        // in place, so no assistant-call/result pair is ever split.
        let mut low = 0_usize;
        let mut high = original_chars;
        let mut best = None;
        while low <= high {
            let middle = low + (high - low) / 2;
            let candidate = truncate_tool_result_content(&original, middle, &recovery);
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
        let projected =
            best.unwrap_or_else(|| truncate_tool_result_content(&original, 0, &recovery));
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

fn truncate_tool_result_content(content: &str, target_chars: usize, recovery: &str) -> String {
    if content.chars().count() <= target_chars {
        return content.to_owned();
    }
    let marker_chars = TOOL_RESULT_TRUNCATION_MARKER.chars().count() + recovery.chars().count();
    if target_chars <= marker_chars {
        return format!("{TOOL_RESULT_TRUNCATION_MARKER}{recovery}");
    }
    let preserved = target_chars.saturating_sub(marker_chars);
    let head = preserved / 2;
    let tail = preserved.saturating_sub(head);
    let chars = content.chars().collect::<Vec<_>>();
    format!(
        "{}{}{}{}",
        chars[..head].iter().collect::<String>(),
        TOOL_RESULT_TRUNCATION_MARKER,
        chars[chars.len().saturating_sub(tail)..]
            .iter()
            .collect::<String>(),
        recovery
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

fn scoped_tool_config(config: &Config, tool: &ValidatedCall) -> Result<Config, String> {
    let slot = match tool.arguments.get("project") {
        None => 1,
        Some(value) => value
            .as_u64()
            .filter(|slot| *slot == 1 || *slot == 2)
            .ok_or("project must be 1 or 2")?,
    };
    let mut scoped = config.clone();
    if slot == 2 {
        scoped.root = Some(
            config
                .secondary_root
                .clone()
                .ok_or("Project 2 is not selected")?,
        );
    }
    Ok(scoped)
}

fn project_result(
    config: &Config,
    tool: &ValidatedCall,
    mut result: (Value, Option<String>),
) -> (Value, Option<String>) {
    if config.secondary_root.is_some() && result.0.is_object() {
        let slot = tool
            .arguments
            .get("project")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        result.0["project"] = json!(slot);
        if slot == 2 {
            if let (Some(root), Some(path)) = (
                config.secondary_root.as_deref(),
                result.0.get("path").and_then(Value::as_str),
            ) {
                result.0["path"] = json!(Path::new(root).join(path).to_string_lossy());
            }
        }
    }
    result
}

fn run_tool(
    config: &Config,
    state: &mut AgentState,
    tool: &ValidatedCall,
    transcript: &Transcript,
) -> Result<(Value, Option<String>), String> {
    state.record_tool_call(&tool.name);
    run_scoped_tool(config, state, tool, transcript)
        .map(|result| project_result(config, tool, result))
}

fn run_scoped_tool(
    config: &Config,
    state: &mut AgentState,
    tool: &ValidatedCall,
    transcript: &Transcript,
) -> Result<(Value, Option<String>), String> {
    let scoped = scoped_tool_config(config, tool)?;
    let config = &scoped;
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
            let (value, changed) = apply_task_memory(state, &tool.arguments, transcript)?;
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
            if terminal_execution_failed(&value) {
                return Err(value.to_string());
            }
            if value.get("status").and_then(Value::as_str) == Some("completed")
                && validation_command(&command)
            {
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
            if matches!(name, "read_file" | "list_directory")
                && !user_requests_read_only(&config.user)
            {
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

/// Raw characters of tool-result content one provider turn may add, derived
/// from the context window. A result is later serialized twice (as a JSON
/// tool result, then inside the request), which inflates quotes and newlines by
/// roughly 1.8x, and the runtime estimates three serialized characters per
/// token. So a single result may use about a quarter of the window in raw
/// characters and a whole turn about two thirds, which is roughly 15% and 40%
/// of the window in estimated tokens. Parallel results share the turn budget
/// (water-filling: small results take what they need, large ones split the
/// rest), so a burst of reads can never exceed the window and force a
/// compaction that cannot fit or a run that dies of `context_budget`. A result
/// cut by the budget is reported as truncated with its continuation offset,
/// exactly like a result cut by the tool maximum.
struct TurnBudget {
    per_result: usize,
    remaining: usize,
}

impl TurnBudget {
    const MIN_RESULT_CHARS: usize = 2_000;

    fn new(context_limit: usize) -> Self {
        let per_result = (context_limit / 4).clamp(4_000, 64 * 1024);
        Self {
            per_result,
            remaining: (context_limit * 2 / 3).max(per_result),
        }
    }

    /// Limit for the next single result.
    fn next_limit(&self) -> usize {
        self.per_result
            .min(self.remaining)
            .max(Self::MIN_RESULT_CHARS)
    }

    /// Draws the budget down by a serialized result (about 1.8 serialized
    /// characters per raw character).
    fn spend(&mut self, serialized_chars: usize) {
        self.remaining = self.remaining.saturating_sub(serialized_chars * 5 / 9);
    }

    /// Limits for results that will be produced together, given how much each
    /// would like to return.
    fn allocate(&self, demands: &[usize]) -> Vec<usize> {
        let mut order = (0..demands.len()).collect::<Vec<_>>();
        order.sort_by_key(|index| demands[*index]);
        let mut limits = vec![0; demands.len()];
        let mut budget = self.remaining;
        let mut left = demands.len();
        for index in order {
            let share = (budget / left.max(1)).max(Self::MIN_RESULT_CHARS);
            let grant = demands[index]
                .min(self.per_result)
                .min(share)
                .max(Self::MIN_RESULT_CHARS.min(demands[index]));
            limits[index] = grant;
            budget = budget.saturating_sub(grant);
            left -= 1;
        }
        limits
    }

    /// The call as it will be executed: model arguments plus the runtime's
    /// internal result limit. The transcript keeps the call exactly as the
    /// model issued it.
    fn adjust(&self, tool: &ValidatedCall, limit: usize) -> ValidatedCall {
        let mut adjusted = tool.clone();
        if let Some(arguments) = adjusted.arguments.as_object_mut() {
            match tool.name.as_str() {
                "read_file" => {
                    arguments.insert("_result_limit_bytes".into(), json!(limit));
                }
                "observation_read" => {
                    let requested = arguments
                        .get("max_chars")
                        .and_then(Value::as_u64)
                        .map_or(8_000, |value| value as usize);
                    arguments.insert("max_chars".into(), json!(requested.min(limit)));
                }
                _ => {}
            }
        }
        adjusted
    }
}

fn safe_read_only_tool(name: &str) -> bool {
    matches!(
        name,
        "read_file" | "list_directory" | "project_knowledge_index" | "project_knowledge_read"
    )
}

fn can_parallelize_safe_read(
    call: &ValidatedCall,
    prior_batch: &[ValidatedCall],
    transcript: &Transcript,
    project_root: Option<&Path>,
) -> bool {
    if call.name != "read_file" {
        return true;
    }
    if repeated_file_read_decision(call, transcript, project_root).is_err() {
        return false;
    }
    let Some(path) = call.arguments.get("path").and_then(Value::as_str) else {
        return true;
    };
    !prior_batch.iter().any(|prior| {
        prior.name == "read_file"
            && prior.arguments.get("path").and_then(Value::as_str) == Some(path)
    })
}

fn terminal_execution_failed(value: &Value) -> bool {
    if value.get("error").is_some()
        || value
            .get("timed_out")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || value
            .get("cancelled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return true;
    }
    let exit_code = value.get("exit_code").and_then(Value::as_i64);
    match value.get("status").and_then(Value::as_str) {
        Some("completed") => exit_code != Some(0),
        Some("partial_success") => {
            let statuses = value.get("pipeline_statuses").and_then(Value::as_array);
            exit_code != Some(141)
                || statuses != Some(&vec![json!(141), json!(0)])
                || value
                    .get("stdout")
                    .and_then(Value::as_str)
                    .is_none_or(|stdout| stdout.trim().is_empty())
        }
        _ => true,
    }
}

/// Executes only deterministic inspection tools. Runtime-owned observation
/// writes and diagnostics are deliberately applied after the concurrent reads
/// complete, in original call order.
fn run_safe_read_tool(
    config: &Config,
    tool: &ValidatedCall,
) -> Result<(Value, Option<String>), String> {
    run_scoped_read_tool(config, tool).map(|result| project_result(config, tool, result))
}

fn run_scoped_read_tool(
    config: &Config,
    tool: &ValidatedCall,
) -> Result<(Value, Option<String>), String> {
    let scoped = scoped_tool_config(config, tool)?;
    let config = &scoped;
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
    let Ok(scoped) = scoped_tool_config(config, tool) else {
        return;
    };
    let config = &scoped;
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
            if !user_requests_read_only(&config.user) {
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

enum FinalCandidateReview {
    Accept,
    ValidationPending,
    /// One bounded reminder naming concrete, mechanically known local files
    /// that sources actually request but that were never opened.
    UnopenedRequests(String),
    /// Deep only: one bounded reminder naming unresolved Task Memory items.
    OpenUnknowns(String),
}

/// A tool-free response completes the run. The only deviations are the
/// post-mutation validation reminder and one bounded reminder when the draft
/// would finish while sources the run read still request local files that were
/// never opened. Neither can repeat, so neither can deadlock a final answer.
fn review_tool_free_final(
    state: &mut AgentState,
    transcript: &mut Transcript,
    ledger: &Ledger,
) -> FinalCandidateReview {
    if transcript.is_finalizing() {
        return FinalCandidateReview::Accept;
    }
    if add_soft_closeout_if_needed(state, transcript) {
        return FinalCandidateReview::ValidationPending;
    }
    let requests = ledger.unopened_requests();
    if !state.request_review_given && !requests.is_empty() {
        state.request_review_given = true;
        let listed = requests
            .iter()
            .take(4)
            .map(|lead| {
                format!(
                    "{} (requested as '{}' by {})",
                    lead.target,
                    lead.literal,
                    lead.from.join(", ")
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        return FinalCandidateReview::UnopenedRequests(format!("Before finishing: sources you read request or submit to local files you have not opened: {listed}. If what you are about to claim depends on one of them (for example what it does, or whether the service behind a call exists), inspect it now. Otherwise finish, and state plainly that you did not inspect it instead of describing its behavior."));
    }
    if !state.convergence_review_given {
        if let Some(review) = strategy::convergence_review(state.strategy, &state.task_memory) {
            state.convergence_review_given = true;
            return FinalCandidateReview::OpenUnknowns(review);
        }
    }
    FinalCandidateReview::Accept
}

pub fn run(config: Config) {
    let mut transcript = if let Some(dir) = &config.evidence_dir {
        match Transcript::durable(
            &PathBuf::from(dir),
            &config.run_id,
            &config.history,
            config.root.as_deref(),
        ) {
            Ok(transcript) => transcript,
            Err(error) => {
                emit(
                    &config.run_id,
                    Event::AgentError {
                        code: "evidence_store".into(),
                        message: error,
                    },
                );
                return;
            }
        }
    } else {
        let mut transcript = Transcript::default();
        transcript.set_project_root(config.root.as_deref().map(std::path::Path::new));
        for message in config.history.clone() {
            transcript.push_message(message);
        }
        transcript
    };
    if !transcript.has_current_run_user(&config.user) {
        transcript.push_run_user(json!({"role":"user", "content":config.user}));
    }
    let mut state = AgentState::default();
    state.strategy = Strategy::from_mode(&config.reasoning_mode);
    state.task_memory = match restore_task_memory(config.task_memory.as_ref(), &transcript) {
        Ok(memory) => memory,
        Err(message) => {
            emit(
                &config.run_id,
                Event::AgentError {
                    code: "task_memory".into(),
                    message,
                },
            );
            return;
        }
    };
    if !user_requests_read_only(&config.user) {
        if let Some(root) = config.root.as_deref() {
            let _ = crate::tools::knowledge::bootstrap(&PathBuf::from(root));
        }
    }
    let budget = CompactionBudget {
        context_window: config.context_limit,
        ratio: DEFAULT_COMPACTION_RATIO,
        reserve_tokens: None,
    };
    let stable = stable_prefix(&config);
    transcript.set_secondary_project_root(config.secondary_root.as_deref().map(Path::new));
    let mut schemas = tool_schemas_for_request(config.root.is_some(), config.policy, &config.user);
    if config.secondary_root.is_some() {
        for schema in &mut schemas {
            if !matches!(
                tool_name(schema),
                "task_memory" | "observation_read" | "observation_index"
            ) {
                schema["function"]["parameters"]["properties"]["project"] = json!({"type":"integer","enum":[1,2],"description":"Selected project slot. 1 is the primary root; 2 is the secondary root. Defaults to 1."});
            }
        }
    }
    let mut final_content = String::new();
    let mut visible_final_content = String::new();
    let mut continuation_count = 0_usize;
    let mut continuation_pending = false;
    let mut overflow_attempts = 0_usize;
    let mut compaction_index = 0_usize;
    let mut last_compaction: Option<(usize, usize)> = None;
    let mut tool_result_tokens_since_compaction = 0_usize;
    // Observations already shown as receipts stay receipts (see `apply_folds`).
    let mut sticky_folds: std::collections::HashSet<String> = std::collections::HashSet::new();
    // An emergency tool-result reduction belongs only to the next provider
    // projection. The append-only transcript remains verbatim.
    let mut pending_fitted_projection: Option<Vec<Value>> = None;
    let project_root = config
        .root
        .as_deref()
        .and_then(|root| Path::new(root).canonicalize().ok());
    let mut project_index = project_root
        .as_deref()
        .map_or_else(ProjectIndex::empty, ProjectIndex::scan);
    let mut indexed_mutations = state.mutations;
    let empty_schemas: Vec<Value> = Vec::new();
    let mut consecutive_empty_turns = 0_usize;

    emit(
        &config.run_id,
        Event::AgentStarted {
            run_id: config.run_id.clone(),
        },
    );
    emit_knowledge_diagnostics(&config, &state);
    for turn in 0..MAX_INVESTIGATION_TURNS + MAX_SYNTHESIS_TURNS {
        if let Some(error) = transcript.storage_error() {
            emit(
                &config.run_id,
                Event::AgentError {
                    code: "evidence_store".into(),
                    message: error.into(),
                },
            );
            return;
        }
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
                transcript.push_steering(content.clone());
                emit(&config.run_id, Event::SteeringApplied { content });
            }
        }
        if turn >= MAX_INVESTIGATION_TURNS && !transcript.is_finalizing() {
            transcript.mark_finalizing();
            trace_forensics(
                &config.run_id,
                "lifecycle_transition",
                json!({"state":"finalizing","reason":"turn_budget_exhausted","turn":turn+1}),
            );
        }
        let request_schemas = if transcript.is_finalizing() {
            &empty_schemas
        } else {
            &schemas
        };
        if state.mutations != indexed_mutations {
            if let Some(root) = project_root.as_deref() {
                project_index = ProjectIndex::scan(root);
            }
            indexed_mutations = state.mutations;
        }
        let ledger = project_root
            .as_deref()
            .map(|root| Ledger::build(&transcript, root, &project_index))
            .unwrap_or_default();
        let investigation = ledger.render_for(
            config.context_limit.saturating_div(16).clamp(1_500, 6_000),
            !transcript.is_finalizing(),
        );
        let dynamic = dynamic_tail(
            &state,
            config.root.as_deref(),
            &config.user,
            &transcript,
            &investigation,
        );
        trace_forensics(
            &config.run_id,
            "investigation_state",
            json!({"turn":turn+1,"read":ledger.read.len(),"listed_with_unopened":ledger.listed.len(),"leads":ledger.leads.len(),"unopened_requests":ledger.unopened_requests().len(),"failed":ledger.failed.len(),"chars":investigation.chars().count(),"lifecycle":lifecycle_label(&transcript)}),
        );
        let pending_tail = transcript.pending_tail(&dynamic);
        let sent_tail = if transcript.has_active_prompt_tail(&pending_tail) {
            String::new()
        } else {
            pending_tail
        };
        let mut messages = pending_fitted_projection
            .take()
            .unwrap_or_else(|| project_evidence(&config, &transcript, &stable, &sent_tail));
        apply_folds(&transcript, &mut messages, &sticky_folds);
        let before_budget = request_budget(&config, &messages, request_schemas);
        let folded = if needs_compaction(budget, before_budget.projected_input_tokens) {
            fold_evidence_to_target(&config, &transcript, request_schemas, &mut messages)
        } else {
            Vec::new()
        };
        sticky_folds.extend(folded_ids(&transcript, &messages));
        if !folded.is_empty() {
            trace_forensics(
                &config.run_id,
                "projection_folding",
                json!({
                    "turn":turn+1,"observations":folded,"before_tokens":before_budget.projected_input_tokens,
                    "after_tokens":request_budget(&config, &messages, request_schemas).projected_input_tokens
                }),
            );
        }
        let requested_max_output = config
            .provider_max_output
            .unwrap_or(APPLICATION_MAX_OUTPUT_TOKENS)
            .min(APPLICATION_MAX_OUTPUT_TOKENS);
        let mut current_budget = request_budget(&config, &messages, request_schemas);
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
        trace_projection(&config.run_id, &transcript, &messages, projected);
        let payload = request_payload_for_phase(
            &config,
            &messages,
            request_schemas,
            output_limit,
            transcript.is_finalizing(),
        );
        trace_forensics(
            &config.run_id,
            "agent_request_state",
            json!({
                "turn":turn + 1,
                "projected_input_tokens":projected,
                "dynamic_tail_chars":dynamic.chars().count(),
                "task_memory_entries":state.task_memory.entries.iter().filter(|entry| !entry.invalidated).count(),
                "lifecycle":lifecycle_label(&transcript),
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
        state.memory_writes_this_turn = 0;
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
            turn + 1,
            &config.cancelled,
            !continuation_pending,
            false,
        ) {
            Ok(streamed) => {
                overflow_attempts = 0;
                if let Some(actual) = streamed.prompt_tokens {
                    learn_token_calibration(projected, actual as usize);
                }
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
                    request_schemas,
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
                if !streamed.content.is_empty() || !streamed.reasoning_raw.trim().is_empty() {
                    transcript
                        .assistant_message_with_reasoning(streamed.content, streamed.reasoning_raw);
                }
                emit(
                    &config.run_id,
                    Event::ToolError {
                        id: "protocol".into(),
                        name: "tool_protocol".into(),
                        message: error.clone(),
                    },
                );
                transcript.remind(if transcript.is_finalizing() {
                    format!("The previous tool call was not executed ({error}). Tools are unavailable: write the final answer now as plain text.")
                } else {
                    format!("The previous tool call was not executed because it was incomplete or malformed: {error}. Emit one complete valid tool call, or answer without tools.")
                });
                continue;
            }
        };
        if !calls.is_empty() || !streamed.content.trim().is_empty() {
            consecutive_empty_turns = 0;
        }
        if calls.is_empty() && streamed.content.trim().is_empty() && !was_continuation {
            // Nothing was said and nothing was called (for example a tool call
            // written inside the reasoning stream, which is never executed).
            // That is not an answer and must not complete the run.
            consecutive_empty_turns += 1;
            trace_forensics(
                &config.run_id,
                "empty_response",
                json!({"turn":turn+1,"finish_reason":streamed.finish_reason,"consecutive":consecutive_empty_turns,"reasoning_chars":streamed.reasoning_raw.chars().count()}),
            );
            if streamed.reasoning_markup_filter.hid_markup {
                emit(
                    &config.run_id,
                    Event::ToolError {
                        id: "protocol".into(),
                        name: "tool_protocol".into(),
                        message: "The provider emitted a tool call inside its reasoning stream; no structured tool call was executed".into(),
                    },
                );
            }
            // The turn happened. Recording what the model reasoned lets the
            // retry continue from it instead of regenerating it from nothing.
            if !streamed.reasoning_raw.trim().is_empty() {
                transcript.assistant_message_with_reasoning(String::new(), streamed.reasoning_raw);
            }
            if consecutive_empty_turns >= MAX_CONSECUTIVE_EMPTY_TURNS && !transcript.is_finalizing()
            {
                transcript.mark_finalizing();
            }
            transcript.remind(if transcript.is_finalizing() {
                "The previous response was empty. Tools are unavailable: write the final answer now as plain text.".into()
            } else if streamed.finish_reason == "length" {
                "The previous response used its entire output budget without a tool call or an answer. Think less: either make one structured tool call or write the answer.".into()
            } else {
                "The previous response contained neither an answer nor a structured tool call (a call written inside reasoning is not executed). Make one structured tool call, or write the answer.".into()
            });
            continue;
        }
        if calls.is_empty() {
            {
                let queue = config.steering.lock().expect("steering lock");
                if !queue.is_empty() {
                    transcript.assistant_message_with_reasoning(
                        streamed.content.clone(),
                        streamed.reasoning.clone(),
                    );
                    emit_status(&config.run_id, &streamed.content);
                    continue;
                }
            }
            if unstructured_tool_call_content(&streamed.content) {
                transcript.assistant_withheld_draft(
                    streamed.content,
                    "unstructured provider tool-call markup",
                );
                emit(
                    &config.run_id,
                    Event::ToolError {
                        id: "protocol".into(),
                        name: "tool_protocol".into(),
                        message: "The provider emitted tool-call markup as ordinary content; no structured tool call was executed".into(),
                    },
                );
                transcript.remind(if transcript.is_finalizing() {
                    "The previous response contained textual tool-call markup, which was not executed. Tools are unavailable: write the final answer now as plain text.".into()
                } else {
                    "The previous response contained textual tool-call markup, which was not executed. Emit a complete structured tool call, or answer normally without tool markup.".into()
                });
                continue;
            }
            if was_continuation {
                let prefix = final_content.clone();
                let accepted = append_continuation_text(&mut final_content, &streamed.content);
                streamed.content = accepted.clone();
                let visible = present_answer(&accepted, &prefix, &transcript, &state);
                visible_final_content.push_str(&visible);
                emit_accepted_final_content(&config.run_id, &visible);
                continuation_pending = false;
            }
            trace_forensics(
                &config.run_id,
                "final_attempt",
                json!({"turn":turn+1,"finish_reason":streamed.finish_reason,"phase":lifecycle_label(&transcript),"continuation_pending":was_continuation}),
            );
            if streamed.finish_reason == "length" {
                if !was_continuation {
                    let visible = present_answer(&streamed.content, "", &transcript, &state);
                    visible_final_content.push_str(&visible);
                    emit_accepted_final_content(&config.run_id, &visible);
                }
                if !was_continuation {
                    append_final_text(&mut final_content, &streamed.content);
                }
                transcript
                    .assistant_message_with_reasoning(streamed.content, streamed.reasoning_raw);
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
                transcript.mark_finalizing();
                trace_forensics(
                    &config.run_id,
                    "finalization_transition",
                    json!({"state":"finalizing","turn":turn+1}),
                );
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
            match review_tool_free_final(&mut state, &mut transcript, &ledger) {
                FinalCandidateReview::ValidationPending => {
                    transcript.assistant_withheld_draft(streamed.content, "pending validation");
                    continue;
                }
                FinalCandidateReview::UnopenedRequests(nudge) => {
                    trace_forensics(
                        &config.run_id,
                        "completion_review",
                        json!({"decision":"unopened_requests","turn":turn+1,"targets":ledger.unopened_requests().iter().map(|lead| lead.target.clone()).collect::<Vec<_>>()}),
                    );
                    transcript.assistant_withheld_draft(
                        streamed.content,
                        "unopened requested local files",
                    );
                    transcript.remind(nudge);
                    continue;
                }
                FinalCandidateReview::OpenUnknowns(nudge) => {
                    trace_forensics(
                        &config.run_id,
                        "completion_review",
                        json!({"decision":"open_unknowns","turn":turn+1,"unknowns":strategy::open_unknowns(&state.task_memory)}),
                    );
                    transcript
                        .assistant_withheld_draft(streamed.content, "unresolved task memory items");
                    transcript.remind(nudge);
                    continue;
                }
                FinalCandidateReview::Accept => {}
            }
            {
                let queue = config.steering.lock().expect("steering lock");
                if !queue.is_empty() {
                    transcript.assistant_message_with_reasoning(
                        streamed.content.clone(),
                        streamed.reasoning.clone(),
                    );
                    emit_status(&config.run_id, &streamed.content);
                    continue;
                }
                config.steering_closed.store(true, Ordering::Relaxed);
            }
            if !was_continuation {
                let visible = present_answer(&streamed.content, "", &transcript, &state);
                visible_final_content.push_str(&visible);
                emit_accepted_final_content(&config.run_id, &visible);
            }
            if !was_continuation {
                append_final_text(&mut final_content, &streamed.content);
            }
            transcript.assistant_message_with_reasoning(streamed.content, streamed.reasoning_raw);
            transcript.mark_run_complete();
            trace_forensics(
                &config.run_id,
                "finalization_transition",
                json!({"state":"complete","turn":turn+1}),
            );
            if let Some(error) = transcript.storage_error() {
                emit(
                    &config.run_id,
                    Event::AgentError {
                        code: "evidence_store".into(),
                        message: error.into(),
                    },
                );
                return;
            }
            if let Err(error) =
                transcript.finish_durable(&config.history, &config.user, &visible_final_content)
            {
                emit(
                    &config.run_id,
                    Event::AgentError {
                        code: "evidence_store".into(),
                        message: error,
                    },
                );
                return;
            }
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
        emit_status(&config.run_id, &streamed.content);
        let canonical_content = streamed.content.clone();
        transcript.assistant_tool_turn_with_reasoning(
            streamed.content,
            streamed.reasoning_raw,
            &calls,
        );
        trace_forensics(
            &config.run_id,
            "canonical_assistant_tool_turn",
            json!({"content_chars":canonical_content.chars().count(),"calls":calls.iter().map(|call| json!({"id":call.id,"name":call.name})).collect::<Vec<_>>() }),
        );
        let mut budget = TurnBudget::new(config.context_limit);
        let mut call_index = 0_usize;
        while call_index < calls.len() {
            if !transcript.is_finalizing()
                && can_parallelize_safe_read(
                    &calls[call_index],
                    &[],
                    &transcript,
                    config.root.as_deref().map(std::path::Path::new),
                )
                && safe_read_only_tool(&calls[call_index].name)
                && schemas
                    .iter()
                    .any(|schema| tool_name(schema) == calls[call_index].name)
            {
                let start = call_index;
                while call_index < calls.len() {
                    let candidate = &calls[call_index];
                    if !safe_read_only_tool(&candidate.name)
                        || !schemas
                            .iter()
                            .any(|schema| tool_name(schema) == candidate.name)
                        || !can_parallelize_safe_read(
                            candidate,
                            &calls[start..call_index],
                            &transcript,
                            config.root.as_deref().map(std::path::Path::new),
                        )
                    {
                        break;
                    }
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
                let demands = batch
                    .iter()
                    .map(|tool| {
                        let natural = (tool.name == "read_file")
                            .then(|| {
                                let path = tool.arguments.get("path")?.as_str()?;
                                let root = project_root.as_deref()?;
                                std::fs::metadata(root.join(path))
                                    .ok()
                                    .map(|m| m.len() as usize)
                            })
                            .flatten();
                        natural.unwrap_or(TurnBudget::MIN_RESULT_CHARS)
                    })
                    .collect::<Vec<_>>();
                let limited = batch
                    .iter()
                    .zip(budget.allocate(&demands))
                    .map(|(tool, limit)| budget.adjust(tool, limit))
                    .collect::<Vec<_>>();
                let results = std::thread::scope(|scope| {
                    let handles = limited
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
                    state.record_tool_call(&tool.name);
                    match result {
                        Ok((value, diff)) => {
                            record_safe_read_effect(&config, &mut state, tool, &value);
                            let content = value.to_string();
                            budget.spend(content.chars().count());
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
                            transcript.tool_result(&tool.id, &tool.name, content.clone());
                            record_read_evidence(&config, &transcript, tool);
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
                            record_read_evidence(&config, &transcript, tool);
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
            if !request_schemas
                .iter()
                .any(|schema| tool_name(schema) == tool.name)
            {
                let message = if transcript.is_finalizing() {
                    format!("Tool '{}' is unavailable: the investigation budget for this run is exhausted. Write the final answer now from the findings already in context.", tool.name)
                } else {
                    format!("tool '{}' is unavailable", tool.name)
                };
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
            if !transcript.is_finalizing() {
                if let Err(message) = repeated_file_read_decision(
                    tool,
                    &transcript,
                    config.root.as_deref().map(std::path::Path::new),
                ) {
                    trace_forensics(
                        &config.run_id,
                        "repeated_read_decision",
                        json!({"decision":"redirected","tool":tool.name,"reason":message}),
                    );
                    emit(
                        &config.run_id,
                        Event::ToolError {
                            id: tool.id.clone(),
                            name: tool.name.clone(),
                            message: message.clone(),
                        },
                    );
                    transcript.inline_tool_result(
                        &tool.id,
                        &tool.name,
                        concise_tool_error(&message),
                    );
                    continue;
                }
            }
            if policy::requires_approval_in_root(
                config.policy,
                &tool.name,
                &tool.arguments,
                config.root.as_deref().map(std::path::Path::new),
            ) {
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
                    concise_tool_error(if tool.name == "run_terminal" && tool.arguments.get("command").and_then(Value::as_str).is_some_and(|c| c.contains("git ")) {
                        "approval required for shell composition. For read-only history, retry as one scoped command: git -C <selected-project> log --oneline -30. Do not treat this attempt as evidence of repository history."
                    } else { "approval required" }),
                );
                continue;
            }
            emit(
                &config.run_id,
                Event::RunState {
                    state: "working".into(),
                },
            );
            let adjusted = budget.adjust(tool, budget.next_limit());
            let tool = &adjusted;
            let outcome = match tool.name.as_str() {
                "observation_index" => Ok((
                    transcript.observation_index(
                        tool.arguments
                            .get("offset")
                            .and_then(Value::as_u64)
                            .unwrap_or(0) as usize,
                        tool.arguments
                            .get("limit")
                            .and_then(Value::as_u64)
                            .unwrap_or(20) as usize,
                    ),
                    None,
                )),
                "observation_read" => transcript
                    .read_observation(
                        tool.arguments
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        tool.arguments
                            .get("offset_chars")
                            .and_then(Value::as_u64)
                            .unwrap_or(0) as usize,
                        tool.arguments
                            .get("max_chars")
                            .and_then(Value::as_u64)
                            .unwrap_or(8_000) as usize,
                    )
                    .map(|value| (value, None)),
                "task_memory"
                    if matches!(
                        tool.arguments.get("action").and_then(Value::as_str),
                        Some("update" | "record") | None
                    ) =>
                {
                    if let Some(conflict) =
                        task_memory_conflict(&state, &transcript, &tool.arguments)
                    {
                        Err(conflict)
                    } else {
                        run_tool(&config, &mut state, tool, &transcript)
                    }
                }
                _ => run_tool(&config, &mut state, tool, &transcript),
            };
            match outcome {
                Ok((value, diff)) => {
                    let content = value.to_string();
                    budget.spend(content.chars().count());
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
                    if tool.name == "observation_read" {
                        let source_id = value
                            .pointer("/observation/id")
                            .or_else(|| tool.arguments.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let offset = tool
                            .arguments
                            .get("offset_chars")
                            .and_then(Value::as_u64)
                            .unwrap_or(0) as usize;
                        let limit = tool
                            .arguments
                            .get("max_chars")
                            .and_then(Value::as_u64)
                            .unwrap_or(8_000) as usize;
                        transcript.rehydrated_tool_result(
                            &tool.id, &tool.name, source_id, offset, limit, &value,
                        );
                    } else if tool.name == "observation_index" {
                        transcript.inline_tool_result(&tool.id, &tool.name, content);
                    } else {
                        transcript.tool_result(&tool.id, &tool.name, content.clone());
                    }
                    record_read_evidence(&config, &transcript, tool);
                }
                Err(message) => {
                    emit(
                        &config.run_id,
                        Event::ToolError {
                            id: tool.id.clone(),
                            name: tool.name.clone(),
                            message: concise_tool_error(&message),
                        },
                    );
                    let stored_error = if tool.name == "run_terminal" {
                        serde_json::from_str::<Value>(&message)
                            .map(|execution| {
                                json!({"error":"terminal execution failed","execution":execution})
                                    .to_string()
                            })
                            .unwrap_or_else(|_| concise_tool_error(&message))
                    } else {
                        concise_tool_error(&message)
                    };
                    if matches!(tool.name.as_str(), "observation_read" | "observation_index") {
                        transcript.inline_tool_result(&tool.id, &tool.name, stored_error);
                    } else {
                        transcript.tool_result(&tool.id, &tool.name, stored_error);
                    }
                    record_read_evidence(&config, &transcript, tool);
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
    fn parallel_reads_route_repeated_successes_and_missing_paths_through_the_guard() {
        let base = std::env::temp_dir().join(format!(
            "parallel-read-guard-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let root = base.join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let existing = "src/current.ts";
        let missing = "src/missing.ts";
        let novel = "src/novel.ts";
        std::fs::write(root.join(existing), "export const current = true;").unwrap();
        std::fs::write(root.join(novel), "export const novel = true;").unwrap();

        let mut transcript =
            Transcript::durable(&base.join("store"), "run", &[], root.to_str()).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit source"}));
        let first_calls = [
            ValidatedCall {
                id: "first-existing".into(),
                name: "read_file".into(),
                arguments: json!({"path":existing}),
            },
            ValidatedCall {
                id: "first-missing".into(),
                name: "read_file".into(),
                arguments: json!({"path":missing}),
            },
        ];
        transcript.assistant_tool_turn(String::new(), &first_calls);
        transcript.tool_result(
            "first-existing",
            "read_file",
            json!({"path":existing,"content":"export const current = true;"}).to_string(),
        );
        transcript.tool_result(
            "first-missing",
            "read_file",
            json!({"path":missing,"error":"file not found"}).to_string(),
        );

        let repeated_existing = ValidatedCall {
            id: "repeat-existing".into(),
            name: "read_file".into(),
            arguments: json!({"path":existing}),
        };
        let repeated_missing = ValidatedCall {
            id: "repeat-missing".into(),
            name: "read_file".into(),
            arguments: json!({"path":missing}),
        };
        let new_source = ValidatedCall {
            id: "new-source".into(),
            name: "read_file".into(),
            arguments: json!({"path":novel}),
        };
        assert!(!can_parallelize_safe_read(
            &repeated_existing,
            &[],
            &transcript,
            Some(&root)
        ));
        assert!(!can_parallelize_safe_read(
            &repeated_missing,
            &[],
            &transcript,
            Some(&root)
        ));
        assert!(can_parallelize_safe_read(
            &new_source,
            &[],
            &transcript,
            Some(&root)
        ));
        assert!(!can_parallelize_safe_read(
            &new_source,
            std::slice::from_ref(&new_source),
            &transcript,
            Some(&root)
        ));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn openai_stream_tool_call_ids_are_preserved_across_turns() {
        let mut first = StreamedTurn::default();
        let mut first_frame = format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-first","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"src/App.tsx\"}"}}]}}]})
        );
        consume_sse(&mut first_frame, &mut first, "run", false, false).unwrap();
        let first_id = first.calls[&0]["id"].as_str().unwrap();

        let mut second = StreamedTurn::default();
        let mut second_frame = format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-second","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"src/App.tsx\"}"}}]}}]})
        );
        consume_sse(&mut second_frame, &mut second, "run", false, false).unwrap();
        let second_id = second.calls[&0]["id"].as_str().unwrap();

        assert_ne!(first_id, second_id);
        assert_eq!(first_id, "call-first");
        assert_eq!(second_id, "call-second");
    }

    #[test]
    fn provider_usage_calibrates_the_pessimistic_token_estimate() {
        TOKEN_CALIBRATION.with(|cell| cell.set(1.0));
        learn_token_calibration(10_000, 7_000);
        let first = TOKEN_CALIBRATION.with(std::cell::Cell::get);
        assert!((first - 0.85).abs() < 1e-9, "{first}");
        assert_eq!(calibrate_estimate(1_000), 850);
        // The estimate that produced the next request was already calibrated.
        learn_token_calibration(8_500, 5_950);
        let second = TOKEN_CALIBRATION.with(std::cell::Cell::get);
        assert!(second < first && second > 0.6, "{second}");
        // A provider that reports nonsense cannot drive the estimate outside its bounds.
        learn_token_calibration(100, 1_000_000);
        assert!(TOKEN_CALIBRATION.with(std::cell::Cell::get) <= CALIBRATION_MAX);
        TOKEN_CALIBRATION.with(|cell| cell.set(1.0));
        learn_token_calibration(1_000_000, 1);
        assert!(TOKEN_CALIBRATION.with(std::cell::Cell::get) >= CALIBRATION_MIN);
        learn_token_calibration(0, 500);
        TOKEN_CALIBRATION.with(|cell| cell.set(1.0));
    }

    #[test]
    fn llama_cpp_usage_reports_total_prompt_size_and_the_reused_prefix() {
        let mut turn = StreamedTurn::default();
        let mut frames = format!(
            "data: {}\n\ndata: {}\n\n",
            json!({"choices":[{"delta":{"content":"x"}}]}),
            json!({"choices":[],"usage":{"prompt_tokens":33190,"completion_tokens":5,"total_tokens":33195,"prompt_tokens_details":{"cached_tokens":18388}},"timings":{"cache_n":18388,"prompt_n":14802,"predicted_n":5,"predicted_ms":50.0,"predicted_per_second":100.0}})
        );
        consume_sse(&mut frames, &mut turn, "fixture", false, false).unwrap();
        assert_eq!(
            turn.prompt_tokens,
            Some(33_190),
            "evaluated tokens must not replace the input size"
        );
        assert_eq!(turn.cached_tokens, Some(18_388));
        // Without a usage block the input size is the evaluated plus the reused part.
        let mut bare = StreamedTurn::default();
        let mut frame = format!(
            "data: {}\n\n",
            json!({"choices":[],"timings":{"cache_n":100,"prompt_n":50,"predicted_n":1}})
        );
        consume_sse(&mut frame, &mut bare, "fixture", false, false).unwrap();
        assert_eq!(bare.prompt_tokens, Some(150));
    }

    #[test]
    fn finalizing_provider_payload_disables_supported_reasoning() {
        let mut config = test_config(32_768);
        config.reasoning_mode = "deep".into();
        config.reasoning_options = Some(json!({
            "fast":{"reasoning_effort":"low"},
            "deep":{"reasoning_effort":"high"},
            "final":{"reasoning_effort":"low"}
        }));
        let messages = vec![json!({"role":"user","content":"answer"})];
        let openai = request_payload_for_phase(&config, &messages, &[], 1_024, false);
        let final_openai = request_payload_for_phase(&config, &messages, &[], 1_024, true);
        assert_eq!(openai["reasoning_effort"], "high");
        assert_eq!(final_openai["reasoning_effort"], "low");

        config.supports_reasoning = false;
        let unsupported = request_payload_for_phase(&config, &messages, &[], 1_024, true);
        assert!(unsupported.get("reasoning_effort").is_none());
    }

    #[test]
    fn reasoning_markup_filter_handles_split_tool_tags_and_keeps_surrounding_text() {
        let mut filter = ReasoningMarkupFilter::default();
        let mut visible = String::new();
        for delta in [
            "Analysis before <tool_",
            "call>read_file<arg_key>path</arg_key>",
            "<arg_value>secret.txt</arg_value></tool_",
            "call> then continue.",
        ] {
            visible.push_str(&filter.push(delta, false));
        }
        visible.push_str(&filter.push("", true));
        assert_eq!(visible, "Analysis before  then continue.");
    }

    #[test]
    fn a_checkpoint_cut_at_the_output_limit_says_so() {
        assert_eq!(mark_if_cut_at_output_limit("complete", "stop"), "complete");
        let cut = mark_if_cut_at_output_limit("half a sen", "length");
        assert!(cut.starts_with("half a sen\n[This checkpoint was cut"));
        assert!(cut.contains("observation_read"));
    }

    #[test]
    fn a_fragment_that_never_became_a_tool_tag_is_ordinary_reasoning_text() {
        let mut filter = ReasoningMarkupFilter::default();
        let mut visible = filter.push("compare a < b and x <tool", false);
        visible.push_str(&filter.push("", true));
        assert_eq!(visible, "compare a < b and x <tool");
        assert!(!filter.hid_markup);
        let mut unterminated = ReasoningMarkupFilter::default();
        let mut text = unterminated.push("plan <tool_call>read_file<arg_key>pa", false);
        text.push_str(&unterminated.push("", true));
        assert_eq!(text, "plan ");
        assert!(unterminated.hid_markup);
    }

    #[test]
    fn terminal_outcome_accepts_only_success_and_recognized_partial_search() {
        assert!(!terminal_execution_failed(
            &json!({"status":"completed","exit_code":0})
        ));
        assert!(!terminal_execution_failed(&json!({
            "status":"partial_success",
            "exit_code":141,
            "pipeline_statuses":[141,0],
            "stdout":"matching source line\n"
        })));
        for failure in [
            json!({"status":"error","exit_code":7,"stdout":"useful stdout"}),
            json!({"status":"error","exit_code":1,"stdout":""}),
            json!({"status":"error","error":"spawn failed"}),
            json!({"status":"timed_out","exit_code":null,"timed_out":true}),
            json!({"status":"partial_success","exit_code":141,"pipeline_statuses":[141,0],"stdout":""}),
            json!({"status":"partial_success","exit_code":141,"pipeline_statuses":[141,0,0],"stdout":"data"}),
        ] {
            assert!(terminal_execution_failed(&failure), "{failure}");
        }
    }

    #[test]
    fn historical_seo_markup_and_structured_calls_remain_distinct() {
        let mut turn = StreamedTurn::default();
        let reasoning = "Продолжаю анализ. Изучаю SEO и analytics.\n<tool_call>read_file<arg_key>path</arg_key><arg_value>ProductSEO.tsx</arg_value></tool_call>";
        let mut frames = String::new();
        for delta in [
            json!({"reasoning_content":reasoning}),
            json!({"content":"Продолжаю анализ. Изучаю SEO и analytics."}),
            json!({"tool_calls":[{"index":0,"id":"seo-1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"Product"}}]}),
            json!({"tool_calls":[{"index":0,"function":{"arguments":"SEO.tsx\"}"}}]}),
            json!({"tool_calls":[{"index":1,"id":"seo-2","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"CatalogSEO.tsx\"}"}}]}),
            json!({"tool_calls":[{"index":2,"id":"seo-3","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"canonical.ts\"}"}}]}),
        ] {
            frames.push_str(&format!(
                "data: {}\n\n",
                json!({"choices":[{"delta":delta}]})
            ));
        }
        frames.push_str(&format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]})
        ));
        consume_sse(&mut frames, &mut turn, "fixture", false, false).unwrap();
        assert!(frames.is_empty());
        assert_eq!(
            turn.reasoning,
            "Продолжаю анализ. Изучаю SEO и analytics.\n"
        );
        assert_eq!(turn.content, "Продолжаю анализ. Изучаю SEO и analytics.");
        let raw = turn.calls.into_values().collect::<Vec<_>>();
        let calls = validate_calls(&raw, Some(&turn.finish_reason)).unwrap();
        assert_eq!(
            calls
                .iter()
                .map(|call| call.arguments["path"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["ProductSEO.tsx", "CatalogSEO.tsx", "canonical.ts"]
        );
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.assistant_tool_turn(turn.content, &calls);
        for call in &calls {
            transcript.tool_result(&call.id, &call.name, "source body".into());
        }
        let before = serde_json::to_value(transcript.entries()).unwrap();
        let projected = project(&transcript, "system", "");
        assert_eq!(serde_json::to_value(transcript.entries()).unwrap(), before);
        assert!(!serde_json::to_string(&projected)
            .unwrap()
            .contains("<tool_call>"));
        for call in &calls {
            assert!(projected
                .iter()
                .any(|message| message["tool_call_id"] == call.id));
        }
    }

    #[test]
    fn content_only_tool_markup_is_not_a_tool_or_final_answer() {
        let mut turn = StreamedTurn::default();
        let mut frames = format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{"content":"<tool_call>read_file<arg_key>path</arg_key><arg_value>ProductSEO.tsx</arg_value></tool_call>"},"finish_reason":"stop"}]})
        );
        consume_sse(&mut frames, &mut turn, "fixture", false, false).unwrap();
        assert!(turn.calls.is_empty());
        assert!(unstructured_tool_call_content(&turn.content));
        assert!(!unstructured_tool_call_content(
            "A report discussing <tool_call> syntax"
        ));
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        let before = transcript.entries().len();
        transcript.assistant_withheld_draft(turn.content, "unstructured provider tool-call markup");
        let projected = project(&transcript, "system", "");
        assert!(!serde_json::to_string(&projected)
            .unwrap()
            .contains("<tool_call>"));
        assert_eq!(transcript.entries().len(), before + 1);
    }

    fn test_config(window: usize) -> Config {
        Config {
            run_id: "test".into(),
            endpoint: "http://localhost/v1/chat/completions".into(),
            model: "test".into(),
            system: "system".into(),
            user: "audit".into(),
            root: None,
            secondary_root: None,
            context_limit: window,
            reasoning_mode: "fast".into(),
            supports_reasoning: true,
            reasoning_options: None,
            policy: RunPolicy::Safe,
            history: Vec::new(),
            evidence_dir: None,
            task_memory: None,
            provider_max_output: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            steering: Arc::new(Mutex::new(Vec::new())),
            steering_closed: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn project_slots_route_reads_and_reject_missing_or_invalid_scope() {
        let base = std::env::temp_dir().join(format!("project-slots-{}", std::process::id()));
        let first = base.join("first");
        let second = base.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(first.join("identity.txt"), "first").unwrap();
        std::fs::write(second.join("identity.txt"), "second").unwrap();
        let mut config = test_config(16384);
        config.root = Some(first.to_string_lossy().into_owned());
        config.secondary_root = Some(second.to_string_lossy().into_owned());
        for (slot, expected) in [(1, "first"), (2, "second")] {
            let call = ValidatedCall {
                id: slot.to_string(),
                name: "read_file".into(),
                arguments: json!({"path":"identity.txt","project":slot}),
            };
            let (value, _) = run_safe_read_tool(&config, &call).unwrap();
            assert!(value.to_string().contains(expected));
            assert_eq!(value["project"], slot);
        }
        let invalid = ValidatedCall {
            id: "invalid".into(),
            name: "read_file".into(),
            arguments: json!({"path":"identity.txt","project":3}),
        };
        assert!(run_safe_read_tool(&config, &invalid).is_err());
        let escape = ValidatedCall {
            id: "escape".into(),
            name: "read_file".into(),
            arguments: json!({"path":"../first/identity.txt","project":2}),
        };
        assert!(run_safe_read_tool(&config, &escape).is_err());
        config.secondary_root = None;
        let absent = ValidatedCall {
            id: "absent".into(),
            name: "read_file".into(),
            arguments: json!({"path":"identity.txt","project":2}),
        };
        assert!(run_safe_read_tool(&config, &absent).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    /// Failure shape: entering synthesis because the investigation budget ended
    /// must not discard what earlier compactions preserved. The only carrier of
    /// older findings is the checkpoint, so it keeps its generated state.
    #[test]
    fn synthesis_checkpoint_keeps_generated_findings_and_drops_the_continue_discovery_footer() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.mark_finalizing();
        let checkpoint = continuation_checkpoint(
            &transcript,
            "Findings and evidence: api.php forwards orders (obs-00000007).".into(),
        );
        assert!(checkpoint.contains("Phase: FINALIZING"));
        assert!(checkpoint.contains("api.php forwards orders (obs-00000007)"));
        assert!(!checkpoint.contains("Do not restart broad project discovery"));
    }

    /// The summary request preserves the context and profile-specific
    /// finalization options used by the rest of the run.
    #[test]
    fn summary_requests_preserve_context_and_model_finalization_options() {
        let mut config = test_config(65_536);
        config.reasoning_options = Some(json!({
            "final":{"reasoning_effort":"low","chat_template_kwargs":{"enable_thinking":false}}
        }));
        let messages = vec![json!({"role":"user","content":"summarize"})];
        let payload = summary_payload(&config, &messages, 1_024);
        assert_eq!(payload["max_tokens"], 1_024);
        assert_eq!(payload["stream"], json!(true));
        assert_eq!(payload["reasoning_effort"], "low");
        assert_eq!(
            payload["chat_template_kwargs"]["enable_thinking"],
            json!(false)
        );
        assert!(payload.get("tools").is_none());
    }

    /// Failure shape: one turn of parallel reads/recoveries larger than the
    /// whole window made the compaction unable to fit and ended the run in a
    /// `context_budget` error, or forced catastrophic summaries at larger
    /// windows. The turn's results are bounded by the window instead.
    #[test]
    fn a_turns_results_are_bounded_by_the_window_and_share_the_budget() {
        let budget = TurnBudget::new(65_536);
        assert_eq!(budget.per_result, 16_384);
        assert_eq!(budget.remaining, 43_690);
        let limits = budget.allocate(&[1_000, 1_500, 100_000, 100_000]);
        assert_eq!(&limits[..2], &[1_000, 1_500], "small results are not cut");
        assert_eq!(limits[2], limits[3], "large results share what is left");
        assert!(limits.iter().sum::<usize>() <= 43_690);
        assert!(limits[2] > 15_000);

        // a small window shrinks everything proportionally but never starves a call
        let small = TurnBudget::new(16_384);
        assert_eq!(small.per_result, 4_096);
        assert!(small.allocate(&[200_000; 4]).iter().all(|l| *l >= 2_000));
        assert!(small.allocate(&[200_000; 2]).iter().sum::<usize>() <= 10_922);

        // sequential results draw the same budget down
        let mut running = TurnBudget::new(65_536);
        let first = running.next_limit();
        running.spend(first);
        running.spend(first);
        assert!(running.next_limit() <= 2_000_usize.max(43_690 - 2 * first * 5 / 9));

        let read = ValidatedCall {
            id: "r".into(),
            name: "read_file".into(),
            arguments: json!({"path": "a.ts"}),
        };
        assert_eq!(
            budget.adjust(&read, 5_000).arguments["_result_limit_bytes"],
            5_000
        );
        assert_eq!(
            read.arguments.get("_result_limit_bytes"),
            None,
            "the model's call is untouched"
        );
        let recover = ValidatedCall {
            id: "o".into(),
            name: "observation_read".into(),
            arguments: json!({"id": "obs-1", "max_chars": 16_000}),
        };
        assert_eq!(budget.adjust(&recover, 3_000).arguments["max_chars"], 3_000);
        assert_eq!(
            budget.adjust(&recover, 30_000).arguments["max_chars"],
            16_000
        );
    }

    #[test]
    fn experimental_toolset_excludes_todo_and_keeps_production_capabilities() {
        let schemas = tool_schemas(true);
        let names = schemas.iter().map(tool_name).collect::<Vec<_>>();
        assert!(!names.contains(&"todo"));
        for name in [
            "task_memory",
            "observation_index",
            "observation_read",
            "read_file",
            "list_directory",
            "run_terminal",
            "project_knowledge_index",
            "project_knowledge_read",
            "project_knowledge_update",
        ] {
            assert!(names.contains(&name), "{name}");
        }
        // The runtime does not offer ceremonies for certifying evidence or
        // requesting a lifecycle transition; completing is simply answering.
        for name in ["evidence_record", "evidence_frontier", "begin_finalization"] {
            assert!(!names.contains(&name), "{name}");
        }
        for schema in &schemas {
            let text = schema.to_string();
            assert!(!text.contains("closeout_gap"), "{text}");
            assert!(!text.contains("verification_of"), "{text}");
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
    fn task_memory_schema_exposes_parameters_at_object_root() {
        let memory = tool_schemas(true)
            .into_iter()
            .find(|tool| tool_name(tool) == "task_memory")
            .unwrap();
        let parameters = &memory["function"]["parameters"];
        assert_eq!(parameters["type"], "object");
        assert_eq!(parameters["required"], json!(["action"]));
        assert!(parameters.get("oneOf").is_none());
        assert!(parameters.get("anyOf").is_none());
        for field in [
            "action",
            "id",
            "finding",
            "evidence",
            "implication",
            "next",
            "supersedes",
            "status",
        ] {
            assert_eq!(parameters["properties"][field]["type"], "string", "{field}");
        }
    }

    #[test]
    fn provider_serialization_preserves_declared_tool_parameter_order() {
        let schemas = tool_schemas(true);
        let payload = json!({"tools": schemas});
        let wire = serde_json::to_string(&payload).unwrap();
        let decoded: Value = serde_json::from_str(&wire).unwrap();
        let memory = decoded["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool_name(tool) == "task_memory")
            .unwrap();
        // Native JSON grammars allow optional fields only in declaration order.
        // Sorting these keys moves finding/evidence before the model's entry ID.
        assert_eq!(
            memory["function"]["parameters"]["properties"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            [
                "action",
                "id",
                "finding",
                "evidence",
                "implication",
                "next",
                "supersedes",
                "status"
            ]
        );
        let read = decoded["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool_name(tool) == "read_file")
            .unwrap();
        assert_eq!(
            read["function"]["parameters"]["properties"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["path", "start_line", "end_line", "offset_chars"]
        );
    }

    #[test]
    fn task_memory_rejects_invalid_actions_and_missing_fields_without_mutation() {
        let mut state = AgentState::default();
        apply_task_memory(
            &mut state,
            &json!({"action":"record","id":"existing","finding":"preserved"}),
            &Transcript::default(),
        )
        .unwrap();
        state.calls_since_memory = 7;
        let before = state.task_memory.clone();
        for arguments in [
            json!({}),
            json!({"finding":"missing action"}),
            json!({"action":"unsupported","finding":"invalid"}),
            json!({"action":"record"}),
            json!({"action":"update","id":"existing"}),
            json!({"action":"record","finding":""}),
            json!({"action":"record","finding":42}),
            json!({"action":"invalidate"}),
            json!({"action":"invalidate","id":"unknown"}),
        ] {
            assert!(
                apply_task_memory(&mut state, &arguments, &Transcript::default()).is_err(),
                "{arguments}"
            );
            assert_eq!(state.task_memory, before);
            assert_eq!(state.memory_writes_this_turn, 1);
            assert_eq!(state.calls_since_memory, 7);
        }
    }

    #[test]
    fn saved_memory_is_not_silently_dropped_or_trusted_without_support() {
        let transcript = Transcript::default();
        assert!(restore_task_memory(Some(&json!({"entries":"invalid"})), &transcript).is_err());
        let mut saved = json!({"revision":3,"entries":[{
            "id":"old","finding":"legacy finding","status":"confirmed","evidence":""
        }]});
        assert!(restore_task_memory(Some(&saved), &transcript).is_err());
        saved["entries"][0]["invalidated"] = json!(true);
        assert_eq!(
            restore_task_memory(Some(&saved), &transcript)
                .unwrap()
                .revision,
            3
        );
        saved["entries"][0]
            .as_object_mut()
            .unwrap()
            .remove("status");
        saved["entries"][0]["invalidated"] = json!(false);
        let restored = restore_task_memory(Some(&saved), &transcript).unwrap();
        assert_eq!(restored.entries[0].status, None);
        assert_eq!(restored.revision, 3);
    }

    #[test]
    fn explicit_read_only_request_removes_project_mutations_from_toolset() {
        for prompt in ["Не изменяй файлы.", "Do not modify files."] {
            let schemas = tool_schemas_for_request(true, RunPolicy::Auto, prompt);
            let names = schemas.iter().map(tool_name).collect::<Vec<_>>();
            for name in [
                "apply_patch",
                "create_file",
                "delete_file",
                "project_knowledge_index",
                "project_knowledge_read",
                "project_knowledge_update",
                "write_file",
            ] {
                assert!(!names.contains(&name), "{prompt}: {name}");
            }
            for name in [
                "read_file",
                "list_directory",
                "run_terminal",
                "task_memory",
                "observation_read",
            ] {
                assert!(names.contains(&name), "{prompt}: {name}");
            }
        }

        let writable = tool_schemas_for_request(true, RunPolicy::Auto, "Update the project files.");
        assert!(writable.iter().any(|tool| tool_name(tool) == "write_file"));
    }

    #[test]
    fn explicit_read_only_source_inspection_does_not_write_project_knowledge() {
        let root = std::env::temp_dir().join(format!(
            "local-ai-read-only-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join(".ai-framework")).unwrap();
        std::fs::write(root.join("src/App.tsx"), "export const app = true;\n").unwrap();
        let manifest = root.join(".ai-framework/manifest.json");
        std::fs::write(&manifest, "preserve invalid metadata verbatim").unwrap();

        let mut config = test_config(65_536);
        config.root = Some(root.to_string_lossy().into_owned());
        config.user = "Не изменяй файлы.".into();
        config.policy = RunPolicy::Auto;
        let mut state = AgentState::default();
        let tail = dynamic_tail(
            &state,
            config.root.as_deref(),
            &config.user,
            &Transcript::default(),
            "",
        );
        assert!(!tail.contains("<project_knowledge_catalog>"));
        for (id, name, arguments) in [
            ("read-source", "read_file", json!({"path":"src/App.tsx"})),
            ("list-source", "list_directory", json!({"path":"src"})),
        ] {
            let call = ValidatedCall {
                id: id.into(),
                name: name.into(),
                arguments,
            };
            let (value, _) = run_tool(&config, &mut state, &call, &Transcript::default()).unwrap();
            record_safe_read_effect(&config, &mut state, &call, &value);
        }
        emit_knowledge_diagnostics(&config, &state);

        assert_eq!(
            std::fs::read_to_string(&manifest).unwrap(),
            "preserve invalid metadata verbatim"
        );
        assert_eq!(
            std::fs::read_dir(root.join(".ai-framework"))
                .unwrap()
                .count(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn evidence_identity_is_internal_to_projection_not_provider_wire() {
        let projected = vec![
            json!({"role":"tool","tool_call_id":"x","content":"result","_observation_id":"obs-1","_result_policy":"rehydrated","_rehydration":{"id":"obs-1","offset_chars":0,"max_chars":10}}),
        ];
        assert!(wire_messages(&projected)[0]
            .get("_observation_id")
            .is_none());
        let wire = wire_messages(&projected);
        assert!(wire[0].get("_result_policy").is_none());
        assert!(wire[0].get("_rehydration").is_none());
        assert_eq!(wire[0]["content"], "result");
    }

    #[test]
    fn stable_guidance_adapts_visible_language_and_uses_compact_architecture_format() {
        let mut config = test_config(65_536);
        config.user = "Проверь архитектуру проекта".into();
        let prompt = stable_prefix(&config);
        assert!(prompt.contains("latest user's language"));
        assert!(prompt.contains("streamed reasoning/progress"));
        assert!(prompt.contains("Keep code, paths, identifiers, commands"));
        assert!(prompt.contains("multiline Mermaid flowchart"));
        assert!(prompt.contains("Do not compress a diagram into one long arrow chain"));
        // Grounding is stated as principles the model applies, not as a lexical
        // grader the runtime applies to it.
        assert!(prompt.contains("Something you did not open is unknown, not absent"));
        assert!(prompt.contains("a search whose scope you can name"));
        assert!(
            prompt.contains("A failed or approval-blocked operation is a blocker, not evidence")
        );
        assert!(prompt.contains("Investigation state"));
        assert!(prompt.contains("never by observation ID"));
        assert!(!prompt.contains("meaningful terms"));
        assert!(!prompt.contains("evidence_record"));
        assert!(!prompt.contains("begin_finalization"));
        assert!(!prompt.contains("if model =="));
    }

    #[test]
    fn emergency_truncation_keeps_recovery_identity_and_pairing() {
        let config = test_config(32_768);
        let mut messages = vec![
            json!({"role":"system","content":"system"}),
            json!({"role":"user","content":"audit"}),
            json!({"role":"assistant","content":"","tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{}"}}]}),
            json!({"role":"tool","tool_call_id":"call-1","_observation_id":"obs-1","content":"x".repeat(150_000)}),
        ];
        assert!(truncate_retained_tool_result_to_fit(&config, &[], &mut messages).is_some());
        assert!(messages[3]["content"]
            .as_str()
            .unwrap()
            .contains("observation_read(id=\"obs-1\")"));
        assert_eq!(
            messages[3]["tool_call_id"],
            messages[2]["tool_calls"][0]["id"]
        );
    }

    #[test]
    fn emergency_fallback_cannot_turn_rehydrated_evidence_into_a_pointer() {
        let config = test_config(32_768);
        let exact = json!({"historical":true,"content":"ORDER_SUBMISSION_EXACT","observation":{"id":"obs-1"}}).to_string();
        let mut messages = vec![
            json!({"role":"system","content":"x".repeat(100_000)}),
            json!({"role":"user","content":"audit"}),
            json!({"role":"assistant","content":"","tool_calls":[{"id":"recover","type":"function","function":{"name":"observation_read","arguments":"{}"}}]}),
            json!({"role":"tool","tool_call_id":"recover","name":"observation_read","_result_policy":"rehydrated","content":exact}),
        ];
        assert!(truncate_retained_tool_result_to_fit(&config, &[], &mut messages).is_none());
        assert!(messages[3]["content"]
            .as_str()
            .unwrap()
            .contains("ORDER_SUBMISSION_EXACT"));
    }

    #[test]
    fn recovered_slice_reaches_the_actual_provider_payload_after_folding() {
        let base = std::env::temp_dir().join(format!(
            "local-agent-wire-recovery-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut transcript = Transcript::durable(&base, "test-run", &[], None).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.assistant_tool_turn(
            "".into(),
            &[ValidatedCall {
                id: "source-call".into(),
                name: "read_file".into(),
                arguments: json!({"path":"api.php"}),
            }],
        );
        transcript.tool_result("source-call", "read_file", "x".repeat(90_000));
        let source_id = transcript.observations()[0].id.clone();
        transcript.assistant_message("source inspected".into());
        let plan = transcript.compaction_plan(2).unwrap();
        transcript.compact("source inspected".into(), plan.covers);
        let recovered = transcript.read_observation(&source_id, 100, 32).unwrap();
        transcript.assistant_tool_turn(
            "".into(),
            &[ValidatedCall {
                id: "recover-call".into(),
                name: "observation_read".into(),
                arguments: json!({"id":source_id,"offset_chars":100,"max_chars":32}),
            }],
        );
        transcript.rehydrated_tool_result(
            "recover-call",
            "observation_read",
            &source_id,
            100,
            32,
            &recovered,
        );
        let config = test_config(32_768);
        let mut messages = project_evidence(&config, &transcript, "system", "");
        fold_to_budget(&transcript, &mut messages, 200, |m| {
            serde_json::to_string(m).unwrap().len() / 3
        });
        let payload = request_payload(&config, &messages, &[], 1_024);
        let visible = payload["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["tool_call_id"] == "recover-call")
            .unwrap();
        let exact: Value = serde_json::from_str(visible["content"].as_str().unwrap()).unwrap();
        assert_eq!(exact["content"], "x".repeat(32));
        assert!(visible.get("_result_policy").is_none());
        assert_eq!(transcript.observations().len(), 1);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn findings_and_inventory_reach_the_provider_after_compaction_without_source_replay() {
        let base = std::env::temp_dir().join(format!(
            "agent-findings-provider-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("api.php"), "<?php WorldFilia();").unwrap();
        let root = root.canonicalize().unwrap();
        let mut transcript =
            Transcript::durable(&base.join("store"), "run", &[], root.to_str()).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit backend order flow"}));
        transcript.assistant_tool_turn(
            "".into(),
            &[ValidatedCall {
                id: "read".into(),
                name: "read_file".into(),
                arguments: json!({"path":"api.php"}),
            }],
        );
        transcript.tool_result(
            "read",
            "read_file",
            json!({"path":"api.php","content":format!("api.php forwards orders to WorldFilia {}", "x".repeat(90_000)),"truncated":false,"targeted":false,"offset_chars":0}).to_string(),
        );
        let id = transcript.observations()[0].id.clone();
        for n in 0..4 {
            transcript.assistant_message(format!("later work {n}"));
        }
        transcript.mark_finalizing();
        let plan = transcript.compaction_plan(2).unwrap();
        transcript.compact("procedural checkpoint".into(), plan.covers);
        let mut state = AgentState::default();
        state
            .task_memory
            .upsert(
                None,
                "api.php forwards orders to WorldFilia".into(),
                id.clone(),
                String::new(),
                String::new(),
                None,
            )
            .unwrap();
        let config = test_config(65_536);
        let ledger = Ledger::build(&transcript, &root, &ProjectIndex::scan(&root));
        let tail = dynamic_tail(
            &state,
            None,
            "audit backend order flow",
            &transcript,
            &ledger.render(3_000),
        );
        let messages = project_evidence(
            &config,
            &transcript,
            "system",
            &transcript.pending_tail(&tail),
        );
        let payload = request_payload(&config, &messages, &[], 1_024).to_string();
        assert!(payload.contains("api.php forwards orders to WorldFilia"));
        assert!(
            payload.contains(&format!("api.php[{id}]")),
            "inventory maps source to its observation"
        );
        assert!(payload.contains("MODE: FINALIZING"));
        assert!(!payload.contains(&"x".repeat(1_000)));
        assert!(
            payload.contains("\"tools\"") == false,
            "synthesis requests carry no tools"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn stable_prefix_carries_the_selected_strategy() {
        let mut config = test_config(65_536);
        let fast = stable_prefix(&config);
        config.reasoning_mode = "deep".into();
        let deep = stable_prefix(&config);
        assert!(fast.contains("Investigation strategy: Fast"));
        assert!(!fast.contains("Investigation strategy: Deep"));
        assert!(deep.contains("Investigation strategy: Deep"));
        assert!(!deep.contains("Investigation strategy: Fast"));
    }

    #[test]
    fn deep_checkpoint_and_unknowns_reach_the_tail_only_for_deep() {
        let mut state = AgentState::default();
        state
            .task_memory
            .upsert_with_status(
                None,
                "what the handler forwards to".into(),
                String::new(),
                String::new(),
                "open the handler".into(),
                None,
                Some(crate::agent::task_memory::Status::Unknown),
            )
            .unwrap();
        state.calls_since_memory = strategy::CHECKPOINT_INTERVAL;
        let transcript = Transcript::default();
        let fast = dynamic_tail(&state, None, "", &transcript, "");
        assert!(!fast.contains("investigation_checkpoint"));
        assert!(!fast.contains("open_unknowns"));
        state.strategy = Strategy::Deep;
        let deep = dynamic_tail(&state, None, "", &transcript, "");
        assert!(deep.contains("investigation_checkpoint"));
        assert!(deep.contains("open_unknowns"));
        assert!(deep.contains("what the handler forwards to"));
        apply_task_memory(
            &mut state,
            &json!({"action":"record","finding":"checkpoint recorded","status":"inferred"}),
            &transcript,
        )
        .unwrap();
        assert!(
            !dynamic_tail(&state, None, "", &transcript, "").contains("investigation_checkpoint")
        );
    }

    #[test]
    fn convergence_review_is_deep_only_and_never_repeats() {
        let mut state = AgentState::default();
        state
            .task_memory
            .upsert_with_status(
                None,
                "unverified hop".into(),
                String::new(),
                String::new(),
                String::new(),
                None,
                Some(crate::agent::task_memory::Status::Unknown),
            )
            .unwrap();
        let mut transcript = Transcript::default();
        let ledger = Ledger::default();
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &ledger),
            FinalCandidateReview::Accept
        ));
        state.strategy = Strategy::Deep;
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &ledger),
            FinalCandidateReview::OpenUnknowns(text) if text.contains("unverified hop")
        ));
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &ledger),
            FinalCandidateReview::Accept
        ));
    }

    #[test]
    fn task_memory_writes_are_bounded_per_turn() {
        let mut state = AgentState::default();
        for n in 0..strategy::MAX_MEMORY_WRITES_PER_TURN {
            apply_task_memory(
                &mut state,
                &json!({"action":"record","finding":format!("f{n}")}),
                &Transcript::default(),
            )
            .unwrap();
        }
        let refused = apply_task_memory(
            &mut state,
            &json!({"action":"record","finding":"extra"}),
            &Transcript::default(),
        );
        assert!(refused.unwrap_err().contains("at most"));
        assert_eq!(
            state.task_memory.entries.len(),
            strategy::MAX_MEMORY_WRITES_PER_TURN
        );
        assert!(apply_task_memory(
            &mut state,
            &json!({"action":"view"}),
            &Transcript::default()
        )
        .is_ok());
        state.memory_writes_this_turn = 0;
        apply_task_memory(
            &mut state,
            &json!({"action":"record","finding":"next turn"}),
            &Transcript::default(),
        )
        .unwrap();
    }

    #[test]
    fn task_memory_status_is_validated_and_kept_on_update() {
        let mut state = AgentState::default();
        apply_task_memory(
            &mut state,
            &json!({"action":"record","id":"a","finding":"x","status":"inferred"}),
            &Transcript::default(),
        )
        .unwrap();
        assert_eq!(
            state.task_memory.entries[0].status,
            Some(crate::agent::task_memory::Status::Inferred)
        );
        apply_task_memory(
            &mut state,
            &json!({"action":"update","id":"a","finding":"y"}),
            &Transcript::default(),
        )
        .unwrap();
        assert_eq!(
            state.task_memory.entries[0].status,
            Some(crate::agent::task_memory::Status::Inferred)
        );
        assert!(apply_task_memory(
            &mut state,
            &json!({"action":"record","finding":"z","status":"maybe"}),
            &Transcript::default(),
        )
        .is_err());
    }

    #[test]
    fn confirmed_memory_checks_effective_status_before_mutation() {
        let base = std::env::temp_dir().join(format!(
            "confirmed-memory-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(base.join("project")).unwrap();
        let root = base.join("project");
        std::fs::write(root.join("source.ts"), "export const value = 1;\n").unwrap();
        let mut transcript =
            Transcript::durable(&base.join("store"), "confirmed-test", &[], root.to_str()).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"inspect source"}));
        transcript.assistant_tool_turn(
            String::new(),
            &[ValidatedCall {
                id: "read".into(),
                name: "read_file".into(),
                arguments: json!({"path":"source.ts"}),
            }],
        );
        transcript.tool_result(
            "read",
            "read_file",
            json!({"path":"source.ts","content":"export const value = 1;"}).to_string(),
        );
        let observation = transcript.observations()[0].id.clone();
        let mut cited = crate::agent::task_memory::TaskMemoryEntry {
            status: Some(crate::agent::task_memory::Status::Confirmed),
            evidence: format!("{observation}..{observation}."),
            ..Default::default()
        };
        assert!(validate_confirmed_memory(&cited, &transcript).is_ok());
        cited.evidence = format!("{observation}..obs-99999999.");
        assert!(validate_confirmed_memory(&cited, &transcript).is_err());
        let mut state = AgentState::default();
        state.calls_since_memory = 7;
        for evidence in ["", "obs-99999999", "source.ts obs-99999999"] {
            let before = state.task_memory.clone();
            assert!(apply_task_memory(&mut state, &json!({
                "action":"record","id":"fact","finding":"observed","status":"confirmed","evidence":evidence
            }), &transcript).is_err());
            assert_eq!(state.task_memory, before);
            assert_eq!(state.calls_since_memory, 7);
            assert_eq!(state.memory_writes_this_turn, 0);
        }
        apply_task_memory(&mut state, &json!({
            "action":"record","id":"fact","finding":"observed","status":"confirmed","evidence":format!("source.ts ({observation})")
        }), &transcript).unwrap();
        assert_eq!(state.calls_since_memory, 0);
        let before = state.task_memory.clone();
        for arguments in [
            json!({"action":"update","id":"fact","finding":"replacement","evidence":""}),
            json!({"action":"record","supersedes":"fact","finding":"replacement","status":"confirmed","evidence":"obs-99999999"}),
        ] {
            assert!(apply_task_memory(&mut state, &arguments, &transcript).is_err());
            assert_eq!(state.task_memory, before);
            assert_eq!(state.memory_writes_this_turn, 1);
        }
        apply_task_memory(
            &mut state,
            &json!({
                "action":"update","id":"fact","finding":"revised","evidence":"source.ts"
            }),
            &transcript,
        )
        .unwrap();
        assert_eq!(
            state.task_memory.entries[0].status,
            Some(crate::agent::task_memory::Status::Confirmed)
        );
        state.memory_writes_this_turn = 0;
        apply_task_memory(
            &mut state,
            &json!({
                "action":"record","id":"hypothesis","finding":"possible","status":"unknown"
            }),
            &transcript,
        )
        .unwrap();
        let before = state.task_memory.clone();
        assert!(apply_task_memory(
            &mut state,
            &json!({
                "action":"update","id":"hypothesis","finding":"promoted","status":"confirmed"
            }),
            &transcript
        )
        .is_err());
        assert_eq!(state.task_memory, before);
        let serialized = serde_json::to_value(&state.task_memory).unwrap();
        let restored = restore_task_memory(Some(&serialized), &transcript).unwrap();
        assert_eq!(restored, state.task_memory);
        state.memory_writes_this_turn = 0;
        std::fs::create_dir_all(root.join("src")).unwrap();
        let spaced_source = "src/\u{00fc}ber view.ts";
        std::fs::write(root.join(spaced_source), "source with a spaced path").unwrap();
        transcript.assistant_tool_turn(
            String::new(),
            &[ValidatedCall {
                id: "spaced".into(),
                name: "read_file".into(),
                arguments: json!({"path":spaced_source}),
            }],
        );
        transcript.tool_result(
            "spaced",
            "read_file",
            json!({"path":spaced_source,"content":"source with a spaced path"}).to_string(),
        );
        apply_task_memory(
            &mut state,
            &json!({
                "action":"record","finding":"spaced path inspected","status":"confirmed",
                "evidence":format!("`{spaced_source}:1`")
            }),
            &transcript,
        )
        .unwrap();
        let before = state.task_memory.clone();
        for evidence in [
            format!("other/{spaced_source}"),
            format!("{spaced_source}.unread"),
            format!("{spaced_source} obs-99999999"),
        ] {
            assert!(apply_task_memory(
                &mut state,
                &json!({
                    "action":"record","finding":"bad path","status":"confirmed","evidence":evidence
                }),
                &transcript
            )
            .is_err());
            assert_eq!(state.task_memory, before);
            assert_eq!(state.memory_writes_this_turn, 1);
        }
        state.memory_writes_this_turn = 0;
        transcript.assistant_tool_turn(
            String::new(),
            &[ValidatedCall {
                id: "missing".into(),
                name: "read_file".into(),
                arguments: json!({"path":"missing.ts"}),
            }],
        );
        transcript.tool_result(
            "missing",
            "read_file",
            json!({"error":"file not found","path":"missing.ts"}).to_string(),
        );
        let failed_id = transcript
            .observation_for_call("missing")
            .unwrap()
            .id
            .clone();
        apply_task_memory(
            &mut state,
            &json!({
                "action":"record","finding":"read failed","status":"confirmed","evidence":failed_id
            }),
            &transcript,
        )
        .unwrap();
        // Existence is structural support for an error/blocker, not proof of source contents.
        assert!(transcript.observation_for_call("missing").unwrap().error);
        transcript.compact("findings retained".into(), transcript.entries().len());
        assert!(validate_confirmed_memory(&restored.entries[0], &transcript).is_ok());
        drop(transcript);
        let resumed =
            Transcript::durable(&base.join("store"), "confirmed-test", &[], root.to_str()).unwrap();
        assert!(validate_confirmed_memory(&restored.entries[0], &resumed).is_ok());
        assert_eq!(
            restore_task_memory(Some(&serde_json::to_value(&restored).unwrap()), &resumed).unwrap(),
            restored
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn dynamic_tail_contains_memory_and_knowledge_without_plan_state() {
        let state = AgentState::default();
        let tail = dynamic_tail(&state, None, "", &Transcript::default(), "");
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

    #[test]
    fn checkpoint_keeps_objective_constraints_and_procedural_state_across_generations() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"Audit the project. Do not modify files or commit. Inspect architecture, then produce the final report."}));
        let first = continuation_checkpoint(&transcript, "Established work: architecture sufficiently investigated.\nCurrent focus: final synthesis.\nBlocked or failed operations: terminal approval pending.\nFinalization state: research complete; do not restart discovery.".into());
        transcript.compact(first, 0);
        transcript.assistant_message("Preparing report".into());
        let second = continuation_checkpoint(&transcript, "Established work: architecture remains covered.\nCurrent focus: final synthesis.\nUnresolved work: write report.".into());
        assert!(second.contains("Do not modify files or commit"));
        assert!(second.contains("Current focus: final synthesis"));
        assert!(second.contains("architecture remains covered"));
        assert!(second.contains("terminal approval pending"));
    }

    #[test]
    fn unsupported_semantic_reversal_points_to_exact_evidence() {
        let base = std::env::temp_dir().join(format!("local-conflict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("project")).unwrap();
        std::fs::write(base.join("project/api.php"), "submit_order()").unwrap();
        let mut transcript = Transcript::durable(
            &base.join("events"),
            "conflict",
            &[],
            base.join("project").to_str(),
        )
        .unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit backend"}));
        transcript.assistant_tool_turn(
            "".into(),
            &[ValidatedCall {
                id: "read".into(),
                name: "read_file".into(),
                arguments: json!({"path":"api.php"}),
            }],
        );
        transcript.tool_result(
            "read",
            "read_file",
            json!({"path":"api.php","content":"submit_order()"}).to_string(),
        );
        let mut state = AgentState::default();
        state
            .task_memory
            .upsert(
                Some("backend"),
                "api.php submits orders".into(),
                transcript.observations()[0].id.clone(),
                "backend exists".into(),
                "".into(),
                None,
            )
            .unwrap();
        state
            .task_memory
            .upsert(
                Some("product"),
                "product exists".into(),
                "".into(),
                "".into(),
                "".into(),
                None,
            )
            .unwrap();
        let conflict = task_memory_conflict(
            &state,
            &transcript,
            &json!({"supersedes":"backend","finding":"no backend","evidence":""}),
        )
        .unwrap();
        assert!(conflict.contains("observation_read"));
        assert!(conflict.contains(&transcript.observations()[0].id));
        assert!(!state.task_memory.entries[0].invalidated);
        assert!(!state.task_memory.entries[1].invalidated);
        std::fs::remove_dir_all(base).unwrap();
    }
}
