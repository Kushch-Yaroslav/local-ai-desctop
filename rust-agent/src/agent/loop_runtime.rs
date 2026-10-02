//! Transcript-first local agent loop.
//!
//! The runtime owns transport, capability safety, durable evidence and bounded
//! recovery. It does not certify evidence, decide exploration coverage, or make
//! semantic completion decisions for the model.

use crate::agent::{
    events::{Event, TailCandidateAttempt},
    evidence::classify_source_read,
    policy::{self, Reasoning, RunPolicy},
    research::ResearchController,
    state::AgentState,
    transcript::{validate_calls, CompactionPlan, ToolResultPolicy, Transcript, ValidatedCall},
    working_evidence,
};
use crate::context::evidence_projection::{attach_historical_index, fold_to_budget};
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
    pub evidence_dir: Option<String>,
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
- Use the latest user's language for all user-visible natural-language text: streamed reasoning/progress, tool preambles, brief status updates, and the final answer. Follow an explicit language request if present. Keep code, paths, identifiers, commands, API/tool syntax, and literal source quotations in their original form. Do not translate protocol fields.
- For non-trivial architecture relationships, use a compact multiline Mermaid flowchart when it improves readability, or a properly indented multiline tree. Do not compress a diagram into one long arrow chain; avoid decorative box art.
- Task Memory = durable semantic continuity for this task. Record meaningful findings, decisions, blockers, and next actions. After compaction, trust a precise Task Memory finding from an unchanged inspected file; reread only for a missing fact, ambiguity, possible change, exact detail, or targeted verification.
- When a source establishes an important audit finding, use evidence_record with its observation ID and one concise claim. For a direct claim, use at least two meaningful terms visible in the observation content; a file path or observation ID alone is not support. Quoted or slash-delimited short code tokens and uppercase acronyms count when present in the observation; ordinary short words do not. A direct negative claim needs source-level negation anchored to at least two meaningful terms from the same claim in one source sentence or line, or a complete read_file observation named in a file-scoped absence claim, or a complete list_directory observation of the exact parent directory that omits the named child. Never infer repository-wide absence from a narrow source. A failed read is a blocker, not direct success evidence: cite its observation ID in a Task Memory finding to record a grounded blocker. Otherwise set inference=true and keep it distinct from direct coverage. A read or generic Task Memory note is only a lead, not proof that a requested area is understood. Established evidence remains visible after compaction; observation_read is for a specific exact detail or contradiction.
- Follow a material local execution dependency discovered in inspected source (for example a UI call into a local service) before claiming its end-to-end behavior is understood. The runtime shows open evidence frontiers; close one by inspecting its target or record a concrete blocker. Do not chase unrelated imports.
- When requested areas have grounded findings and material execution frontiers are closed, begin_finalization marks the shift to synthesis. In the final answer, answer the user's sections directly, distinguish facts from hypotheses, prioritize concrete effects over generic advice, state blocked limits, and avoid duplicate points or meta-progress narration. Treat AI-assisted development claims conservatively; ordinary code style is weak evidence. Then write one user-facing answer from established evidence.
- For project archaeology with run_terminal, prefer one scoped read-only command such as git -C <project> log --oneline; avoid compound shell wrappers and unsafe pipelines that require approval.
- Project Knowledge = reusable observations already derived from this project. Use relevant fresh knowledge before broad rereading; source remains authoritative when exact current code or an unresolved detail is needed. It is project-level; Task Memory is task-level.
- After compaction: use the continuation brief, Task Memory, then relevant Project Knowledge; read source only for genuinely new or verification-specific information.
- Do not call tools merely because they are available. Stop naturally when the requested work is complete.
"#;

const SUMMARY_GUIDANCE: &str = r#"Create an AGENT CONTINUATION CHECKPOINT, not a generic conversation summary. Use these concise headings: Established work; Current focus; Unresolved work; Coverage; Findings and evidence; Blocked or failed operations; Finalization state; Next useful intent. Preserve explicit user constraints and distinguish verified facts from hypotheses. If research is complete or final synthesis has begun, say so explicitly and direct the next context not to restart broad discovery. Do not invent a plan, task IDs, lifecycle, or checklist. Do not repeat raw tool output, token counts, runtime mechanics, generic encouragement, or an activity log."#;

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
            object.remove("_observation_id");
            object.remove("_result_policy");
            object.remove("_rehydration");
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
    let wire_messages = wire_messages(messages);
    let mut payload = json!({
        "model": config.model,
        "messages": wire_messages,
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
        message["content"] = json!(format!("{body}\n[observation id={} source={} historical_revision={}; use this ID in evidence_record for an established finding]", meta.id, meta.source.as_deref().unwrap_or("none"), meta.source_revision.as_deref().unwrap_or("unknown")));
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
    prefix.push_str(&format!(
        "\nPreferred visible prose language for this run: {}.",
        crate::agent::transcript::preferred_visible_language(&config.user)
    ));
    if let Some(root) = &config.root {
        prefix.push_str("\n<working_directory>");
        prefix.push_str(root);
        prefix.push_str("</working_directory>");
    }
    prefix
}

fn lifecycle_label(transcript: &Transcript) -> &'static str {
    if transcript.is_finalizing() {
        "finalizing"
    } else if transcript.is_closeout_requested() {
        "research_targeted_closeout"
    } else {
        "researching"
    }
}

fn dynamic_tail(
    state: &AgentState,
    root: Option<&str>,
    objective: &str,
    transcript: &Transcript,
    context_window: usize,
) -> String {
    let mut tail = Vec::new();
    if transcript.is_finalizing() {
        tail.push("<runtime_mode>Finalizing: broad investigation is complete. Answer the user's requested sections directly in the preferred visible language. The final answer payload contains only the user-facing report, with no progress narration, promises to continue, or repeated introduction. Use a tool only for a specific unresolved contradiction or critical exact fact.</runtime_mode>".to_owned());
    }
    let facts = working_evidence::collect(transcript, &state.task_memory);
    let evidence_budget = context_window.saturating_div(10).clamp(2_000, 8_000);
    let (evidence, _) = working_evidence::project(&facts, objective, evidence_budget);
    if !evidence.is_empty() {
        tail.push(format!("<established_evidence>\nDirect records cite an observation. Source-associated assistant/task-memory notes are leads, not proof of every clause. Synthesize from established claims and provenance; recover exact bodies only for a specific missing detail or contradiction.\n{evidence}\n</established_evidence>"));
    }
    if !transcript.is_finalizing() {
        let open = transcript
            .frontiers()
            .into_iter()
            .filter(|frontier| {
                !crate::agent::frontiers::resolved_by_evidence(
                    frontier,
                    transcript.observations(),
                    &facts,
                ) && !transcript.frontier_dispositions().iter().any(|d| {
                    d.id == frontier.id && matches!(d.outcome.as_str(), "blocked" | "irrelevant")
                })
            })
            .take(5)
            .map(|f| {
                format!(
                    "{}: {} -> {} [local target: {}; {}] (from {})",
                    f.id,
                    f.source,
                    f.target,
                    f.resolved_path.as_deref().unwrap_or("unresolved"),
                    f.resolution.as_deref().unwrap_or("resolution unavailable"),
                    f.from_observation
                )
            })
            .collect::<Vec<_>>();
        if !open.is_empty() {
            tail.push(format!("<open_evidence_frontiers>\n{}\nThese are verified local execution edges, not a task list. Read the listed local target and record a direct finding with evidence_record; that finding closes the frontier automatically. Use evidence_frontier only when a target-specific read actually failed or requires approval, and cite that exact failed/approval observation with outcome=blocked. Do not use a disposition for a successful target read.\n</open_evidence_frontiers>",open.join("\n")));
        }
    }
    let memory = if transcript.is_finalizing() || transcript.is_closeout_requested() {
        state.task_memory.prompt_for_closeout(objective)
    } else {
        state.task_memory.prompt_for(objective)
    };
    if !memory.is_empty() {
        tail.push(format!("<task_memory>\n{memory}\n</task_memory>"));
    }
    if !transcript.is_finalizing() && !user_requests_read_only(objective) {
        let knowledge = crate::tools::knowledge::prompt_catalog(root);
        if !knowledge.is_empty() {
            tail.push(knowledge);
        }
    }
    tail.join("\n")
}

