use serde::Serialize;
use serde_json::Value;

/// One structural retained-tail candidate considered during a single
/// compaction. It is accounting only; transcript content never crosses this
/// protocol boundary.
#[derive(Clone, Debug, Serialize)]
pub struct TailCandidateAttempt {
    pub message_count: usize,
    pub estimated_tokens: usize,
    pub projected_request_tokens: usize,
    pub fits: bool,
}

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
    /// A completed research turn's visible narration. Electron places this
    /// in the timeline, never in the final-answer accumulator.
    AgentStatus {
        content: String,
    },
    ToolCallStarted {
        id: String,
        name: String,
        arguments: Value,
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
    TaskMemoryUpdate {
        memory: Value,
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
        /// Provider-reported prompt/KV cache read tokens. Absent means the
        /// provider did not report this metric; it is never inferred.
        cached_tokens: Option<u64>,
        /// Provider-reported prompt/KV cache write tokens.
        cache_write_tokens: Option<u64>,
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
    },
    /// Safe compaction accounting for benchmark forensics. It contains sizes,
    /// structure, and stable planning IDs only; never transcript text.
    CompactionDiagnostics {
        compaction_index: usize,
        trigger_reason: String,
        context_window: usize,
        projected_input_before: usize,
        projected_input_after: usize,
        stable_prefix_tokens: usize,
        tool_schema_tokens: usize,
        transcript_tokens_before: usize,
        summary_prompt_tokens: usize,
        runtime_tail_tokens: usize,
        memory_catalog_tokens: usize,
        compaction_target_tokens: usize,
        preferred_output_tokens: usize,
        available_output_before: usize,
        available_output_after: usize,
        selected_max_output_tokens: usize,
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
        emergency_tool_result_truncation: bool,
        emergency_tool_result_original_tokens: Option<usize>,
        emergency_tool_result_original_chars: Option<usize>,
        emergency_tool_result_projected_tokens: Option<usize>,
        emergency_tool_result_projected_chars: Option<usize>,
        emergency_tool_result_source: Option<String>,
    },
    /// Observability only: compaction occurred soon after a prior compaction.
    RapidRecompaction {
        previous_after_tokens: usize,
        current_before_tokens: usize,
        new_turns: usize,
        new_tool_result_tokens: usize,
    },
    /// Project-local virtual-context cache diagnostics. Content is deliberately
    /// excluded; this is for the context/debug surface only.
    KnowledgeCache {
        exists: bool,
        manifest_version: Option<u32>,
        total_files: usize,
        approximate_bytes: u64,
        knowledge_reads: usize,
        knowledge_writes: usize,
        cache_hits: usize,
        stale_source_entries: usize,
        bytes_injected: usize,
    },
    ApprovalRequired {
        id: String,
        category: String,
        detail: String,
    },
    Final {
        complete: bool,
        continuation_count: usize,
        chars: usize,
        finish_reason: String,
    },
    /// Diagnostics-only lifecycle marker. The UI receives all chunks through
    /// the same `content_delta` stream as the original response.
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
