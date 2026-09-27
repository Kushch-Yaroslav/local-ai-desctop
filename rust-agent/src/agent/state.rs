use super::todo::TaskPlan;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};

/// Structured, runtime-owned working memory for one autonomous user request.
/// It is held only by `AgentState`; nothing here is written to disk or loaded
/// into a later independent request.
#[derive(Clone, Debug, Default)]
pub struct CurrentTaskMemory {
    pub evidence: Vec<EvidenceRecord>,
    pub task_checkpoints: Vec<TaskCheckpoint>,
    pub verified_facts: Vec<VerifiedFact>,
    pub unresolved_gaps: Vec<UnresolvedGap>,
    pub hypotheses: Vec<Hypothesis>,
    pub attempted_strategies: BTreeMap<String, AttemptedStrategy>,
    pub revision: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvidenceRecord {
    pub id: String,
    pub kind: EvidenceKind,
    pub source: String,
    pub range: Option<(usize, usize)>,
    pub tool: String,
    pub result_fingerprint: u64,
    pub created_order: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum EvidenceKind {
    FileRead,
    SourceRange,
    DirectoryInventory,
    TerminalInspection,
    ProjectMutation,
    ValidationResult,
}

#[derive(Clone, Debug)]
pub struct TaskCheckpoint {
    pub task_id: String,
    pub evidence_ids: Vec<String>,
    pub findings: Vec<String>,
    pub complete: bool,
    pub unresolved: Vec<String>,
    pub revision: usize,
}

#[derive(Clone, Debug)]
pub struct VerifiedFact {
    pub id: String,
    pub statement: String,
    pub sources: Vec<SourceReference>,
    pub related_tasks: Vec<String>,
    pub revision: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceReference {
    pub path: String,
    pub range: Option<(usize, usize)>,
    pub complete_for_task: bool,
}

#[derive(Clone, Debug)]
pub struct UnresolvedGap {
    pub id: String,
    pub missing_fact: String,
    pub related_tasks: Vec<String>,
    pub attempted_sources: Vec<String>,
    pub bounded_reason: Option<String>,
    pub revision: usize,
}

#[derive(Clone, Debug)]
pub struct Hypothesis {
    pub id: String,
    pub statement: String,
    pub supporting_fact_ids: Vec<String>,
    pub status: HypothesisStatus,
    pub revision: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HypothesisStatus {
    Active,
    Invalidated,
}

#[derive(Clone, Debug)]
pub struct AttemptedStrategy {
    pub category: String,
    pub target: String,
    pub purpose: String,
    pub evidence_revision_before: usize,
    pub evidence_revision_after: usize,
    pub attempts: usize,
}

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
    /// Explicit line coverage when the read was ranged. An absent range means
    /// the source was read but no precise source span was supplied.
    pub ranges: Vec<(usize, usize)>,
    /// Concise, model-authored facts retained independently of raw tool text.
    /// Raw excerpts are only a partial fallback and never make evidence complete.
    pub facts: Vec<String>,
    pub relevance: Vec<String>,
    pub unresolved: Vec<String>,
    /// Exact Task Plan item labels that this checkpoint supports. Evidence is
    /// source-specific, but saturation must decide whether each *open task*
    /// has enough evidence; a count of complete sources cannot do that.
    pub covered_tasks: Vec<String>,
    /// `true` means a Notes checkpoint established sufficient task-specific
    /// facts. A successful physical read alone is intentionally only partial.
    pub evidence_complete: bool,
}

#[derive(Default, Debug)]
pub struct AgentState {
    pub notes: String,
    pub plan: TaskPlan,
    pub cancelled: bool,
    pub investigated: BTreeMap<String, InvestigatedItem>,
    pub memory: CurrentTaskMemory,
    pub consecutive_repeated_exploration: usize,
    pub synthesis_nudged: bool,
    /// Consecutive turns that neither produced new evidence nor changed the
    /// durable Notes/Plan state. This covers rejected calls and tool-free
    /// reasoning loops, which are not visible to the physical-read repeat
    /// counter above.
    pub consecutive_no_progress_turns: usize,
    pub no_progress_nudged: bool,
    pub saturation_round: usize,
    /// Evidence revisions are deliberately separate from the transcript. They
    /// let the loop request a concise, model-authored Task Notes checkpoint at
    /// useful boundaries without persisting private reasoning.
    pub evidence_revision: usize,
    pub noted_evidence_revision: usize,
    pub plan_checkpoint_evidence_revision: usize,
    pub post_saturation_retrievals: usize,
    pub resolved_missing_facts: Vec<String>,
    /// Line ranges already covered by a targeted saturated read, keyed by file
    /// path. A saturated re-read inside an already-covered range produces no
    /// new evidence and is rejected even while reads of *other* ranges (or of
    /// other files, or of genuinely new gaps) remain available. This decouples
    /// the anti-loop guard from the budget counter so the budget can scale
    /// honestly with unresolved work.
    pub saturated_read_ranges: BTreeMap<String, Vec<(usize, usize)>>,
    /// Gap-closeout escape valve: hard-caps repeated model no-tool closeout
    /// passes on the same run so a saturated deep audit cannot cycle through
    /// the planning handoff forever while claiming to want more evidence.
    /// Distinct from `plan_closeout_due`, which is one-shot per gap-closeout
    /// cycle and cleared by a plan mutation. This one counts *all* closeout
    /// passes since the last material evidence record. It is used only after
    /// the post-saturation focused-retrieval budget is exhausted; before that
    /// an evidence gap remains investigation, never a closeout signal. At the
    /// exhausted boundary it prevents an unresponsive model from repeating the
    /// limitation-recording handoff forever.
    pub gap_closeout_passes: usize,
}

/// Hard cap on consecutive gap-closeout valve passes without any intervening
/// evidence record (a saturated targeted read, a Notes checkpoint, or other
/// material new observation). Beyond this we finalize the run instead of
/// letting the planning handoff become an infinite loop.
pub const MAX_GAP_CLOSEOUT_PASSES: usize = 3;

impl AgentState {
    /// Record a newly-performed saturated targeted read. A range is redundant
    /// only when it is fully covered already. Partly overlapping ranges may
    /// contain the missing lines for a different fact, so merge them into the
    /// stored coverage instead of rejecting them.
    pub fn record_saturated_range(&mut self, path: &str, start: usize, end: usize) -> bool {
        let ranges = self.saturated_read_ranges.entry(path.to_owned()).or_insert_with(Vec::new);
        if ranges.iter().any(|(s, e)| *s <= start && end <= *e) {
            return false;
        }
        let mut merged_start = start;
        let mut merged_end = end;
        ranges.retain(|(known_start, known_end)| {
            if known_start.saturating_sub(1) <= merged_end
                && merged_start.saturating_sub(1) <= *known_end
            {
                merged_start = merged_start.min(*known_start);
                merged_end = merged_end.max(*known_end);
                false
            } else {
                true
            }
        });
        ranges.push((merged_start, merged_end));
        true
    }

    pub fn saturated_range_seen(&self, path: &str, start: usize, end: usize) -> bool {
        self.saturated_read_ranges
            .get(path)
            .is_some_and(|ranges| ranges.iter().any(|(s, e)| *s <= start && end <= *e))
    }

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
                ranges: Vec::new(),
                facts: Vec::new(),
                relevance: Vec::new(),
                unresolved: Vec::new(),
                covered_tasks: Vec::new(),
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
            self.record_progress();
            true
        } else {
            self.consecutive_repeated_exploration += 1;
            false
        }
    }

    pub fn record_progress(&mut self) {
        self.consecutive_no_progress_turns = 0;
        self.no_progress_nudged = false;
    }

    pub fn record_source_range(&mut self, kind: &str, path: &str, range: Option<(usize, usize)>) {
        let Some((start, end)) = range else {
            return;
        };
        let Some(item) = self.investigated.get_mut(&format!("{kind}:{path}")) else {
            return;
        };
        if !item.ranges.iter().any(|known| *known == (start, end)) {
            item.ranges.push((start, end));
        }
    }

    pub fn record_no_progress_turn(&mut self) {
        self.consecutive_no_progress_turns += 1;
    }

    pub fn record_evidence(
        &mut self,
        kind: EvidenceKind,
        source: String,
        range: Option<(usize, usize)>,
        tool: &str,
        result: &str,
    ) -> String {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        (kind.clone(), &source, range, tool, result).hash(&mut hasher);
        let fingerprint = hasher.finish();
        if let Some(existing) = self.memory.evidence.iter().find(|record| {
            record.kind == kind
                && record.source == source
                && record.range == range
                && record.tool == tool
                && record.result_fingerprint == fingerprint
        }) {
            return existing.id.clone();
        }
        let id = format!("ev-{}", self.memory.evidence.len() + 1);
        self.memory.evidence.push(EvidenceRecord {
            id: id.clone(),
            kind,
            source,
            range,
            tool: tool.to_owned(),
            result_fingerprint: fingerprint,
            created_order: self.memory.evidence.len() + 1,
        });
        self.memory.revision += 1;
        id
    }

    pub fn checkpoint_task(
        &mut self,
        task_ref: &str,
        evidence_ids: &[String],
        findings: &[String],
        complete: bool,
        unresolved: &[String],
    ) -> Result<(), String> {
        let task = self.plan.item_by_ref(task_ref).ok_or_else(|| format!("unknown Task Plan task '{task_ref}'"))?;
        let task_id = task.id.clone();
        if evidence_ids.is_empty() {
            return Err(format!("Task checkpoint for {task_id} requires at least one evidence id"));
        }
        if findings.iter().all(|finding| finding.trim().is_empty()) && unresolved.iter().all(|gap| gap.trim().is_empty()) {
            return Err(format!("Task checkpoint for {task_id} requires a finding or unresolved gap"));
        }
        let records = evidence_ids
            .iter()
            .map(|id| self.memory.evidence.iter().find(|record| &record.id == id).cloned().ok_or_else(|| format!("unknown evidence id '{id}'")))
            .collect::<Result<Vec<_>, _>>()?;
        let mut next_plan = self.plan.clone();
        if complete {
            next_plan.finish(&task_id, false)?;
        }
        let mut next = self.memory.clone();
        next.revision += 1;
        let revision = next.revision;
        let checkpoint = TaskCheckpoint {
            task_id: task_id.clone(),
            evidence_ids: evidence_ids.to_vec(),
            findings: findings.iter().filter(|finding| !finding.trim().is_empty()).cloned().collect(),
            complete,
            unresolved: unresolved.iter().filter(|gap| !gap.trim().is_empty()).cloned().collect(),
            revision,
        };
        next.task_checkpoints.retain(|known| known.task_id != task_id);
        next.task_checkpoints.push(checkpoint.clone());
        for finding in &checkpoint.findings {
            let sources = records.iter().map(|record| SourceReference {
                path: record.source.clone(),
                range: record.range,
                complete_for_task: complete,
            }).collect::<Vec<_>>();
            upsert_fact_in_memory(&mut next, finding, sources, vec![task_id.clone()]);
        }
        for gap in &checkpoint.unresolved {
            upsert_gap_in_memory(&mut next, gap, vec![task_id.clone()], records.iter().map(|record| record.source.clone()).collect());
        }
        self.memory = next;
        self.plan = next_plan;
        self.record_progress();
        Ok(())
    }

    pub fn has_complete_checkpoint_for(&self, task_ref: &str) -> bool {
        self.plan.item_by_ref(task_ref).is_some_and(|task| {
            self.memory.task_checkpoints.iter().any(|checkpoint| checkpoint.task_id == task.id && checkpoint.complete && !checkpoint.findings.is_empty())
        })
    }

    pub fn has_bounded_checkpoint_for(&self, task_ref: &str) -> bool {
        self.plan.item_by_ref(task_ref).is_some_and(|task| {
            self.memory.task_checkpoints.iter().any(|checkpoint| checkpoint.task_id == task.id && !checkpoint.unresolved.is_empty())
        })
    }

    pub fn checkpoint_guidance(&self, task_ref: &str) -> String {
        let task = self.plan.item_by_ref(task_ref);
        let task_id = task.map(|task| task.id.as_str()).unwrap_or(task_ref);
        let evidence = self.memory.evidence.iter().rev().take(8).map(|record| format!("{} {}", record.id, record.source)).collect::<Vec<_>>().join(", ");
        format!("Cannot complete {task_id}: no valid task checkpoint references source evidence yet. Create task_checkpoint with task_id '{task_id}', relevant evidence_ids, and concise findings. Available recent evidence: {}. Do not retrieve more files unless a factual gap remains.", if evidence.is_empty() { "(none)" } else { &evidence })
    }

    pub fn open_count(&self) -> usize {
        self.plan.open_count()
    }

    /// Open plan items still need durable, `complete_for_task` evidence before
    /// the audit may be synthesized. Evidence must name the item it supports;
    /// unrelated complete sources cannot satisfy an arbitrary plan task.
    pub fn open_without_complete_evidence(&self) -> usize {
        self
            .plan
            .phases
            .iter()
            .flat_map(|phase| phase.tasks.iter())
            .filter(|task| matches!(task.status, super::todo::Status::Pending | super::todo::Status::InProgress))
            .filter(|task| !self.has_complete_checkpoint_for(&task.id))
            .count()
    }

    /// `done` is only honest when a checkpoint names the exact Task Plan item.
    /// Keep this query beside `open_without_complete_evidence` so closeout
    /// policy uses the same per-task evidence model as phase selection.
    pub fn has_complete_evidence_for(&self, task: &str) -> bool {
        self.has_complete_checkpoint_for(task)
    }

    /// A dropped item remains an honest closeout only when durable evidence
    /// records the task-specific fact that could not be verified. This is not
    /// complete evidence; it authorizes a bounded limitation in the final
    /// response instead of silently treating a global coverage count as proof.
    pub fn has_bounded_gap_for(&self, task: &str) -> bool {
        self.has_bounded_checkpoint_for(task)
    }

    pub fn investigated_summary(&self) -> Vec<String> {
        self.investigated
            .values()
            .map(|item| {
                format!("SOURCE: {}\nstatus: {}\ncovered_tasks: {}\nphysical_reads: {}\nranges: {}\nfacts: {}\nrelevance: {}\nunresolved: {}\npartial_excerpt: {}",
                    item.path,
                    if item.evidence_complete { "complete_for_task" } else { "partial" },
                    if item.covered_tasks.is_empty() { "(no Task Plan item checkpointed)".into() } else { item.covered_tasks.join(" | ") },
                    item.reads,
                    if item.ranges.is_empty() { "(no precise range)".into() } else { item.ranges.iter().map(|(start,end)| format!("{start}..{end}")).collect::<Vec<_>>().join(" | ") },
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
        let mut items = self.investigated.values().collect::<Vec<_>>();
        // Completed, model-checkpointed evidence is durable working memory.
        // Do not let path ordering evict it merely because later source paths
        // sort after earlier broad exploration output.
        items.sort_by(|left, right| {
            right
                .evidence_complete
                .cmp(&left.evidence_complete)
                .then_with(|| (!right.facts.is_empty()).cmp(&(!left.facts.is_empty())))
                .then_with(|| left.path.cmp(&right.path))
        });
        items
            .into_iter()
            .map(|item| {
                format!("SOURCE: {}\nstatus: {}\ncovered_tasks: {}\nphysical_reads: {}\nranges: {}\nfacts: {}\nrelevance: {}\nunresolved: {}\npartial_excerpt: {}",
                    item.path,
                    if item.evidence_complete { "complete_for_task" } else { "partial" },
                    if item.covered_tasks.is_empty() { "(no Task Plan item checkpointed)".into() } else { item.covered_tasks.join(" | ") },
                    item.reads,
                    if item.ranges.is_empty() { "(no precise range)".into() } else { item.ranges.iter().map(|(start,end)| format!("{start}..{end}")).collect::<Vec<_>>().join(" | ") },
                    if item.facts.is_empty() { "(no model-authored facts checkpointed yet)".into() } else { item.facts.join(" | ") },
                    if item.relevance.is_empty() { "(not classified)".into() } else { item.relevance.join(" | ") },
                    if item.unresolved.is_empty() { "none".into() } else { item.unresolved.join(" | ") },
                    item.finding)
            })
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

    /// Physical reads establish one durable fact even before the model writes
    /// a richer checkpoint: the source existed and was successfully read in
    /// this request. Keep this compact inventory outside the excerpt budget so
    /// compaction cannot turn a verified `public/api.php` into "not visible".
    pub fn verified_source_inventory(&self, max_chars: usize) -> String {
        let mut paths = self
            .investigated
            .values()
            .filter(|item| item.reads > 0)
            .map(|item| item.path.as_str())
            .collect::<Vec<_>>();
        paths.sort_unstable();
        paths.dedup();
        clip_paths(paths, max_chars)
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

    fn upsert_verified_fact(&mut self, statement: &str, source: SourceReference, tasks: &[String]) -> bool {
        let statement = statement.trim();
        if statement.is_empty() {
            return false;
        }
        if let Some(fact) = self.memory.verified_facts.iter_mut().find(|fact| {
            fact.statement.eq_ignore_ascii_case(statement)
        }) {
            let mut changed = false;
            if !fact.sources.contains(&source) {
                fact.sources.push(source);
                changed = true;
            }
            for task in tasks {
                if !fact.related_tasks.iter().any(|known| known == task) {
                    fact.related_tasks.push(task.clone());
                    changed = true;
                }
            }
            if changed {
                self.memory.revision += 1;
                fact.revision = self.memory.revision;
            }
            return changed;
        }
        self.memory.revision += 1;
        let revision = self.memory.revision;
        self.memory.verified_facts.push(VerifiedFact {
            id: format!("fact-{revision}"),
            statement: statement.to_owned(),
            sources: vec![source],
            related_tasks: tasks.to_vec(),
            revision,
        });
        true
    }

    fn upsert_gap(
        &mut self,
        missing_fact: &str,
        tasks: &[String],
        source: &str,
        bounded_reason: Option<String>,
    ) -> bool {
        let missing_fact = missing_fact.trim();
        if missing_fact.is_empty() {
            return false;
        }
        if let Some(gap) = self.memory.unresolved_gaps.iter_mut().find(|gap| {
            gap.missing_fact.eq_ignore_ascii_case(missing_fact)
        }) {
            let mut changed = false;
            for task in tasks {
                if !gap.related_tasks.iter().any(|known| known == task) {
                    gap.related_tasks.push(task.clone());
                    changed = true;
                }
            }
            if !source.is_empty() && !gap.attempted_sources.iter().any(|known| known == source) {
                gap.attempted_sources.push(source.to_owned());
                changed = true;
            }
            if bounded_reason.is_some() && gap.bounded_reason != bounded_reason {
                gap.bounded_reason = bounded_reason;
                changed = true;
            }
            if changed {
                self.memory.revision += 1;
                gap.revision = self.memory.revision;
            }
            return changed;
        }
        self.memory.revision += 1;
        let revision = self.memory.revision;
        self.memory.unresolved_gaps.push(UnresolvedGap {
            id: format!("gap-{revision}"),
            missing_fact: missing_fact.to_owned(),
            related_tasks: tasks.to_vec(),
            attempted_sources: (!source.is_empty()).then(|| source.to_owned()).into_iter().collect(),
            bounded_reason,
            revision,
        });
        true
    }

    /// Promote only evidence explicitly checkpointed by the model. This avoids
    /// the old contradiction: `evidence_complete=true` paired with a shallow
    /// first-source excerpt that cannot support the current audit.
    pub fn checkpoint_source_evidence(&mut self, evidence: &serde_json::Value) -> bool {
        let Some(items) = evidence.as_array() else {
            return false;
        };
        let mut changed = false;
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
            let relevance: Vec<String> = item
                .get("relevance")
                .and_then(serde_json::Value::as_array)
                .map(|xs| {
                    xs.iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let unresolved: Vec<String> = item
                .get("unresolved")
                .and_then(serde_json::Value::as_array)
                .map(|xs| {
                    xs.iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let covered_tasks: Vec<String> = item
                .get("tasks")
                .and_then(serde_json::Value::as_array)
                .map(|xs| {
                    xs.iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let complete = item
                .get("complete_for_task")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
                && unresolved.is_empty();
            let bounded_reason = item
                .get("bounded_reason")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            for investigated in self
                .investigated
                .values_mut()
                .filter(|known| known.path == path)
            {
                changed |= investigated.facts != facts
                    || investigated.relevance != relevance
                    || investigated.unresolved != unresolved
                    || investigated.covered_tasks != covered_tasks
                    || investigated.evidence_complete != complete;
                investigated.facts = facts.clone();
                investigated.relevance = relevance.clone();
                investigated.unresolved = unresolved.clone();
                investigated.covered_tasks = covered_tasks.clone();
                investigated.evidence_complete = complete;
            }
            // Durable, model-authored facts survive even when the physical read
            // that produced them has already left the active request (compaction
            // handoff). Re-materialize the record in that case so the
            // `complete_for_task` checkpoint is not silently dropped and the
            // evidence gate never treats it as a missing fact.
            if !self.investigated.values().any(|known| known.path == path)
                && (!facts.is_empty() || !unresolved.is_empty() || complete)
            {
                self.investigated.insert(
                    path.to_owned(),
                    InvestigatedItem {
                        kind: "notes".into(),
                        path: path.to_owned(),
                        finding: facts.join("; "),
                        reads: 0,
                        truncated: false,
                        ranges: Vec::new(),
                        facts: facts.clone(),
                        relevance,
                        unresolved: unresolved.clone(),
                        covered_tasks: covered_tasks.clone(),
                        evidence_complete: complete,
                    },
                );
                self.evidence_revision += 1;
                changed = true;
            }
            let ranges = self
                .investigated
                .values()
                .find(|known| known.path == path)
                .and_then(|known| known.ranges.last().copied());
            let source = SourceReference {
                path: path.to_owned(),
                range: ranges,
                complete_for_task: complete,
            };
            let evidence_ids = self.memory.evidence.iter()
                .filter(|record| record.source == path)
                .map(|record| record.id.clone())
                .collect::<Vec<_>>();
            let task_ids = covered_tasks.iter()
                .filter_map(|task| self.plan.item_by_ref(task).map(|item| item.id.clone()))
                .collect::<Vec<_>>();
            // Compatibility input is converted to the canonical checkpoint
            // only when runtime provenance exists. It can never fabricate a
            // verified fact from a path the runtime did not observe.
            if !evidence_ids.is_empty() && !task_ids.is_empty() {
                for task_id in task_ids {
                    if self.checkpoint_task(&task_id, &evidence_ids, &facts, complete, &unresolved).is_ok() {
                        changed = true;
                    }
                }
            }
            for fact in &facts {
                if !evidence_ids.is_empty() {
                    changed |= self.upsert_verified_fact(fact, source.clone(), &task_ids_from_labels(&self.plan, &covered_tasks));
                }
            }
            for gap in &unresolved {
                if !evidence_ids.is_empty() {
                    changed |= self.upsert_gap(gap, &task_ids_from_labels(&self.plan, &covered_tasks), path, bounded_reason.clone());
                }
            }
            if complete && !covered_tasks.is_empty() {
                let before = self.memory.unresolved_gaps.len();
                self.memory.unresolved_gaps.retain(|gap| {
                    !gap.related_tasks.iter().any(|task| covered_tasks.iter().any(|covered| covered == task))
                });
                if self.memory.unresolved_gaps.len() != before {
                    self.memory.revision += 1;
                    changed = true;
                }
            }
        }
        if changed {
            self.record_progress();
        }
        changed
    }

    /// Hypotheses are deliberately separate from facts. They are accepted only
    /// when they name at least one already verified fact as support; they never
    /// replace or negate a verified record.
    pub fn checkpoint_hypotheses(&mut self, hypotheses: &serde_json::Value) -> bool {
        let Some(items) = hypotheses.as_array() else {
            return false;
        };
        let mut changed = false;
        for item in items {
            let Some(statement) = item.get("statement").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let support = item
                .get("supporting_facts")
                .and_then(serde_json::Value::as_array)
                .map(|values| {
                    values.iter().filter_map(serde_json::Value::as_str).filter_map(|value| {
                        self.memory.verified_facts.iter().find(|fact| {
                            fact.id == value || fact.statement.eq_ignore_ascii_case(value)
                        }).map(|fact| fact.id.clone())
                    }).collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let status = match item.get("status").and_then(serde_json::Value::as_str) {
                Some("invalidated") => HypothesisStatus::Invalidated,
                _ => HypothesisStatus::Active,
            };
            if (support.is_empty() && status == HypothesisStatus::Active) || statement.trim().is_empty() {
                continue;
            }
            if let Some(hypothesis) = self.memory.hypotheses.iter_mut().find(|known| {
                known.statement.eq_ignore_ascii_case(statement)
            }) {
                if hypothesis.supporting_fact_ids != support || hypothesis.status != status {
                    self.memory.revision += 1;
                    hypothesis.supporting_fact_ids = support;
                    hypothesis.status = status;
                    hypothesis.revision = self.memory.revision;
                    changed = true;
                }
            } else {
                self.memory.revision += 1;
                let revision = self.memory.revision;
                self.memory.hypotheses.push(Hypothesis {
                    id: format!("hypothesis-{revision}"),
                    statement: statement.to_owned(),
                    supporting_fact_ids: support,
                    status,
                    revision,
                });
                changed = true;
            }
        }
        changed
    }

    pub fn strategy_fingerprint(name: &str, arguments: &serde_json::Value) -> Option<(String, String, String)> {
        match name {
            "list_directory" => Some((
                "project_inventory".into(),
                arguments.get("path").and_then(serde_json::Value::as_str).unwrap_or(".").trim_matches('/').to_owned(),
                "directory discovery".into(),
            )),
            "run_terminal" => {
                let command = arguments.get("command").and_then(serde_json::Value::as_str)?;
                let normalized = command.split_whitespace().collect::<Vec<_>>().join(" ");
                let lower = normalized.to_ascii_lowercase();
                (lower.starts_with("find ") || lower.contains("rg --files") || lower.contains("ls -r"))
                    .then(|| ("project_inventory".into(), normalized, "project-wide source discovery".into()))
            }
            _ => None,
        }
    }

    pub fn repeated_strategy_message(&self, name: &str, arguments: &serde_json::Value) -> Option<String> {
        let (category, target, _) = Self::strategy_fingerprint(name, arguments)?;
        let fingerprint = format!("{category}:{target}");
        let strategy = self.memory.attempted_strategies.get(&fingerprint)?;
        (strategy.evidence_revision_after >= strategy.evidence_revision_before).then(|| format!(
            "This {category} for '{target}' was already completed and is preserved in Current Task Memory. Do not repeat project orientation unless a new concrete missing fact requires a different scope. Continue from verified facts and open gaps instead."
        ))
    }

    pub fn record_strategy(&mut self, name: &str, arguments: &serde_json::Value, evidence_before: usize) {
        let Some((category, target, purpose)) = Self::strategy_fingerprint(name, arguments) else {
            return;
        };
        let fingerprint = format!("{category}:{target}");
        let evidence_after = self.evidence_revision;
        if let Some(strategy) = self.memory.attempted_strategies.get_mut(&fingerprint) {
            strategy.attempts += 1;
            strategy.evidence_revision_after = evidence_after;
            return;
        }
        self.memory.attempted_strategies.insert(fingerprint, AttemptedStrategy {
            category,
            target,
            purpose,
            evidence_revision_before: evidence_before,
            evidence_revision_after: evidence_after,
            attempts: 1,
        });
    }

    pub fn current_task_memory_projection(&self, max_chars: usize) -> String {
        let active = self.plan.active_phase().unwrap_or("current work");
        let mut lines = vec![format!("CURRENT TASK MEMORY (revision {}): current plan phase: {active}", self.memory.revision)];
        if !self.memory.evidence.is_empty() {
            lines.push("AVAILABLE MACHINE EVIDENCE:".into());
            for record in self.memory.evidence.iter().rev().take(10).rev() {
                let range = record.range.map(|(start, end)| format!(":{start}..{end}")).unwrap_or_default();
                lines.push(format!("- {} {:?} {}{}", record.id, record.kind, record.source, range));
            }
        }
        if let Some(task) = self.plan.active_task() {
            if !self.has_complete_checkpoint_for(&task.id) && !self.memory.evidence.is_empty() {
                lines.push(format!("PENDING ACTION: create task_checkpoint for {} — {} using relevant existing evidence IDs before marking it done.", task.id, task.content));
            }
        }
        if !self.memory.verified_facts.is_empty() {
            lines.push("VERIFIED FACTS:".into());
            for fact in self.memory.verified_facts.iter().rev().take(18).rev() {
                let sources = fact.sources.iter().map(|source| source.path.as_str()).collect::<Vec<_>>().join(", ");
                let tasks = if fact.related_tasks.is_empty() { "unlinked".into() } else { fact.related_tasks.join(" | ") };
                lines.push(format!("- [{}] {} (sources: {}; tasks: {tasks})", fact.id, fact.statement, sources));
            }
        }
        if !self.memory.unresolved_gaps.is_empty() {
            lines.push("OPEN GAPS:".into());
            for gap in self.memory.unresolved_gaps.iter().rev().take(12).rev() {
                let tasks = if gap.related_tasks.is_empty() { "unlinked".into() } else { gap.related_tasks.join(" | ") };
                let attempted = if gap.attempted_sources.is_empty() { "none".into() } else { gap.attempted_sources.join(", ") };
                lines.push(format!("- [{}] {} (tasks: {tasks}; attempted: {attempted}{})", gap.id, gap.missing_fact, gap.bounded_reason.as_ref().map(|reason| format!("; bounded: {reason}")).unwrap_or_default()));
            }
        }
        if !self.memory.hypotheses.is_empty() {
            lines.push("HYPOTHESES (not verified facts):".into());
            for hypothesis in self.memory.hypotheses.iter().filter(|item| item.status == HypothesisStatus::Active).take(8) {
                lines.push(format!("- [{}] {} (supported by: {})", hypothesis.id, hypothesis.statement, hypothesis.supporting_fact_ids.join(", ")));
            }
        }
        let strategies = self.memory.attempted_strategies.values().filter(|strategy| strategy.category == "project_inventory").take(8).collect::<Vec<_>>();
        if !strategies.is_empty() {
            lines.push("ALREADY INVESTIGATED — do not repeat without a new scope:".into());
            for strategy in strategies {
                lines.push(format!("- {}: {}", strategy.category, strategy.target));
            }
        }
        let output = lines.join("\n");
        if output.chars().count() > max_chars {
            format!("{} …", output.chars().take(max_chars).collect::<String>())
        } else {
            output
        }
    }

    pub fn mark_plan_checkpoint(&mut self) {
        self.plan_checkpoint_evidence_revision = self.evidence_revision;
        self.record_progress();
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

fn clip_paths(paths: Vec<&str>, max_chars: usize) -> String {
    let mut output = String::new();
    for path in paths {
        let separator = if output.is_empty() { "" } else { " | " };
        if output.chars().count() + separator.chars().count() + path.chars().count() > max_chars {
            output.push_str(" …");
            break;
        }
        output.push_str(separator);
        output.push_str(path);
    }
    output
}

fn upsert_fact_in_memory(memory: &mut CurrentTaskMemory, statement: &str, sources: Vec<SourceReference>, tasks: Vec<String>) {
    if let Some(fact) = memory.verified_facts.iter_mut().find(|fact| fact.statement.eq_ignore_ascii_case(statement)) {
        for source in sources {
            if !fact.sources.contains(&source) {
                fact.sources.push(source);
            }
        }
        for task in tasks {
            if !fact.related_tasks.contains(&task) {
                fact.related_tasks.push(task);
            }
        }
        fact.revision = memory.revision;
        return;
    }
    memory.verified_facts.push(VerifiedFact {
        id: format!("fact-{}", memory.verified_facts.len() + 1),
        statement: statement.to_owned(),
        sources,
        related_tasks: tasks,
        revision: memory.revision,
    });
}

fn task_ids_from_labels(plan: &TaskPlan, tasks: &[String]) -> Vec<String> {
    tasks.iter()
        .filter_map(|task| plan.item_by_ref(task).map(|item| item.id.clone()))
        .collect()
}

fn upsert_gap_in_memory(memory: &mut CurrentTaskMemory, missing_fact: &str, tasks: Vec<String>, sources: Vec<String>) {
    if let Some(gap) = memory.unresolved_gaps.iter_mut().find(|gap| gap.missing_fact.eq_ignore_ascii_case(missing_fact)) {
        for task in tasks {
            if !gap.related_tasks.contains(&task) { gap.related_tasks.push(task); }
        }
        for source in sources {
            if !gap.attempted_sources.contains(&source) { gap.attempted_sources.push(source); }
        }
        gap.revision = memory.revision;
        return;
    }
    memory.unresolved_gaps.push(UnresolvedGap {
        id: format!("gap-{}", memory.unresolved_gaps.len() + 1),
        missing_fact: missing_fact.to_owned(),
        related_tasks: tasks,
        attempted_sources: sources,
        bounded_reason: None,
        revision: memory.revision,
    });
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

    #[test]
    fn verified_source_inventory_survives_excerpt_projection() {
        let mut state = AgentState::default();
        state.record_investigation(
            "read_file",
            "public/api.php".into(),
            "PHP endpoint".into(),
            false,
        );
        for number in 0..30 {
            state.record_investigation(
                "read_file",
                format!("src/{number:02}.tsx"),
                "component".into(),
                false,
            );
        }
        assert!(state.verified_source_inventory(3_000).contains("public/api.php"));
    }

    #[test]
    fn verified_fact_and_gap_survive_many_other_sources() {
        let mut state = AgentState::default();
        state.record_investigation("read_file", "public/api.php".into(), "order handler".into(), false);
        state.record_source_range("read_file", "public/api.php", Some((12, 90)));
        assert!(state.checkpoint_source_evidence(&serde_json::json!([{
            "path":"public/api.php", "tasks":["trace purchase flow"],
            "facts":["public/api.php exists and handles order form requests"],
            "unresolved":["exact validation failure response is not confirmed"],
            "complete_for_task":false
        }])));
        for index in 0..40 {
            state.record_investigation("read_file", format!("src/{index:02}.tsx"), "component".into(), false);
        }
        let projection = state.current_task_memory_projection(8_000);
        assert!(projection.contains("public/api.php exists and handles order form requests"));
        assert!(projection.contains("exact validation failure response is not confirmed"));
        let fact = state.memory.verified_facts.first().unwrap();
        assert_eq!(fact.sources[0].range, Some((12, 90)));
    }

    #[test]
    fn source_presence_is_not_a_verified_fact() {
        let mut state = AgentState::default();
        state.record_investigation("read_file", "public/api.php".into(), "handler".into(), false);
        assert!(state.verified_source_inventory(1_000).contains("public/api.php"));
        assert!(state.memory.verified_facts.is_empty());
    }

    #[test]
    fn repeated_inventory_is_remembered_without_new_progress() {
        let mut state = AgentState::default();
        let args = serde_json::json!({"path":"src"});
        state.record_investigation("list_directory", "src".into(), "App.tsx".into(), false);
        let revision = state.evidence_revision;
        state.record_strategy("list_directory", &args, 0);
        assert!(state.repeated_strategy_message("list_directory", &args).is_some());
        state.record_no_progress_turn();
        assert_eq!(state.evidence_revision, revision);
        assert_eq!(state.consecutive_no_progress_turns, 1);
    }

    #[test]
    fn useful_read_and_hypothesis_do_not_corrupt_verified_fact() {
        let mut state = AgentState::default();
        assert!(state.record_investigation("read_file", "public/api.php".into(), "handler".into(), false));
        let first_revision = state.evidence_revision;
        assert!(state.checkpoint_source_evidence(&serde_json::json!([{
            "path":"public/api.php", "tasks":["architecture"],
            "facts":["public/api.php exists"], "unresolved":[], "complete_for_task":true
        }])));
        assert!(state.evidence_revision >= first_revision);
        assert!(state.checkpoint_hypotheses(&serde_json::json!([{
            "statement":"the PHP endpoint may be legacy", "supporting_facts":["public/api.php exists"]
        }])));
        assert_eq!(state.memory.verified_facts[0].statement, "public/api.php exists");
        assert_eq!(state.memory.hypotheses[0].statement, "the PHP endpoint may be legacy");
    }

    fn plan_with_one_task(state: &mut AgentState) -> String {
        state.plan.init(vec![super::super::todo::Phase {
            name: "Analysis".into(),
            tasks: vec![super::super::todo::Item { id: String::new(), content: "trace backend".into(), status: super::super::todo::Status::Pending }],
        }]).unwrap();
        state.plan.active_task().unwrap().id.clone()
    }

    #[test]
    fn successful_read_creates_deduplicated_machine_evidence() {
        let mut state = AgentState::default();
        let first = state.record_evidence(EvidenceKind::SourceRange, "public/api.php".into(), Some((1, 80)), "read_file", "handler");
        let repeated = state.record_evidence(EvidenceKind::SourceRange, "public/api.php".into(), Some((1, 80)), "read_file", "handler");
        assert_eq!(first, "ev-1");
        assert_eq!(first, repeated);
        assert_eq!(state.memory.evidence.len(), 1);
    }

    #[test]
    fn task_requires_valid_checkpoint_and_invalid_checkpoint_is_atomic() {
        let mut state = AgentState::default();
        let task_id = plan_with_one_task(&mut state);
        assert!(!state.has_complete_checkpoint_for(&task_id));
        let before = state.memory.clone();
        assert!(state.checkpoint_task(&task_id, &["ev-missing".into()], &["fact".into()], true, &[]).is_err());
        assert_eq!(state.memory.evidence.len(), before.evidence.len());
        let evidence = state.record_evidence(EvidenceKind::FileRead, "public/api.php".into(), None, "read_file", "handler");
        state.checkpoint_task(&task_id, &[evidence], &["backend handler exists".into()], true, &[]).unwrap();
        assert!(state.has_complete_checkpoint_for(&task_id));
        assert!(state.has_complete_evidence_for(&task_id));
    }
}
