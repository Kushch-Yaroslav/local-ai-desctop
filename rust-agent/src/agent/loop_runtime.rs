use crate::agent::{
    events::Event,
    policy::{self, RunPolicy},
    state::AgentState,
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
    pub cancelled: Arc<AtomicBool>,
    pub steering: Arc<Mutex<Vec<String>>>,
}

// `context_limit` is the user-selected working context, not the llama.cpp
// server ceiling. Reserve room for a complete streamed answer and template
// overhead before projecting a request.
const RESERVED_OUTPUT_TOKENS: usize = 8_192;
const SAFETY_TOKENS: usize = 1_024;
/// Escape hatch for a provider that repeatedly exhausts output while we are
/// continuing one final answer. This is not a normal answer-length cap.
const MAX_FINAL_CONTINUATIONS: usize = 3;
// Avoid compaction churn: a small summary delta costs a turn but leaves the
// next request above the same watermark. Hard-budget compaction still wins.
const MIN_COMPACTION_GAIN_TOKENS: usize = 256;

// Ported from Jan's always-on agent guidelines and adapted to Local's
// Task Plan/Task Notes tools. This is runtime control context, not a synthetic
// user turn: it remains at the system boundary across compaction.
const AGENT_GUIDANCE: &str = r#"
# Agent guidelines
- Be concise and answer the user's actual question once sufficient evidence is available.
- Tool output is complete unless it explicitly says it was truncated. Do not reread an unchanged file or rerun an inspection just to look for hidden output.
- For a substantial multi-step project analysis, first create a Task Plan that covers inspection, business/architecture assessment, implementation assessment, and synthesis. Keep it current: complete or drop work as soon as it is resolved.
- For a substantial analysis, keep Task Notes updated at major evidence checkpoints with concise facts, conclusions, business/architecture relevance, risks, unanswered questions, and whether each source is sufficient for this task. Task Notes and investigated-state survive context optimization. They are durable evidence, not a list of paths.
- `complete_for_task` evidence means model-authored facts sufficient for this user's task survive even though raw source text is no longer active. Trust it. A physical read with only a partial excerpt is explicitly `partial`, not complete. Reread only for one named missing fact, using a narrow `read_file` start_line/end_line range. Never reread solely to reconstruct an entire file.
- Explore purposefully. After project structure and representative core files establish the requested facts, stop broad exploration. Either identify one specific missing fact, or update Task Plan/Task Notes and synthesize the final response. Do not keep reading files "just in case".
- A tool-free response is the normal way to finish. Do not call a tool merely because tools are available.
"#;

fn max_projected_input(context_limit: usize) -> usize {
    context_limit.saturating_sub(RESERVED_OUTPUT_TOKENS + SAFETY_TOKENS)
}

/// Ordinary tool/reasoning turns reserve a stable budget. Final answers use
/// the actual remaining selected-context capacity rather than inheriting the
/// execution-turn 8K ceiling.
fn final_output_budget(context_limit: usize, projected_input_tokens: usize) -> usize {
    context_limit.saturating_sub(projected_input_tokens.saturating_add(SAFETY_TOKENS))
}

/// Provider `length` is a transport boundary, never a semantic completion.
/// Keep the decision pure so its contract remains covered without a live SSE
/// server: only a tool-free final prefix may be continued as prose.
fn final_requires_continuation(finish_reason: &str, has_tool_calls: bool) -> bool {
    finish_reason == "length" && !has_tool_calls
}

fn final_continuation_available(count: usize) -> bool {
    count < MAX_FINAL_CONTINUATIONS
}

fn compaction_threshold(context_limit: usize) -> usize {
    max_projected_input(context_limit).saturating_mul(4) / 5
}

fn compaction_target(context_limit: usize) -> usize {
    // Hysteresis: proactive compaction lands well below the trigger. Keeping
    // the projected request near the trigger caused one compaction per turn.
    max_projected_input(context_limit).saturating_mul(13) / 20
}

/// Deliberately conservative for JSON/tool payloads. The provider remains the
/// source of exact usage; this budget exists to prevent an oversize request.
fn estimate_projected_tokens(messages: &[Value]) -> usize {
    serde_json::to_string(messages).unwrap_or_default().len() / 2
}

