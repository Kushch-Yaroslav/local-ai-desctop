//! Transcript-first local agent loop.
//!
//! The runtime owns transport, capability safety, durable evidence and bounded
//! recovery. It does not certify evidence, decide exploration coverage, or make
//! semantic completion decisions for the model; see
//! `docs/architecture/agent-investigation-state.md`.

use crate::agent::{
    deliverables,
    events::{Event, TailCandidateAttempt},
    evidence::classify_source_read,
    ledger::{Ledger, ProjectIndex},
    plan::StepStatus,
    policy::{self, Reasoning, RunPolicy},
    reads::repeated_file_read_decision,
    state::{AgentState, PauseState},
    strategy::{self, Strategy},
    transcript::{validate_calls, CompactionPlan, ToolResultPolicy, Transcript, ValidatedCall},
    verification::{self, Need},
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

/// What file and terminal tools may act on in this run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolScope {
    /// No project and no directory named by the user: no execution tools.
    None,
    /// Only directories the user named explicitly.
    Workspace,
    /// A selected project (optionally plus explicitly named directories).
    Project,
}

#[derive(Clone)]
pub struct Config {
    pub run_id: String,
    pub endpoint: String,
    pub model: String,
    pub system: String,
    pub user: String,
    pub root: Option<String>,
    pub secondary_root: Option<String>,
    /// Directories the user named explicitly. File tools may use absolute paths
    /// inside them; without a project the first one is also the terminal's cwd.
    pub workspace_roots: Vec<String>,
    pub context_limit: usize,
    pub reasoning_mode: String,
    pub supports_reasoning: bool,
    pub reasoning_options: Option<Value>,
    pub policy: RunPolicy,
    pub history: Vec<Value>,
    pub evidence_dir: Option<String>,
    pub task_memory: Option<Value>,
    pub provider_max_output: Option<usize>,
    /// Whether a real browser can be used for checks. `None` looks for one;
    /// the host or a test may state it.
    pub browser_capability: Option<bool>,
    pub cancelled: Arc<AtomicBool>,
    pub steering: Arc<Mutex<Vec<String>>>,
    pub steering_closed: Arc<AtomicBool>,
    /// Set together with a queued steering message that the user marked as a
    /// pause request (a structured control, not parsed from text).
    pub pause_requested: Arc<AtomicBool>,
}

impl Config {
    pub fn tool_scope(&self) -> ToolScope {
        if self.root.is_some() {
            ToolScope::Project
        } else if !self.workspace_roots.is_empty() {
            ToolScope::Workspace
        } else {
            ToolScope::None
        }
    }

    /// Root of file tools and cwd of the terminal: the selected project, else
    /// the first directory the user named.
    fn work_root(&self) -> Option<&str> {
        self.root
            .as_deref()
            .or_else(|| self.workspace_roots.first().map(String::as_str))
    }

