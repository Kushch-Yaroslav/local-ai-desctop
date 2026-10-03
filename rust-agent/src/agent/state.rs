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
    /// Observability for optional `.ai-framework` virtual context access.
    pub knowledge_reads: usize,
    pub knowledge_writes: usize,
    pub knowledge_cache_hits: usize,
    pub knowledge_missing_paths: BTreeMap<String, u64>,
}

impl AgentState {
    pub fn record_mutation(&mut self) {
        self.mutations = self.mutations.saturating_add(1);
        self.workspace_mutated_since_validation = true;
        self.verification_nudged = false;
    }

    pub fn record_tool_call(&mut self, tool: &str) {
        if tool == "task_memory" {
            self.calls_since_memory = 0;
        } else {
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
    fn memory_cadence_resets_on_task_memory_only() {
        let mut state = AgentState::default();
        state.record_tool_call("read_file");
        state.record_tool_call("list_directory");
        assert_eq!(state.calls_since_memory, 2);
        state.record_tool_call("task_memory");
        assert_eq!(state.calls_since_memory, 0);
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
