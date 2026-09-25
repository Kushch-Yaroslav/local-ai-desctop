use super::todo::TaskPlan;
use std::collections::BTreeMap;

/// A compact, runtime-owned record of evidence gathered during this run. It is
/// not a second transcript: canonical tool turns remain the source of truth.
/// This working state is projected through compaction so an investigation does
/// not start over merely because old raw file output left the request.
#[derive(Clone, Debug, Default)]
pub struct InvestigatedItem {
    pub kind: String,
    pub path: String,
    pub finding: String,
    pub reads: usize,
    pub truncated: bool,
    /// Concise, model-authored facts retained independently of raw tool text.
    /// Raw excerpts are only a partial fallback and never make evidence complete.
    pub facts: Vec<String>,
    pub relevance: Vec<String>,
    pub unresolved: Vec<String>,
    /// `true` means a Notes checkpoint established sufficient task-specific
    /// facts. A successful physical read alone is intentionally only partial.
    pub evidence_complete: bool,
}

#[derive(Default)]
pub struct AgentState {
    pub notes: String,
    pub plan: TaskPlan,
    pub cancelled: bool,
    pub investigated: BTreeMap<String, InvestigatedItem>,
    pub consecutive_repeated_exploration: usize,
    pub synthesis_nudged: bool,
    pub saturation_round: usize,
    /// Evidence revisions are deliberately separate from the transcript. They
    /// let the loop request a concise, model-authored Task Notes checkpoint at
    /// useful boundaries without persisting private reasoning.
    pub evidence_revision: usize,
    pub noted_evidence_revision: usize,
    pub plan_checkpoint_evidence_revision: usize,
    pub post_saturation_retrievals: usize,
    pub resolved_missing_facts: Vec<String>,
}

impl AgentState {
    pub fn record_investigation(
        &mut self,
        kind: &str,
        path: String,
        finding: String,
        truncated: bool,
    ) -> bool {
        let key = format!("{kind}:{path}");
        let entry = self
            .investigated
            .entry(key)
            .or_insert_with(|| InvestigatedItem {
                kind: kind.to_owned(),
                path,
                finding: finding.clone(),
                reads: 0,
                truncated,
                facts: Vec::new(),
                relevance: Vec::new(),
                unresolved: Vec::new(),
                evidence_complete: false,
            });
        entry.reads += 1;
        let changed = entry.finding != finding || entry.truncated != truncated;
        if changed {
            entry.finding = finding;
            entry.truncated = truncated;
        }
        if entry.reads == 1 || changed {
            self.evidence_revision += 1;
            self.consecutive_repeated_exploration = 0;
            true
        } else {
            self.consecutive_repeated_exploration += 1;
            false
        }
    }

    pub fn investigated_summary(&self) -> Vec<String> {
        self.investigated
            .values()
            .map(|item| {
                format!("SOURCE: {}\nstatus: {}\nphysical_reads: {}\nfacts: {}\nrelevance: {}\nunresolved: {}\npartial_excerpt: {}",
                    item.path,
                    if item.evidence_complete { "complete_for_task" } else { "partial" },
                    item.reads,
                    if item.facts.is_empty() { "(no model-authored facts checkpointed yet)".into() } else { item.facts.join(" | ") },
                    if item.relevance.is_empty() { "(not classified)".into() } else { item.relevance.join(" | ") },
                    if item.unresolved.is_empty() { "none".into() } else { item.unresolved.join(" | ") },
                    item.finding)
            })
            .collect()
    }

    /// A projection budget, not data loss: canonical investigated evidence is
    /// retained in runtime state. Context handoffs need representative facts,
    /// not an unbounded copy of every file excerpt.
    pub fn investigated_summary_bounded(&self, max_items: usize, max_chars: usize) -> Vec<String> {
        self.investigated_summary()
            .into_iter()
            .take(max_items)
            .map(|entry| {
                let clipped = entry.chars().take(max_chars).collect::<String>();
                if entry.chars().count() > max_chars {
                    format!("{clipped} …")
                } else {
                    clipped
                }
            })
            .collect()
    }

    pub fn prior_investigation(&self, kind: &str, path: &str) -> Option<&InvestigatedItem> {
        self.investigated.get(&format!("{kind}:{path}"))
    }

    pub fn notes_checkpoint_due(&self) -> bool {
        self.evidence_revision > self.noted_evidence_revision
    }

    pub fn uncheckpointed_evidence_count(&self) -> usize {
        self.evidence_revision
            .saturating_sub(self.noted_evidence_revision)
    }

    pub fn checkpoint_notes(&mut self) {
        self.noted_evidence_revision = self.evidence_revision;
    }

    /// Promote only evidence explicitly checkpointed by the model. This avoids
    /// the old contradiction: `evidence_complete=true` paired with a shallow
    /// first-source excerpt that cannot support the current audit.
    pub fn checkpoint_source_evidence(&mut self, evidence: &serde_json::Value) {
        let Some(items) = evidence.as_array() else {
            return;
        };
        for item in items {
            let Some(path) = item.get("path").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let facts = item
                .get("facts")
                .and_then(serde_json::Value::as_array)
                .map(|xs| {
                    xs.iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if facts.is_empty() {
                continue;
            }
            for investigated in self
                .investigated
                .values_mut()
                .filter(|known| known.path == path)
            {
                investigated.facts = facts.clone();
                investigated.relevance = item
                    .get("relevance")
                    .and_then(serde_json::Value::as_array)
                    .map(|xs| {
                        xs.iter()
                            .filter_map(serde_json::Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                investigated.unresolved = item
                    .get("unresolved")
                    .and_then(serde_json::Value::as_array)
                    .map(|xs| {
                        xs.iter()
                            .filter_map(serde_json::Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                investigated.evidence_complete = item
                    .get("complete_for_task")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                    && investigated.unresolved.is_empty();
            }
        }
    }

    pub fn mark_plan_checkpoint(&mut self) {
        self.plan_checkpoint_evidence_revision = self.evidence_revision;
    }

    pub fn plan_checkpoint_due(&self) -> bool {
        self.plan.has_open()
            && self
                .evidence_revision
                .saturating_sub(self.plan_checkpoint_evidence_revision)
                >= 3
    }

    /// Notes are a bounded snapshot of durable evidence, not an overwrite of
    /// everything the model learned earlier. Preserve distinct factual lines
    /// while allowing the model to supersede a repeated snapshot.
    pub fn merge_notes(&mut self, update: &str) -> bool {
        let mut lines = Vec::new();
        for text in [self.notes.as_str(), update] {
            for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
                if !lines
                    .iter()
                    .any(|known: &String| known.eq_ignore_ascii_case(line))
                {
                    lines.push(line.to_owned());
                }
            }
        }
        let merged = lines.join("\n");
        let bounded = if merged.chars().count() > 6_000 {
            merged.chars().take(6_000).collect::<String>()
        } else {
            merged
        };
        let changed = bounded != self.notes;
        self.notes = bounded;
        changed
    }

    pub fn invalidate_path(&mut self, path: &str) {
        self.investigated.retain(|_, item| item.path != path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notes_merge_retains_prior_distinct_facts_and_deduplicates_snapshots() {
        let mut state = AgentState::default();
        assert!(state.merge_notes("App.tsx: router shell\nBusiness: paid acquisition"));
        assert!(state.merge_notes("Business: paid acquisition\nmain.tsx: provider bootstrap"));
        assert!(state.notes.contains("App.tsx"));
        assert!(state.notes.contains("main.tsx"));
        assert!(!state.merge_notes("Business: paid acquisition"));
    }
}