fn lifecycle_tail(
    state: &AgentState,
    root: Option<&str>,
    objective: &str,
    transcript: &Transcript,
    research: &ResearchController,
    context_window: usize,
) -> String {
    let mut tail = dynamic_tail(state, root, objective, transcript, context_window);
    if transcript.is_closeout_requested() && !transcript.is_finalizing() {
        tail.push_str(&format!("\n<runtime_closeout>Research remains open only for concrete requested-area gaps: {}. Open material dependencies: {}. For evidence-gathering tools, name one exact closeout_gap and explain the specific closeout_reason. Read a new target or range, recover an existing observation, or give a source-anchored verification reason for an unchanged repeat. Record a direct finding or grounded blocker for the named gap, then synthesize. Earlier broad research next-steps are superseded by this durable phase.</runtime_closeout>", research.missing_areas().join(", "), research.open_frontier_summary()));
    }
    tail
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
    let mut tools = vec![
        json!({"type":"function","function":{"name":"task_memory","description":"Durable semantic memory for the current task across compaction. Record/update meaningful findings, decisions, blockers, or unresolved questions; view reads it; invalidate needs id. Record/update requires finding and may include evidence, implication, next, id, supersedes. Trust precise unchanged-file memory; reread only for a concrete missing, ambiguous, changed, exact-detail, or verification need.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["record","update","invalidate","view"]},"id":{"type":"string"},"finding":{"type":"string"},"evidence":{"type":"string"},"implication":{"type":"string"},"next":{"type":"string"},"supersedes":{"type":"string"}},"required":["action"]}}}),
        json!({"type":"function","function":{"name":"observation_index","description":"List historical tool observations by stable ID, with source path and outcome metadata. Use source to select the raw observation for the needed file. If more=true, continue at the returned next_offset. Observation IDs start with obs-; established-evidence IDs (ev-) are not observation IDs.","parameters":{"type":"object","properties":{"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}}}}}),
        json!({"type":"function","function":{"name":"observation_read","description":"Recover a bounded exact slice of a stored historical tool result by observation ID. The response distinguishes historical evidence from current source and reports whether the source changed.","parameters":{"type":"object","properties":{"id":{"type":"string"},"offset_chars":{"type":"integer","minimum":0},"max_chars":{"type":"integer","minimum":1,"maximum":16000}},"required":["id"]}}}),
        json!({"type":"function","function":{"name":"evidence_record","description":"Preserve one concise, source-backed finding from a specific historical observation. Direct claims require a raw source observation; project knowledge, task-memory, and observation indexes are leads, not proof. Every sentence must match at least 2 meaningful terms and at least 25% of its meaningful terms in the observation. Quoted or slash-delimited short code tokens and uppercase acronyms count when present in the observation; ordinary short words do not. Split compound or multi-source claims into separate records; keep each claim to 800 characters or fewer. A path or ID alone is not support. A direct negative claim needs source-level negation anchored to at least 2 meaningful terms from the same claim in one source sentence or line, or a complete read_file observation explicitly named for a file-scoped absence, or a complete list_directory observation of the exact parent directory omitting the named child. A narrow source cannot establish repository-wide absence. A failed read cannot establish direct success; cite its observation ID in Task Memory to record a grounded blocker. Set inference=true for interpretations or claims not directly supported by the observation. Inference is kept distinct from direct coverage; do not retry a rejected claim/observation pair unchanged.","parameters":{"type":"object","properties":{"observation_id":{"type":"string"},"claim":{"type":"string","maxLength":800},"inference":{"type":"boolean"}},"required":["observation_id","claim"]}}}),
        json!({"type":"function","function":{"name":"evidence_frontier","description":"Record outcome=blocked only for an advertised frontier whose resolved local target read failed or required approval. Cite the exact target-specific error/approval observation and give a concrete reason. A successful target read with an accepted direct evidence_record closes the frontier automatically; no disposition is needed.","parameters":{"type":"object","properties":{"id":{"type":"string"},"outcome":{"type":"string","enum":["blocked"]},"reason":{"type":"string"},"observation_id":{"type":"string"}},"required":["id","outcome","reason","observation_id"]}}}),
        json!({"type":"function","function":{"name":"begin_finalization","description":"Mark evidence gathering complete and move to final synthesis. The runtime checks requested-area evidence and returns any genuine gap instead of restarting broad discovery. This is a lifecycle transition, not a task plan.","parameters":{"type":"object","properties":{}}}}),
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
    for schema in &mut tools {
        let name = tool_name(schema).to_owned();
        if matches!(
            name.as_str(),
            "observation_read" | "read_file" | "project_knowledge_read" | "run_terminal"
        ) {
            if let Some(properties) = schema
                .pointer_mut("/function/parameters/properties")
                .and_then(Value::as_object_mut)
            {
                properties.insert("verification_reason".into(),json!({"type":"string","description":"In Finalizing only: the specific contradiction or exact missing fact being checked."}));
                if name != "observation_read" {
                    properties.insert("verification_of".into(),json!({"type":"string","description":"In Finalizing only: stable observation ID grounding this targeted check."}));
                }
            }
        }
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
                    | "evidence_record"
                    | "begin_finalization"
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
    if transcript
        .observations()
        .iter()
        .any(|o| o.id != cited.id && new_evidence.contains(&o.id))
    {
        return None;
    }
    Some(format!("Potential evidence conflict: {} cites exact historical observation {}. Retrieve that observation with observation_read and cite a verified observation before replacing this finding.", prior.id, cited.id))
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
        "Continue immediately after the exact ending below. Do not restart, repeat headings, summarize, or reproduce earlier text. Finalization is in progress; use a tool only for a specific unresolved contradiction or critical missing fact.\n<previous_tail>\n{}\n</previous_tail>",
        continuation_tail(content)
    )
}

fn append_final_text(accumulator: &mut String, delta: &str) {
    accumulator.push_str(delta);
}

fn can_continue_final_length(transcript: &Transcript, research: &ResearchController) -> bool {
    !research.has_open_frontiers()
        && (transcript.is_finalizing()
            || !research.has_requested_areas()
            || research.synthesis_ready())
}

fn can_begin_finalization(research: &ResearchController, facts_count: usize) -> bool {
    !research.has_open_frontiers()
        && (research.synthesis_ready() || (!research.has_requested_areas() && facts_count > 0))
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
                "semantic_gain":false,"recoverable":tool.arguments.get("id").and_then(Value::as_str).is_some_and(|id| transcript.read_observation(id,0,1).is_ok())
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

fn tool_turn_is_replay(calls: &[ValidatedCall], transcript: &Transcript) -> bool {
    !calls.is_empty()
        && calls.iter().all(|call| match call.name.as_str() {
            "observation_read" | "observation_index" => true,
            "read_file" => transcript
                .observation_for_call(&call.id)
                .is_some_and(|current| {
                    let prior = transcript
                        .observations()
                        .iter()
                        .position(|observation| observation.id == current.id)
                        .unwrap_or(0);
                    classify_source_read(current, transcript.observations()[..prior].iter())
                        == "unchanged_duplicate"
                }),
            _ => false,
        })
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
            consume_transport_buffer(
                &mut buffer,
                &mut turn,
                run_id,
                turn_index,
                emit_visible,
                emit_content,
                native_ollama,
            )?;
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
            consume_transport_buffer(
                &mut buffer,
                &mut turn,
                run_id,
                turn_index,
                emit_visible,
                emit_content,
                native_ollama,
            )?;
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
        consume_transport_buffer(
            &mut buffer,
            &mut turn,
            run_id,
            turn_index,
            emit_visible,
            emit_content,
            native_ollama,
        )?;
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
    turn_index: usize,
    emit_visible: bool,
    emit_content: bool,
    native_ollama: bool,
) -> Result<(), String> {
    if native_ollama {
        consume_ollama_ndjson(buffer, turn, run_id, turn_index, emit_visible, emit_content)
    } else {
        consume_sse(buffer, turn, run_id, emit_visible, emit_content)
    }
}

fn consume_ollama_ndjson(
    buffer: &mut String,
    turn: &mut StreamedTurn,
    run_id: &str,
    turn_index: usize,
    emit_visible: bool,
    emit_content: bool,
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
            if emit_content {
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
                    // stable for streaming updates and unique across Agent turns.
                    json!({"id":format!("ollama-{run_id}-{turn_index}-{index}"),"type":"function","function":{"name":"","arguments":""}})
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
                    json!({"chars":reasoning.chars().count()}),
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

fn continuation_checkpoint(transcript: &Transcript, generated: String) -> String {
    if transcript.is_finalizing() {
        return format!("[AGENT CONTINUATION CHECKPOINT — NOT USER CONTENT]\nPreferred visible prose language: {}.\nPhase: FINALIZING (authoritative durable runtime state). Broad research is complete. Continue the single final response from the established evidence and recent exact tail. Earlier research next-steps and summary prose are not instructions. Verify only a specific contradiction or critical missing exact fact; merge overlapping conclusions and state each once.", transcript.language_preference());
    }
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
        "Unresolved work",
        "Coverage",
        "Findings and evidence",
        "Blocked or failed operations",
        "Finalization state",
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
    let lifecycle = if transcript.is_closeout_requested() {
        "\nRuntime closeout request (authoritative): remain in research only for concrete requested-area evidence gaps or an open material frontier. Earlier broad research next-steps do not override this targeted gap review. Once those gaps are grounded, transition to final synthesis."
    } else {
        ""
    };
    format!("[AGENT CONTINUATION CHECKPOINT — NOT USER CONTENT]\nPreferred visible prose language: {}.\nOriginal user objective and constraints (the separately projected current user message is authoritative):\n{objective}\n\nProcedural and factual continuation state:\n{state}{lifecycle}\n\nUse this checkpoint to continue the current line of work. Do not restart broad project discovery unless a specific missing or changed fact requires it.", transcript.language_preference())
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
    if crate::agent::lifecycle::repeated_file_read_decision(call, transcript, project_root).is_err()
    {
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
    EvidenceGap(String),
}

fn review_tool_free_final(
    state: &mut AgentState,
    transcript: &mut Transcript,
    research: &mut ResearchController,
) -> FinalCandidateReview {
    if transcript.is_finalizing() && !research.has_open_frontiers() {
        return FinalCandidateReview::Accept;
    }
    if add_soft_closeout_if_needed(state, transcript) {
        return FinalCandidateReview::ValidationPending;
    }
    if let Some(nudge) = research.final_nudge(
        !transcript.observations().is_empty(),
        transcript.is_finalizing(),
    ) {
        return FinalCandidateReview::EvidenceGap(nudge);
    }
    if research.has_open_frontiers()
        || (research.has_requested_areas() && !research.synthesis_ready())
    {
        return FinalCandidateReview::EvidenceGap(format!(
            "Final answer remains blocked by requested evidence gaps: {}. Open execution dependencies: {}. Resolve these exact gaps or record a grounded target-specific blocker.",
            research.missing_areas().join(", "),
            research.open_frontier_summary()
        ));
    }
    transcript.mark_finalizing();
    FinalCandidateReview::Accept
}

/// Coverage is assessed by ResearchController; only this runtime transition
/// owns the durable phase. A new read without a new established finding does
/// not indefinitely postpone a ready synthesis.
fn advance_lifecycle(
    transcript: &mut Transcript,
    research: &ResearchController,
) -> Option<&'static str> {
    if transcript.is_finalizing() {
        return None;
    }
    if transcript.is_closeout_requested() && research.synthesis_ready() {
        transcript.mark_finalizing();
        return Some("targeted_closeout_gaps_satisfied");
    }
    if research.closeout_candidate() && !transcript.is_closeout_requested() {
        transcript.mark_closeout_requested();
        return Some("grounded_coverage_with_specific_remaining_gaps");
    }
    if transcript.last_tool_turn_gained_evidence() {
        return None;
    }
    if research.synthesis_ready() {
        transcript.mark_finalizing();
        Some("established_coverage_without_new_semantic_evidence")
    } else {
        None
    }
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
    let mut research =
        ResearchController::with_depth(&config.user, config.reasoning_mode == "deep");
    state.task_memory = config
        .task_memory
        .as_ref()
        .and_then(|memory| serde_json::from_value(memory.clone()).ok())
        .unwrap_or_default();
    research.refresh_from_memory(&state.task_memory, transcript.observations());
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
    let schemas = tool_schemas_for_request(config.root.is_some(), config.policy, &config.user);
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
    let mut previous_tool_turn_replayed = false;

    emit(
        &config.run_id,
        Event::AgentStarted {
            run_id: config.run_id.clone(),
        },
    );
    emit_knowledge_diagnostics(&config, &state);
    for turn in 0..128_usize {
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
                transcript.push_steering(content);
            }
        }
        let facts = working_evidence::collect(&transcript, &state.task_memory);
        research.refresh_from_evidence(&state.task_memory, transcript.observations(), &facts);
        research.refresh_frontiers(
            &transcript.frontiers(),
            &transcript.frontier_dispositions(),
            transcript.observations(),
            &facts,
        );
        let semantic_gain = transcript.last_tool_turn_gained_evidence();
        if let Some(reason) = advance_lifecycle(&mut transcript, &research) {
            trace_forensics(
                &config.run_id,
                "lifecycle_transition",
                json!({"state":lifecycle_label(&transcript),"reason":reason,"turn":turn+1,"evidence_count":facts.len(),"coverage":research.trace(),"last_tool_turn_semantic_gain":semantic_gain,"last_tool_turn_replay_only":previous_tool_turn_replayed}),
            );
        }
        // Sibling calls in this assistant turn use the phase advertised in
        // this request, even if one call changes the durable phase mid-turn.
        let closeout_at_request = transcript.is_closeout_requested() && !transcript.is_finalizing();
        let lifecycle_targets = research.closeout_targets();
        let blocked_frontiers = crate::agent::lifecycle::blocked_frontier_targets(
            &transcript.frontiers(),
            transcript.observations(),
            &lifecycle_targets,
        );
        let research_schemas =
            crate::agent::lifecycle::research_schemas(&schemas, &blocked_frontiers);
        let finalizing_schemas = if transcript.is_finalizing() {
            crate::agent::lifecycle::finalizing_schemas(&schemas, &blocked_frontiers)
        } else {
            Vec::new()
        };
        let closeout_schemas = if closeout_at_request {
            crate::agent::lifecycle::closeout_schemas(
                &schemas,
                &lifecycle_targets,
                &blocked_frontiers,
            )
        } else {
            Vec::new()
        };
        let request_schemas = if transcript.is_finalizing() {
            &finalizing_schemas
        } else if closeout_at_request {
            &closeout_schemas
        } else {
            &research_schemas
        };
        let dynamic = lifecycle_tail(
            &state,
            config.root.as_deref(),
            &config.user,
            &transcript,
            &research,
            config.context_limit,
        );
        let evidence_budget = config.context_limit.saturating_div(10).clamp(2_000, 8_000);
        let (evidence_text, evidence_ids) =
            working_evidence::project(&facts, &config.user, evidence_budget);
        trace_forensics(
            &config.run_id,
            "evidence_projection",
            json!({"turn":turn+1,"facts":facts.len(),"projected_ids":evidence_ids,"projected_chars":evidence_text.chars().count(),"budget_chars":evidence_budget,"lifecycle":lifecycle_label(&transcript),"coverage":research.trace(),"semantic_gain_last_turn":semantic_gain}),
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
        let before_budget = request_budget(&config, &messages, request_schemas);
        let folded = if needs_compaction(budget, before_budget.projected_input_tokens) {
            fold_evidence_to_target(&config, &transcript, request_schemas, &mut messages)
        } else {
            Vec::new()
        };
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
        let payload = request_payload(&config, &messages, request_schemas, output_limit);
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
                transcript.remind("The previous response contained textual tool-call markup, which was not executed. Emit a complete structured tool call, or answer normally without tool markup.".into());
                continue;
            }
            if was_continuation && can_continue_final_length(&transcript, &research) {
                let accepted = append_continuation_text(&mut final_content, &streamed.content);
                streamed.content = accepted.clone();
                emit_accepted_final_content(&config.run_id, &accepted);
                continuation_pending = false;
            }
            trace_forensics(
                &config.run_id,
                "final_attempt",
                json!({"turn":turn+1,"finish_reason":streamed.finish_reason,"phase":lifecycle_label(&transcript),"coverage":research.trace(),"ready":research.synthesis_ready(),"continuation_pending":was_continuation}),
            );
            if streamed.finish_reason == "length" {
                if !can_continue_final_length(&transcript, &research) {
                    transcript.assistant_withheld_draft(
                        streamed.content,
                        "incomplete final with requested evidence gaps",
                    );
                    transcript.mark_closeout_requested();
                    let nudge=research.final_nudge(!transcript.observations().is_empty(),false).unwrap_or_else(|| format!("The attempted final answer still lacks direct findings for: {}. Open material dependencies: {}. Resolve only those concrete gaps or state a grounded blocker before synthesizing.",research.missing_areas().join(", "),research.open_frontier_summary()));
                    transcript.remind(nudge);
                    trace_forensics(
                        &config.run_id,
                        "finalization_decision",
                        json!({"decision":"withhold_incomplete_length_draft","coverage":research.trace(),"phase":lifecycle_label(&transcript)}),
                    );
                    continue;
                }
                if !was_continuation {
                    emit_accepted_final_content(&config.run_id, &streamed.content);
                }
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
            match review_tool_free_final(&mut state, &mut transcript, &mut research) {
                FinalCandidateReview::ValidationPending => {
                    transcript.assistant_withheld_draft(streamed.content, "pending validation");
                    continue;
                }
                FinalCandidateReview::EvidenceGap(nudge) => {
                    transcript.mark_closeout_requested();
                    trace_forensics(
                        &config.run_id,
                        "research_controller",
                        json!({"decision":"evidence_gap","final_attempt":true,"state":research.trace()}),
                    );
                    transcript
                        .assistant_withheld_draft(streamed.content, "a specific evidence gap");
                    transcript.remind(nudge);
                    continue;
                }
                FinalCandidateReview::Accept => {}
            }
            if !was_continuation {
                emit_accepted_final_content(&config.run_id, &streamed.content);
            }
            if !was_continuation {
                append_final_text(&mut final_content, &streamed.content);
            }
            transcript.assistant_message(streamed.content);
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
                transcript.finish_durable(&config.history, &config.user, &final_content)
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
        // Coverage is updated only from a Task Memory entry that cites a real
        // observation. Read novelty is recorded after the tool result exists.
        transcript.assistant_tool_turn(streamed.content, &calls);
        trace_forensics(
            &config.run_id,
            "canonical_assistant_tool_turn",
            json!({"content_chars":canonical_content.chars().count(),"calls":calls.iter().map(|call| json!({"id":call.id,"name":call.name})).collect::<Vec<_>>() }),
        );
        let mut call_index = 0_usize;
        while call_index < calls.len() {
            if !transcript.is_finalizing()
                && !closeout_at_request
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
                            transcript.tool_result(&tool.id, &tool.name, content.clone());
                            for frontier in transcript.discover_frontiers(&tool.id, &content) {
                                trace_forensics(
                                    &config.run_id,
                                    "evidence_frontier",
                                    json!({"id":frontier.id,"source":frontier.source,"target":frontier.target,"state":"discovered"}),
                                );
                            }
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
            if !closeout_at_request && !transcript.is_finalizing() {
                if let Err(message) = crate::agent::lifecycle::repeated_file_read_decision(
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
            if closeout_at_request && !transcript.is_finalizing() {
                if let Err(message) = crate::agent::lifecycle::closeout_decision(
                    tool,
                    &transcript,
                    &research,
                    config.root.as_deref().map(std::path::Path::new),
                ) {
                    trace_forensics(
                        &config.run_id,
                        "closeout_decision",
                        json!({"decision":"redirected","tool":tool.name,"reason":message,"remaining":research.closeout_targets()}),
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
            if transcript.is_finalizing() {
                match crate::agent::lifecycle::verification_decision(tool, &transcript) {
                    Ok(kind) => trace_forensics(
                        &config.run_id,
                        "finalization_verification",
                        json!({"decision":"allowed","kind":kind,"tool":tool.name,"observation_id":tool.arguments.get("verification_of").or_else(||tool.arguments.get("id"))}),
                    ),
                    Err(reason) => {
                        let message = format!("Finalization is active; this exploratory call was not executed ({reason}). Continue the final answer from established evidence. For a concrete contradiction or critical exact fact, provide verification_reason and an existing observation ID (verification_of for live/source reads).");
                        trace_forensics(
                            &config.run_id,
                            "finalization_verification",
                            json!({"decision":"redirected","reason":reason,"tool":tool.name}),
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
                "evidence_record" => {
                    let prior = transcript.entries().len();
                    transcript.record_established_evidence(
                        tool.arguments.get("claim").and_then(Value::as_str).unwrap_or(""),
                        tool.arguments.get("observation_id").and_then(Value::as_str).unwrap_or(""),
                        tool.arguments.get("inference").and_then(Value::as_bool).unwrap_or(false),
                    ).and_then(|fact| {
                        trace_forensics(&config.run_id, if transcript.entries().len()>prior {"evidence_established"} else {"evidence_replayed"}, json!({"evidence_id":fact.id,"observation_id":fact.observation_id,"source":fact.source,"semantic_gain":transcript.entries().len()>prior}));
                        serde_json::to_value(fact).map_err(|error| error.to_string())
                    }).map(|value| (value, None))
                }
                "evidence_frontier" => transcript
                    .dispose_frontier(
                        tool.arguments
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        tool.arguments
                            .get("outcome")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        tool.arguments
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        tool.arguments.get("observation_id").and_then(Value::as_str),
                    )
                    .map(|()| (json!({"recorded":true}), None)),
                "begin_finalization" => {
                    trace_forensics(
                        &config.run_id,
                        "finalization_request",
                        json!({"turn":turn+1,"phase":lifecycle_label(&transcript),"coverage_before":research.trace()}),
                    );
                    let facts = working_evidence::collect(&transcript, &state.task_memory);
                    research.refresh_from_evidence(
                        &state.task_memory,
                        transcript.observations(),
                        &facts,
                    );
                    research.refresh_frontiers(
                        &transcript.frontiers(),
                        &transcript.frontier_dispositions(),
                        transcript.observations(),
                        &facts,
                    );
                    if can_begin_finalization(&research, facts.len()) {
                        transcript.mark_finalizing();
                        trace_forensics(
                            &config.run_id,
                            "lifecycle_transition",
                            json!({"state":"finalizing","reason":"explicit_evidence_checked_handoff","turn":turn+1,"coverage":research.trace()}),
                        );
                        Ok((
                            json!({"state":"finalizing","evidence_count":facts.len()}),
                            None,
                        ))
                    } else {
                        let missing = research.missing_areas();
                        trace_forensics(
                            &config.run_id,
                            "finalization_decision",
                            json!({"decision":"targeted_gap","missing":missing,"coverage":research.trace()}),
                        );
                        transcript.mark_closeout_requested();
                        Err(format!("Cannot establish finalization yet. Requested areas without established direct evidence: {}. Open execution dependencies: {}. The runtime now retains a targeted gap-review state across compaction. Record a specific source-backed finding or grounded blocker; inspect only the named material gap.", missing.join(", "), research.open_frontier_summary()))
                    }
                }
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
                        run_tool(&config, &mut state, tool)
                    }
                }
                _ => run_tool(&config, &mut state, tool),
            };
            match outcome {
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
                    } else if matches!(
                        tool.name.as_str(),
                        "observation_index"
                            | "evidence_record"
                            | "evidence_frontier"
                            | "begin_finalization"
                    ) {
                        transcript.inline_tool_result(&tool.id, &tool.name, content);
                    } else {
                        transcript.tool_result(&tool.id, &tool.name, content.clone());
                        for frontier in transcript.discover_frontiers(&tool.id, &content) {
                            trace_forensics(
                                &config.run_id,
                                "evidence_frontier",
                                json!({"id":frontier.id,"source":frontier.source,"target":frontier.target,"state":"discovered"}),
                            );
                        }
                    }
                    if matches!(
                        tool.name.as_str(),
                        "task_memory"
                            | "evidence_record"
                            | "evidence_frontier"
                            | "begin_finalization"
                    ) {
                        let facts = working_evidence::collect(&transcript, &state.task_memory);
                        research.refresh_from_evidence(
                            &state.task_memory,
                            transcript.observations(),
                            &facts,
                        );
                        research.refresh_frontiers(
                            &transcript.frontiers(),
                            &transcript.frontier_dispositions(),
                            transcript.observations(),
                            &facts,
                        );
                        trace_forensics(
                            &config.run_id,
                            "finalization_decision",
                            json!({"eligible_coverage":research.synthesis_ready(),"awaiting_synthesis_or_replay_saturation":!transcript.is_finalizing(),"coverage":research.trace()}),
                        );
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
                    if matches!(
                        tool.name.as_str(),
                        "observation_read"
                            | "observation_index"
                            | "evidence_record"
                            | "begin_finalization"
                    ) {
                        transcript.inline_tool_result(&tool.id, &tool.name, stored_error);
                    } else {
                        transcript.tool_result(&tool.id, &tool.name, stored_error);
                    }
                    record_read_evidence(&config, &transcript, tool);
                }
            }
        }
        previous_tool_turn_replayed = tool_turn_is_replay(&calls, &transcript);
        let current_facts = working_evidence::collect(&transcript, &state.task_memory);
        research.refresh_from_evidence(
            &state.task_memory,
            transcript.observations(),
            &current_facts,
        );
        research.refresh_frontiers(
            &transcript.frontiers(),
            &transcript.frontier_dispositions(),
            transcript.observations(),
            &current_facts,
        );
        trace_forensics(
            &config.run_id,
            "research_controller",
            json!({"turn":turn+1,"replay_only":previous_tool_turn_replayed,"semantic_gain":transcript.last_tool_turn_gained_evidence(),"evidence_count":current_facts.len(),"synthesis_ready":research.synthesis_ready(),"targeted_closeout_candidate":research.closeout_candidate(),"coverage":research.trace(),"lifecycle":lifecycle_label(&transcript)}),
        );
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
    fn native_ollama_tool_ids_are_unique_across_provider_turns() {
        let frame = || {
            format!(
                "{}\n",
                json!({
                    "message":{
                        "tool_calls":[{
                            "function":{
                                "name":"read_file",
                                "arguments":{"path":"src/App.tsx"}
                            }
                        }]
                    }
                })
            )
        };
        let mut first = StreamedTurn::default();
        let mut first_frame = frame();
        consume_ollama_ndjson(&mut first_frame, &mut first, "run", 1, false, false).unwrap();
        let first_id = first.calls[&0]["id"].as_str().unwrap();

        let mut second = StreamedTurn::default();
        let mut second_frame = frame();
        consume_ollama_ndjson(&mut second_frame, &mut second, "run", 2, false, false).unwrap();
        let second_id = second.calls[&0]["id"].as_str().unwrap();

        assert_ne!(first_id, second_id);
        assert_eq!(first_id, "ollama-run-1-0");
        assert_eq!(second_id, "ollama-run-2-0");
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
        assert_eq!(turn.reasoning, reasoning);
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

    #[test]
    fn closeout_survives_irrelevant_rereads_and_rejected_final_until_gaps_close() {
        fn establish(transcript: &mut Transcript, id: &str, path: &str, claim: &str) {
            transcript.assistant_tool_turn(
                String::new(),
                &[ValidatedCall {
                    id: id.into(),
                    name: "read_file".into(),
                    arguments: json!({"path":path}),
                }],
            );
            transcript.tool_result(
                id,
                "read_file",
                json!({"path":path,"content":claim}).to_string(),
            );
            let observation_id = transcript.observation_for_call(id).unwrap().id.clone();
            transcript
                .record_established_evidence(claim, &observation_id, false)
                .unwrap();
        }
        let base = std::env::temp_dir().join(format!(
            "closeout-run-shape-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        for file in ["ProductSEO.tsx", "order.ts", "history.txt"] {
            std::fs::write(root.join(file), file).unwrap();
        }
        let objective = "audit product backend order flow history implementation quality";
        let mut transcript =
            Transcript::durable(&base.join("store"), "run", &[], root.to_str()).unwrap();
        transcript.push_run_user(json!({"role":"user","content":objective}));
        let seo = root.join("ProductSEO.tsx").to_string_lossy().into_owned();
        establish(
            &mut transcript,
            "seo-first",
            &seo,
            "Product catalog SEO is present",
        );
        let mut state = AgentState::default();
        let mut research = ResearchController::with_depth(objective, true);
        let refresh = |research: &mut ResearchController,
                       transcript: &Transcript,
                       state: &AgentState| {
            let facts = working_evidence::collect(transcript, &state.task_memory);
            research.refresh_from_evidence(&state.task_memory, transcript.observations(), &facts);
            research.refresh_frontiers(
                &transcript.frontiers(),
                &transcript.frontier_dispositions(),
                transcript.observations(),
                &facts,
            );
        };
        refresh(&mut research, &transcript, &state);
        assert!(research.closeout_candidate());
        assert_eq!(
            advance_lifecycle(&mut transcript, &research),
            Some("grounded_coverage_with_specific_remaining_gaps")
        );
        assert!(transcript.is_closeout_requested());
        assert_eq!(
            research.missing_areas(),
            vec![
                "backend/order flow",
                "history/evolution",
                "implementation quality"
            ]
        );
        let tail = lifecycle_tail(
            &state,
            root.to_str(),
            objective,
            &transcript,
            &research,
            65_536,
        );
        transcript.record_prompt_tail(&tail);
        let duplicate = ValidatedCall {
            id: "seo-again".into(),
            name: "read_file".into(),
            arguments: json!({"path":seo,"closeout_gap":"backend/order flow","closeout_reason":"inspect checkout flow"}),
        };
        let error = crate::agent::lifecycle::closeout_decision(
            &duplicate,
            &transcript,
            &research,
            Some(&root),
        )
        .unwrap_err();
        transcript.assistant_tool_turn(
            "Продолжаю анализ. Изучаю SEO и analytics.".into(),
            &[duplicate],
        );
        transcript.inline_tool_result("seo-again", "read_file", concise_tool_error(&error));
        assert_eq!(transcript.observations().len(), 1);
        refresh(&mut research, &transcript, &state);
        assert_eq!(advance_lifecycle(&mut transcript, &research), None);
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &mut research),
            FinalCandidateReview::EvidenceGap(_)
        ));
        transcript.mark_closeout_requested();
        transcript.assistant_withheld_draft(String::new(), "a specific evidence gap");
        transcript.remind("Remain on the three exact gaps".into());
        let retry_tail = transcript.pending_tail(&lifecycle_tail(
            &state,
            root.to_str(),
            objective,
            &transcript,
            &research,
            65_536,
        ));
        assert!(retry_tail.contains("backend/order flow"));
        transcript.record_prompt_tail(&retry_tail);
        transcript.clear_reminders();
        let clean_tail = lifecycle_tail(
            &state,
            root.to_str(),
            objective,
            &transcript,
            &research,
            65_536,
        );
        transcript.record_prompt_tail(&clean_tail);
        transcript.assistant_message("Further status text".into());
        let projected = project(&transcript, "system", "");
        assert!(projected.last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("<runtime_closeout>"));
        assert!(!transcript.is_finalizing());
        establish(
            &mut transcript,
            "backend",
            &root.join("order.ts").to_string_lossy(),
            "backend order submission exists",
        );
        establish(
            &mut transcript,
            "history",
            &root.join("history.txt").to_string_lossy(),
            "history evolution recorded",
        );
        transcript.assistant_tool_turn(
            String::new(),
            &[ValidatedCall {
                id: "quality-blocker".into(),
                name: "read_file".into(),
                arguments: json!({"path":"missing-tests"}),
            }],
        );
        transcript.tool_result(
            "quality-blocker",
            "read_file",
            json!({"error":"test source unavailable","path":"missing-tests"}).to_string(),
        );
        let blocker = transcript
            .observation_for_call("quality-blocker")
            .unwrap()
            .id
            .clone();
        state
            .task_memory
            .upsert(
                Some("quality"),
                "quality tests unavailable".into(),
                blocker,
                "implementation quality is blocked".into(),
                String::new(),
                None,
            )
            .unwrap();
        refresh(&mut research, &transcript, &state);
        assert!(research.synthesis_ready(), "coverage: {}", research.trace());
        assert_eq!(
            advance_lifecycle(&mut transcript, &research),
            Some("targeted_closeout_gaps_satisfied")
        );
        assert_eq!(advance_lifecycle(&mut transcript, &research), None);
        assert_eq!(
            transcript
                .entries()
                .iter()
                .filter(|entry| matches!(entry, crate::agent::transcript::Entry::CloseoutRequested))
                .count(),
            1
        );
        assert_eq!(
            transcript
                .entries()
                .iter()
                .filter(|entry| matches!(entry, crate::agent::transcript::Entry::Finalizing))
                .count(),
            1
        );
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &mut research),
            FinalCandidateReview::Accept
        ));
        std::fs::remove_dir_all(base).unwrap();
    }
    use crate::agent::research::Coverage;

    fn test_config(window: usize) -> Config {
        Config {
            run_id: "test".into(),
            endpoint: "http://localhost/v1/chat/completions".into(),
            model: "test".into(),
            system: "system".into(),
            user: "audit".into(),
            root: None,
            context_limit: window,
            reasoning_mode: "fast".into(),
            policy: RunPolicy::Safe,
            history: Vec::new(),
            evidence_dir: None,
            task_memory: None,
            provider_max_output: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            steering: Arc::new(Mutex::new(Vec::new())),
        }
    }

    #[test]
    fn premature_final_stays_in_research_with_only_specific_gaps() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit backend and history"}));
        let mut research = ResearchController::with_depth("audit backend and history", true);
        research.evidence(
            "backend/order flow",
            Coverage::Sufficient,
            "obs-backed backend claim",
        );
        let mut state = AgentState::default();
        let result = review_tool_free_final(&mut state, &mut transcript, &mut research);
        assert!(
            matches!(result,FinalCandidateReview::EvidenceGap(ref gap) if gap.contains("history/evolution") && !gap.contains("backend/order flow"))
        );
        transcript.mark_closeout_requested();
        assert!(!transcript.is_finalizing());
        assert_eq!(lifecycle_label(&transcript), "research_targeted_closeout");
    }

    #[test]
    fn sufficient_coverage_and_no_semantic_gain_enters_monotonic_finalization() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit backend and history"}));
        let mut research = ResearchController::with_depth("audit backend and history", true);
        research.evidence(
            "backend/order flow",
            Coverage::Sufficient,
            "direct backend evidence",
        );
        research.blocked(
            "history/evolution",
            "recorded read-only git approval denial",
        );
        for n in 0..150 {
            transcript.assistant_message(format!("productive earlier step {n}"));
        }
        assert_eq!(
            advance_lifecycle(&mut transcript, &research),
            Some("established_coverage_without_new_semantic_evidence")
        );
        assert!(transcript.is_finalizing());
        assert_eq!(
            advance_lifecycle(&mut transcript, &ResearchController::new("backend audit")),
            None
        );
        assert!(transcript.is_finalizing());
        let mut state = AgentState::default();
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &mut research),
            FinalCandidateReview::Accept
        ));
        transcript.assistant_message("final report".into());
        transcript.mark_run_complete();
        assert_eq!(
            transcript
                .entries()
                .iter()
                .filter(|e| matches!(e, crate::agent::transcript::Entry::RunComplete))
                .count(),
            1
        );
    }

    #[test]
    fn fresh_semantic_evidence_delays_automatic_synthesis_without_action_threshold() {
        let base = std::env::temp_dir().join(format!(
            "lifecycle-gain-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let mut transcript = Transcript::durable(&base, "run", &[], None).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit backend"}));
        transcript.assistant_tool_turn(
            String::new(),
            &[ValidatedCall {
                id: "read".into(),
                name: "read_file".into(),
                arguments: json!({"path":"src/service.ts"}),
            }],
        );
        transcript.tool_result(
            "read",
            "read_file",
            json!({"content":"backend endpoint accepts requests"}).to_string(),
        );
        let id = transcript.observations()[0].id.clone();
        transcript
            .record_established_evidence("backend endpoint accepts requests", &id, false)
            .unwrap();
        let mut research = ResearchController::with_depth("audit backend", true);
        research.evidence(
            "backend/order flow",
            Coverage::Sufficient,
            "new direct finding",
        );
        assert!(transcript.last_tool_turn_gained_evidence());
        assert_eq!(advance_lifecycle(&mut transcript, &research), None);
        assert!(!transcript.is_finalizing());
        transcript.assistant_tool_turn(
            String::new(),
            &[ValidatedCall {
                id: "replay".into(),
                name: "observation_read".into(),
                arguments: json!({"id":id}),
            }],
        );
        transcript.rehydrated_tool_result(
            "replay",
            "observation_read",
            &id,
            0,
            100,
            &transcript.read_observation(&id, 0, 100).unwrap(),
        );
        assert!(!transcript.last_tool_turn_gained_evidence());
        assert!(advance_lifecycle(&mut transcript, &research).is_some());
        assert!(transcript.is_finalizing());
        drop(transcript);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn finalization_checkpoint_does_not_replay_stale_research_instructions() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.compact(
            "Next useful intent: list the repository again".into(),
            transcript.entries().len(),
        );
        transcript.mark_finalizing();
        let checkpoint =
            continuation_checkpoint(&transcript, "Unresolved work: broad research".into());
        assert!(checkpoint.contains("Phase: FINALIZING"));
        assert!(!checkpoint.contains("list the repository again"));
        assert!(!checkpoint.contains("Unresolved work: broad research"));
    }

    #[test]
    fn closeout_compaction_keeps_targeted_mode_and_drops_old_memory_next() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit backend"}));
        transcript.mark_closeout_requested();
        transcript.compact(
            "Old next step: list all directories".into(),
            transcript.entries().len(),
        );
        let mut state = AgentState::default();
        state
            .task_memory
            .upsert(
                None,
                "backend finding".into(),
                "obs-00000001".into(),
                String::new(),
                "read every file again".into(),
                None,
            )
            .unwrap();
        let tail = dynamic_tail(&state, None, "audit backend", &transcript, 65_536);
        let checkpoint =
            continuation_checkpoint(&transcript, "Established work: backend inspected.".into());
        assert!(transcript.is_closeout_requested());
        assert!(checkpoint.contains("Runtime closeout request"));
        assert!(tail.contains("backend finding"));
        assert!(!tail.contains("read every file again"));
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
            "evidence_record",
            "evidence_frontier",
            "begin_finalization",
            "read_file",
            "list_directory",
            "run_terminal",
            "project_knowledge_index",
            "project_knowledge_read",
            "project_knowledge_update",
        ] {
            assert!(names.contains(&name), "{name}");
        }
        let frontier = schemas
            .iter()
            .find(|tool| tool_name(tool) == "evidence_frontier")
            .unwrap();
        let required = frontier
            .pointer("/function/parameters/required")
            .and_then(Value::as_array)
            .unwrap();
        assert!(required
            .iter()
            .any(|field| field.as_str() == Some("observation_id")));
        assert!(frontier
            .pointer("/function/description")
            .and_then(Value::as_str)
            .unwrap()
            .contains("target read failed or required approval"));
        assert_eq!(
            frontier.pointer("/function/parameters/properties/outcome/enum"),
            Some(&json!(["blocked"]))
        );
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
                "evidence_record",
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
            config.context_limit,
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
            let (value, _) = run_tool(&config, &mut state, &call).unwrap();
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
        assert!(ollama_native_messages(&projected)[0]
            .get("_observation_id")
            .is_none());
        for wire in [
            wire_messages(&projected),
            ollama_native_messages(&projected),
        ] {
            assert!(wire[0].get("_result_policy").is_none());
            assert!(wire[0].get("_rehydration").is_none());
            assert_eq!(wire[0]["content"], "result");
        }
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
        assert!(prompt.contains("at least two meaningful terms visible in the observation content"));
        assert!(
            prompt.contains("complete list_directory observation of the exact parent directory")
        );
        assert!(prompt.contains("cite its observation ID in a Task Memory finding"));
        assert!(!prompt.contains("if model =="));
    }

    #[test]
    fn incomplete_final_cannot_continue_until_finalization_is_valid() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"backend history audit"}));
        let research = ResearchController::new("backend history audit");
        assert!(!can_continue_final_length(&transcript, &research));
        transcript.mark_finalizing();
        assert!(can_continue_final_length(&transcript, &research));
        let reminder = continuation_reminder("Final section already started");
        assert!(reminder.contains("specific unresolved contradiction"));
        assert!(!reminder.contains("more investigation"));
    }

    #[test]
    fn tool_free_final_review_accepts_completed_work_and_targets_premature_gaps() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"backend audit"}));
        let mut state = AgentState::default();
        let mut no_requested_area = ResearchController::new("explain this project");
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &mut no_requested_area),
            FinalCandidateReview::Accept
        ));
        assert!(transcript.is_finalizing());

        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"backend audit"}));
        let mut missing = ResearchController::new("backend audit");
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &mut missing),
            FinalCandidateReview::EvidenceGap(_)
        ));
        transcript.mark_finalizing();
        let mut fresh_controller = ResearchController::new("backend audit");
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &mut fresh_controller),
            FinalCandidateReview::Accept
        ));
    }

    #[test]
    fn failed_frontier_close_cannot_exhaust_the_finalization_gate() {
        use crate::agent::frontiers::{EvidenceFrontier, FrontierDisposition};
        let frontier = EvidenceFrontier {
            id: "frontier-obs-00000030-00".into(),
            from_observation: "obs-00000030".into(),
            source: "/project/src/OrderForm.tsx".into(),
            target: "api.php".into(),
            resolved_path: Some("/project/public/api.php".into()),
            project_relative_path: Some("public/api.php".into()),
            resolution: Some("project public root; document base /".into()),
        };
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit backend"}));
        let mut research = ResearchController::with_depth("audit backend", true);
        research.evidence(
            "backend/order flow",
            Coverage::Sufficient,
            "direct local finding",
        );
        research.refresh_frontiers(&[frontier.clone()], &[], &[], &[]);
        assert!(!can_begin_finalization(&research, 1));
        assert!(!can_continue_final_length(&transcript, &research));
        let mut state = AgentState::default();
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &mut research),
            FinalCandidateReview::EvidenceGap(_)
        ));
        // The previous one-shot nudge has been spent, as in the GLM journal.
        // A second tool-free draft still cannot bypass the open frontier.
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &mut research),
            FinalCandidateReview::EvidenceGap(_)
        ));
        assert!(!transcript.is_finalizing());
        research.refresh_frontiers(
            &[frontier.clone()],
            &[FrontierDisposition {
                id: frontier.id.clone(),
                outcome: "blocked".into(),
                reason: "target-specific permission denial".into(),
                observation_id: Some("obs-denied".into()),
            }],
            &[],
            &[],
        );
        assert!(can_begin_finalization(&research, 1));
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &mut research),
            FinalCandidateReview::Accept
        ));
        assert!(transcript.is_finalizing());
        research.refresh_frontiers(&[frontier], &[], &[], &[]);
        assert!(matches!(
            review_tool_free_final(&mut state, &mut transcript, &mut research),
            FinalCandidateReview::EvidenceGap(_)
        ));
        assert!(!can_continue_final_length(&transcript, &research));
        assert!(
            transcript.is_finalizing(),
            "a valid finalization transition is monotonic"
        );
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
    fn established_evidence_and_finalization_reach_provider_after_compaction_without_source_replay()
    {
        let base = std::env::temp_dir().join(format!(
            "agent-evidence-provider-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("api.php"), "<?php WorldFilia();").unwrap();
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
            format!(
                "{} {}",
                "api.php forwards orders to WorldFilia",
                "x".repeat(90_000)
            ),
        );
        let id = transcript.observations()[0].id.clone();
        transcript
            .record_established_evidence("api.php forwards orders to WorldFilia", &id, false)
            .unwrap();
        for n in 0..4 {
            transcript.assistant_message(format!("later work {n}"));
        }
        transcript.mark_finalizing();
        let plan = transcript.compaction_plan(2).unwrap();
        transcript.compact("procedural checkpoint".into(), plan.covers);
        let state = AgentState::default();
        let config = test_config(65_536);
        let tail = dynamic_tail(
            &state,
            None,
            "audit backend order flow",
            &transcript,
            65_536,
        );
        let messages = project_evidence(
            &config,
            &transcript,
            "system",
            &transcript.pending_tail(&tail),
        );
        let payload = request_payload(&config, &messages, &[], 1_024).to_string();
        assert!(payload.contains("api.php forwards orders to WorldFilia"));
        assert!(payload.contains(&id));
        assert!(payload.contains("MODE: FINALIZING"));
        assert!(!payload.contains(&"x".repeat(1_000)));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn replay_saturation_distinguishes_existing_body_from_new_source_version() {
        let base = std::env::temp_dir().join(format!(
            "agent-replay-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("api.php"), "version A").unwrap();
        let mut t = Transcript::durable(&base.join("store"), "run", &[], root.to_str()).unwrap();
        t.push_run_user(json!({"role":"user","content":"backend audit"}));
        let call = |id: &str| ValidatedCall {
            id: id.into(),
            name: "read_file".into(),
            arguments: json!({"path":"api.php"}),
        };
        t.assistant_tool_turn("".into(), &[call("first")]);
        t.tool_result("first", "read_file", "A".into());
        assert!(!tool_turn_is_replay(&[call("first")], &t));
        let id = t.observations()[0].id.clone();
        t.assistant_tool_turn(
            "".into(),
            &[ValidatedCall {
                id: "recover".into(),
                name: "observation_read".into(),
                arguments: json!({"id":id}),
            }],
        );
        let result = t.read_observation(&id, 0, 10).unwrap();
        t.rehydrated_tool_result("recover", "observation_read", &id, 0, 10, &result);
        assert!(tool_turn_is_replay(
            &[ValidatedCall {
                id: "recover".into(),
                name: "observation_read".into(),
                arguments: json!({"id":id})
            }],
            &t
        ));
        assert_eq!(t.observations().len(), 1);
        t.assistant_tool_turn("".into(), &[call("duplicate")]);
        t.tool_result("duplicate", "read_file", "A".into());
        assert!(tool_turn_is_replay(&[call("duplicate")], &t));
        std::fs::write(root.join("api.php"), "version B").unwrap();
        t.assistant_tool_turn("".into(), &[call("changed")]);
        t.tool_result("changed", "read_file", "B".into());
        assert!(!tool_turn_is_replay(&[call("changed")], &t));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn dynamic_tail_contains_memory_and_knowledge_without_plan_state() {
        let state = AgentState::default();
        let tail = dynamic_tail(&state, None, "", &Transcript::default(), 65_536);
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
