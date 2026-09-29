//! Lightweight runtime bookkeeping.
//!
//! This deliberately contains no evidence ontology, completion proof, source
//! inventory, saturation counter, or semantic no-progress state. The model's
//! transcript and durable task memory are the agent's working state.

use super::task_memory::TaskMemory;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default)]
pub struct AgentState {
    /// Durable semantic findings for the current task. This is not a plan.
    pub task_memory: TaskMemory,
    pub workspace_mutated_since_validation: bool,
    pub closeout_nudged: bool,
    pub verification_nudged: bool,
    /// Observability for optional `.ai-framework` virtual context access.
    pub knowledge_reads: usize,
    pub knowledge_writes: usize,
    pub knowledge_cache_hits: usize,
    pub knowledge_missing_paths: BTreeMap<String, u64>,
}

impl AgentState {
    pub fn record_mutation(&mut self) {
        self.workspace_mutated_since_validation = true;
        self.verification_nudged = false;
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