/// Preserve concise, model-useful evidence at a projection boundary even when
/// a model has not yet written a Task Note. Canonical tool output is never
/// deleted; this is only the Jan-style working-set handoff for older calls.
fn compacted_working_state(transcript: &Transcript, covers: usize, state: &AgentState) -> Value {
    let mut actions = Vec::new();
    for entry in transcript.entries().iter().take(covers).rev() {
        let crate::agent::transcript::Entry::Message(message) = entry else {
            continue;
        };
        let Some(calls) = message.get("tool_calls").and_then(Value::as_array) else {
            continue;
        };
        for call in calls.iter().rev() {
            let name = call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let arguments = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let detail = serde_json::from_str::<Value>(arguments)
                .ok()
                .and_then(|value| {
                    value
                        .get("path")
                        .or_else(|| value.get("command"))
                        .or_else(|| value.get("task"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| "completed".into());
            actions.push(format!("{name}: {detail}"));
            if actions.len() == 12 {
                break;
            }
        }
        if actions.len() == 12 {
            break;
        }
    }
    actions.reverse();
    json!({
        "kind":"runtime_compaction",
        "completed_turns":"Earlier assistant/tool pairs remain canonical. Use the semantic state below and retained suffix before rereading any file.",
        "already_investigated_or_executed": actions,
        "investigated_evidence":state.investigated_summary_bounded(16, 560),
        "working_state_note":"Task Plan, Task Notes, and source-specific semantic evidence are projected separately as current runtime state. Complete evidence remains sufficient when raw source is intentionally omitted.",
    })
}
fn tools() -> Value {
    json!([
        {"type":"function","function":{"name":"list_directory","description":"List a project directory. Treat its result as complete; do not repeat an unchanged listing without a concrete new question.","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}},
        {"type":"function","function":{"name":"read_file","description":"Read a project file. If an unchanged source already has evidence_complete=true, do not reread merely because raw content left context. For a specific missing fact, provide reason and a narrow 1-based start_line/end_line range.","parameters":{"type":"object","properties":{"path":{"type":"string"},"reason":{"type":"string","description":"The exact fact missing from durable evidence"},"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1}},"required":["path"]}}},
        {"type":"function","function":{"name":"write_file","description":"Write a project file","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}},
        {"type":"function","function":{"name":"run_terminal","description":"Run a project shell command and use its complete diagnostics to decide the next step","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout_ms":{"type":"integer"}},"required":["command"]}}},
        {"type":"function","function":{"name":"task_plan","description":"Manage the canonical Task Plan: init, start, done, drop, or batch. For a phase boundary, use batch to close completed tasks and start the next task in one honest update. Do not finalize with open work unless explicitly dropped. init accepts phases: [{name,tasks:[{content,status?]}]. batch accepts updates:[{action:start|done|drop,task}].","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["init","start","done","drop","batch"]},"phases":{"type":"array"},"task":{"type":"string"},"updates":{"type":"array","items":{"type":"object","properties":{"action":{"type":"string","enum":["start","done","drop"]},"task":{"type":"string"}},"required":["action","task"]}}},"required":["action"]}}},
        {"type":"function","function":{"name":"task_notes","description":"Checkpoint durable cross-source conclusions and source evidence; do not overwrite prior findings. `notes` contains concise business/architecture conclusions. `evidence` contains only sources whose facts are now sufficient: [{path,facts:[...],relevance:[...],unresolved:[...],complete_for_task:boolean}]. Set complete_for_task=true only when facts answer the current task without raw text. Update after major discoveries and before context optimization.","parameters":{"type":"object","properties":{"notes":{"type":"string"},"evidence":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"facts":{"type":"array","items":{"type":"string"}},"relevance":{"type":"array","items":{"type":"string"}},"unresolved":{"type":"array","items":{"type":"string"}},"complete_for_task":{"type":"boolean"}},"required":["path","facts","complete_for_task"]}}},"required":["notes"]}}}
    ])
}

/// Jan's eager-goal Todo turn is not merely a prompt instruction: the first
/// completion is scoped to the Todo capability.  Qwen through the current
/// llama.cpp server can ignore a named `tool_choice` when unrelated tools are
/// also advertised, so keep that same capability boundary for our Task Plan
/// handoff.  The resulting plan is still wholly model-authored and validated
/// by the normal tool path; this never fabricates a visible plan in runtime.
fn planning_tools() -> Value {
    let all = tools();
    let Some(items) = all.as_array() else {
        return json!([]);
    };
    Value::Array(
        items
            .iter()
            .filter(|tool| {
                tool.pointer("/function/name").and_then(Value::as_str) == Some("task_plan")
            })
            .cloned()
            .collect(),
    )
}

/// Scope the one-shot Notes checkpoint exactly like Jan scopes its Todo
/// handoff. This remains a model-authored tool call, never a synthetic note.
fn notes_tools() -> Value {
    let all = tools();
    let Some(items) = all.as_array() else {
        return json!([]);
    };
    Value::Array(
        items
            .iter()
            .filter(|tool| {
                tool.pointer("/function/name").and_then(Value::as_str) == Some("task_notes")
            })
            .cloned()
            .collect(),
    )
}

/// Once two independent saturation checks agree, only a single, declared
/// fact may be retrieved. This is a capability boundary, rather than another
/// advisory paragraph the model can ignore.
fn saturation_tools() -> Value {
    let all = tools();
    let Some(items) = all.as_array() else {
        return json!([]);
    };
    Value::Array(
        items
            .iter()
            .filter(|tool| {
                matches!(
                    tool.pointer("/function/name").and_then(Value::as_str),
                    Some("task_plan" | "task_notes" | "read_file")
                )
            })
            .cloned()
            .map(|mut tool| {
                if tool.pointer("/function/name").and_then(Value::as_str) == Some("read_file") {
                    tool["function"]["parameters"]["required"] =
                        json!(["path", "reason", "start_line", "end_line"]);
                }
                tool
            })
            .collect(),
    )
}

fn requires_initial_plan(user: &str, has_project: bool) -> bool {
    if !has_project {
        return false;
    }
    let lower = user.to_lowercase();
    user.chars().count() >= 140
        || [
            "анализ",
            "проанализ",
            "architecture",
            "analy",
            "business",
            "плюсы",
            "минусы",
            "сравн",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn phase_for(state: &AgentState, needs_plan: bool, turn: usize) -> &'static str {
    // Saturation is a state transition, not merely a reminder appended to an
    // otherwise identical exploration request.  Keep Plan/Notes checkpoints
    // available in the loop, but project the ordinary model turn as
    // synthesis so the model consolidates durable evidence instead of
    // reopening the audit.
    if state.saturation_round >= 2 {
        return if !state.plan.phases.is_empty() && !state.plan.has_open() {
            "final"
        } else {
            "synthesis"
        };
    }
    let active = state
        .plan
        .active_phase()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if active.contains("verify") || active.contains("провер") {
        "verify"
    } else if active.contains("setup")
        || active.contains("analysis")
        || active.contains("investig")
        || active.contains("исслед")
        || active.contains("анализ")
    {
        "investigate"
    } else if !state.plan.phases.is_empty() && !state.plan.has_open() {
        "final"
    } else if needs_plan && state.plan.phases.is_empty() {
        "plan"
    } else if turn == 0 {
        "plan"
    } else {
        "execute"
    }
}

/// After the second evidence-saturation boundary, only an explicit Plan/Notes
/// checkpoint or a narrowly justified source lookup may continue the loop.
/// Keep this as a pure predicate so the capability registry and the execution
/// defence cannot drift apart again.
fn rejects_saturated_tool(state: &AgentState, tool: &ValidatedCall) -> bool {
    if state.saturation_round < 2 {
        return false;
    }
    if matches!(tool.name.as_str(), "task_plan" | "task_notes") {
        return false;
    }
    if tool.name == "read_file" {
        return tool
            .arguments
            .get("reason")
            .and_then(Value::as_str)
            .is_none_or(|reason| reason.trim().is_empty())
            || (tool.arguments.get("start_line").is_none()
                && tool.arguments.get("end_line").is_none())
            || state.post_saturation_retrievals >= 2;
    }
    true
}

fn semantic_excerpt(value: &str, maximum: usize) -> String {
    let compact = value
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(40)
        .collect::<Vec<_>>()
        .join(" ");
    let clipped = compact.chars().take(maximum).collect::<String>();
    if compact.chars().count() > maximum {
        format!("{clipped} …")
    } else {
        clipped
    }
}

fn record_tool_evidence(
    state: &mut AgentState,
    name: &str,
    arguments: &Value,
    result: &Value,
) -> bool {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or(".")
        .to_owned();
    match name {
        "read_file" => {
            let content = result
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default();
            state.record_investigation(
                "read_file",
                path,
                semantic_excerpt(content, 1_200),
                content.contains("[output truncated"),
            )
        }
        "list_directory" => {
            let entries = result
                .get("entries")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            state.record_investigation(
                "list_directory",
                path,
                semantic_excerpt(&entries, 720),
                false,
            )
        }
        _ => false,
    }
}

fn working_control(state: &AgentState) -> String {
    let plan = clip_projection_text(
        &serde_json::to_string(&state.plan).unwrap_or_default(),
        3_600,
    );
    let notes = clip_projection_text(&state.notes, 6_000);
    let investigated = state.investigated_summary_bounded(24, 900).join("\n\n");
    [
        (!notes.is_empty()).then(|| format!("<task_notes>{notes}</task_notes>")),
        Some(format!("<task_plan>{plan}</task_plan>")),
        (!investigated.is_empty())
            .then(|| format!("<investigated_evidence>These are deterministic runtime records, not vague prose. `complete_for_task` means facts are sufficient for this user request even when raw source is absent. `partial` means only a specifically named fact may justify a targeted range read.\n{investigated}</investigated_evidence>")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n")
}

fn clip_projection_text(value: &str, maximum: usize) -> String {
    let clipped = value.chars().take(maximum).collect::<String>();
    if value.chars().count() > maximum {
        format!("{clipped} …")
    } else {
        clipped
    }
}

/// Jan's todo tool accepts concise task strings and initializes their status
/// itself. Normalize Local's OpenAI JSON into the same tolerant shape before
/// deserializing the ordered Task Plan.
fn normalize_plan_phases(value: Value) -> Result<Value, String> {
    let phases = value
        .as_array()
        .ok_or_else(|| "Task Plan init phases must be an array".to_owned())?;
    let is_flat = phases
        .first()
        .is_some_and(|item| item.get("tasks").is_none());
    let source = if is_flat {
        vec![json!({"name":"Implementation","tasks":phases})]
    } else {
        phases.clone()
    };
    let normalized = source
        .into_iter()
        .map(|mut phase| {
            let tasks = phase
                .get("tasks")
                .and_then(Value::as_array)
                .ok_or_else(|| "Task Plan phase requires tasks".to_owned())?
                .iter()
                .map(|task| match task {
                    Value::String(content) => Ok(json!({"content":content,"status":"pending"})),
                    Value::Object(_) => {
                        let content = task.get("content").and_then(Value::as_str).ok_or_else(|| "Task Plan item requires content".to_owned())?;
                        Ok(json!({"content":content,"status":task.get("status").cloned().unwrap_or_else(|| json!("pending"))}))
                    }
                    _ => Err("Task Plan item must be a string or object".to_owned()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            phase["tasks"] = json!(tasks);
            Ok(phase)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!(normalized))
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
    prompt_ms: Option<f64>,
    predicted_ms: Option<f64>,
    predicted_per_second: Option<f64>,
}

fn transcript_entry_is_tool(transcript: &Transcript, index: usize) -> bool {
    matches!(transcript.entries().get(index), Some(crate::agent::transcript::Entry::Message(message)) if message.get("role").and_then(Value::as_str) == Some("tool"))
}

/// Select the smallest projection boundary that actually fits the selected
/// input budget.  A fixed number of retained entries is not safe: one batch
/// of `read_file` calls can already be larger than a 16K working context.
/// Every candidate starts at an assistant/non-tool boundary, so no projected
/// suffix can start with an orphan `role=tool` message.  If even the newest
/// valid suffix is too large, the canonical transcript is still intact while
/// the model receives the compact working-state handoff only.
fn compaction_boundary_to_fit(
    transcript: &Transcript,
    state: &AgentState,
    system: &str,
    max_input: usize,
) -> Option<(usize, usize)> {
    let len = transcript.entries().len();
    let before = estimate_projected_tokens(&project(transcript, system, &working_control(state)));
    for covers in 1..=len {
        if transcript_entry_is_tool(transcript, covers) {
            continue;
        }
        let mut candidate = transcript.clone();
        candidate.compact(compacted_working_state(transcript, covers, state), covers);
        let after =
            estimate_projected_tokens(&project(&candidate, system, &working_control(state)));
        // A compaction boundary is meaningful only when it both fits the hard
        // selected-context budget and materially reduces the projection.  A
        // summary that costs as much as (or more than) the retained history is
        // not an optimization and must not mutate canonical projection state.
        if after <= max_input && before.saturating_sub(after) >= MIN_COMPACTION_GAIN_TOKENS {
            return Some((covers, after));
        }
    }
    None
}

fn emit_context_optimized(
    run_id: &str,
    trigger_reason: &str,
    before: usize,
    after: usize,
    _covers: usize,
    transcript: &Transcript,
    state: &AgentState,
) {
    let control = working_control(state);
    let plan = serde_json::to_string(&state.plan).unwrap_or_default();
    let notes = &state.notes;
    let evidence = state.investigated_summary_bounded(16, 560).join("\n");
    emit(
        run_id,
        Event::ContextOptimized {
            before,
            after,
            trigger_reason: trigger_reason.into(),
            removed_transcript_tokens: before.saturating_sub(after),
            retained_suffix_tokens: estimate_projected_tokens(&project(transcript, "", ""))
                .min(after),
            working_state_tokens: estimate_projected_tokens(&[
                json!({"role":"system","content":control}),
            ]),
            plan_tokens: estimate_projected_tokens(&[json!({"role":"system","content":plan})]),
            notes_tokens: estimate_projected_tokens(&[json!({"role":"system","content":notes})]),
            evidence_tokens: estimate_projected_tokens(&[
                json!({"role":"system","content":evidence}),
            ]),
        },
    );
}

/// A safe, indexed representation of the exact `OpenAI` wire transcript. It is
/// emitted before transport and included in an upstream error, so a provider
/// template failure can be diagnosed without logging source code or prompts.
fn request_shape(messages: &[Value], query: &str) -> Vec<String> {
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("?");
            let calls = message
                .get("tool_calls")
                .and_then(Value::as_array)
                .map(|calls| {
                    calls
                        .iter()
                        .map(|call| {
                            let id = call.get("id").and_then(Value::as_str).unwrap_or("?");
                            let name = call
                                .pointer("/function/name")
                                .and_then(Value::as_str)
                                .unwrap_or("?");
                            format!("{id}:{name}")
                        })
                        .collect::<Vec<_>>()
                        .join("|")
                })
                .filter(|calls| !calls.is_empty());
            let result = message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .map(|id| format!(" result={id}"));
            let current = (role == "user"
                && message.get("content").and_then(Value::as_str) == Some(query))
            .then_some(" current_user");
            format!(
                "{index}:{role}{}{}{}",
                calls.map_or(String::new(), |v| format!(" calls={v}")),
                result.unwrap_or_default(),
                current.unwrap_or_default()
            )
        })
        .collect()
}

/// Jan's request boundary always retains the current user query. Compaction may
/// hide old history, never the turn that owns this run.
fn ensure_current_user_query(messages: &[Value], query: &str) -> Result<(), String> {
    if query.trim().is_empty() {
        return Err("agent run has no current user query".into());
    }
    let present = messages.iter().rposition(|message| {
        message.get("role").and_then(Value::as_str) == Some("user")
            && message.get("content").and_then(Value::as_str) == Some(query)
    });
    // Do not append a late pseudo-user after a tool suffix. That was a
    // self-healing shortcut unique to V2; it changes Qwen's multi-step tool
    // state and is exactly the kind of malformed projection Jan avoids. The
    // owning prompt is canonical and must already be in this projection.
    present
        .filter(|index| *index > 0)
        .map(|_| ())
        .ok_or_else(|| "projection omitted the canonical current user query".to_owned())
}

/// Dependency-free OpenAI-compatible SSE transport. It emits deltas before the
/// response finishes and returns the assembled turn only for strict validation.
fn stream_call(
    endpoint: &str,
    payload: &Value,
    run_id: &str,
    cancelled: &AtomicBool,
) -> Result<StreamedTurn, String> {
    let without = endpoint.trim_start_matches("http://");
    let (host_port, path) = without
        .split_once('/')
        .unwrap_or((without, "v1/chat/completions"));
    let path = format!("/{path}");
    let mut stream = TcpStream::connect(host_port).map_err(|e| e.to_string())?;
    let body = payload.to_string();
    let request=format!("POST {path} HTTP/1.1\r\nHost: {host_port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    if !line.contains(" 200 ") {
        let status = line.trim().to_owned();
        let mut body = String::new();
        let _ = reader.read_to_string(&mut body);
        return Err(format!("model HTTP status: {status}; {}", body.trim()));
    }
    let mut chunked = false;
    loop {
        line.clear();
        reader.read_line(&mut line).map_err(|e| e.to_string())?;
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
    // Providers may take seconds before first token; only poll with a short
    // timeout once their streaming response has begun.
    reader
        .get_mut()
        .set_read_timeout(Some(std::time::Duration::from_millis(250)))
        .map_err(|e| e.to_string())?;
    let mut turn = StreamedTurn::default();
    let mut sse = String::new();
    if chunked {
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            line.clear();
            match reader.read_line(&mut line) {
                Ok(_) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    continue
                }
                Err(e) => return Err(e.to_string()),
            };
            let size = usize::from_str_radix(line.trim(), 16)
                .map_err(|e| format!("invalid chunk size: {e}"))?;
            if size == 0 {
                break;
            }
            let mut bytes = vec![0; size];
            reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
            let mut crlf = [0; 2];
            reader.read_exact(&mut crlf).map_err(|e| e.to_string())?;
            sse.push_str(&String::from_utf8_lossy(&bytes));
            consume_sse(&mut sse, &mut turn, run_id)?;
        }
    } else {
        let mut bytes = [0; 8192];
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let count = match reader.read(&mut bytes) {
                Ok(count) => count,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    continue
                }
                Err(e) => return Err(e.to_string()),
            };
            if count == 0 {
                break;
            }
            sse.push_str(&String::from_utf8_lossy(&bytes[..count]));
            consume_sse(&mut sse, &mut turn, run_id)?;
        }
    }
    Ok(turn)
}
fn consume_sse(buffer: &mut String, turn: &mut StreamedTurn, run_id: &str) -> Result<(), String> {
    while let Some(end) = buffer.find("\n\n") {
        let block = buffer[..end].replace('\r', "");
        buffer.drain(..end + 2);
        for line in block.lines().filter_map(|line| line.strip_prefix("data: ")) {
            if line == "[DONE]" {
                continue;
            }
            let value: Value =
                serde_json::from_str(line).map_err(|e| format!("invalid SSE JSON: {e}"))?;
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
            let reasoning_delta = delta.and_then(|d| {
                ["reasoning_content", "reasoning", "thinking"]
                    .iter()
                    .find_map(|field| d.get(*field).and_then(Value::as_str))
            });
            if let Some(text) = reasoning_delta {
                if !turn.thinking_started {
                    turn.thinking_started = true;
                    emit(run_id, Event::ThinkingStarted);
                }
                turn.reasoning.push_str(text);
                turn.reasoning_delta_count += 1;
                emit(
                    run_id,
                    Event::ThinkingDelta {
                        content: text.to_owned(),
                    },
                );
            }
            if let Some(text) = delta.and_then(|d| d.get("content")).and_then(Value::as_str) {
                // Assistant prose on a tool turn (and a closeout candidate)
                // is not a user-visible response. Keep it local until the
                // terminal no-tool boundary decides whether it is the one
                // final answer. This is what prevents a single logical final
                // from being streamed once as deltas and again as FinalDelta.
                turn.content.push_str(text);
            }
            if let Some(calls) = delta
                .and_then(|d| d.get("tool_calls"))
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
                        entry["id"] = id.clone()
                    }
                    if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                        let new = entry
                            .pointer("/function/name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .is_empty();
                        entry["function"]["name"] = json!(name);
                        if new {
                            emit(
                                run_id,
                                Event::ToolCallStarted {
                                    id: entry["id"].as_str().unwrap_or_default().to_owned(),
                                    name: name.to_owned(),
                                    arguments: json!({}),
                                },
                            );
                        }
                    }
                    if let Some(part) = call.pointer("/function/arguments").and_then(Value::as_str)
                    {
                        let previous = entry
                            .pointer("/function/arguments")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        entry["function"]["arguments"] = json!(format!("{previous}{part}"));
                        emit(
                            run_id,
                            Event::ToolCallDelta {
                                id: entry["id"].as_str().unwrap_or_default().to_owned(),
                                delta: part.to_owned(),
                            },
                        );
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
pub fn run(config: Config) {
    let mut transcript = Transcript::default();
    for message in config.history {
        transcript.push_message(message);
    }
    transcript.push_run_user(json!({"role":"user","content":config.user}));
    // This is the user turn that owns the whole autonomous run. A compaction
    // boundary may summarize older conversation, but it must never project a
    // suffix beginning with assistant/tool records and append this query only
    // afterwards: Qwen's Jinja template then has no valid user query.
    let mut state = AgentState::default();
    // Jan's Todo reminder is bounded and belongs to the model's own Todo
    // mutation path. Qwen needs a capability-scoped closeout turn to honour
    // that reminder reliably, otherwise it can publish a final while its plan
    // still says 0/N.
    let mut closeout_attempts = 0usize;
    let mut final_started = false;
    let mut final_content = String::new();
    let mut final_continuations = 0usize;
    let mut plan_closeout_due = false;
    let mut notes_nudged = false;
    let needs_plan = requires_initial_plan(&config.user, config.root.is_some());
    // Project scope is an execution boundary, but it is also essential model
    // context.  Without this explicit control record Qwen can conclude that
    // “this project” was never attached and answer instead of invoking the
    // planning capability.
    let system_control = format!(
        "{}\n{}{}",
        config.system,
        AGENT_GUIDANCE,
        config.root.as_ref().map_or_else(String::new, |root| format!(
            "\n<project_scope root=\"{}\">A selected local project is attached. Use project tools with relative paths rooted here; inspect it rather than asking the user for a path.</project_scope>",
            root
        )),
    );
    emit(
        &config.run_id,
        Event::AgentStarted {
            run_id: config.run_id.clone(),
        },
    );
    // Jan's normal mode is not governed by a small action cap. The high guard
    // only protects an unattended local process from a provider loop.
    for turn in 0..512 {
        if config.cancelled.load(Ordering::Relaxed) {
            emit(
                &config.run_id,
                Event::AgentStopped {
                    reason: "cancelled".into(),
                },
            );
            return;
        }
        let steering = std::mem::take(&mut *config.steering.lock().expect("steering lock"));
        for message in steering {
            transcript.push_steering(message);
        }
        emit(&config.run_id, Event::TurnStarted { index: turn + 1 });
        // Once a provider exhausts a final prefix, that continuation is a
        // final-output request even if an honest Plan closeout happened to be
        // pending.  It must not fall back to the ordinary 8K execution budget
        // or reopen tools between chunks.
        let final_continuation_turn = final_started && final_continuations > 0;
        let phase = if final_continuation_turn {
            "final_continuation"
        } else {
            phase_for(&state, needs_plan, turn)
        };
        if matches!(phase, "synthesis" | "final" | "final_continuation") {
            transcript.remind("SYNTHESIS PHASE: investigation is complete. Consolidate the durable Task Notes and investigated evidence into the user-facing audit now. Do not rediscover the project, reconstruct raw files, or repeatedly draft the same outline internally. A focused retrieval is allowed only for one named unresolved fact; otherwise update the current Task Plan honestly and produce the final answer.".into());
        }
        emit(
            &config.run_id,
            Event::RunState {
                state: if phase == "verify" {
                    "verifying"
                } else {
                    "thinking"
                }
                .into(),
            },
        );
        // Canonical history remains append-only. When a long autonomous task
        // approaches its selected context we create a fresh projection boundary
        // and retain a protocol-safe suffix (never a leading orphan tool result).
        // The selected context is a hard per-request budget. llama.cpp's
        // n_ctx is merely an upper ceiling; reserve the same completion room
        // passed as max_tokens plus protocol slack before projecting input.
        let max_projected_input = max_projected_input(config.context_limit);
        // GGUF source/JSON payloads are routinely denser than chars/4. A
        // conservative chars/2 estimate starts Jan-like compaction before an
        // upstream rejection, not after it.
        let provisional_notes = working_control(&state);
        let estimated_before =
            estimate_projected_tokens(&project(&transcript, &system_control, &provisional_notes));
        let compaction_trigger = compaction_threshold(config.context_limit);
        // Prefer a model-authored semantic checkpoint before the first
        // compaction after a meaningful exploration group. If the transcript
        // is already beyond the hard input budget we still compact defensively
        // and checkpoint on the immediately following turn.
        let checkpoint_before_compaction = needs_plan
            && state.investigated.len() >= 3
            && state.notes_checkpoint_due()
            && state.uncheckpointed_evidence_count() >= 3
            && estimated_before <= max_projected_input;
        if estimated_before > compaction_trigger && !checkpoint_before_compaction {
            let before = estimated_before;
            // Keep the longest recent protocol-safe suffix that actually
            // fits.  The former fixed 14-entry tail could preserve multiple
            // large reads and make the compacted request *larger* than the
            // original projection.
            if let Some((covers, after)) = compaction_boundary_to_fit(
                &transcript,
                &state,
                &system_control,
                compaction_target(config.context_limit),
            ) {
                let summary = compacted_working_state(&transcript, covers, &state);
                transcript.compact(summary, covers);
                emit_context_optimized(
                    &config.run_id,
                    "proactive_threshold",
                    before,
                    after,
                    covers,
                    &transcript,
                    &state,
                );
            }
        }
        if state.consecutive_repeated_exploration >= 3 && !state.synthesis_nudged {
            state.synthesis_nudged = true;
            transcript.remind(format!(
                "Exploration has repeated files/listings without material new evidence. Review the Task Plan, Task Notes, and investigated state. Do not read another file unless you can name the specific missing fact. Record any established findings, close the exploration task, and synthesize the requested answer.\n{}",
                state.investigated_summary_bounded(6, 160).join("\n")
            ));
        }
        // Saturation is evidence-based rather than an action cap. It gives the
        // model an explicit closeout preference once broad audit dimensions
        // have durable support, while preserving its freedom to name a real
        // missing fact and continue.
        let coverage_likely_sufficient = needs_plan
            && state.investigated.len() >= 6
            && state.notes.chars().count() >= 500
            && !state.notes_checkpoint_due();
        if coverage_likely_sufficient && state.saturation_round < 2 {
            state.saturation_round += 1;
            state.synthesis_nudged = true;
            transcript.remind(format!(
                "Coverage is likely sufficient for synthesis (saturation round {}). {} investigated sources have durable evidence and Task Notes contain current findings. {} Before another broad inspection, identify one exact unresolved fact. Otherwise update/close the current Task Plan work and write the requested final audit.\n{}",
                state.saturation_round,
                state.investigated.len(),
                if state.saturation_round >= 2 { "Broad batches are no longer justified: use at most one focused retrieval for that fact, then synthesize." } else { "You may retrieve only a focused fact if it is genuinely missing." },
                state.plan.open_summary().unwrap_or_default()
            ));
        }
        if state.saturation_round >= 2 {
            transcript.remind(format!(
                "Second saturation boundary: broad exploration capability is now withheld. If evidence is insufficient, use exactly one `read_file` call with a `reason` naming one missing fact and a narrow line range; then checkpoint that fact and synthesize. Do not list directories, reconstruct full files, run terminal alternatives, or request batches. Focused retrievals used: {}.\n{}",
                state.post_saturation_retrievals,
                state.plan.open_summary().unwrap_or_default()
            ));
        }
        if needs_plan
            && !state.plan.phases.is_empty()
            && state.notes.is_empty()
            && state.investigated.len() >= 3
            && !notes_nudged
        {
            notes_nudged = true;
            transcript.remind("You have representative project evidence but no Task Notes. Before broadening exploration, call task_notes with concise factual findings and update the current Task Plan item.".into());
        }
        let control_notes = working_control(&state);
        let mut messages = project(&transcript, &system_control, &control_notes);
        // Reminders are system-boundary control rather than transcript turns.
        // They are added after the normal threshold check above, so assess the
        // final request shape too.  This is still proactive compaction, not an
        // upstream retry: no oversize payload is sent to the provider.
        if estimate_projected_tokens(&messages) > max_projected_input {
            let before = estimate_projected_tokens(&messages);
            if let Some((covers, after)) = compaction_boundary_to_fit(
                &transcript,
                &state,
                &system_control,
                max_projected_input,
            ) {
                transcript.compact(compacted_working_state(&transcript, covers, &state), covers);
                emit_context_optimized(
                    &config.run_id,
                    "hard_input_budget",
                    before,
                    after,
                    covers,
                    &transcript,
                    &state,
                );
                messages = project(&transcript, &system_control, &working_control(&state));
            }
        }
        if let Err(message) = ensure_current_user_query(&messages, &config.user) {
            emit(
                &config.run_id,
                Event::AgentError {
                    code: "projection".into(),
                    message,
                },
            );
            return;
        }
        let projected_tokens = estimate_projected_tokens(&messages);
        if projected_tokens > max_projected_input {
            emit(
                &config.run_id,
                Event::AgentError {
                    code: "context_budget".into(),
                    message: format!("projection is {projected_tokens} tokens; selected input budget is {max_projected_input}"),
                },
            );
            return;
        }
        let roles = messages
            .iter()
            .map(|message| {
                message
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
                    .to_owned()
            })
            .collect::<Vec<_>>();
        let current_user_index = messages.iter().rposition(|message| {
            message.get("role").and_then(Value::as_str) == Some("user")
                && message.get("content").and_then(Value::as_str) == Some(config.user.as_str())
        });
        let entries = request_shape(&messages, &config.user);
        let compaction_boundary = transcript.compaction_boundary();
        let last_request_shape = format!(
            "turn={} messages={} roles={} current_user_index={current_user_index:?} system_first={} compaction_boundary={compaction_boundary:?} entries=[{}]",
            turn + 1,
            messages.len(),
            roles.join(","),
            messages.first().and_then(|message| message.get("role")).and_then(Value::as_str) == Some("system"),
            entries.join("; "),
        );
        emit(
            &config.run_id,
            Event::RequestShape {
                turn: turn + 1,
                message_count: messages.len(),
                roles,
                current_user_index,
                system_first: messages
                    .first()
                    .and_then(|message| message.get("role"))
                    .and_then(Value::as_str)
                    == Some("system"),
                entries,
                compaction_boundary,
            },
        );
        emit(
            &config.run_id,
            Event::ContextStats {
                used: projected_tokens,
                limit: config.context_limit,
            },
        );
        let reasoning = match policy::reasoning(&config.reasoning_mode, phase) {
            policy::Reasoning::Off => json!({"chat_template_kwargs":{"enable_thinking":false}}),
            policy::Reasoning::Low => json!({"reasoning_effort":"low"}),
            policy::Reasoning::Deep => json!({"reasoning_effort":"xhigh"}),
        };
        // Mirrors Jan's eager-goal Todo turn: for a substantial analysis the
        // first visible operation is real structured state, not an optional
        // prompt suggestion. After representative evidence exists, checkpoint
        // it once in Task Notes before allowing broader exploration again.
        let plan_closeout_turn = plan_closeout_due && state.plan.has_open();
        let phase_checkpoint_turn =
            needs_plan && !state.plan.phases.is_empty() && state.plan_checkpoint_due();
        let planning_turn = !final_continuation_turn
            && ((needs_plan && state.plan.phases.is_empty())
                || plan_closeout_turn
                || phase_checkpoint_turn);
        let notes_checkpoint_turn = !final_continuation_turn
            && needs_plan
            && state.investigated.len() >= 3
            && state.notes_checkpoint_due()
            && (state.notes.is_empty()
                || state.uncheckpointed_evidence_count() >= 3
                || checkpoint_before_compaction);
        let tool_choice = if planning_turn {
            // llama.cpp/Qwen honours `required` more reliably for a later
            // closeout handoff than a named function after a long tool suffix.
            // The registry still contains exactly task_plan, so this remains a
            // real model-authored plan operation rather than runtime completion.
            if plan_closeout_turn || phase_checkpoint_turn {
                json!("required")
            } else {
                json!({"type":"function","function":{"name":"task_plan"}})
            }
        } else if notes_checkpoint_turn {
            json!({"type":"function","function":{"name":"task_notes"}})
        } else {
            json!("auto")
        };
        let visible_tools = if final_continuation_turn {
            json!([])
        } else if planning_turn {
            planning_tools()
        } else if notes_checkpoint_turn {
            notes_tools()
        } else if phase == "final" {
            json!([])
        } else if state.saturation_round >= 2 {
            saturation_tools()
        } else {
            tools()
        };
        let request_output_budget = if matches!(phase, "final" | "final_continuation") {
            final_output_budget(config.context_limit, projected_tokens)
        } else {
            RESERVED_OUTPUT_TOKENS
        };
        if request_output_budget == 0 {
            emit(
                &config.run_id,
                Event::AgentError {
                    code: "final_context_budget".into(),
                    message: "no selected-context capacity remains for a final answer".into(),
                },
            );
            return;
        }
        let mut payload = json!({"model":config.model,"messages":messages,"tools":visible_tools,"tool_choice":tool_choice,"stream":true,"stream_options":{"include_usage":true},"max_tokens":request_output_budget});
        payload
            .as_object_mut()
            .expect("object")
            .extend(reasoning.as_object().expect("object").clone());
        emit(
            &config.run_id,
            Event::RequestPolicy {
                turn: turn + 1,
                phase: phase.to_owned(),
                reasoning_effort: payload
                    .get("reasoning_effort")
                    .and_then(Value::as_str)
                    .unwrap_or("thinking_off")
                    .to_owned(),
                tool_choice: payload.get("tool_choice").cloned().unwrap_or(Value::Null),
                tools: payload
                    .get("tools")
                    .and_then(Value::as_array)
                    .map(|tools| {
                        tools
                            .iter()
                            .filter_map(|tool| {
                                tool.pointer("/function/name")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                max_tokens: request_output_budget,
                context_limit: config.context_limit,
                projected_input_tokens: projected_tokens,
                reserved_output_tokens: request_output_budget,
            },
        );
        let streamed = match stream_call(
            &config.endpoint,
            &payload,
            &config.run_id,
            &config.cancelled,
        ) {
            Ok(v) => v,
            Err(e) => {
                if e == "cancelled" {
                    emit(
                        &config.run_id,
                        Event::AgentStopped {
                            reason: "cancelled".into(),
                        },
                    );
                    return;
                }
                emit(
                    &config.run_id,
                    Event::AgentError {
                        code: "upstream".into(),
                        message: format!("{e}; request_shape: {last_request_shape}"),
                    },
                );
                return;
            }
        };
        let finish = streamed.finish_reason.clone();
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
                prompt_ms: streamed.prompt_ms,
                predicted_ms: streamed.predicted_ms,
                predicted_per_second: streamed.predicted_per_second,
                finish_reason: finish.clone(),
            },
        );
        emit(
            &config.run_id,
            Event::TurnReasoning {
                turn: turn + 1,
                started: streamed.thinking_started,
                delta_count: streamed.reasoning_delta_count,
                chars: streamed.reasoning.chars().count(),
            },
        );
        let content = streamed.content;
        let raw_calls = streamed.calls.into_values().collect::<Vec<_>>();
        if !streamed.reasoning.is_empty() {
            emit(&config.run_id, Event::ThinkingFinished);
        }
        let calls = match validate_calls(&raw_calls, Some(&finish)) {
            Ok(c) => c,
            Err(e) => {
                emit(
                    &config.run_id,
                    Event::ToolError {
                        id: "protocol".into(),
                        name: "tool_protocol".into(),
                        message: e.clone(),
                    },
                );
                // Keep invalid calls out of canonical assistant/tool history. This
                // is a runtime protocol notice, never an invented user turn.
                transcript.remind(format!("A tool call was rejected by the protocol: {e}. Emit a complete valid call or answer without tools."));
                continue;
            }
        };
        if calls.is_empty() {
            if final_requires_continuation(&finish, false) {
                // A completion-exhausted prefix is never a successful final.
                // Preserve it in canonical history and append its next chunk
                // to the same visible assistant response on the next request.
                if !final_started {
                    final_started = true;
                    emit(&config.run_id, Event::FinalStarted);
                }
                if !content.is_empty() {
                    final_content.push_str(&content);
                    transcript.assistant_final_partial(content.clone());
                    emit(&config.run_id, Event::FinalDelta { content });
                }
                if !final_continuation_available(final_continuations) {
                    emit(
                        &config.run_id,
                        Event::AgentError {
                            code: "final_output_exhausted".into(),
                            message: format!(
                                "final answer exhausted provider output capacity after {final_continuations} continuation(s); partial text was preserved but not marked complete"
                            ),
                        },
                    );
                    return;
                }
                final_continuations += 1;
                transcript.remind(format!(
                    "The user-facing final answer was interrupted by the provider output limit after {} characters. Continue exactly from that unfinished point. Do not repeat its introduction, outline, or completed sections. Finish naturally when complete.",
                    final_content.chars().count()
                ));
                emit(
                    &config.run_id,
                    Event::FinalContinuation {
                        continuation: final_continuations,
                        prior_chars: final_content.chars().count(),
                        finish_reason: finish,
                        next_max_tokens: final_output_budget(
                            config.context_limit,
                            projected_tokens,
                        ),
                    },
                );
                continue;
            }
            // Jan's terminal boundary is tool-driven: a tool-free completion
            // ends the cycle. Empty assistant content is deliberately not
            // recorded in canonical history (matching Jan's
            // `record_assistant_turn`), and it is not turned into an invented
            // recovery/user message.
            // Jan grants one closeout pass when model completion leaves an
            // explicit Todo open. The reminder lives in runtime control context,
            // preserving the canonical conversation and its tool pair invariants.
            let (_, plan_total) = state.plan.progress();
            if state.plan.has_open() && closeout_attempts < plan_total.max(1) {
                closeout_attempts += 1;
                plan_closeout_due = true;
                transcript.remind(format!("Task Plan remains open. This is a closeout turn: call task_plan now to mark the completed current item done, or explicitly drop work that is not needed. Do not write an answer yet.\n{}", state.plan.open_summary().unwrap_or_default()));
                continue;
            }
            emit(
                &config.run_id,
                Event::RunState {
                    state: "finalizing".into(),
                },
            );
            if !final_started {
                emit(&config.run_id, Event::FinalStarted);
            }
            if !content.is_empty() {
                final_content.push_str(&content);
                emit(&config.run_id, Event::FinalDelta { content })
            }
            emit(
                &config.run_id,
                Event::Final {
                    content: final_content.clone(),
                    complete: true,
                    continuation_count: final_continuations,
                    chars: final_content.chars().count(),
                    finish_reason: finish,
                },
            );
            return;
        }
        transcript.assistant_tool_turn(content, &calls);
        for tool in calls {
            emit(
                &config.run_id,
                Event::RunState {
                    state: "working".into(),
                },
            );
            // Capability filtering is the normal enforcement path. Keep this
            // validation too for providers that emit an unadvertised cached
            // tool call. A named reason is the declared missing fact.
            if rejects_saturated_tool(&state, &tool) {
                let message = "Coverage is already sufficient. This request is broader than one declared unresolved fact, or the focused-retrieval budget is exhausted. Resolve the existing fact in Task Notes/Task Plan or synthesize.".to_owned();
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
            emit(
                &config.run_id,
                Event::ToolCallStarted {
                    id: tool.id.clone(),
                    name: tool.name.clone(),
                    arguments: tool.arguments.clone(),
                },
            );
            emit(
                &config.run_id,
                Event::ToolCall {
                    id: tool.id.clone(),
                    name: tool.name.clone(),
                },
            );
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
            let targeted_read = tool.name == "read_file"
                && (tool.arguments.get("start_line").is_some()
                    || tool.arguments.get("end_line").is_some()
                    || tool
                        .arguments
                        .get("reason")
                        .and_then(Value::as_str)
                        .is_some_and(|reason| !reason.trim().is_empty()));
            let prior_investigation = ((!targeted_read)
                && matches!(tool.name.as_str(), "read_file" | "list_directory"))
            .then(|| tool.arguments.get("path").and_then(Value::as_str))
            .flatten()
            .and_then(|path| state.prior_investigation(&tool.name, path))
            .filter(|item| item.evidence_complete)
            .map(|item| (item.path.clone(), item.finding.clone(), item.reads));
            let reuses_existing_investigation = prior_investigation.is_some();
            let result = if let Some((path, finding, reads)) = prior_investigation {
                Ok((
                    json!({
                        "reused_investigation": true,
                        "path": path,
                        "prior_reads": reads,
                        "evidence_complete": true,
                        "task_relevant_evidence": finding,
                        "missing_facts": [],
                        "instruction": "No physical read was performed. This unchanged source already has sufficient task-relevant evidence in working memory. Do not retry through terminal or a path variant. Only request a narrow read_file range with a named exact missing fact."
                    }),
                    None,
                ))
            } else {
                match tool.name.as_str() {
                    "task_notes" => {
                        let incoming_notes = tool
                            .arguments
                            .get("notes")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        state.merge_notes(&incoming_notes);
                        state.checkpoint_source_evidence(
                            tool.arguments.get("evidence").unwrap_or(&Value::Null),
                        );
                        state.checkpoint_notes();
                        emit(
                            &config.run_id,
                            Event::TaskNoteUpdate {
                                notes: state.notes.clone(),
                            },
                        );
                        Ok((json!({"updated":true}), None))
                    }
                    "task_plan" => (|| -> Result<(Value, Option<String>), String> {
                        let action = tool
                            .arguments
                            .get("action")
                            .and_then(Value::as_str)
                            .unwrap_or("init");
                        match action {
                            "init" => {
                                let phases = tool
                                    .arguments
                                    .get("phases")
                                    .cloned()
                                    .or_else(|| tool.arguments.get("steps").cloned())
                                    .ok_or_else(|| "Task Plan init requires phases".to_owned())?;
                                let phases = normalize_plan_phases(phases)?;
                                state.plan.init(
                                    serde_json::from_value(phases)
                                        .map_err(|e| format!("invalid Task Plan: {e}"))?,
                                )?;
                            }
                            "start" | "done" | "drop" => {
                                let task = tool
                                    .arguments
                                    .get("task")
                                    .and_then(Value::as_str)
                                    .filter(|task| !task.trim().is_empty())
                                    .ok_or_else(|| format!("Task Plan {action} requires task"))?;
                                if action == "start" {
                                    state.plan.start(task)?;
                                } else {
                                    state.plan.finish(task, action == "drop")?;
                                }
                            }
                            "batch" => {
                                let updates = tool
                                    .arguments
                                    .get("updates")
                                    .and_then(Value::as_array)
                                    .ok_or_else(|| "Task Plan batch requires updates".to_owned())?;
                                for update in updates {
                                    let action =
                                        update.get("action").and_then(Value::as_str).ok_or_else(
                                            || "Task Plan batch update requires action".to_owned(),
                                        )?;
                                    let task = update
                                        .get("task")
                                        .and_then(Value::as_str)
                                        .filter(|task| !task.trim().is_empty())
                                        .ok_or_else(|| {
                                            "Task Plan batch update requires task".to_owned()
                                        })?;
                                    match action {
                                        "start" => state.plan.start(task)?,
                                        "done" | "drop" => {
                                            state.plan.finish(task, action == "drop")?
                                        }
                                        _ => return Err(
                                            "Task Plan batch updates must be start, done, or drop"
                                                .into(),
                                        ),
                                    }
                                }
                            }
                            _ => {
                                return Err(
                                    "Task Plan action must be init, start, done, drop, or batch"
                                        .into(),
                                )
                            }
                        }
                        emit(
                            &config.run_id,
                            Event::PlanUpdate {
                                plan: serde_json::to_value(&state.plan)
                                    .map_err(|e| e.to_string())?,
                            },
                        );
                        // A successful plan mutation consumes the scoped
                        // closeout handoff. A later final may arm the next
                        // item, but it cannot silently reuse this one.
                        plan_closeout_due = false;
                        state.mark_plan_checkpoint();
                        let (completed, total) = state.plan.progress();
                        if state
                            .plan
                            .active_phase()
                            .is_some_and(|name| name.eq_ignore_ascii_case("verify"))
                        {
                            emit(
                                &config.run_id,
                                Event::VerificationUpdate {
                                    status: "active".into(),
                                    detail: state.plan.open_summary().unwrap_or_default(),
                                },
                            );
                        }
                        Ok((
                            json!({"updated":true,"action":action,"completed":completed,"total":total,"open":state.plan.open_summary()}),
                            None,
                        ))
                    })(),
                    "run_terminal" => config
                        .root
                        .as_ref()
                        .ok_or_else(|| "no project scope".to_owned())
                        .and_then(|r| {
                            crate::tools::shell::execute(
                                &PathBuf::from(r),
                                &tool.arguments,
                                || config.cancelled.load(Ordering::Relaxed),
                                |pid, pgid, session_id, started_at| {
                                    emit(
                                        &config.run_id,
                                        Event::ToolProcessStarted {
                                            id: tool.id.clone(),
                                            command: tool
                                                .arguments
                                                .get("command")
                                                .and_then(Value::as_str)
                                                .unwrap_or_default()
                                                .to_owned(),
                                            cwd: r.clone(),
                                            pid,
                                            pgid,
                                            session_id,
                                            started_at,
                                        },
                                    );
                                },
                                |stream, content| {
                                    emit(
                                        &config.run_id,
                                        Event::ToolOutputDelta {
                                            id: tool.id.clone(),
                                            stream: stream.into(),
                                            content: content.into(),
                                        },
                                    );
                                },
                            )
                            .and_then(|value| {
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
                                    Err(value.to_string())
                                } else {
                                    Ok((value, None))
                                }
                            })
                        }),
                    _ => config
                        .root
                        .as_ref()
                        .ok_or_else(|| "no project scope".to_owned())
                        .and_then(|r| {
                            crate::tools::filesystem::execute(
                                &PathBuf::from(r),
                                &tool.name,
                                &tool.arguments,
                            )
                        }),
                }
            };
            match result {
                Ok((value, diff)) => {
                    let material_new_evidence = (!reuses_existing_investigation)
                        && record_tool_evidence(&mut state, &tool.name, &tool.arguments, &value);
                    if matches!(tool.name.as_str(), "write_file" | "edit_file" | "patch") {
                        if let Some(path) = tool.arguments.get("path").and_then(Value::as_str) {
                            state.invalidate_path(path);
                        }
                    }
                    if material_new_evidence {
                        // New evidence makes an earlier anti-repeat nudge stale;
                        // the model may reasonably continue to the next focused
                        // question rather than being forced to synthesize.
                        state.synthesis_nudged = false;
                    }
                    if state.saturation_round >= 2 && tool.name == "read_file" {
                        let reason = tool
                            .arguments
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        state.post_saturation_retrievals += 1;
                        if !state
                            .resolved_missing_facts
                            .iter()
                            .any(|known| known.eq_ignore_ascii_case(&reason))
                        {
                            state.resolved_missing_facts.push(reason);
                        }
                    }
                    let text = value.to_string();
                    emit(
                        &config.run_id,
                        Event::ToolResult {
                            id: tool.id.clone(),
                            name: tool.name.clone(),
                            content: text.clone(),
                            is_error: false,
                            diff,
                        },
                    );
                    transcript.tool_result(&tool.id, &tool.name, text)
                }
                Err(error) => {
                    emit(
                        &config.run_id,
                        Event::ToolError {
                            id: tool.id.clone(),
                            name: tool.name.clone(),
                            message: error.clone(),
                        },
                    );
                    transcript.tool_result(&tool.id, &tool.name, format!("ERROR: {error}"))
                }
            }
        }
    }
    emit(
        &config.run_id,
        Event::AgentError {
            code: "turn_limit".into(),
            message: "agent reached turn limit".into(),
        },
    );
}

#[cfg(test)]
mod projection_tests {
    use super::*;
    use crate::agent::transcript::ValidatedCall;
    #[test]
    fn current_query_survives_all_request_boundaries() {
        for query in [
            "first request with Project 1",
            "next request in this conversation",
            "request after switching project",
            "regenerate after agent error",
            "request after completed response",
            "request after context compaction",
        ] {
            let mut transcript = Transcript::default();
            transcript.push_message(json!({"role":"user","content":"older request"}));
            transcript.push_message(json!({"role":"assistant","content":"older answer"}));
            if query.contains("compaction") {
                transcript.compact(json!({"summary":"older work"}), 2);
            }
            // The owning prompt is recorded before projection. A missing one
            // is a programming error, not an excuse to append a user node
            // after a tool suffix.
            transcript.push_message(json!({"role":"user","content":query}));
            let messages = project(&transcript, "control", "task note");
            ensure_current_user_query(&messages, query).unwrap();
            assert_eq!(messages.first().unwrap()["role"], "system");
            assert!(messages
                .iter()
                .any(|message| message["role"] == "user" && message["content"] == query));
        }
        assert!(ensure_current_user_query(&[], "").is_err());
        assert!(
            ensure_current_user_query(&[json!({"role":"system","content":"x"})], "missing")
                .is_err()
        );
    }

    #[test]
    fn compaction_keeps_the_run_user_before_tool_suffix() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"user","content":"old"}));
        transcript.push_message(json!({"role":"assistant","content":"old answer"}));
        transcript.push_message(json!({"role":"user","content":"current"}));
        transcript.assistant_tool_turn(
            "".into(),
            &[ValidatedCall {
                id: "call_1".into(),
                name: "read_file".into(),
                arguments: json!({"path":"a"}),
            }],
        );
        transcript.tool_result("call_1", "read_file", "ok".into());
        let current_user_entry = 2;
        transcript.compact(json!({"summary":"old"}), current_user_entry);
        let projected = project(&transcript, "system", "");
        assert_eq!(projected[1]["role"], "user");
        assert_eq!(projected[1]["content"], "current");
        assert_eq!(projected[2]["role"], "assistant");
        assert_eq!(projected[3]["role"], "tool");
    }

    #[test]
    fn selected_context_is_a_hard_projection_budget() {
        assert_eq!(max_projected_input(32_768), 23_552);
        assert_eq!(compaction_threshold(32_768), 18_841);
        assert!(
            estimate_projected_tokens(&[json!({"role":"user", "content":"x".repeat(50_000)})])
                > max_projected_input(32_768)
        );
    }

    #[test]
    fn final_budget_uses_remaining_context_not_execution_turn_ceiling() {
        // A final has 18K of projected input in a selected 32K window. It
        // gets every safe remaining token, while normal execution remains at
        // the stable 8K reservation.
        let final_budget = final_output_budget(32_768, 18_304);
        assert_eq!(final_budget, 13_440);
        assert_eq!(18_304 + final_budget + SAFETY_TOKENS, 32_768);
        assert!(final_budget > RESERVED_OUTPUT_TOKENS);
    }

    #[test]
    fn output_exhaustion_is_not_a_successful_final() {
        assert!(final_requires_continuation("length", false));
        assert!(!final_requires_continuation("stop", false));
        assert!(!final_requires_continuation("length", true));
        assert!(final_continuation_available(0));
        assert!(final_continuation_available(MAX_FINAL_CONTINUATIONS - 1));
        assert!(!final_continuation_available(MAX_FINAL_CONTINUATIONS));
    }

    #[test]
    fn compaction_chooses_a_boundary_that_fits_large_early_tool_output() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"analyze"}));
        transcript.assistant_tool_turn(
            String::new(),
            &[
                ValidatedCall {
                    id: "read_a".into(),
                    name: "read_file".into(),
                    arguments: json!({"path":"src/App.tsx"}),
                },
                ValidatedCall {
                    id: "read_b".into(),
                    name: "read_file".into(),
                    arguments: json!({"path":"src/Home.tsx"}),
                },
                ValidatedCall {
                    id: "read_c".into(),
                    name: "read_file".into(),
                    arguments: json!({"path":"src/Routes.tsx"}),
                },
            ],
        );
        for id in ["read_a", "read_b", "read_c"] {
            transcript.tool_result(id, "read_file", "x".repeat(40_000));
        }
        let state = AgentState::default();
        let system = "system";
        let before = estimate_projected_tokens(&project(&transcript, system, ""));
        let (covers, after) =
            compaction_boundary_to_fit(&transcript, &state, system, 2_000).unwrap();
        assert!(covers > 0);
        assert!(after <= 2_000, "after={after}");
        assert!(after < before);
    }

    #[test]
    fn compaction_refuses_a_noop_or_larger_projection() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"short analysis"}));
        let state = AgentState::default();
        // The working-state handoff itself is larger than this tiny canonical
        // transcript. It must not create a misleading ContextOptimized event.
        assert!(compaction_boundary_to_fit(&transcript, &state, "system", 20_000).is_none());
    }

    #[test]
    fn compaction_handoff_preserves_investigated_paths_and_notes() {
        let mut transcript = Transcript::default();
        transcript.assistant_tool_turn(
            String::new(),
            &[ValidatedCall {
                id: "read".into(),
                name: "read_file".into(),
                arguments: json!({"path":"src/App.tsx"}),
            }],
        );
        let mut state = AgentState::default();
        state.notes = "App is a Vite entry point".into();
        let summary = compacted_working_state(&transcript, 1, &state);
        assert!(summary["already_investigated_or_executed"]
            .to_string()
            .contains("src/App.tsx"));
        assert!(summary["working_state_note"]
            .as_str()
            .unwrap()
            .contains("source-specific semantic evidence"));
        assert!(working_control(&state).contains("App is a Vite entry point"));
    }

    #[test]
    fn substantial_project_analysis_requires_plan_and_notes_checkpoint() {
        assert!(requires_initial_plan(
            "Проанализируй этот проект: бизнес, архитектуру, плюсы, минусы и признаки AI-стиля.",
            true
        ));
        assert!(!requires_initial_plan("прочитай package.json", true));
        let phases = normalize_plan_phases(json!([
            {"name":"Setup","tasks":["inspect structure", {"content":"identify flow"}]},
            {"name":"Synthesis","tasks":["write final"]}
        ]))
        .unwrap();
        let mut state = AgentState::default();
        state
            .plan
            .init(serde_json::from_value(phases).unwrap())
            .unwrap();
        assert!(state.plan.has_open());
        assert_eq!(phase_for(&state, true, 1), "investigate");
    }

    #[test]
    fn eager_planning_turn_exposes_only_the_real_plan_capability() {
        let plan_tools = planning_tools();
        let names = plan_tools
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["task_plan"]);
    }

    #[test]
    fn notes_checkpoint_exposes_only_the_real_notes_capability() {
        let note_tools = notes_tools();
        let names = note_tools
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["task_notes"]);
    }

    #[test]
    fn investigated_semantic_evidence_survives_compactions_and_repeats_nudge() {
        let mut state = AgentState::default();
        let args = json!({"path":"src/App.tsx"});
        let output =
            json!({"path":"src/App.tsx","content":"export function App() { return <Home />; }"});
        assert!(record_tool_evidence(
            &mut state,
            "read_file",
            &args,
            &output
        ));
        assert!(!record_tool_evidence(
            &mut state,
            "read_file",
            &args,
            &output
        ));
        assert!(!record_tool_evidence(
            &mut state,
            "read_file",
            &args,
            &output
        ));
        assert!(!record_tool_evidence(
            &mut state,
            "read_file",
            &args,
            &output
        ));
        assert_eq!(state.consecutive_repeated_exploration, 3);
        state.notes = "Business: landing flow. Architecture: React Home route.".into();
        state.checkpoint_source_evidence(&json!([{"path":"src/App.tsx","facts":["renders Home route"],"relevance":["architecture"],"unresolved":[],"complete_for_task":true}]));
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"analyze"}));
        transcript.compact(compacted_working_state(&transcript, 1, &state), 1);
        let controls = working_control(&state);
        let projected = project(&transcript, "system", &controls);
        assert!(projected[0]["content"]
            .as_str()
            .unwrap()
            .contains("src/App.tsx"));
        assert!(projected[0]["content"]
            .as_str()
            .unwrap()
            .contains("landing flow"));
        assert!(projected[0]["content"]
            .as_str()
            .unwrap()
            .contains("complete_for_task"));
    }

    #[test]
    fn complete_evidence_reuses_memory_but_targeted_reads_remain_available() {
        let mut state = AgentState::default();
        let args = json!({"path":"src/pixels.ts"});
        let output = json!({"content":"export const purchase = () => redirectAfter(250);"});
        assert!(record_tool_evidence(
            &mut state,
            "read_file",
            &args,
            &output
        ));
        assert!(
            !state
                .prior_investigation("read_file", "src/pixels.ts")
                .unwrap()
                .evidence_complete
        );
        state.checkpoint_source_evidence(&json!([{"path":"src/pixels.ts","facts":["redirects after 250ms"],"relevance":["conversion flow"],"unresolved":[],"complete_for_task":true}]));
        assert!(
            state
                .prior_investigation("read_file", "src/pixels.ts")
                .unwrap()
                .evidence_complete
        );
        assert!(
            !state
                .prior_investigation("read_file", "src/pixels.ts")
                .unwrap()
                .truncated
        );
        assert!(state
            .prior_investigation("read_file", "src/pixels.ts")
            .unwrap()
            .finding
            .contains("redirectAfter"));
        assert!(!args.get("start_line").is_some());
        let targeted = json!({"path":"src/pixels.ts", "reason":"exact redirect timeout", "start_line":10, "end_line":20});
        assert!(targeted.get("reason").is_some());
        assert!(targeted.get("start_line").is_some());
    }

    #[test]
    fn only_checkpointed_facts_make_source_complete_after_compaction() {
        let mut state = AgentState::default();
        record_tool_evidence(
            &mut state,
            "read_file",
            &json!({"path":"src/App.tsx"}),
            &json!({"content":"export default function App() { return <Routes/> }"}),
        );
        assert!(
            !state
                .prior_investigation("read_file", "src/App.tsx")
                .unwrap()
                .evidence_complete
        );
        state.checkpoint_source_evidence(&json!([{"path":"src/App.tsx","facts":["uses BrowserRouter route shell","renders AppRoutes"],"relevance":["application architecture"],"unresolved":[],"complete_for_task":true}]));
        let projected = project(&Transcript::default(), "control", &working_control(&state));
        let control = projected[0]["content"].as_str().unwrap();
        assert!(control.contains("SOURCE: src/App.tsx"));
        assert!(control.contains("status: complete_for_task"));
        assert!(control.contains("uses BrowserRouter route shell"));
    }

    #[test]
    fn second_saturation_exposes_only_targeted_retrieval_capability() {
        let saturation = saturation_tools();
        let names = saturation
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["read_file", "task_plan", "task_notes"]);
        let read = saturation
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| {
                tool.pointer("/function/name").and_then(Value::as_str) == Some("read_file")
            })
            .unwrap();
        assert_eq!(
            read.pointer("/function/parameters/required").unwrap(),
            &json!(["path", "reason", "start_line", "end_line"])
        );
    }

    #[test]
    fn second_saturation_keeps_plan_and_notes_closeout_calls_executable() {
        let state = AgentState {
            saturation_round: 2,
            ..AgentState::default()
        };
        for name in ["task_plan", "task_notes"] {
            assert!(
                !rejects_saturated_tool(
                    &state,
                    &ValidatedCall {
                        id: name.into(),
                        name: name.into(),
                        arguments: json!({}),
                    },
                ),
                "{name} must be the sanctioned closeout path"
            );
        }
        assert!(rejects_saturated_tool(
            &state,
            &ValidatedCall {
                id: "broad".into(),
                name: "list_directory".into(),
                arguments: json!({"path":"src"}),
            },
        ));
        assert!(!rejects_saturated_tool(
            &state,
            &ValidatedCall {
                id: "focused".into(),
                name: "read_file".into(),
                arguments: json!({"path":"src/App.tsx","reason":"exact route order","start_line":10,"end_line":20}),
            },
        ));
    }

    #[test]
    fn second_saturation_enters_synthesis_and_terminal_plan_enters_finalization() {
        let mut state = AgentState {
            saturation_round: 2,
            ..AgentState::default()
        };
        state
            .plan
            .init(vec![crate::agent::todo::Phase {
                name: "Analysis".into(),
                tasks: vec![crate::agent::todo::Item {
                    content: "write audit".into(),
                    status: crate::agent::todo::Status::Pending,
                }],
            }])
            .unwrap();
        assert_eq!(phase_for(&state, true, 8), "synthesis");
        state.plan.finish("write audit", false).unwrap();
        assert_eq!(phase_for(&state, true, 9), "final");
    }

    #[test]
    fn compaction_hysteresis_targets_below_trigger() {
        assert!(compaction_target(32_768) < compaction_threshold(32_768));
        assert!(compaction_target(32_768) < max_projected_input(32_768));
    }

    #[test]
    fn accepts_reasoning_aliases_from_openai_compatible_sse() {
        let mut buffer =
            "data: {\"choices\":[{\"delta\":{\"reasoning\":\"inspect\"}}]}\n\n".to_owned();
        let mut streamed = StreamedTurn::default();
        consume_sse(&mut buffer, &mut streamed, "test").unwrap();
        assert!(streamed.thinking_started);
        assert_eq!(streamed.reasoning_delta_count, 1);
        assert_eq!(streamed.reasoning, "inspect");
    }
}
