use serde::Serialize;
use serde_json::Value;

/// Stable NDJSON protocol consumed by Electron main. Unknown event types are
/// intentionally ignorable, so the protocol can grow without breaking UI.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    AgentStarted {
        run_id: String,
    },
    TurnStarted {
        index: usize,
    },
    /// Debug-safe request shape emitted immediately before every upstream call.
    /// It deliberately contains roles and indices only, never conversation text.
    RequestShape {
        turn: usize,
        message_count: usize,
        roles: Vec<String>,
        current_user_index: Option<usize>,
        system_first: bool,
        /// Safe, indexed wire-shape diagnostics. Content is intentionally
        /// excluded; tool ids and names are retained to prove pairing.
        entries: Vec<String>,
        compaction_boundary: Option<usize>,
    },
    /// Safe request-policy diagnostics. This proves the exact reasoning and
    /// tool-choice contract sent to the provider without logging prompts.
    RequestPolicy {
        turn: usize,
        phase: String,
        reasoning_effort: String,
        tool_choice: Value,
        tools: Vec<String>,
        max_tokens: usize,
        context_limit: usize,
        projected_input_tokens: usize,
        reserved_output_tokens: usize,
    },
    RunState {
        state: String,
    },
    ThinkingStarted,
    ThinkingDelta {
        content: String,
    },
    ThinkingFinished,
    /// Per-turn transport diagnostics: distinguishes a provider that produced
    /// no reasoning from a renderer/bridge projection failure.
    TurnReasoning {
        turn: usize,
        started: bool,
        delta_count: usize,
        chars: usize,
    },
    ContentDelta {
        content: String,
    },
    ToolCallStarted {
        id: String,
        name: String,
        arguments: Value,
    },
    ToolCallDelta {
        id: String,
        delta: String,
    },
    ToolCall {
        id: String,
        name: String,
    },
    ToolOutputDelta {
        id: String,
        stream: String,
        content: String,
    },
    /// Emitted synchronously after spawn, before any stdout/stderr. It gives
    /// the Electron persistence layer a durable identity for interrupted runs.
    ToolProcessStarted {
        id: String,
        command: String,
        cwd: String,
        pid: u32,
        pgid: u32,
        session_id: u32,
        started_at: u128,
    },
    ToolResult {
        id: String,
        name: String,
        content: String,
        is_error: bool,
        diff: Option<String>,
    },
    ToolError {
        id: String,
        name: String,
        message: String,
    },
    PlanUpdate {
        plan: Value,
    },
    TaskNoteUpdate {
        notes: String,
    },
    VerificationUpdate {
        status: String,
        detail: String,
    },
    ContextStats {
        used: usize,
        limit: usize,
    },
    /// Normalized provider usage for one completed streamed model turn. This
    /// mirrors Jan's `TurnUsage` boundary: display clients accumulate real
    /// backend counters rather than infer speed from renderer updates.
    TurnUsage {
        prompt_tokens: Option<u64>,
        completion_tokens: Option<u64>,
        total_tokens: Option<u64>,
        prompt_ms: Option<f64>,
        predicted_ms: Option<f64>,
        predicted_per_second: Option<f64>,
        finish_reason: String,
    },
    ContextOptimized {
        before: usize,
        after: usize,
        trigger_reason: String,
        removed_transcript_tokens: usize,
        retained_suffix_tokens: usize,
        working_state_tokens: usize,
        plan_tokens: usize,
        notes_tokens: usize,
        evidence_tokens: usize,
    },
    ApprovalRequired {
        id: String,
        category: String,
        detail: String,
    },
    FinalStarted,
    FinalDelta {
        content: String,
    },
    Final {
        content: String,
        complete: bool,
        continuation_count: usize,
        chars: usize,
        finish_reason: String,
    },
    /// Diagnostics-only lifecycle marker. The UI receives all chunks through
    /// one logical final response via `final_delta`.
    FinalContinuation {
        continuation: usize,
        prior_chars: usize,
        finish_reason: String,
        next_max_tokens: usize,
    },
    AgentStopped {
        reason: String,
    },
    AgentError {
        code: String,
        message: String,
    },
}