    fn grants(&self) -> Vec<PathBuf> {
        self.workspace_roots.iter().map(PathBuf::from).collect()
    }
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
- For code changes, read before writing, make targeted changes, then check them: after you change files, run the cheapest check that shows the change works (the project's own tests, or a short script that runs the changed code; for a page, a real browser run, such as a headless browser or a Playwright or Puppeteer script; jsdom or a hand-written DOM stand-in does not count as a browser check). A check must go through the same entry path the user will use (for a page: the real HTML with its script order and load timing, not only the script run against a stand-in); if it only covers part of that path or uses a stand-in, say so. A claim is only as strong as the check behind it: a command that exits 0 shows what it ran, not more. If the check the claim needs cannot be run here (for example, no browser), leave it implemented and say so plainly instead of substituting a weaker check. For a small literal edit, prefer replace_text after reading the file; it avoids patch context markers without weakening freshness checks. Verification is part of the work, not an extra step to announce. Reading a file back shows only that it exists, not that it works. When a check fails, fix the cause and run it again; do not invent checks or skip a failure.
- For substantial tasks, reason about an approach before acting, adapt as you learn, use tools for concrete evidence, avoid broad rereads, and continue until the user's task is complete.
- Plan = your own short list of steps for non-trivial work (plan tool: set if useful, then update at meaningful milestones or when the approach changes; skip it for a trivial request). It is not the user's deliverables and finishing its steps proves nothing. Do not narrate plan updates or restate the plan in prose; no update is required after every action.
- Agent runtime state belongs to the harness, not to the human. Accepted updates stay beside the tool substep that produced them; the latest value of each section supersedes earlier values. A cleared section is no longer active. Continue the next action without treating these updates as new user instructions.
- Use the latest user's language for all user-visible natural-language text: streamed reasoning/progress, tool preambles, brief status updates, and the final answer. Follow an explicit language request if present. Keep code, paths, identifiers, commands, API/tool syntax, and literal source quotations in their original form. Do not translate protocol fields.
- For non-trivial architecture relationships, use a compact multiline Mermaid flowchart when it improves readability, or a properly indented multiline tree. Do not compress a diagram into one long arrow chain; avoid decorative box art.
- Task Memory = durable semantic continuity for this task. Record meaningful findings, decisions, blockers, and next actions, and cite the observation IDs (obs-…) a finding rests on in its evidence field. After compaction, trust a precise Task Memory finding from an unchanged inspected file; reread only for a missing fact, ambiguity, possible change, exact detail, or targeted verification.
- Set Task Memory status and evidence as JSON fields, not prose inside finding. Confirmed entries require evidence containing an observation ID or exact inspected source path from this transcript. A valid reference does not prove the claim; use inferred or unknown for unverified conclusions.
- Investigation state = a mechanical inventory the runtime keeps of this run's tool observations: files read with their observation IDs, listed entries and local files referenced by sources you read that were not opened yet, failed operations, and commands run. It is not a task list and nothing in it is required. Use it to avoid rereading and to notice code you have not seen; follow a reference only when what you are about to claim depends on it. Recover an exact stored body with observation_read.
- Deliverables: when the request has two or more separate things to produce or change, or one result that must work end to end, record each requested one with the deliverables tool before you start. Mark an item implemented when you built it; that is your claim. It becomes verified only when the runtime has recorded a passing check of it made after your last change (action verify), and any later change takes the verification back. Block an item with a concrete reason if it cannot be completed. Record only what the user asked for, never your own ideas. Do not use it for a single-step or analysis-only request. Produce what the user will see or use first and refine afterwards: a part is not finished until it is reachable the way the user will use it, not merely implemented. Files you create only to diagnose something are not part of the result; delete them before you finish.
- Ground claims in what you observed. Keep observed facts, inferences and unknowns apart, and mark inferences as inferences. Something you did not open is unknown, not absent. State that something does not exist only for a scope you actually covered (a complete directory listing, a complete file read, or a search whose scope you can name) and name that scope; otherwise say it was not found in what you inspected. A failed or approval-blocked operation is a blocker, not evidence.
- Report outcomes from the recorded state, not from intent. Say a deliverable works only if it is verified; otherwise say it is implemented and not verified, and say what failed or was not checked. Never state a count, result or behaviour you did not see in a tool result or check.
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
        } else if options.get("main").is_some_and(Value::is_object) {
            // The user's explicit thinking/effort choice, resolved by the host. It is independent of the strategy.
            "main"
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
    let wire_messages = crate::context::message_sequence::normalize(&wire_messages(messages));
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
        } else if message.get("role").and_then(Value::as_str) == Some("runtime")
            || content.starts_with("[RUNTIME GUIDANCE — NOT USER CONTENT]")
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
    match config.tool_scope() {
        ToolScope::Project if !config.workspace_roots.is_empty() => {
            prefix.push_str(&format!(
                "\nThe user also named these directories explicitly; file tools accept absolute paths inside them: {}.",
                config.workspace_roots.join(", ")
            ));
        }
        ToolScope::Workspace => {
            prefix.push_str(&format!(
                "\nNo project is selected. The user named these directories explicitly: {}. File tools accept absolute paths inside them, and a relative path resolves against the first one. run_terminal starts in the first one. Project knowledge tools are not available.",
                config.workspace_roots.join(", ")
            ));
        }
        ToolScope::None => {
            prefix.push_str("\nNo project is selected and the user has not named a directory, so file and terminal tools are not available in this run. If the task needs them, say so and ask the user to name a directory or select a project. Do not claim an action was performed that no tool performed.");
        }
        ToolScope::Project => {}
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
    if state.pause.is_some() {
        let memory = state.task_memory.prompt_for_closeout(objective);
        if !memory.is_empty() {
            tail.push(format!("<task_memory>\n{memory}\n</task_memory>"));
        }
        let plan = state.task_memory.plan.prompt();
        if !plan.is_empty() {
            tail.push(plan);
        }
        let deliverables = state.task_memory.deliverables.prompt();
        if !deliverables.is_empty() {
            tail.push(deliverables);
        }
        let verification = state.task_memory.verification.prompt(
            &state.task_memory.deliverables,
            state.verification_closed,
            state.browser_available,
        );
        if !verification.is_empty() {
            tail.push(verification);
        }
        tail.push(PAUSE_DIRECTIVE.to_owned());
        return tail.join("\n");
    }
    if state.pause_offered {
        tail.push("<steering_options>The user just sent a message while you were working. If, and only if, it clearly asks you to pause or stop at this point, call pause_run. If it asks to continue, check, change or add anything, do not call it: follow the message and keep working.</steering_options>".to_owned());
    }
    let memory = if transcript.is_finalizing() {
        state.task_memory.prompt_for_closeout(objective)
    } else {
        state.task_memory.prompt_for(objective)
    };
    if !memory.is_empty() {
        tail.push(format!("<task_memory>\n{memory}\n</task_memory>"));
    }
    let plan = state.task_memory.plan.prompt();
    if !plan.is_empty() {
        tail.push(plan);
    }
    let deliverables = state.task_memory.deliverables.prompt();
    if !deliverables.is_empty() {
        tail.push(deliverables);
    }
    let verification = state.task_memory.verification.prompt(
        &state.task_memory.deliverables,
        state.verification_closed,
        state.browser_available,
    );
    if !verification.is_empty() {
        tail.push(verification);
    }
    if !transcript.is_finalizing() && !user_requests_read_only(objective) {
        if let Some(hint) = contract_hint(state, objective) {
            tail.push(hint);
        }
    }
    if state.task_memory.deliverables.has_pending() {
        if transcript.is_finalizing() {
            tail.push(format!("<unfinished_deliverables>{}</unfinished_deliverables>\nThe run budget ended before these were completed. In the answer, report each of them plainly as not completed: say what exists, what is missing and why the run stopped. Do not present them as done.", state.task_memory.deliverables.pending_summary()));
        } else if let Some(notice) = run_budget_notice(
            state.turn,
            MAX_INVESTIGATION_TURNS,
            &state.task_memory.deliverables.pending_summary(),
        ) {
            tail.push(notice);
        }
    }
    if !transcript.is_finalizing() && !state.created_files.is_empty() {
        let listed = state
            .created_files
            .iter()
            .rev()
            .take(12)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        tail.push(format!(
            "<files_created_this_run>{listed}</files_created_this_run>"
        ));
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

/// Number of separate items the user's request itself enumerates (numbered or bulleted lines). Purely structural: it
/// reads list markers, not words, so it works in any language and for any subject.
fn enumerated_items(user: &str) -> usize {
    user.lines()
        .filter(|line| {
            let line = line.trim_start();
            let digits = line.chars().take_while(char::is_ascii_digit).count();
            let numbered = digits > 0
                && digits <= 2
                && line[digits..]
                    .chars()
                    .next()
                    .is_some_and(|marker| marker == '.' || marker == ')')
                && line[digits + 1..].starts_with(char::is_whitespace);
            let bulleted = ["- ", "* ", "• "]
                .iter()
                .any(|bullet| line.starts_with(bullet));
            (numbered || bulleted) && line.chars().filter(|c| c.is_alphabetic()).count() >= 6
        })
        .count()
}

/// A short hint, shown only while no deliverables are recorded, that the model is expected to write down what was
/// asked. It costs no turn and stops after the early part of the run.
fn contract_hint(state: &AgentState, user: &str) -> Option<String> {
    const HINT_UNTIL_TURN: usize = 25;
    if !state.task_memory.deliverables.is_empty() || state.turn >= HINT_UNTIL_TURN {
        return None;
    }
    let items = enumerated_items(user);
    if items >= 2 {
        return Some(format!("<deliverables_hint>The request lists {items} separate items. Record each requested one with the deliverables tool (action add) before you start, so none is lost on a long run.</deliverables_hint>"));
    }
    (state.mutations > 0).then(|| "<deliverables_hint>You have started changing the project but recorded no deliverables. If the request has two or more separate things to deliver, record them with the deliverables tool now and mark what you have built as implemented. Ignore this for a single-step request.</deliverables_hint>".to_owned())
}

/// Makes the turn budget visible once it matters, and only while requested
/// deliverables are still unfinished: the model otherwise has no way to know
/// that it is spending the last turns on refinements of the first deliverable.
fn run_budget_notice(turn: usize, budget: usize, pending: &str) -> Option<String> {
    let used = turn.saturating_add(1);
    if used * 2 < budget {
        return None;
    }
    let left = budget.saturating_sub(used);
    let urgency = if used * 100 >= budget * 85 {
        format!(" Only about {left} turns remain: finish what the user will use, and mark anything you cannot complete as blocked with the reason.")
    } else {
        " Put the remaining turns on delivering what the user will see or use first; extra tests and refinements come after it works.".to_owned()
    };
    Some(format!("<run_budget>Turn {used} of {budget}. Unfinished deliverables: {pending}.{urgency}</run_budget>"))
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

fn tool_schemas(scope: ToolScope) -> Vec<Value> {
    // Native tool grammars enumerate object-root properties, not union roots.
    // Action-specific requirements are enforced transactionally at dispatch.
    let mut tools = vec![
        json!({"type":"function","function":{"name":"task_memory","description":"Durable semantic memory for the current task across compaction. Record/update meaningful findings, decisions, blockers, or unresolved questions; view reads it; invalidate needs id. Record requires finding; update needs the id of an existing entry and changes only the fields you pass (an empty string clears one). Both may include evidence, implication, next, supersedes, status. Cite observations by exact id (obs-00000012), one per item in observations or comma-separated in evidence. Trust precise unchanged-file memory; reread only for a concrete missing, ambiguous, changed, exact-detail, or verification need.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["record","update","invalidate","view"]},"id":{"type":"string"},"finding":{"type":"string"},"evidence":{"type":"string"},"implication":{"type":"string"},"next":{"type":"string"},"supersedes":{"type":"string"},"status":{"type":"string","enum":["confirmed","inferred","unknown","contradicted"],"description":"How well established the finding is: confirmed (observed, cited), inferred (reasoned, not observed), unknown (open; put the resolving step in next), contradicted (evidence disagrees)."},"observations":{"type":"array","items":{"type":"string"},"description":"Observation IDs (obs-…) that support the finding; same as evidence, one id per item."}},"required":["action"]}}}),
        json!({"type":"function","function":{"name":"deliverables","description":"The user's requested deliverables for this task (execution contract). Use it only when the request has two or more separate things to produce or change, or one result that must work end to end. add: record each requested deliverable once (text, optional task, optional check: the weakest evidence that proves the claim: readback = it exists, static = lint/typecheck, build = it builds, test = the tests pass, runtime = running the code works, browser = it works in a real browser; a changed page is always held to browser). implemented: you built it (id, evidence): this is your claim and is not proof. verify: select relevant run_terminal checks with deliverable_ids before executing them; the runtime has a passing check of it (id; evidence = ev-… ids from <verification_state>; Fast may omit them): only checks the runtime saw run after your last change count, and any later change to the project takes the verification back. block: it cannot be completed (id, concrete reason). drop: the user withdrew it (id, reason). view: list them. Record only what the user asked for, never your own optional ideas.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["add","implemented","verify","block","drop","view"]},"id":{"type":"string"},"task":{"type":"string"},"text":{"type":"string"},"evidence":{"type":"string"},"reason":{"type":"string"},"check":{"type":"string","enum":["readback","static","build","test","runtime","browser"]}},"required":["action"]}}}),
        json!({"type":"function","function":{"name":"plan","description":"Your own short execution plan: how you will get the work done. Optional: skip it for a trivial or single-step request. set: replace the unfinished steps with a short ordered list of one-line steps (steps); the first becomes active. update: change a step (id; status pending|in_progress|completed|blocked, optional text or note; blocked needs a note); completing the active step activates the next. add: insert a step (text, optional after). view: list. Update at meaningful milestones or when your approach changes; do not narrate it or update it after every call. A plan is not proof: finishing steps does not complete the user's deliverables.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["set","update","add","view"]},"steps":{"type":"array","items":{"type":"string"}},"id":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed","blocked"]},"text":{"type":"string"},"note":{"type":"string"},"after":{"type":"string"}},"required":["action"]}}}),
        json!({"type":"function","function":{"name":"observation_index","description":"List historical tool observations by stable ID, with source path and outcome metadata. Use source to select the raw observation for the needed file. If more=true, continue at the returned next_offset. Observation IDs start with obs-.","parameters":{"type":"object","properties":{"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}}}}}),
        json!({"type":"function","function":{"name":"observation_read","description":"Recover a bounded exact slice of a stored historical tool result by observation ID. The response distinguishes historical evidence from current source and reports whether the source changed.","parameters":{"type":"object","properties":{"id":{"type":"string"},"offset_chars":{"type":"integer","minimum":0},"max_chars":{"type":"integer","minimum":1,"maximum":16000}},"required":["id"]}}}),
    ];
    if scope != ToolScope::None {
        tools.extend([
            json!({"type":"function","function":{"name":"apply_patch","description":"Edit files atomically. For a one-line edit, use `*** Begin Patch\n*** Update File: path\n@@\n-old line with original indentation\n+new line with original indentation\n*** End Patch`. Every unchanged context line needs one EXTRA leading space before the exact source indentation; copied source alone is not valid patch context. Every update hunk must contain at least one -old or +new line. Patch format: *** Begin Patch, then per file `*** Update File: path` with hunks of ` unchanged context`, `-old` and `+new` lines (separate hunks with a line `@@`; add enough context to match exactly one place), `*** Add File: path` with every line prefixed `+`, or `*** Delete File: path`, then *** End Patch. The whole patch applies or none of it does.","parameters":{"type":"object","properties":{"patch":{"type":"string"}},"required":["patch"]}}}),
            json!({"type":"function","function":{"name":"create_file","description":"Create a new project file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}),
            json!({"type":"function","function":{"name":"delete_file","description":"Delete a project file when allowed.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}),
            json!({"type":"function","function":{"name":"list_directory","description":"List a project directory. complete=true means all directory entries are represented; false means internal runtime entries were omitted.","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}),
            json!({"type":"function","function":{"name":"read_file","description":"Read up to 64 KiB of a project file. A truncated result provides next_offset_chars; use that offset or a specific line range for more.","parameters":{"type":"object","properties":{"path":{"type":"string"},"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1},"offset_chars":{"type":"integer","minimum":0}},"required":["path"]}}}),
            json!({"type":"function","function":{"name":"project_knowledge_index","description":"Read the small .ai-framework manifest index and source freshness map. Use it before repeating broad project orientation.","parameters":{"type":"object","properties":{}}}}),
            json!({"type":"function","function":{"name":"project_knowledge_read","description":"Read selected reusable project observations from .ai-framework: paths is required. Prefer relevant fresh knowledge before broad rereads; do not reread unchanged source only to reconstruct context. Read source for exact current code or a concrete unresolved/verification detail.","parameters":{"type":"object","properties":{"paths":{"type":"array","items":{"type":"string"}}},"required":["paths"]}}}),
            json!({"type":"function","function":{"name":"project_knowledge_update","description":"Optionally persist durable, reusable semantic project knowledge in .ai-framework. This is never required for normal work. Only use project/, modules/, sources/, or tasks/ markdown paths.","parameters":{"type":"object","properties":{"updates":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"},"mode":{"type":"string","enum":["replace","merge"]}},"required":["path","content"]}},"source_paths":{"type":"array","items":{"type":"string"}}},"required":["updates"]}}}),
            json!({"type":"function","function":{"name":"run_terminal","description":"Run an existing relevant project command. For an acceptance check, select deliverable_ids BEFORE running it. The command remains associated with those items on every retry, including failures. Unselected checks remain project warnings; full-test requirements are project-wide; build requirements cover build checks. After code changes, prefer a focused check.","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout_ms":{"type":"integer","minimum":1},"deliverable_ids":{"type":"array","items":{"type":"string"},"description":"Existing deliverable ids this check verifies. Associations are permanent, including failed checks."}},"required":["command"]}}}),
            json!({"type":"function","function":{"name":"replace_text","description":"For a small edit, replace exactly one literal snippet in an existing file after a fresh read. old_text and new_text are plain source strings, not patch syntax. Include enough exact text to identify one place. Empty, missing or repeated old_text and changes since the last read are refused; write is atomic. Prefer this for one-line edits; use apply_patch for multiple hunks.","parameters":{"type":"object","properties":{"path":{"type":"string"},"old_text":{"type":"string"},"new_text":{"type":"string"}},"required":["path","old_text","new_text"]}}}),
            json!({"type":"function","function":{"name":"write_file","description":"Write the full content of a project file, replacing it. To change part of a file, prefer apply_patch.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}),
        ]);
    }
    if scope == ToolScope::Workspace {
        // The .ai-framework cache belongs to a selected project.
        tools.retain(|tool| !tool_name(tool).starts_with("project_knowledge_"));
    }
    tools.sort_by(|left, right| tool_name(left).cmp(tool_name(right)));
    tools
}
/// A constrained/read-only run does not advertise mutations and therefore
/// cannot strand the model behind an approval-only capability. Task Memory and
/// explicit knowledge reads remain available so analysis has a complete
/// working contract.
fn tool_schemas_for_policy(scope: ToolScope, policy: RunPolicy) -> Vec<Value> {
    let mut tools = tool_schemas(scope);
    if policy == RunPolicy::Safe {
        tools.retain(|tool| {
            matches!(
                tool_name(tool),
                "task_memory"
                    | "deliverables"
                    | "plan"
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
            | "replace_text"
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

fn tool_schemas_for_request(scope: ToolScope, policy: RunPolicy, user: &str) -> Vec<Value> {
    let mut tools = tool_schemas_for_policy(scope, policy);
    if user_requests_read_only(user) {
        // A read-only request produces nothing to deliver, so the execution
        // contract tool is not offered either.
        tools.retain(|tool| {
            !is_project_side_effect_tool(tool_name(tool)) && tool_name(tool) != "deliverables"
        });
    }
    tools
}

const CHECKPOINT_TOOLS: [&str; 3] = ["task_memory", "deliverables", "plan"];

fn pause_run_schema() -> Value {
    json!({"type":"function","function":{
        "name":"pause_run",
        "description":"Call this only if the user's latest message clearly asks you to pause or stop working at this point. It does not delete anything: you get a short checkpoint to save state, then the run ends and the user can continue later. Do not call it for any other message.",
        "parameters":{"type":"object","properties":{},"additionalProperties":false}
    }})
}

/// Schemas offered for one provider request. A paused run may only write its
/// checkpoint; right after a steering message the model may also classify it
/// as a pause request.
fn turn_schemas(schemas: &[Value], state: &AgentState, finalizing: bool) -> Vec<Value> {
    if finalizing {
        Vec::new()
    } else if state.pause.is_some() {
        schemas
            .iter()
            .filter(|schema| CHECKPOINT_TOOLS.contains(&tool_name(schema)))
            .cloned()
            .collect()
    } else if state.pause_offered {
        let mut offered = schemas.to_vec();
        offered.push(pause_run_schema());
        offered
    } else {
        schemas.to_vec()
    }
}

fn begin_pause(config: &Config, state: &mut AgentState, source: &str) -> bool {
    if state.pause.is_some() {
        return false;
    }
    state.pause = Some(PauseState {
        checkpoint_turns_left: PauseState::CHECKPOINT_TURNS,
    });
    state.pause_offered = false;
    emit(
        &config.run_id,
        Event::PauseStarted {
            source: source.into(),
        },
    );
    trace_forensics(
        &config.run_id,
        "pause_started",
        json!({"source":source,"checkpoint_turns":PauseState::CHECKPOINT_TURNS}),
    );
    true
}

const PAUSE_DIRECTIVE: &str = "<run_paused>The user paused this run. Do not start new investigation or work. With the checkpoint tools only: record in task_memory what is established and what is still unknown, with the next step, and set each deliverable to its true status (implemented is not verified), and keep the plan current. Then write a short answer for the user: what is done, what is not, and that the work continues when they ask to continue. Do not claim unfinished work as done.</run_paused>";

const PAUSED_TOOL_MESSAGE: &str = "The run is paused: only the checkpoint tools (task_memory, deliverables, plan) are available. Save the checkpoint and write the short pause summary.";

const PAUSE_FALLBACK: &str = "Работа поставлена на паузу. Состояние и список невыполненного сохранены; чтобы продолжить, напишите «Продолжить».";

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

/// Maps the action names models commonly use to the supported ones.
fn canonical_memory_action(action: &str) -> Option<&'static str> {
    match action.trim().to_lowercase().as_str() {
        "record" | "add" | "create" | "new" | "write" | "save" => Some("record"),
        "update" | "revise" | "edit" | "modify" | "amend" => Some("update"),
        "invalidate" | "delete" | "remove" | "discard" | "retract" => Some("invalidate"),
        "view" | "get" | "list" | "read" | "show" => Some("view"),
        _ => None,
    }
}

fn memory_text_field(value: &Value, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(format!("{key} must be a string.")),
    }
}

/// Evidence arrives as a string, an array, or in `observations`; all are
/// merged into one reference string.
fn memory_evidence_field(value: &Value) -> Result<Option<String>, String> {
    let mut parts = Vec::new();
    let mut given = false;
    for key in ["evidence", "observations"] {
        match value.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(text)) => {
                given = true;
                parts.push(text.clone());
            }
            Some(Value::Array(items)) => {
                given = true;
                for item in items {
                    parts.push(item.as_str().map(str::to_owned).ok_or_else(|| {
                        format!(
                            "{key} must be a list of strings (observation ids or source paths)."
                        )
                    })?);
                }
            }
            Some(_) => {
                return Err(format!(
                    "{key} must be a string or a list of strings (observation ids or source paths)."
                ))
            }
        }
    }
    Ok(given.then(|| parts.join(", ")))
}

fn parse_task_memory_change(
    value: &Value,
    transcript: &Transcript,
) -> Result<crate::agent::task_memory::Change, String> {
    let status = memory_text_field(value, "status")?
        .filter(|status| !status.trim().is_empty())
        .map(|status| crate::agent::task_memory::Status::parse(&status))
        .transpose()?;
    Ok(crate::agent::task_memory::Change {
        id: memory_text_field(value, "id")?,
        finding: memory_text_field(value, "finding")?,
        evidence: memory_evidence_field(value)?.map(|e| normalize_evidence_refs(&e, transcript)),
        implication: memory_text_field(value, "implication")?,
        next: memory_text_field(value, "next")?,
        supersedes: memory_text_field(value, "supersedes")?,
        status,
    })
}

/// Rewrites observation references into their exact ids: unpadded ids
/// (`obs-15`), any letter case, and compact runs such as
/// `obs-00000015/0016` or `obs-15, 16` become one id per observation. A
/// reference that names no real observation is left as written so that it is
/// reported, never silently repaired.
fn normalize_evidence_refs(evidence: &str, transcript: &Transcript) -> String {
    let chars = evidence.chars().collect::<Vec<_>>();
    let mut out = String::new();
    let mut index = 0;
    let is_prefix = |at: usize| {
        chars.len() >= at + 4
            && chars[at..at + 4]
                .iter()
                .collect::<String>()
                .eq_ignore_ascii_case("obs-")
            && (at == 0 || !(chars[at - 1].is_alphanumeric() || chars[at - 1] == '_'))
    };
    let digits_at = |at: usize| {
        chars[at..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count()
    };
    while index < chars.len() {
        if !is_prefix(index) || digits_at(index + 4) == 0 {
            out.push(chars[index]);
            index += 1;
            continue;
        }
        let first = digits_at(index + 4);
        let width = first;
        let mut numbers = vec![chars[index + 4..index + 4 + first]
            .iter()
            .collect::<String>()];
        let mut end = index + 4 + first;
        // `/0016`, `, 16` or `+0016` directly continues the run only when no new `obs-` prefix follows.
        loop {
            let mut at = end;
            if at < chars.len() && matches!(chars[at], '/' | '+' | ',' | '&') {
                at += 1;
                while at < chars.len() && chars[at] == ' ' {
                    at += 1;
                }
                let run = if at < chars.len() { digits_at(at) } else { 0 };
                let word_boundary = at + run >= chars.len() || !chars[at + run].is_alphanumeric();
                if run > 0 && word_boundary && !is_prefix(at) {
                    numbers.push(chars[at..at + run].iter().collect::<String>());
                    end = at + run;
                    continue;
                }
            }
            break;
        }
        let rendered = numbers
            .iter()
            .map(|digits| {
                let number = digits.parse::<usize>().unwrap_or(usize::MAX);
                let candidate = format!("obs-{number:0width$}", width = width.max(8));
                transcript
                    .observation(&candidate)
                    .map_or_else(|| format!("obs-{digits}"), |o| o.id.clone())
            })
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&rendered);
        index = end;
    }
    out
}

/// A short list of real references the model can cite instead.
fn observation_hint(transcript: &Transcript) -> String {
    let observations = transcript.observations();
    if observations.is_empty() {
        return "No observations exist in this run yet: read or search something first, then cite its obs- id.".into();
    }
    let recent = observations
        .iter()
        .rev()
        .filter(|observation| !observation.error)
        .take(4)
        .map(|observation| match observation.source.as_deref() {
            Some(source) if !source.is_empty() => format!("{} ({source})", observation.id),
            _ => observation.id.clone(),
        })
        .collect::<Vec<_>>();
    format!(
        "Valid references include: {}. observation_index lists all.",
        recent.join(", ")
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
    // Revising only status, next or implication leaves the cited evidence in place.
    if arguments.get("supersedes").is_none()
        && arguments.get("finding").is_none()
        && arguments.get("evidence").is_none()
        && arguments.get("observations").is_none()
    {
        return None;
    }
    let prior = state
        .task_memory
        .entries
        .iter()
        .find(|e| e.id == replacing && !e.invalidated)?;
    let cited = transcript
        .observations()
        .iter()
        .find(|o| prior.evidence.contains(&o.id))?;
    let new_evidence = memory_evidence_field(arguments)
        .ok()
        .flatten()
        .map(|evidence| normalize_evidence_refs(&evidence, transcript))
        .unwrap_or_default();
    if transcript.observations().iter().any(|o| {
        new_evidence.contains(&o.id)
            || o.source
                .as_deref()
                .is_some_and(|source| new_evidence == source)
    }) {
        return None;
    }
    Some(format!("Potential evidence conflict: {} cites exact historical observation {}. Retrieve that observation with observation_read and cite a verified observation before replacing this finding (to retire it without a replacement, use action=invalidate). {}", prior.id, cited.id, observation_hint(transcript)))
}

/// Why this evidence does not support a confirmed claim, or `None` if it does.
fn evidence_problem(evidence: &str, transcript: &Transcript) -> Option<String> {
    let reference_character = |character: char| {
        character.is_alphanumeric() || matches!(character, '-' | '_' | '.' | '/' | '\\')
    };
    let tokens = evidence
        .split(|character| !reference_character(character))
        .flat_map(|token| token.split(".."))
        .map(|token| token.trim_matches('.'));
    let mut found = transcript.observations().iter().any(|observation| {
        observation.source.as_deref().is_some_and(|source| {
            !source.is_empty()
                && evidence.match_indices(source).any(|(start, matched)| {
                    let end = start + matched.len();
                    !evidence[..start]
                        .chars()
                        .next_back()
                        .is_some_and(reference_character)
                        && !evidence[end..]
                            .chars()
                            .next()
                            .is_some_and(reference_character)
                })
        })
    });
    for token in tokens.filter(|token| !token.is_empty()) {
        if token.starts_with("obs-") {
            if transcript.observation(token).is_none() {
                return Some(format!(
                    "evidence cites unknown observation '{token}'. {}",
                    observation_hint(transcript)
                ));
            }
            found = true;
        }
    }
    (!found).then(|| format!("evidence is empty or names no observation ID or exact source path inspected in this run. {}", observation_hint(transcript)))
}

fn validate_confirmed_memory(
    entry: &crate::agent::task_memory::TaskMemoryEntry,
    transcript: &Transcript,
) -> Result<(), String> {
    use crate::agent::task_memory::Status;
    if entry.status != Some(Status::Confirmed) {
        return Ok(());
    }
    match evidence_problem(&entry.evidence, transcript) {
        None => Ok(()),
        Some(problem) if problem.starts_with("evidence cites unknown") => Err(format!("Confirmed Task Memory cites unknown observation{}. Fix the reference (or use status inferred/unknown while it is unverified) and retry; no memory was changed.", &problem["evidence cites unknown observation".len()..])),
        Some(problem) => Err(format!("Confirmed Task Memory needs support: {problem} Add it with evidence (or observations), or use status inferred/unknown while it is unverified; no memory was changed.")),
    }
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
    let requested = required_text(arguments, "action")?;
    let action = canonical_memory_action(&requested).ok_or_else(|| {
        format!(
            "unsupported task_memory action '{requested}': use record, update, invalidate or view"
        )
    })?;
    if action == "view" {
        return Ok((
            json!({"task_memory": state.task_memory, "updated": false}),
            false,
        ));
    }
    let mut notes = Vec::new();
    let mut touched = None;
    if action == "invalidate" {
        let id = arguments
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                format!(
                    "invalidate needs the id of the entry to retire. {}",
                    state.task_memory.ids_hint()
                )
            })?;
        state.task_memory.invalidate(id)?;
    } else {
        if state.memory_writes_this_turn >= strategy::MAX_MEMORY_WRITES_PER_TURN {
            return Err(format!("Task Memory accepts at most {} writes per turn. Merge the remaining findings into one entry (update an existing id) instead of one entry per fact.", strategy::MAX_MEMORY_WRITES_PER_TURN));
        }
        let kind = if action == "record" {
            crate::agent::task_memory::WriteKind::Record
        } else {
            crate::agent::task_memory::WriteKind::Update
        };
        let change = parse_task_memory_change(arguments, transcript)?;
        let mut candidate = state.task_memory.clone();
        let applied = candidate.apply(kind, change)?;
        let entry = candidate
            .entries
            .iter()
            .find(|entry| entry.id == applied.id)
            .ok_or_else(|| "Task Memory write did not create an entry".to_owned())?;
        validate_confirmed_memory(entry, transcript)?;
        state.task_memory = candidate;
        state.memory_writes_this_turn += 1;
        notes = applied.notes;
        touched = Some(applied.id);
    }
    state.calls_since_memory = 0;
    let mut result = json!({"task_memory": state.task_memory, "updated": true});
    if let Some(id) = touched {
        result["id"] = json!(id);
    }
    if !notes.is_empty() {
        result["notes"] = json!(notes);
    }
    Ok((result, true))
}

/// Updates the execution plan. The result is the compact plan itself: the plan
/// is short by construction, and the model needs nothing else back.
fn apply_plan(state: &mut AgentState, arguments: &Value) -> Result<(Value, bool), String> {
    let action = required_text(arguments, "action")?;
    let text_arg = |key: &str| arguments.get(key).and_then(Value::as_str);
    let mut candidate = state.task_memory.plan.clone();
    match action.trim().to_lowercase().as_str() {
        "view" | "get" | "list" | "show" => {
            return Ok((
                json!({"plan": state.task_memory.plan, "updated": false}),
                false,
            ));
        }
        "set" | "create" | "replace" => {
            let steps = arguments
                .get("steps")
                .and_then(Value::as_array)
                .map(|steps| {
                    steps
                        .iter()
                        .filter_map(|step| {
                            step.as_str().map(str::to_owned).or_else(|| {
                                step.get("text").and_then(Value::as_str).map(str::to_owned)
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .ok_or_else(|| "steps is required: an array of short one-line steps".to_owned())?;
            candidate.set(&steps)?;
        }
        "add" => candidate.add(&required_text(arguments, "text")?, text_arg("after"))?,
        "update" | "complete" | "done" => {
            let status = match text_arg("status") {
                Some(value) => Some(StepStatus::parse(value).ok_or_else(|| {
                    "status must be pending, in_progress, completed or blocked".to_owned()
                })?),
                None if action.trim().eq_ignore_ascii_case("update") => None,
                None => Some(StepStatus::Completed),
            };
            candidate.update(
                &required_text(arguments, "id")?,
                status,
                text_arg("text"),
                text_arg("note"),
            )?;
        }
        _ => return Err("unsupported plan action: use set, update, add or view".into()),
    }
    let unchanged = candidate == state.task_memory.plan;
    state.task_memory.plan = candidate;
    Ok((
        json!({"plan": state.task_memory.plan, "updated": !unchanged}),
        !unchanged,
    ))
}

/// Updates the execution contract. In Deep, completing an item needs evidence
/// that cites an observation or an inspected source path, like a confirmed
/// finding; Fast only asks the model to say what it observed.
fn apply_deliverables(
    state: &mut AgentState,
    arguments: &Value,
    transcript: &Transcript,
) -> Result<(Value, bool), String> {
    let action = required_text(arguments, "action")?;
    let text_of = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let id = || required_text(arguments, "id");
    let mut candidate = state.task_memory.deliverables.clone();
    match action.as_str() {
        "view" => {
            return Ok((
                json!({"deliverables": state.task_memory.deliverables, "updated": false}),
                false,
            ))
        }
        "add" => {
            let check = match arguments.get("check").and_then(Value::as_str) {
                Some(value) if !value.trim().is_empty() => {
                    Some(Need::parse(value).ok_or_else(|| {
                        "check must be readback, static, build, test, runtime or browser".to_owned()
                    })?)
                }
                _ => None,
            };
            candidate.add_checked(
                arguments.get("id").and_then(Value::as_str),
                &text_of("task"),
                &text_of("text"),
                check,
            )?;
        }
        "implemented" | "done" => {
            let id = id()?;
            let evidence = normalize_evidence_refs(&text_of("evidence"), transcript);
            if state.strategy.is_deep() {
                if let Some(problem) = evidence_problem(&evidence, transcript) {
                    return Err(format!("In Deep mode a deliverable is marked implemented only with evidence that cites an observation ID (obs-…) or the exact path of a source you inspected in this run: {problem} Check it, then retry with that evidence; nothing was changed."));
                }
            }
            candidate.implement(&id, &evidence)?;
        }
        "verify" => {
            let id = id()?;
            let item = candidate
                .items
                .iter()
                .find(|item| item.id == id)
                .ok_or_else(|| format!("unknown deliverable '{id}'"))?;
            let cited = evidence_ids(arguments);
            // Persist the relationship BEFORE judging the result. A rejected
            // verify attempt cannot be undone by subsequently omitting its ids.
            let attachment = state.task_memory.verification.attach(&id, &cited);
            sync_verification_failure(state);
            attachment?;
            let proof = state.task_memory.verification.proof_for_item(
                item,
                &cited,
                state.strategy.is_deep(),
                state.browser_available,
            )?;
            candidate.verify(&id, proof)?;
        }
        "block" => candidate.block(&id()?, &text_of("reason"))?,
        "drop" => candidate.drop_item(&id()?, &text_of("reason"))?,
        _ => return Err(
            "unsupported deliverables action: use add, implemented, verify, block, drop or view"
                .into(),
        ),
    }
    state.task_memory.deliverables = candidate;
    sync_verification_failure(state);
    Ok((
        json!({"deliverables": state.task_memory.deliverables, "updated": true}),
        true,
    ))
}

/// Evidence ids (ev-…) named in a `verify` call, whether given as a list or
/// as free text.
fn evidence_ids(arguments: &Value) -> Vec<String> {
    let mut text = String::new();
    for key in ["evidence", "proof", "evidence_ids"] {
        match arguments.get(key) {
            Some(Value::String(value)) => {
                text.push(' ');
                text.push_str(value);
            }
            Some(Value::Array(values)) => {
                for value in values.iter().filter_map(Value::as_str) {
                    text.push(' ');
                    text.push_str(value);
                }
            }
            _ => {}
        }
    }
    let mut ids: Vec<String> = text
        .split(|character: char| !(character.is_ascii_alphanumeric() || character == '-'))
        .filter(|word| word.len() > 3 && word[..3].eq_ignore_ascii_case("ev-"))
        .map(str::to_ascii_lowercase)
        .collect();
    ids.dedup();
    ids
}

fn emit_task_memory(config: &Config, state: &AgentState) {
    if let Ok(memory) = serde_json::to_value(&state.task_memory) {
        emit(&config.run_id, Event::TaskMemoryUpdate { memory });
    }
}

/// Keeps the deliverables honest about the checks the runtime saw fail. Returns
/// whether anything changed.
fn sync_verification_failure(state: &mut AgentState) -> bool {
    state
        .task_memory
        .deliverables
        .sync_failures(&state.task_memory.verification)
}

/// Applies what a terminal command may have done to the project, so a command
/// that edits files (sed -i, mv, a redirect) invalidates earlier checks the way
/// a file tool would. Returns whether the project is known or assumed changed.
///
/// A read-only command changes nothing. Any command not recognised as a check
/// or as read-only is assumed to change the project: the epoch advances, so all
/// run, test and static evidence goes stale, and the code files it names are
/// marked changed. Before a check is trusted, tracked files are compared with
/// what the runtime last saw, so an edit made by the check itself (for example
/// `--fix`) is noticed too. Files a check changes that the task never touched
/// are not detected.
fn record_terminal_effect(
    state: &mut AgentState,
    scope: &crate::tools::filesystem::Scope,
    command: &str,
    effect: verification::Effect,
) -> bool {
    if effect == verification::Effect::ReadOnly {
        return false;
    }
    let mut changed = false;
    let tracked = state
        .task_memory
        .verification
        .revisions
        .iter()
        .map(|(path, revision)| (path.clone(), revision.clone()))
        .collect::<Vec<_>>();
    for (path, known) in tracked {
        match crate::tools::filesystem::file_revision(scope, &path) {
            Some((_, current)) if current == known => {}
            Some((_, current)) => {
                state.task_memory.verification.note_change(Some(&path));
                state
                    .task_memory
                    .verification
                    .revisions
                    .insert(path, current);
                changed = true;
            }
            None => {
                state.task_memory.verification.note_deletion(&path);
                changed = true;
            }
        }
    }
    if effect == verification::Effect::Mutating {
        let ledger = &mut state.task_memory.verification;
        ledger.note_change(None);
        for token in verification::mentioned_code_paths(command) {
            let path = token.strip_prefix("./").unwrap_or(&token).to_owned();
            match crate::tools::filesystem::file_revision(scope, &path) {
                Some((_, revision)) => {
                    ledger.note_change(Some(&path));
                    ledger.revisions.insert(path, revision);
                }
                None => ledger.note_deletion(&path),
            }
        }
        state.record_mutation();
        changed = true;
    }
    if changed {
        state.task_memory.deliverables.demote_verified();
        sync_verification_failure(state);
    }
    changed
}

/// Records what a finished terminal command shows. Only a command with an exit
/// code that the runtime can classify as a check becomes evidence; timeouts and
/// cancellations are inconclusive.
fn record_terminal_evidence(
    state: &mut AgentState,
    root: &Path,
    command: &str,
    value: &Value,
) -> bool {
    let completed = value.get("status").and_then(Value::as_str);
    let Some(exit_code) = value.get("exit_code").and_then(Value::as_i64) else {
        return false;
    };
    if value.get("timed_out").and_then(Value::as_bool) == Some(true)
        || value.get("cancelled").and_then(Value::as_bool) == Some(true)
        || !matches!(completed, Some("completed" | "error"))
    {
        return false;
    }
    let changed = state
        .task_memory
        .verification
        .changed
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let Some(mut kind) = verification::classify_command(command, &changed) else {
        return false;
    };
    if kind == verification::Kind::Run && verification::script_drives_browser(root, command) {
        kind = verification::Kind::Browser;
    }
    let pass = exit_code == 0 && completed == Some("completed");
    let detail = if pass {
        "exit 0".to_owned()
    } else {
        let text = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default();
        let output = if text("stderr").trim().is_empty() {
            text("stdout")
        } else {
            text("stderr")
        };
        let tail = output
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or_default();
        format!("exit {exit_code}: {tail}")
    };
    let turn = state.turn;
    state.task_memory.verification.record_outcome(
        kind,
        command,
        pass,
        &detail,
        turn,
        &json!({
            "exit_code": exit_code, "status": completed,
            "stdout": value.get("stdout"), "stderr": value.get("stderr")
        })
        .to_string(),
    );
    if state.verification_reviews > 0 {
        state.checks_since_review += 1;
    }
    sync_verification_failure(state);
    true
}

/// A successful write, patch or delete changes what any earlier check saw. The
/// runtime reads each written file back itself, so "it was written" never
/// depends on the model's word.
fn record_project_change(
    state: &mut AgentState,
    scope: &crate::tools::filesystem::Scope,
    name: &str,
    paths: &[String],
) {
    let turn = state.turn;
    for path in paths {
        if name == "delete_file" {
            state.task_memory.verification.note_deletion(path);
            continue;
        }
        state.task_memory.verification.note_change(Some(path));
        if let Some((file, revision)) = crate::tools::filesystem::file_revision(scope, path) {
            state
                .task_memory
                .verification
                .revisions
                .insert(path.clone(), revision);
            let size = std::fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0);
            state.task_memory.verification.record(
                verification::Kind::Readback,
                path,
                true,
                &format!("{size} bytes on disk"),
                turn,
            );
        }
    }
    if paths.is_empty() {
        state.task_memory.verification.note_change(None);
    }
    state.task_memory.deliverables.demote_verified();
    sync_verification_failure(state);
}

/// Paths a patch adds, so files created through `apply_patch` are tracked too.
fn patch_added_files(patch: &str) -> Vec<String> {
    patch
        .lines()
        .filter_map(|line| line.trim().strip_prefix("*** Add File:"))
        .map(|path| path.trim().to_owned())
        .filter(|path| !path.is_empty())
        .collect()
}

fn mutation_tool(name: &str) -> bool {
    matches!(
        name,
        "write_file" | "create_file" | "apply_patch" | "delete_file" | "replace_text"
    )
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

/// An execution ending is not proof of task completion. Surface authoritative
/// unresolved state once, without another provider/tool turn or invented plan
/// transitions. The model's prose cannot suppress this terminal disclosure.
fn terminal_status_note(
    state: &AgentState,
    transcript: &Transcript,
    turn_budget_exhausted: bool,
) -> String {
    use deliverables::DeliverableStatus as Status;
    let items = &state.task_memory.deliverables.items;
    let outstanding = items.iter().any(|item| matches!(item.status,
        Status::Pending | Status::Implemented | Status::Blocked));
    let verification = &state.task_memory.verification;
    let need = verification.effective_need(None);
    let anonymous_gap = items.is_empty() && state.mutations > 0 && state.can_verify
        && need != Need::Readback
        && (verification.best_passing(need).is_none()
            || verification.blocking_failure(&state.task_memory.deliverables).is_some());
    let steps = &state.task_memory.plan.steps;
    let unfinished_plan = steps.iter().any(|step| step.status != StepStatus::Completed);
    if !outstanding && !unfinished_plan && !anonymous_gap {
        return String::new();
    }
    let russian = transcript.language_preference() == "Russian";
    let mut parts = Vec::new();
    if anonymous_gap {
        parts.push(if russian { "Изменённое поведение не подтверждено проверкой." }
            else { "Changed behaviour is not verified." }.to_owned());
    }
    if outstanding {
        let total = items.iter().filter(|item| item.status != Status::Dropped).count();
        let verified = items.iter().filter(|item| item.status == Status::Verified).count();
        parts.push(if russian { format!("Подтверждено результатов: {verified}/{total}.") }
            else { format!("Deliverables verified: {verified}/{total}.") });
        for (status, label) in [
            (Status::Implemented, if russian { "Реализовано, но не проверено" } else { "Implemented, not verified" }),
            (Status::Pending, if russian { "Не завершено" } else { "Pending" }),
            (Status::Blocked, if russian { "Заблокировано" } else { "Blocked" }),
        ] {
            let ids = items.iter().filter(|item| item.status == status)
                .map(|item| item.id.as_str()).collect::<Vec<_>>();
            if !ids.is_empty() { parts.push(format!("{label}: {}.", ids.join(", "))); }
        }
    }
    if unfinished_plan {
        let completed = steps.iter().filter(|step| step.status == StepStatus::Completed).count();
        parts.push(if russian { format!("Последнее сохранённое состояние плана: {completed}/{} шагов выполнено; остальные шаги не завершены.", steps.len()) }
            else { format!("Last recorded plan: {completed}/{} steps complete; remaining steps are incomplete.", steps.len()) });
    }
    if turn_budget_exhausted {
        parts.push(if russian { "Лимит рабочих ходов исчерпан; запуск остановлен с указанным выше состоянием." }
            else { "Work-turn budget exhausted; the run ended with the state above." }.to_owned());
    }
    format!("\n\n**{}** {}", if russian { "Статус Agent V2:" } else { "Agent V2 status:" }, parts.join(" "))
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

/// Prefix of the stream error raised when the model's output degenerates into
/// verbatim repetition. Sampling can trap a local model in a paragraph loop that
/// otherwise runs until `max_tokens` (tens of minutes on a large MoE model).
const REPETITION_LOOP_ERROR: &str = "repetition_loop";
const REPETITION_CHECK_STEP_CHARS: usize = 256;
const REPETITION_WINDOW_CHARS: usize = 16_000;
const REPETITION_MIN_PERIOD: usize = 32;
const REPETITION_MAX_PERIOD: usize = 4_000;
const REPETITION_MIN_RUN_CHARS: usize = 1_500;

/// Detects a tail that repeats one block verbatim at least four times (the
/// periodic run covers three further periods) over at least
/// `REPETITION_MIN_RUN_CHARS`. The block must be textual (≥10 distinct chars), so
/// separators or padding runs are not mistaken for a loop.
fn degenerate_repetition(text: &str) -> Option<(usize, usize)> {
    let tail: Vec<char> = {
        let total = text.chars().count();
        text.chars()
            .skip(total.saturating_sub(REPETITION_WINDOW_CHARS))
            .collect()
    };
    let n = tail.len();
    let max_period = REPETITION_MAX_PERIOD.min(n / 4);
    for period in REPETITION_MIN_PERIOD..=max_period {
        let mut run = 0;
        let mut index = n - 1;
        while index >= period && tail[index] == tail[index - period] {
            run += 1;
            index -= 1;
        }
        if run >= (3 * period).max(REPETITION_MIN_RUN_CHARS) {
            let distinct: std::collections::BTreeSet<char> =
                tail[n - period..].iter().copied().collect();
            if distinct.len() >= 10 {
                return Some((period, run));
            }
        }
    }
    None
}

fn check_repetition(text: &str, checked: &mut usize, kind: &str) -> Result<(), String> {
    let length = text.len();
    if length < *checked + REPETITION_CHECK_STEP_CHARS {
        return Ok(());
    }
    *checked = length;
    match degenerate_repetition(text) {
        Some((period, run)) => Err(format!(
            "{REPETITION_LOOP_ERROR}: model {kind} repeated a {period}-character block verbatim over the last {run} characters"
        )),
        None => Ok(()),
    }
}

/// Text returned to the model when a call needs approval it cannot get in this run.
fn approval_refusal(tool: &ValidatedCall) -> &'static str {
    if tool.name == "run_terminal"
        && tool
            .arguments
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|c| c.contains("git "))
    {
        "approval required for shell composition. For read-only history, retry as one scoped command: git -C <selected-project> log --oneline -30. Do not treat this attempt as evidence of repository history."
    } else if tool.name == "run_terminal" {
        "approval required: this command uses shell composition (&&, ||, ;, redirection, substitution, a wrapper) or affects the user session, and it was not run. Run each step as its own simple command; the terminal already starts in the working directory, so cd is not needed. Do not treat this refusal as a result."
    } else {
        "approval required"
    }
}

#[derive(Default)]
struct StreamedTurn {
    /// Byte lengths of `content`/`reasoning_raw` at the last repetition check.
    content_repetition_checked: usize,
    reasoning_repetition_checked: usize,
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
                check_repetition(
                    &turn.reasoning_raw,
                    &mut turn.reasoning_repetition_checked,
                    "reasoning",
                )?;
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
                check_repetition(
                    &turn.content,
                    &mut turn.content_repetition_checked,
                    "output",
                )?;
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
    // A model that is mid-task may answer the summary request with tool-call
    // markup instead of a handoff. That is not a summary: it carries none of
    // the state compaction exists to preserve, so it is retried once with an
    // explicit instruction and otherwise replaced by a neutral note (Task
    // Memory and the deliverables stay authoritative in the prompt tail).
    let mut attempt_messages = messages.clone();
    for attempt in 0..2 {
        let payload = summary_payload(config, &attempt_messages, max_tokens);
        if let Ok(turn) = stream_call(
            &config.endpoint,
            &payload,
            &config.run_id,
            0,
            &config.cancelled,
            false,
            false,
        ) {
            if is_usable_summary(&turn.content) {
                let text = mark_if_cut_at_output_limit(turn.content.trim(), &turn.finish_reason);
                return SummaryResult {
                    output_tokens: turn
                        .completion_tokens
                        .map_or_else(|| estimate_tokens(&json!(text)), |tokens| tokens as usize),
                    text,
                    input_tokens,
                };
            }
        }
        if attempt == 0 {
            attempt_messages.push(json!({"role":"user", "content":"Reply with the plain-text checkpoint only, under the required headings. Do not call tools and do not write tool-call markup."}));
        }
    }
    SummaryResult {
        text: "Earlier conversation was compacted; the current prompt contains the usable summary and retained recent transcript.".into(),
        input_tokens,
        output_tokens: 0,
    }
}

/// A summary must be prose. Empty text, or text that is (or starts with)
/// tool-call markup, preserves nothing.
fn is_usable_summary(content: &str) -> bool {
    let text = content.trim();
    if text.is_empty() {
        return false;
    }
    let lowered = text.to_ascii_lowercase();
    !(lowered.starts_with("<tool_call")
        || lowered.starts_with("<function=")
        || lowered.starts_with("<|tool_call")
        || (lowered.contains("<tool_call>") && lowered.contains("<function=")))
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

/// Project 2 is a reference the user may only want to read. Passive knowledge
/// caching writes into the project's `.ai-framework`, so it is limited to the
/// primary project; an explicit `project_knowledge_update` stays the model's choice.
fn targets_secondary_project(tool: &ValidatedCall) -> bool {
    tool.arguments.get("project").and_then(Value::as_u64) == Some(2)
}

/// A reference project without a knowledge cache stays that way: the knowledge
/// tools would otherwise create `.ai-framework` in it just to answer "nothing here".
fn absent_reference_knowledge(config: &Config, tool: &ValidatedCall) -> Option<Value> {
    if !targets_secondary_project(tool)
        || !matches!(
            tool.name.as_str(),
            "project_knowledge_index" | "project_knowledge_read"
        )
    {
        return None;
    }
    let root = config.root.as_deref()?;
    if Path::new(root).join(".ai-framework").exists() {
        return None;
    }
    Some(json!({
        "exists": false,
        "entries": [],
        "message": "Project 2 has no knowledge cache and the runtime does not create one in a reference project. Read its files directly."
    }))
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
    if let Some(absent) = absent_reference_knowledge(config, tool) {
        return Ok((absent, None));
    }
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
        "deliverables" => {
            let result = apply_deliverables(state, &tool.arguments, transcript);
            // Failed verify citations also change the durable evidence state.
            if result.is_err() {
                emit_task_memory(config, state);
            }
            let (value, changed) = result?;
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
        "plan" => {
            let (value, changed) = apply_plan(state, &tool.arguments)?;
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
                .work_root()
                .map(str::to_owned)
                .ok_or_else(|| "no project scope".to_owned())?;
            let command = tool
                .arguments
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let ids = match tool.arguments.get("deliverable_ids") {
                None => Vec::new(),
                Some(Value::Array(values)) => values
                    .iter()
                    .map(|value| {
                        let id = value
                            .as_str()
                            .ok_or_else(|| "deliverable_ids must contain strings".to_owned())?;
                        if !state.task_memory.deliverables.items.iter().any(|item| {
                            item.id == id
                                && !matches!(
                                    item.status,
                                    deliverables::DeliverableStatus::Dropped
                                        | deliverables::DeliverableStatus::Blocked
                                )
                        }) {
                            return Err(format!("unknown or inactive deliverable '{id}'"));
                        }
                        Ok(id.to_owned())
                    })
                    .collect::<Result<Vec<_>, String>>()?,
                _ => {
                    return Err(
                        "deliverable_ids must be an array of recorded deliverable ids".into(),
                    )
                }
            };
            state.task_memory.verification.bind(&command, &ids)?;
            if !ids.is_empty() {
                sync_verification_failure(state);
                emit_task_memory(config, state);
            }
            let value = crate::tools::shell::execute(
                &PathBuf::from(&root),
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
            let grants = config.grants();
            let scope = crate::tools::filesystem::Scope {
                root: Path::new(&root),
                grants: &grants,
            };
            let tracked = state
                .task_memory
                .verification
                .changed
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>();
            let effect = verification::terminal_effect(&command, &tracked);
            let mut changed = record_terminal_effect(state, &scope, &command, effect);
            // A check that rewrote tracked files did not check the files the
            // runtime knows about, so its exit code is not recorded.
            let inconclusive = changed && matches!(effect, verification::Effect::Check(_));
            if !inconclusive && record_terminal_evidence(state, Path::new(&root), &command, &value)
            {
                changed = true;
            }
            if changed {
                emit_task_memory(config, state);
            }
            if terminal_execution_failed(&value) {
                return Err(value.to_string());
            }
            Ok((value, None))
        }
        name => {
            let root = config
                .work_root()
                .ok_or_else(|| "no project scope".to_owned())?;
            let grants = config.grants();
            let target = tool
                .arguments
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let existed_before = target
                .as_deref()
                .is_some_and(|path| Path::new(root).join(path).exists());
            let file_scope = crate::tools::filesystem::Scope {
                root: Path::new(root),
                grants: &grants,
            };
            if name == "write_file" {
                if let Some((file, revision)) = target
                    .as_deref()
                    .and_then(|path| crate::tools::filesystem::file_revision(&file_scope, path))
                {
                    if state.file_changed_since_seen(&file, &revision) {
                        return Err("File changed since your last read. Read the latest version before writing.".to_owned());
                    }
                }
            }
            let result = if name == "replace_text" {
                let (file, _) = target.as_deref()
                    .and_then(|path| crate::tools::filesystem::file_revision(&file_scope, path))
                    .ok_or_else(|| "replace_text requires an existing file inside the project scope".to_owned())?;
                let expected = state.file_revisions.get(&file)
                    .ok_or_else(|| "Read the file before using replace_text; model-supplied revisions are not accepted".to_owned())?;
                crate::tools::filesystem::replace_text_in(&file_scope, &tool.arguments, expected)?
            } else {
                crate::tools::filesystem::execute_in(&file_scope, name, &tool.arguments)?
            };
            let touched = match name {
                "read_file" | "write_file" | "create_file" | "replace_text" => target.iter().cloned().collect(),
                "apply_patch" => result
                    .0
                    .get("files")
                    .and_then(Value::as_array)
                    .map(|files| {
                        files
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
                _ => Vec::<String>::new(),
            };
            for path in touched {
                if let Some((file, revision)) =
                    crate::tools::filesystem::file_revision(&file_scope, &path)
                {
                    state.note_file_revision(file, revision);
                }
            }
            match (name, target.as_deref()) {
                ("create_file" | "write_file", Some(path)) if !existed_before => {
                    state.record_created_file(path);
                }
                ("delete_file", Some(path)) => state.record_deleted_file(path),
                ("apply_patch", _) => {
                    let patch = tool
                        .arguments
                        .get("patch")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    for path in patch_added_files(patch) {
                        state.record_created_file(&path);
                    }
                }
                _ => {}
            }
            if config.root.is_some()
                && !targets_secondary_project(tool)
                && matches!(name, "read_file" | "list_directory")
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
                let changed = match name {
                    "apply_patch" => result
                        .0
                        .get("files")
                        .and_then(Value::as_array)
                        .map(|files| {
                            files
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default(),
                    _ => target.iter().cloned().collect::<Vec<_>>(),
                };
                record_project_change(state, &file_scope, name, &changed);
                emit_task_memory(config, state);
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
    if let Some(absent) = absent_reference_knowledge(config, tool) {
        return Ok((absent, None));
    }
    let root = config
        .work_root()
        .ok_or_else(|| "no project scope".to_owned())?;
    match tool.name.as_str() {
        "project_knowledge_index" => {
            let root = config
                .root
                .as_ref()
                .ok_or_else(|| "no project scope".to_owned())?;
            crate::tools::knowledge::index(&PathBuf::from(root)).map(|value| (value, None))
        }
        "project_knowledge_read" => {
            let root = config
                .root
                .as_ref()
                .ok_or_else(|| "no project scope".to_owned())?;
            crate::tools::knowledge::read(&PathBuf::from(root), &tool.arguments)
                .map(|value| (value, None))
        }
        "read_file" | "list_directory" => {
            let grants = config.grants();
            crate::tools::filesystem::execute_in(
                &crate::tools::filesystem::Scope {
                    root: Path::new(root),
                    grants: &grants,
                },
                &tool.name,
                &tool.arguments,
            )
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
    if absent_reference_knowledge(config, tool).is_some() {
        return;
    }
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
            if tool.name == "read_file" {
                if let (Some(root), Some(path)) = (
                    config.work_root(),
                    tool.arguments.get("path").and_then(Value::as_str),
                ) {
                    let grants = config.grants();
                    let scope = crate::tools::filesystem::Scope {
                        root: Path::new(root),
                        grants: &grants,
                    };
                    if let Some((file, revision)) =
                        crate::tools::filesystem::file_revision(&scope, path)
                    {
                        state.note_file_revision(file, revision);
                    }
                }
            }
            if !user_requests_read_only(&config.user) && !targets_secondary_project(tool) {
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

/// Commands that produce evidence a run may spend after the first
/// verification review before the gate stops asking.
fn verification_budget(strategy: Strategy) -> usize {
    if strategy.is_deep() {
        12
    } else {
        6
    }
}

/// What a finished modification run has not shown yet, or `None`. The gate
/// applies only to runs that changed the project and can execute commands, and
/// it asks for the cheapest check that settles it, not for exhaustive testing.
fn verification_gap(state: &AgentState) -> Option<String> {
    if state.mutations == 0 || !state.can_verify || state.verification_closed {
        return None;
    }
    let ledger = &state.task_memory.verification;
    let mut lines = Vec::new();
    if let Some(failure) = ledger.blocking_failure(&state.task_memory.deliverables) {
        lines.push(format!(
            "{} failed after your last change: {} ({})",
            failure.id, failure.subject, failure.detail
        ));
    }
    let deliverables = &state.task_memory.deliverables;
    let unreachable = ledger.unreachable(deliverables, state.browser_available);
    let reachable = deliverables
        .unverified()
        .into_iter()
        .filter(|item| !unreachable.iter().any(|other| other.id == item.id))
        .collect::<Vec<_>>();
    if !reachable.is_empty() {
        let mut line = format!(
            "implemented but not verified: {}",
            deliverables::Deliverables::summarize(&reachable)
        );
        if reachable.iter().any(|item| {
            ledger.effective_need(item.check) == Need::Browser
                && ledger.best_passing(Need::Browser).is_none()
        }) {
            line.push_str(" (needs a run in a real browser, e.g. a headless browser or a Playwright or Puppeteer script; a jsdom or node script is not one)");
        }
        lines.push(line);
    } else if deliverables.is_empty() {
        let need = ledger.effective_need(None);
        if need != Need::Readback
            && ledger.reachable(need, state.browser_available)
            && ledger.best_passing(need).is_none()
        {
            lines.push(match need {
                Need::Browser => "you changed a page, and no run in a real browser (a headless browser, Playwright or Puppeteer script) has passed since your last change; a jsdom or node script is not one".to_owned(),
                _ => "you changed code, and no test or script that runs it has passed since your last change".to_owned(),
            });
        }
    }
    if state.strategy.is_deep()
        && (deliverables.is_empty()
            || deliverables
                .unverified()
                .iter()
                .any(|item| item.check == Some(Need::Test)))
        && ledger.code_changed
        && !ledger.has_fresh_pass_of(verification::Kind::Test)
    {
        if let Some(command) = &state.project_test_command {
            lines.push(format!(
                "the project has a test command ({command}) that has not passed since your last change"
            ));
        }
    }
    (!lines.is_empty()).then(|| lines.join("; "))
}

fn verification_review_text(gap: &str, failing: bool) -> String {
    let fix = if failing {
        " A check failed: fix the cause and run it again."
    } else {
        ""
    };
    format!("Before finishing: the runtime has not seen your work verified: {gap}.{fix} Run the most relevant check now: the project's tests, or a short script that runs the changed code (for a page, a real headless browser; jsdom is only a stand-in and does not prove page behaviour). Reading the file back does not show it works. Then call deliverables verify for what the check covers. If it cannot be checked here, finish and say plainly that it is implemented but not verified. Do not call it working without a passing check.")
}

enum FinalCandidateReview {
    PendingDeliverables(String),
    Accept,
    /// The work changed and was not shown to work; one bounded review.
    VerificationPending(String),
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
    if transcript.is_finalizing() || state.pause.is_some() {
        return FinalCandidateReview::Accept;
    }
    // The model recorded what the user asked for and has not finished it. Deep
    // may be sent back twice; Fast once. Afterwards the answer is accepted, so
    // this can never deadlock a run. The answer must then say what is missing.
    let allowed_reviews = if state.strategy.is_deep() { 2 } else { 1 };
    if state.task_memory.deliverables.has_pending() && state.deliverable_reviews < allowed_reviews {
        state.deliverable_reviews += 1;
        return FinalCandidateReview::PendingDeliverables(deliverables::pending_review(
            &state.task_memory.deliverables.pending_summary(),
            &state.created_files,
            state.strategy.is_deep(),
        ));
    }
    if let Some(gap) = verification_gap(state) {
        let failure = state
            .task_memory
            .verification
            .blocking_failure(&state.task_memory.deliverables)
            .map(|record| record.id.clone());
        // A new failing check earns one review of its own; the same failure is
        // never sent back twice, and otherwise reviews are fixed per mode.
        let new_failure = failure.is_some() && failure != state.reviewed_failure;
        if new_failure || state.verification_reviews < allowed_reviews {
            state.verification_reviews += 1;
            if new_failure {
                state.reviewed_failure = failure.clone();
            }
            return FinalCandidateReview::VerificationPending(verification_review_text(
                &gap,
                failure.is_some(),
            ));
        }
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
    state.task_memory.verification.start_run();
    state.task_memory.deliverables.demote_verified();
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
    let mut schemas = tool_schemas_for_request(config.tool_scope(), config.policy, &config.user);
    if config.secondary_root.is_some() {
        for schema in &mut schemas {
            if !matches!(
                tool_name(schema),
                "task_memory" | "deliverables" | "plan" | "observation_read" | "observation_index"
            ) {
                schema["function"]["parameters"]["properties"]["project"] = json!({"type":"integer","enum":[1,2],"description":"Selected project slot. 1 is the primary root; 2 is the secondary root. Defaults to 1."});
            }
        }
    }
    state.can_verify = schemas
        .iter()
        .any(|schema| tool_name(schema) == "run_terminal");
    state.browser_available = state.can_verify
        && config.browser_capability.unwrap_or_else(|| {
            config
                .work_root()
                .is_some_and(|root| verification::browser_available(Path::new(root)))
        });
    if state.can_verify && state.strategy.is_deep() {
        state.project_test_command = config
            .work_root()
            .and_then(|root| verification::detect_test_command(Path::new(root)));
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
    let mut consecutive_empty_turns = 0_usize;
    let mut turn_budget_exhausted = false;

    emit(
        &config.run_id,
        Event::AgentStarted {
            run_id: config.run_id.clone(),
        },
    );
    // Continue's epoch/status transition must reach persistence and the panel
    // even if the model finishes without another tool call.
    if !state.task_memory.verification.is_empty() || !state.task_memory.deliverables.is_empty() {
        emit_task_memory(&config, &state);
    }
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
        state.pause_offered = false;
        let mut steering_applied = false;
        if let Ok(mut steering) = config.steering.lock() {
            for content in steering.drain(..) {
                transcript.push_steering(content.clone());
                emit(&config.run_id, Event::SteeringApplied { content });
                steering_applied = true;
            }
            if config.pause_requested.swap(false, Ordering::Relaxed) {
                begin_pause(&config, &mut state, "user_control");
            }
        }
        state.pause_offered = steering_applied && state.pause.is_none();
        if let Some(pause) = state.pause.as_mut() {
            if pause.checkpoint_turns_left == 0 {
                if !transcript.is_finalizing() {
                    transcript.mark_finalizing();
                }
            } else {
                pause.checkpoint_turns_left -= 1;
            }
        }
        state.turn = turn;
        if !state.verification_closed
            && state.verification_reviews > 0
            && state.checks_since_review >= verification_budget(state.strategy)
        {
            state.verification_closed = true;
        }
        if turn >= MAX_INVESTIGATION_TURNS && !transcript.is_finalizing() {
            turn_budget_exhausted = true;
            transcript.mark_finalizing();
            trace_forensics(
                &config.run_id,
                "lifecycle_transition",
                json!({"state":"finalizing","reason":"turn_budget_exhausted","turn":turn+1}),
            );
        }
        let offered_schemas = turn_schemas(&schemas, &state, transcript.is_finalizing());
        let request_schemas = &offered_schemas;
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
                        && message
                            .get("content")
                            .and_then(Value::as_str)
                            .is_some_and(|content| content.contains(config.user.as_str()))
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
            Err(error) if error.starts_with(REPETITION_LOOP_ERROR) => {
                emit(
                    &config.run_id,
                    Event::AgentError {
                        code: REPETITION_LOOP_ERROR.into(),
                        message: format!("Модель зациклилась и начала дословно повторять один и тот же фрагмент, поэтому генерация остановлена автоматически. Уже выполненная работа сохранена — отправьте сообщение, чтобы продолжить. ({error})"),
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
        if state.pause.is_some()
            && calls.is_empty()
            && streamed.content.trim().is_empty()
            && !was_continuation
            && consecutive_empty_turns >= 1
        {
            streamed.content = PAUSE_FALLBACK.into();
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
                FinalCandidateReview::VerificationPending(nudge) => {
                    trace_forensics(
                        &config.run_id,
                        "completion_review",
                        json!({"decision":"verification_pending","turn":turn+1,"reviews":state.verification_reviews}),
                    );
                    transcript.assistant_withheld_draft(streamed.content, "unverified changes");
                    transcript.remind(nudge);
                    continue;
                }
                FinalCandidateReview::PendingDeliverables(nudge) => {
                    trace_forensics(
                        &config.run_id,
                        "completion_review",
                        json!({"decision":"pending_deliverables","turn":turn+1,"pending":state.task_memory.deliverables.pending_summary()}),
                    );
                    transcript
                        .assistant_withheld_draft(streamed.content, "unfinished deliverables");
                    transcript.remind(nudge);
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
            let note = terminal_status_note(&state, &transcript, turn_budget_exhausted);
            emit_accepted_final_content(&config.run_id, &note);
            visible_final_content.push_str(&note);
            final_content.push_str(&note);
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
            if let Some(pause) = state.pause {
                emit(
                    &config.run_id,
                    Event::RunPaused {
                        checkpoint_turns: PauseState::CHECKPOINT_TURNS
                            - pause
                                .checkpoint_turns_left
                                .min(PauseState::CHECKPOINT_TURNS),
                    },
                );
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
                && state.pause.is_none()
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
                emit(
                    &config.run_id,
                    Event::ToolError {
                        id: tool.id.clone(),
                        name: tool.name.clone(),
                        message: "generation cancelled".into(),
                    },
                );
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
                let message = if state.pause.is_some() && !transcript.is_finalizing() {
                    PAUSED_TOOL_MESSAGE.to_owned()
                } else if transcript.is_finalizing() {
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
            if state.pause.is_some()
                && !CHECKPOINT_TOOLS.contains(&tool.name.as_str())
                && tool.name != "pause_run"
            {
                let message = PAUSED_TOOL_MESSAGE.to_owned();
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
                let refusal = approval_refusal(tool);
                // The started card must end with this call's own result: the
                // model's retry is a new call with a new ID.
                emit(
                    &config.run_id,
                    Event::ToolError {
                        id: tool.id.clone(),
                        name: tool.name.clone(),
                        message: refusal.into(),
                    },
                );
                transcript.tool_result(&tool.id, &tool.name, concise_tool_error(refusal));
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
                "pause_run" if state.pause_offered && state.pause.is_none() => {
                    begin_pause(&config, &mut state, "model_classified");
                    Ok((
                        json!({"status":"pausing","next":"Save the checkpoint with task_memory and deliverables, then write the short pause summary."}),
                        None,
                    ))
                }
                "pause_run" => Err(
                    "pause_run is available only right after the user sent a new message".into(),
                ),
                "task_memory"
                    if match tool.arguments.get("action").and_then(Value::as_str) {
                        None => true,
                        Some(action) => {
                            matches!(canonical_memory_action(action), Some("update" | "record"))
                        }
                    } =>
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
                    // A failed terminal keeps its structured execution so the
                    // result closes the same card the process started.
                    emit(
                        &config.run_id,
                        Event::ToolError {
                            id: tool.id.clone(),
                            name: tool.name.clone(),
                            message: stored_error.clone(),
                        },
                    );
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
    fn verbatim_paragraph_loop_aborts_the_stream_but_normal_text_does_not() {
        let block = "**Итог**: я нашёл ключевую проблему — `makeBotMove()` может вернуться без вызова `finishTurn()`.\n\nНо это не объяснит, почему бот не ходит после хода игрока.\n\n";
        let mut turn = StreamedTurn::default();
        let mut buffer = String::new();
        let mut result = Ok(());
        let mut frames = 0;
        // Stream the loop one delta at a time, as the provider does.
        for _ in 0..40 {
            for piece in block.split_inclusive(' ') {
                buffer.push_str(&format!(
                    "data: {}\n\n",
                    json!({"choices":[{"index":0,"delta":{"content":piece}}]})
                ));
                frames += 1;
                result = consume_sse(&mut buffer, &mut turn, "test-run", false, false);
                if result.is_err() {
                    break;
                }
            }
            if result.is_err() {
                break;
            }
        }
        let error = result.expect_err("a verbatim loop must stop the stream");
        assert!(error.starts_with(REPETITION_LOOP_ERROR), "{error}");
        // Detected after a handful of repetitions, not at max_tokens.
        assert!(
            turn.content.chars().count() < REPETITION_MIN_RUN_CHARS + 3 * block.chars().count(),
            "{frames} {} {}",
            turn.content.chars().count(),
            block.chars().count()
        );

        let varied: String = (0..400)
            .map(|n| {
                format!(
                    "Шаг {n}: проверяю файл module_{n}.js и фиксирую результат {}.\n",
                    n * 7
                )
            })
            .collect();
        assert_eq!(degenerate_repetition(&varied), None);
        assert_eq!(degenerate_repetition(&"=".repeat(8_000)), None);
        let table: String = (0..300).map(|n| format!("| {n} | ok | — |\n")).collect();
        assert_eq!(degenerate_repetition(&table), None);
    }
    #[test]
    fn pause_restricts_schemas_to_the_checkpoint_and_offers_pause_run_only_after_steering() {
        let schemas = tool_schemas_for_request(ToolScope::Project, RunPolicy::Auto, "build it");
        let names = |offered: &[Value]| {
            offered
                .iter()
                .map(|s| tool_name(s).to_owned())
                .collect::<Vec<_>>()
        };
        let mut state = AgentState::default();
        assert!(!names(&turn_schemas(&schemas, &state, false)).contains(&"pause_run".to_owned()));
        state.pause_offered = true;
        assert!(names(&turn_schemas(&schemas, &state, false)).contains(&"pause_run".to_owned()));
        state.pause_offered = false;
        state.pause = Some(PauseState {
            checkpoint_turns_left: 2,
        });
        assert_eq!(
            names(&turn_schemas(&schemas, &state, false)),
            ["deliverables", "plan", "task_memory"]
                .iter()
                .map(|s| (*s).to_owned())
                .collect::<Vec<_>>()
                .into_iter()
                .filter(|n| names(&schemas).contains(n))
                .collect::<Vec<_>>()
        );
        assert!(turn_schemas(&schemas, &state, true).is_empty());
    }

    #[test]
    fn a_paused_tail_carries_state_but_none_of_the_guidance_that_resumes_work() {
        let mut state = AgentState::default();
        state.turn = 5;
        state.mutations = 3;
        state.created_files.push("a.txt".into());
        let transcript = Transcript::default();
        let request = "Do two things:\n1. add a bot mode\n2. add a theme switch";
        let running = dynamic_tail(
            &state,
            None,
            request,
            &transcript,
            "<investigation>x</investigation>",
        );
        assert!(running.contains("<deliverables_hint>") && running.contains("<investigation>"));
        state.pause = Some(PauseState {
            checkpoint_turns_left: 2,
        });
        let paused = dynamic_tail(
            &state,
            None,
            request,
            &transcript,
            "<investigation>x</investigation>",
        );
        assert!(paused.contains("<run_paused>"));
        for resumed in [
            "deliverables_hint",
            "run_budget",
            "files_created_this_run",
            "<investigation>",
            "checkpoint_due",
        ] {
            assert!(!paused.contains(resumed), "{resumed}");
        }
        assert!(!paused.to_lowercase().contains("todo"));
    }

    #[test]
    fn a_paused_final_is_accepted_without_any_completion_review() {
        let mut state = AgentState::default();
        state.mutations = 3;
        state.can_verify = true;
        state.strategy = Strategy::Deep;
        state.pause = Some(PauseState {
            checkpoint_turns_left: 1,
        });
        let mut transcript = Transcript::default();
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &Ledger::default()),
            FinalCandidateReview::Accept
        ));
        assert_eq!(state.verification_reviews, 0);
    }

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
    fn an_explicit_main_reasoning_selection_is_independent_of_the_strategy() {
        let mut config = test_config(32_768);
        config.reasoning_mode = "deep".into();
        config.reasoning_options = Some(json!({
            "fast":{"reasoning_effort":"low"},
            "deep":{"reasoning_effort":"xhigh"},
            "main":{"reasoning_effort":"medium","chat_template_kwargs":{"enable_thinking":true}},
            "final":{"chat_template_kwargs":{"enable_thinking":false}}
        }));
        let messages = vec![json!({"role":"user","content":"work"})];
        let working = request_payload_for_phase(&config, &messages, &[], 1_024, false);
        assert_eq!(
            working["reasoning_effort"], "medium",
            "Deep strategy must not override the chosen effort"
        );
        let finalizing = request_payload_for_phase(&config, &messages, &[], 1_024, true);
        assert!(finalizing.get("reasoning_effort").is_none());
        assert_eq!(
            finalizing["chat_template_kwargs"]["enable_thinking"],
            json!(false)
        );

        config.reasoning_options =
            Some(json!({"main":{"chat_template_kwargs":{"enable_thinking":false}}}));
        let off = request_payload_for_phase(&config, &messages, &[], 1_024, false);
        assert_eq!(off["chat_template_kwargs"]["enable_thinking"], json!(false));
        assert!(
            off.get("reasoning_effort").is_none(),
            "thinking off sends no effort"
        );
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
            workspace_roots: Vec::new(),
            context_limit: window,
            reasoning_mode: "fast".into(),
            supports_reasoning: true,
            reasoning_options: None,
            policy: RunPolicy::Safe,
            history: Vec::new(),
            evidence_dir: None,
            task_memory: None,
            provider_max_output: None,
            browser_capability: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            steering: Arc::new(Mutex::new(Vec::new())),
            steering_closed: Arc::new(AtomicBool::new(false)),
            pause_requested: Arc::new(AtomicBool::new(false)),
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
        let schemas = tool_schemas(ToolScope::Project);
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
        let memory = tool_schemas(ToolScope::Project)
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
        assert_eq!(parameters["properties"]["observations"]["type"], "array");
        assert_eq!(
            parameters["properties"]["observations"]["items"]["type"],
            "string"
        );
    }

    #[test]
    fn provider_serialization_preserves_declared_tool_parameter_order() {
        let schemas = tool_schemas(ToolScope::Project);
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
                "status",
                "observations"
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
            let schemas = tool_schemas_for_request(ToolScope::Project, RunPolicy::Auto, prompt);
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

        let writable = tool_schemas_for_request(
            ToolScope::Project,
            RunPolicy::Auto,
            "Update the project files.",
        );
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

    fn transcript_with_reads(count: usize) -> (Transcript, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "memory-refs-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(base.join("project")).unwrap();
        let root = base.join("project");
        let mut transcript =
            Transcript::durable(&base.join("store"), "refs-test", &[], root.to_str()).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"inspect"}));
        for n in 0..count {
            let file = format!("f{n}.ts");
            std::fs::write(root.join(&file), format!("export const v = {n};")).unwrap();
            transcript.assistant_tool_turn(
                String::new(),
                &[ValidatedCall {
                    id: format!("read{n}"),
                    name: "read_file".into(),
                    arguments: json!({"path":file}),
                }],
            );
            transcript.tool_result(
                &format!("read{n}"),
                "read_file",
                json!({"path":file,"content":format!("export const v = {n};")}).to_string(),
            );
        }
        (transcript, base)
    }

    #[test]
    fn evidence_references_are_normalized_but_never_invented() {
        let (transcript, base) = transcript_with_reads(3);
        let normalize = |text: &str| normalize_evidence_refs(text, &transcript);
        assert_eq!(normalize("obs-00000001"), "obs-00000001");
        assert_eq!(normalize("obs-1"), "obs-00000001");
        assert_eq!(normalize("OBS-2"), "obs-00000002");
        assert_eq!(normalize("obs-00000001/0002"), "obs-00000001, obs-00000002");
        assert_eq!(
            normalize("obs-00000001, 0003 and f0.ts"),
            "obs-00000001, obs-00000003 and f0.ts"
        );
        assert_eq!(
            normalize("obs-00000001, obs-00000002"),
            "obs-00000001, obs-00000002"
        );
        assert_eq!(
            normalize("obs-99"),
            "obs-99",
            "a fabricated id stays as written so it is reported"
        );
        assert_eq!(normalize("obs-1/99"), "obs-00000001, obs-99");
        assert_eq!(normalize("see src/obs-notes.md"), "see src/obs-notes.md");
        let problem = evidence_problem(&normalize("obs-99"), &transcript).unwrap();
        assert!(
            problem.contains("obs-99") && problem.contains("obs-00000003"),
            "{problem}"
        );
        assert!(evidence_problem(&normalize("obs-1/2"), &transcript).is_none());
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn task_memory_accepts_common_action_names_and_evidence_shapes() {
        let (transcript, base) = transcript_with_reads(2);
        let mut state = AgentState::default();
        apply_task_memory(
            &mut state,
            &json!({"action":"create","finding":"a","status":"refuted"}),
            &transcript,
        )
        .unwrap();
        assert_eq!(
            state.task_memory.entries[0].status,
            Some(crate::agent::task_memory::Status::Contradicted)
        );
        state.memory_writes_this_turn = 0;
        apply_task_memory(
            &mut state,
            &json!({"action":"edit","id":"tm-001","status":"confirmed","observations":["obs-1","obs-2"]}),
            &transcript,
        )
        .unwrap();
        assert_eq!(
            state.task_memory.entries[0].evidence,
            "obs-00000001, obs-00000002"
        );
        assert_eq!(state.task_memory.entries[0].finding, "a");
        state.memory_writes_this_turn = 0;
        for bad in [
            json!({"action":"update","id":"tm-001","evidence":[1]}),
            json!({"action":"update","id":"tm-001","evidence":{"a":1}}),
        ] {
            assert!(apply_task_memory(&mut state, &bad, &transcript).is_err());
        }
        apply_task_memory(
            &mut state,
            &json!({"action":"delete","id":"tm-001"}),
            &transcript,
        )
        .unwrap();
        assert!(state.task_memory.entries[0].invalidated);
        assert!(
            canonical_memory_action("get") == Some("view")
                && canonical_memory_action("zzz").is_none()
        );
        std::fs::remove_dir_all(base).ok();
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

    fn state_with_pending() -> AgentState {
        let mut state = AgentState::default();
        state
            .task_memory
            .deliverables
            .add(None, "bot", "bot opponent is selectable in the UI")
            .unwrap();
        state
            .task_memory
            .deliverables
            .add(None, "theme", "theme switch changes the theme")
            .unwrap();
        state
            .task_memory
            .deliverables
            .implement("d-001", "")
            .unwrap();
        state
    }

    #[test]
    fn terminal_disclosure_distinguishes_unverified_blocked_and_saved_plan_without_mutation() {
        let mut state = state_with_pending();
        state.task_memory.plan.set(&["inspect".into(), "verify".into()]).unwrap();
        state.task_memory.deliverables.block("d-002", "browser unavailable").unwrap();
        let before = serde_json::to_value(&state.task_memory).unwrap();
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"Выполни задачу"}));
        let note = terminal_status_note(&state, &transcript, true);
        assert!(note.contains("Подтверждено результатов: 0/2"));
        assert!(note.contains("Реализовано, но не проверено: d-001"));
        assert!(note.contains("Заблокировано: d-002"));
        assert!(note.contains("0/2 шагов выполнено"));
        assert!(note.contains("Лимит рабочих ходов исчерпан"));
        assert_eq!(serde_json::to_value(&state.task_memory).unwrap(), before);
        assert!(!terminal_status_note(&state, &transcript, false).contains("Лимит рабочих ходов"));
        assert!(terminal_status_note(&AgentState::default(), &transcript, false).is_empty());
        for item in &mut state.task_memory.deliverables.items {
            item.status = deliverables::DeliverableStatus::Verified;
        }
        for step in &mut state.task_memory.plan.steps { step.status = StepStatus::Completed; }
        assert!(terminal_status_note(&state, &transcript, true).is_empty());
        let mut without_items = AgentState::default();
        without_items.mutations = 1;
        without_items.can_verify = true;
        without_items.verification_closed = true;
        without_items.task_memory.verification.note_change(Some("app.js"));
        assert!(terminal_status_note(&without_items, &transcript, false).contains("не подтверждено проверкой"),
            "an exhausted review allowance must not silently certify an unregistered change");
    }

    #[test]
    fn unfinished_deliverables_are_in_every_tail_and_survive_what_compaction_discards() {
        let state = state_with_pending();
        let tail = dynamic_tail(&state, None, "", &Transcript::default(), "");
        assert!(tail.contains("[implemented] d-001 bot opponent is selectable in the UI"));
        assert!(tail.contains("[pending] d-002 theme switch changes the theme"));
        // The tail is rebuilt from durable state each turn, so a compaction summary can never be the only place
        // the requirements live.
        let mut compacted = Transcript::default();
        compacted.push_run_user(json!({"role":"user","content":"x"}));
        compacted.compact("[checkpoint without any deliverables]".into(), 1);
        assert!(dynamic_tail(&state, None, "", &compacted, "").contains("[pending] d-002"));
    }

    #[test]
    fn enumerated_items_are_counted_from_list_markers_not_from_words() {
        assert_eq!(
            enumerated_items("Do two things.\n1. Add the bot mode\n2. Add the theme switch"),
            2
        );
        assert_eq!(enumerated_items("У тебя 2 задачи.\n1. Добавить режим бота\n2) Добавить переключатель темы\n3 не пункт"), 2);
        assert_eq!(
            enumerated_items(
                "- first thing to build\n* second thing to build\n• third thing to build"
            ),
            3
        );
        assert_eq!(
            enumerated_items("Add a mode and also a theme switch in one go, 2 things in total."),
            0
        );
        assert_eq!(
            enumerated_items("1. ok"),
            0,
            "a marker with no real content is not an item"
        );
        assert_eq!(
            enumerated_items("version 1.2 is out\nsee 3.5 for details"),
            0
        );
    }

    #[test]
    fn the_contract_hint_is_structural_bounded_and_goes_away_once_a_list_exists() {
        let request =
            "Two tasks:\n1. Add the bot mode to the game\n2. Add the theme switch to the game";
        let mut state = AgentState::default();
        assert!(contract_hint(&state, request)
            .unwrap()
            .contains("lists 2 separate items"));
        assert!(
            contract_hint(&state, "Fix the typo in the readme").is_none(),
            "a single-step request gets no hint"
        );
        state.mutations = 1;
        assert!(contract_hint(&state, "Fix the typo in the readme")
            .unwrap()
            .contains("Ignore this for a single-step request"));
        state.turn = 30;
        assert!(
            contract_hint(&state, request).is_none(),
            "the hint must stop nagging"
        );
        state.turn = 3;
        state
            .task_memory
            .deliverables
            .add(None, "", "the bot mode is selectable")
            .unwrap();
        assert!(
            contract_hint(&state, request).is_none(),
            "once a list exists the hint is redundant"
        );
        let mut fresh = AgentState::default();
        assert!(
            dynamic_tail(&fresh, None, request, &Transcript::default(), "")
                .contains("<deliverables_hint>")
        );
        assert!(!dynamic_tail(
            &fresh,
            None,
            "Audit the product. Do not modify files.\n1. Product\n2. Backend",
            &Transcript::default(),
            ""
        )
        .contains("<deliverables_hint>"));
        fresh.turn = 1;
    }

    #[test]
    fn the_budget_notice_appears_only_while_deliverables_are_pending_and_the_budget_is_half_used() {
        assert!(run_budget_notice(10, 128, "d-002 x").is_none());
        let middle = run_budget_notice(70, 128, "d-002 x").unwrap();
        assert!(middle.contains("Turn 71 of 128") && middle.contains("d-002 x"));
        assert!(!middle.contains("Only about"));
        let late = run_budget_notice(120, 128, "d-002 x").unwrap();
        assert!(late.contains("Only about 7 turns remain") && late.contains("blocked"));
        let mut state = state_with_pending();
        state.turn = 100;
        let tail = dynamic_tail(&state, None, "", &Transcript::default(), "");
        assert!(tail.contains("<run_budget>"));
        state
            .task_memory
            .deliverables
            .implement("d-002", "")
            .unwrap();
        assert!(
            !dynamic_tail(&state, None, "", &Transcript::default(), "").contains("<run_budget>")
        );
    }

    #[test]
    fn a_forced_final_names_the_unfinished_deliverables_and_forbids_calling_them_done() {
        let state = state_with_pending();
        let mut transcript = Transcript::default();
        transcript.mark_finalizing();
        let tail = dynamic_tail(&state, None, "", &transcript, "");
        assert!(
            tail.contains("<unfinished_deliverables>d-002 theme switch changes the theme (theme)")
        );
        assert!(tail.contains("report each of them plainly as not completed"));
        assert!(!tail.contains("<run_budget>"));
    }

    #[test]
    fn tool_call_markup_is_not_a_usable_compaction_summary() {
        assert!(!is_usable_summary(""));
        assert!(!is_usable_summary("   \n"));
        assert!(!is_usable_summary(
            "<tool_call>\n<function=read_file>\n<parameter=path>\nx\n</parameter>\n</function>\n</tool_call>"
        ));
        assert!(!is_usable_summary(
            "<function=read_file><parameter=path>x</parameter></function>"
        ));
        assert!(is_usable_summary(
            "Established work:\n- read the rules\nCurrent focus: wiring"
        ));
        assert!(is_usable_summary("A summary that mentions <tool_call> markup only in passing is prose, but must start as prose."));
    }

    #[test]
    fn guidance_describes_the_execution_contract_without_forcing_it_on_simple_requests() {
        assert!(AGENT_GUIDANCE.contains("deliverables tool"));
        assert!(AGENT_GUIDANCE.contains("Do not use it for a single-step or analysis-only request"));
        assert!(AGENT_GUIDANCE.contains("never your own ideas"));
        assert!(AGENT_GUIDANCE.contains("delete them before you finish"));
        assert!(Strategy::Deep
            .guidance()
            .contains("what you observed, not what you intended"));
        assert!(!Strategy::Fast.guidance().contains("deliverable"));
    }

    #[test]
    fn the_deliverables_tool_schema_is_flat_and_survives_serialization_in_declaration_order() {
        let tool = tool_schemas(ToolScope::Project)
            .into_iter()
            .find(|tool| tool_name(tool) == "deliverables")
            .expect("deliverables tool");
        let parameters = &tool["function"]["parameters"];
        assert!(parameters.get("oneOf").is_none() && parameters.get("anyOf").is_none());
        let serialized = serde_json::to_string(parameters).unwrap();
        let order = ["action", "id", "task", "text", "evidence", "reason"]
            .iter()
            .map(|key| serialized.find(&format!("\"{key}\"")).unwrap())
            .collect::<Vec<_>>();
        assert!(
            order.windows(2).all(|pair| pair[0] < pair[1]),
            "{serialized}"
        );
        assert_eq!(parameters["required"], json!(["action"]));
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
