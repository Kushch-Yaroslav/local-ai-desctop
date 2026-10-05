//! Lightweight runtime bookkeeping.
//!
//! This deliberately contains no evidence ontology, completion proof, source
//! inventory, saturation counter, or semantic no-progress state. The model's
//! transcript and durable task memory are the agent's working state.

use super::strategy::Strategy;
use super::task_memory::TaskMemory;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default)]
pub struct AgentState {
    /// Durable semantic findings for the current task. This is not a plan.
    pub task_memory: TaskMemory,
    pub workspace_mutated_since_validation: bool,
    /// Count of successful project mutations, used to refresh derived views.
    pub mutations: usize,
    pub verification_nudged: bool,
    /// The single reminder about unopened requested local files was already
    /// given for this run; it never repeats.
    pub request_review_given: bool,
    /// Investigation strategy selected by the run's Agent mode.
    pub strategy: Strategy,
    /// Tool calls since Task Memory was last written (Deep checkpoint cadence).
    pub calls_since_memory: usize,
    /// Task Memory writes accepted in the current provider turn.
    pub memory_writes_this_turn: usize,
    /// The single convergence review for unresolved Task Memory items was
    /// already given for this run; it never repeats.
    pub convergence_review_given: bool,
    /// Reviews already given for recorded deliverables that were still
    /// unfinished when the model tried to end the run. Bounded per mode, so a
    /// review can never deadlock a final answer.
    pub deliverable_reviews: usize,
    /// Zero-based provider turn currently being prepared, for budget notices.
    pub turn: usize,
    /// Project files this run created and has not deleted since, so scratch
    /// files stay visible instead of being forgotten.
    pub created_files: Vec<String>,
    /// Observability for optional `.ai-framework` virtual context access.
    pub knowledge_reads: usize,
    pub knowledge_writes: usize,
    pub knowledge_cache_hits: usize,
    pub knowledge_missing_paths: BTreeMap<String, u64>,
    /// Graceful pause lifecycle (`None` while the run is simply running).
    pub pause: Option<PauseState>,
    /// A steering message was applied this turn, so the model may classify it
    /// as a pause request by calling `pause_run`.
    pub pause_offered: bool,
}

/// Bounded checkpoint that follows a pause request. Tools other than the
/// checkpoint tools are withdrawn, runtime guidance that would resume work is
/// suppressed, and the run ends with a short summary instead of completing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PauseState {
    pub checkpoint_turns_left: usize,
}

impl PauseState {
    pub const CHECKPOINT_TURNS: usize = 3;
}

impl AgentState {
    pub fn record_mutation(&mut self) {
        self.mutations = self.mutations.saturating_add(1);
        self.workspace_mutated_since_validation = true;
        self.verification_nudged = false;
    }

    pub fn record_created_file(&mut self, path: &str) {
        const LIMIT: usize = 64;
        if path.is_empty() || self.created_files.iter().any(|known| known == path) {
            return;
        }
        if self.created_files.len() >= LIMIT {
            self.created_files.remove(0);
        }
        self.created_files.push(path.to_owned());
    }

    pub fn record_deleted_file(&mut self, path: &str) {
        self.created_files.retain(|known| known != path);
    }

    pub fn record_tool_call(&mut self, tool: &str) {
        if tool != "task_memory" && tool != "deliverables" {
            self.calls_since_memory = self.calls_since_memory.saturating_add(1);
        }
    }

    pub fn record_validation(&mut self) {
        self.workspace_mutated_since_validation = false;
    }

    pub fn record_knowledge_read(&mut self) {
        self.knowledge_reads = self.knowledge_reads.saturating_add(1);
        self.knowledge_cache_hits = self.knowledge_cache_hits.saturating_add(1);
    }

    pub fn record_knowledge_write(&mut self) {
        self.knowledge_writes = self.knowledge_writes.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_call_alone_does_not_reset_write_cadence() {
        let mut state = AgentState::default();
        state.record_tool_call("read_file");
        state.record_tool_call("list_directory");
        assert_eq!(state.calls_since_memory, 2);
        state.record_tool_call("task_memory");
        assert_eq!(state.calls_since_memory, 2);
    }

    #[test]
    fn bookkeeping_tools_are_not_work_calls() {
        let mut state = AgentState::default();
        state.record_tool_call("deliverables");
        state.record_tool_call("task_memory");
        assert_eq!(state.calls_since_memory, 0);
    }

    #[test]
    fn created_files_are_listed_once_and_forgotten_when_deleted() {
        let mut state = AgentState::default();
        state.record_created_file("a.js");
        state.record_created_file("a.js");
        state.record_created_file("b.js");
        assert_eq!(state.created_files, ["a.js", "b.js"]);
        state.record_deleted_file("a.js");
        assert_eq!(state.created_files, ["b.js"]);
        for index in 0..100 {
            state.record_created_file(&format!("f{index}.js"));
        }
        assert_eq!(state.created_files.len(), 64);
        assert_eq!(state.created_files.last().unwrap(), "f99.js");
    }

    #[test]
    fn validation_only_tracks_the_latest_mutation() {
        let mut state = AgentState::default();
        state.record_mutation();
        assert!(state.workspace_mutated_since_validation);
        state.record_validation();
        assert!(!state.workspace_mutated_since_validation);
        state.record_mutation();
        assert!(state.workspace_mutated_since_validation);
    }
}
