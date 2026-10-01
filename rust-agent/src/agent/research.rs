//! One bounded evidence-gap check. Evidence and read novelty belong to the
//! canonical observation store; this module owns no research history.
use crate::agent::evidence::Observation;
use crate::agent::frontiers::{resolved_by_evidence, EvidenceFrontier, FrontierDisposition};
use crate::agent::task_memory::TaskMemory;
use crate::agent::working_evidence::EstablishedEvidence;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Coverage {
    None,
    Weak,
    Sufficient,
    Blocked,
}

#[derive(Clone, Debug)]
struct Area {
    coverage: Coverage,
    reasons: BTreeSet<String>,
    /// An inferential assessment can be answered honestly as uncertain after
    /// the concrete requested areas are grounded; lack of proof is not a
    /// reason to replay the entire repository.
    requires_direct_evidence: bool,
}

pub struct ResearchController {
    areas: BTreeMap<String, Area>,
    gap_nudged: bool,
    deep: bool,
    open_frontiers: Vec<EvidenceFrontier>,
    blocked_frontiers: Vec<EvidenceFrontier>,
}
impl ResearchController {
    pub fn new(user: &str) -> Self {
        Self::with_depth(user, false)
    }
    pub fn with_depth(user: &str, deep: bool) -> Self {
        let lower = user.to_lowercase();
        let groups: [(&str, &[&str], bool); 6] = [
            (
                "product/business",
                &["product", "business", "продукт", "бизнес", "flow"],
                true,
            ),
            (
                "architecture",
                &[
                    "architecture",
                    "routing",
                    "state",
                    "архитект",
                    "маршрут",
                    "состояни",
                ],
                true,
            ),
            (
                "implementation quality",
                &["quality", "implementation", "code", "качество", "реализац"],
                true,
            ),
            (
                "backend/order flow",
                &[
                    "backend",
                    "api",
                    "checkout",
                    "order",
                    "бэкенд",
                    "заказ",
                    "оплат",
                ],
                true,
            ),
            (
                "history/evolution",
                &["history", "evolution", "git", "истори", "эволюц", "legacy"],
                true,
            ),
            (
                "AI-assisted evidence",
                &[
                    "ai-assisted",
                    "ai assisted",
                    "copilot",
                    "ии",
                    "ai ",
                    "искусствен",
                ],
                false,
            ),
        ];
        let mut areas = BTreeMap::new();
        for (name, words, requires_direct_evidence) in groups {
            if words.iter().any(|w| keyword_matches(&lower, w)) {
                areas.insert(
                    name.into(),
                    Area {
                        coverage: Coverage::None,
                        reasons: BTreeSet::new(),
                        requires_direct_evidence,
                    },
                );
            }
        }
        Self {
            areas,
            gap_nudged: false,
            deep,
            open_frontiers: Vec::new(),
            blocked_frontiers: Vec::new(),
        }
    }
    pub fn evidence(&mut self, area: &str, strength: Coverage, reason: &str) {
        if let Some(entry) = self.areas.get_mut(area) {
            if strength > entry.coverage
                || (entry.coverage == Coverage::Blocked && strength == Coverage::Sufficient)
            {
                entry.coverage = strength;
            }
            entry.reasons.insert(reason.into());
        }
    }
    pub fn blocked(&mut self, area: &str, reason: &str) {
        if let Some(e) = self.areas.get_mut(area) {
            if e.coverage != Coverage::Sufficient {
                e.coverage = Coverage::Blocked;
            }
            e.reasons.insert(reason.into());
        }
    }
    pub fn refresh_from_memory(&mut self, memory: &TaskMemory, observations: &[Observation]) {
        for area in self.areas.values_mut() {
            area.coverage = Coverage::None;
            area.reasons.clear();
        }
        for entry in memory.entries.iter().filter(|entry| !entry.invalidated) {
            let cited = observations
                .iter()
                .find(|o| cites_observation(&entry.evidence, &o.id));
            let strength = match cited {
                Some(o) if o.error => Coverage::Blocked,
                Some(_) if !self.deep => Coverage::Sufficient,
                Some(_) => Coverage::Weak,
                None if !entry.evidence.trim().is_empty() => Coverage::Weak,
                None => continue,
            };
            self.semantic_text(
                &format!("{} {}", entry.finding, entry.implication),
                &entry.id,
                strength,
            );
        }
    }
    /// Accepted source-linked statements can carry coverage after compaction.
    /// Replaying an observation does not create a statement and cannot change
    /// coverage or reset any saturation decision on its own.
    pub fn refresh_from_evidence(
        &mut self,
        memory: &TaskMemory,
        observations: &[Observation],
        facts: &[EstablishedEvidence],
    ) {
        self.refresh_from_memory(memory, observations);
        for fact in facts {
            if fact
                .observation_id
                .as_deref()
                .is_some_and(|id| observations.iter().any(|o| o.id == id && !o.error))
            {
                let strength = if matches!(
                    fact.origin.as_str(),
                    "agent-reported direct" | "agent established from observation"
                ) {
                    Coverage::Sufficient
                } else if fact.origin == "task-memory cited" && !self.deep {
                    Coverage::Sufficient
                } else {
                    // A source named near an assistant note is useful context,
                    // but cannot by itself prove every clause in that note.
                    Coverage::Weak
                };
                self.semantic_text(&fact.claim, &fact.id, strength);
            }
        }
    }
    pub fn refresh_frontiers(
        &mut self,
        frontiers: &[EvidenceFrontier],
        dispositions: &[FrontierDisposition],
        observations: &[Observation],
        facts: &[EstablishedEvidence],
    ) {
        let previous = self
            .open_frontiers
            .iter()
            .map(|f| f.id.clone())
            .collect::<BTreeSet<_>>();
        let mut new_frontier = false;
        self.open_frontiers.clear();
        self.blocked_frontiers.clear();
        if !self.areas.contains_key("backend/order flow")
            && !self.areas.contains_key("architecture")
            && !self.areas.contains_key("product/business")
        {
            return;
        }
        for frontier in frontiers {
            if resolved_by_evidence(frontier, observations, facts) {
                continue;
            }
            match dispositions.iter().rev().find(|d| d.id == frontier.id) {
                Some(d) if d.outcome == "irrelevant" => {}
                Some(d) if d.outcome == "blocked" => self.blocked_frontiers.push(frontier.clone()),
                _ => {
                    new_frontier |= !previous.contains(&frontier.id);
                    self.open_frontiers.push(frontier.clone());
                }
            }
        }
        if new_frontier {
            self.gap_nudged = false;
        }
    }
    pub fn open_frontier_summary(&self) -> String {
        self.open_frontiers
            .iter()
            .take(4)
            .map(|f| {
                format!(
                    "{}: {} -> {} [local target: {}]",
                    f.id,
                    f.source,
                    f.target,
                    f.resolved_path.as_deref().unwrap_or("unresolved")
                )
            })
            .collect::<Vec<_>>()
            .join("; ")
    }
    /// Every explicitly requested area needs an active evidence-bearing Task
    /// Memory entry or a blocker, and at least one entry must cite a concrete
    /// observation. Uncited notes alone never force finalization.
    pub fn synthesis_ready(&self) -> bool {
        !self.areas.is_empty()
            && self.open_frontiers.is_empty()
            && self.areas.values().all(|area| {
                !area.requires_direct_evidence
                    || if self.deep {
                        matches!(area.coverage, Coverage::Sufficient | Coverage::Blocked)
                    } else {
                        area.coverage != Coverage::None
                    }
            })
            && self
                .areas
                .values()
                .any(|area| matches!(area.coverage, Coverage::Sufficient | Coverage::Blocked))
    }
    /// A closeout request narrows research to evidence gaps; it does not claim
    /// that finalization is ready. No action count or model identity is used.
    pub fn closeout_candidate(&self) -> bool {
        !self.synthesis_ready()
            && !self.areas.is_empty()
            && self.open_frontiers.is_empty()
            && self
                .areas
                .values()
                .any(|area| matches!(area.coverage, Coverage::Sufficient | Coverage::Blocked))
    }
    pub fn has_pending_gap_review(&self) -> bool {
        !self.gap_nudged
            && (!self.open_frontiers.is_empty()
                || self.areas.values().any(|area| {
                    area.requires_direct_evidence
                        && (area.coverage == Coverage::None
                            || self.deep && area.coverage == Coverage::Weak)
                }))
    }
    pub fn missing_areas(&self) -> Vec<&str> {
        self.areas
            .iter()
            .filter(|(_, area)| {
                area.requires_direct_evidence
                    && (area.coverage == Coverage::None
                        || self.deep && area.coverage == Coverage::Weak)
            })
            .map(|(name, _)| name.as_str())
            .collect()
    }
    /// Exact unresolved identifiers for a durable targeted closeout. This is
    /// derived from established evidence on each turn, never from action
    /// counts or a model-generated plan.
    pub fn closeout_targets(&self) -> Vec<String> {
        let mut targets = self
            .missing_areas()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        targets.extend(
            self.open_frontiers
                .iter()
                .map(|frontier| frontier.id.clone()),
        );
        targets
    }
    pub fn has_requested_areas(&self) -> bool {
        !self.areas.is_empty()
    }
    pub fn has_open_frontiers(&self) -> bool {
        !self.open_frontiers.is_empty()
    }
    fn semantic_text(&mut self, text: &str, reason: &str, strength: Coverage) {
        let l = text.to_lowercase();
        for (area, words) in [
            (
                "backend/order flow",
                &[
                    "api",
                    "post",
                    "checkout",
                    "order",
                    "php",
                    "заказ",
                    "форм",
                    "оплат",
                    "бэкенд",
                    "cpa",
                ][..],
            ),
            (
                "architecture",
                &[
                    "route",
                    "context",
                    "state",
                    "component",
                    "архитект",
                    "маршрут",
                    "компонент",
                    "состоян",
                    "роут",
                    "seo",
                ][..],
            ),
            (
                "history/evolution",
                &[
                    "legacy",
                    "old",
                    "history",
                    "previous",
                    "истори",
                    "раньше",
                    "первонач",
                    "наслед",
                    "эволюц",
                    "casino",
                ][..],
            ),
            (
                "implementation quality",
                &[
                    "duplicate",
                    "typing",
                    "error",
                    "test",
                    "quality",
                    "ошиб",
                    "дубли",
                    "качеств",
                    "техдолг",
                    "опечат",
                    "импорт",
                ][..],
            ),
            (
                "product/business",
                &[
                    "product",
                    "offer",
                    "funnel",
                    "cpa",
                    "продукт",
                    "магазин",
                    "бизнес",
                    "конверс",
                    "аффилиат",
                    "товар",
                ][..],
            ),
            (
                "AI-assisted evidence",
                &[
                    "ai",
                    "llm",
                    "copilot",
                    "generated",
                    "ии",
                    "искусствен",
                    "нейросет",
                ][..],
            ),
        ] {
            if words.iter().any(|w| keyword_matches(&l, w)) {
                if strength == Coverage::Blocked {
                    self.blocked(area, reason);
                } else {
                    self.evidence(area, strength, reason);
                }
            }
        }
    }
    pub fn final_nudge(&mut self, has_observations: bool, finalizing: bool) -> Option<String> {
        if !self.has_pending_gap_review() || finalizing {
            return None;
        }
        let gaps = self
            .missing_areas()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if gaps.is_empty() && self.open_frontiers.is_empty() {
            return None;
        }
        self.gap_nudged = true;
        let frontier_note = self
            .open_frontiers
            .iter()
            .take(3)
            .map(|f| format!("{} -> {} ({})", f.source, f.target, f.id))
            .collect::<Vec<_>>()
            .join("; ");
        Some(if has_observations {
            format!("Before finalizing, these requested areas need concrete source-backed findings: {}. Open execution dependencies: {}. Inspect the specific target or record a grounded blocker; a prior touch or uncited summary does not resolve it. Check observation_index before repeating a read.", gaps.join(", "), frontier_note)
        } else {
            format!("Before finalizing, these explicitly requested areas have no recorded observations: {}. Investigate useful gaps.", gaps.join(", "))
        })
    }
    pub fn trace(&self) -> String {
        self.areas
            .iter()
            .map(|(k, v)| format!("{k}:{:?}:{:?}", v.coverage, v.reasons))
            .chain(
                self.open_frontiers
                    .iter()
                    .map(|f| format!("open:{}:{}->{}", f.id, f.source, f.target)),
            )
            .chain(
                self.blocked_frontiers
                    .iter()
                    .map(|f| format!("blocked:{}:{}->{}", f.id, f.source, f.target)),
            )
            .collect::<Vec<_>>()
            .join("|")
    }
}

fn keyword_matches(text: &str, word: &str) -> bool {
    if word.chars().count() > 2 {
        return text.contains(word);
    }
    text.match_indices(word).any(|(start, _)| {
        let end = start + word.len();
        !text[..start]
            .chars()
            .next_back()
            .is_some_and(char::is_alphabetic)
            && !text[end..].chars().next().is_some_and(char::is_alphabetic)
    })
}

fn cites_observation(text: &str, id: &str) -> bool {
    text.match_indices(id).any(|(start, _)| {
        let end = start + id.len();
        !text[..start]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '-')
            && !text[end..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn observed(id: &str, error: bool) -> Observation {
        Observation {
            id: id.into(),
            event_id: "evt-1".into(),
            call_id: "call-1".into(),
            tool: "read_file".into(),
            source: Some("api.php".into()),
            source_revision: Some("v1".into()),
            requested_range: None,
            returned_range: None,
            error,
            body_sha256: "hash".into(),
            body_bytes: 12,
        }
    }
    fn full() -> ResearchController {
        let mut c = ResearchController::new(
            "product architecture implementation backend history AI-assisted audit",
        );
        for a in [
            "product/business",
            "architecture",
            "implementation quality",
            "backend/order flow",
            "AI-assisted evidence",
        ] {
            c.evidence(a, Coverage::Sufficient, "direct");
        }
        c
    }
    #[test]
    fn final_names_only_genuine_uncited_gaps_and_once() {
        let mut c = full();
        let n = c.final_nudge(false, false).unwrap();
        assert!(n.contains("history/evolution"));
        assert!(!n.contains("architecture"));
        assert!(c.final_nudge(false, false).is_none());
    }
    #[test]
    fn blocked_history_allows_final() {
        let mut c = full();
        c.blocked("history/evolution", "approval");
        assert!(c.final_nudge(false, false).is_none());
    }
    #[test]
    fn cited_memory_marks_evidence_or_blocker() {
        let mut c = ResearchController::new("backend history");
        let mut memory = TaskMemory::default();
        memory
            .upsert(
                Some("backend"),
                "checkout POST api.php".into(),
                "obs-1".into(),
                "".into(),
                "".into(),
                None,
            )
            .unwrap();
        memory
            .upsert(
                Some("history"),
                "legacy history permission denied".into(),
                "obs-2".into(),
                "".into(),
                "".into(),
                None,
            )
            .unwrap();
        c.refresh_from_memory(
            &memory,
            &[observed("obs-1", false), observed("obs-2", true)],
        );
        assert_eq!(c.areas["backend/order flow"].coverage, Coverage::Sufficient);
        assert_eq!(c.areas["history/evolution"].coverage, Coverage::Blocked);
    }
    #[test]
    fn lexical_source_name_alone_does_not_mark_coverage() {
        let c = ResearchController::new("backend architecture");
        assert_eq!(c.areas["backend/order flow"].coverage, Coverage::None);
        assert_eq!(c.areas["architecture"].coverage, Coverage::None);
    }

    #[test]
    fn uncited_existing_observations_trigger_reuse_before_more_research() {
        let mut c = ResearchController::new("backend audit");
        let nudge = c.final_nudge(true, false).unwrap();
        assert!(nudge.contains("observation_index"));
        assert!(nudge.contains("specific target"));
    }

    #[test]
    fn active_memory_controls_coverage_and_finalization_without_model_identity() {
        let mut memory = TaskMemory::default();
        let observations = [observed("obs-1", false), observed("obs-2", true)];
        let mut controller = ResearchController::new("backend and history audit");
        memory
            .upsert(
                Some("backend"),
                "api.php order endpoint".into(),
                "obs-1".into(),
                "backend confirmed".into(),
                "".into(),
                None,
            )
            .unwrap();
        controller.refresh_from_memory(&memory, &observations);
        assert!(!controller.synthesis_ready());
        assert!(controller
            .final_nudge(true, false)
            .unwrap()
            .contains("history"));
        memory
            .upsert(
                Some("history"),
                "legacy history unavailable".into(),
                "obs-2".into(),
                "blocked".into(),
                "".into(),
                None,
            )
            .unwrap();
        controller.refresh_from_memory(&memory, &observations);
        assert!(controller.synthesis_ready());
        assert!(controller.final_nudge(true, true).is_none());
        memory.invalidate("backend").unwrap();
        controller.refresh_from_memory(&memory, &observations);
        assert!(
            !controller.synthesis_ready(),
            "invalidated evidence cannot count"
        );
        assert!(
            controller.final_nudge(true, true).is_none(),
            "durable finalization suppresses drift"
        );
    }

    #[test]
    fn uncited_task_memory_is_weak_evidence_not_an_unexplored_area() {
        let mut memory = TaskMemory::default();
        memory
            .upsert(
                Some("backend"),
                "api.php accepts orders".into(),
                "public/api.php lines 1-20".into(),
                "".into(),
                "".into(),
                None,
            )
            .unwrap();
        let mut controller = ResearchController::new("backend audit");
        controller.refresh_from_memory(&memory, &[]);
        assert!(!controller.synthesis_ready());
        assert!(controller.final_nudge(false, false).is_none());
    }

    #[test]
    fn one_exact_citation_anchors_other_evidence_bearing_requested_areas() {
        let mut memory = TaskMemory::default();
        memory
            .upsert(
                Some("backend"),
                "api.php order endpoint".into(),
                "obs-1".into(),
                "".into(),
                "".into(),
                None,
            )
            .unwrap();
        memory
            .upsert(
                Some("history"),
                "legacy history reviewed".into(),
                "git log evidence".into(),
                "".into(),
                "".into(),
                None,
            )
            .unwrap();
        let mut controller = ResearchController::new("backend and history audit");
        controller.refresh_from_memory(&memory, &[observed("obs-1", false)]);
        assert!(controller.synthesis_ready());
        assert!(controller.final_nudge(true, false).is_none());
    }

    #[test]
    fn specific_conflict_can_be_checked_while_generic_gap_nudges_are_suppressed() {
        let mut controller = ResearchController::new("backend and history");
        assert!(controller.final_nudge(true, true).is_none());
        assert!(
            controller.final_nudge(true, false).is_some(),
            "a premature final attempt still receives the targeted gap check"
        );
    }

    #[test]
    fn replay_is_not_semantic_gain_but_new_claim_from_same_observation_is() {
        let observations = [observed("obs-1", false)];
        let mut controller = ResearchController::new("backend and history audit");
        let backend = EstablishedEvidence {
            id: "ev-1".into(),
            claim: "api.php handles backend orders".into(),
            origin: "agent established from observation".into(),
            observation_id: Some("obs-1".into()),
            source: Some("api.php".into()),
            revision: None,
        };
        controller.refresh_from_evidence(&TaskMemory::default(), &observations, &[backend.clone()]);
        let before = controller.trace();
        for _ in 0..20 {
            // observation_read returns the old body but writes no evidence.
            controller.refresh_from_evidence(
                &TaskMemory::default(),
                &observations,
                &[backend.clone()],
            );
            assert_eq!(controller.trace(), before);
            assert!(!controller.synthesis_ready());
        }
        let history = EstablishedEvidence {
            id: "ev-2".into(),
            claim: "legacy history shows earlier casino version".into(),
            ..backend.clone()
        };
        controller.refresh_from_evidence(
            &TaskMemory::default(),
            &observations,
            &[backend, history],
        );
        assert!(controller.synthesis_ready());
    }

    #[test]
    fn russian_grounded_findings_cover_requested_areas_without_model_identity() {
        let mut controller =
            ResearchController::new("Аудит продукта, архитектуры, качества, заказов и истории");
        let observations = [observed("obs-1", false)];
        let claims = [
            "магазин натуральных товаров собирает конверсии",
            "архитектура маршрутов использует SEO",
            "ошибка импорта снижает качество",
            "api.php принимает заказ",
            "история проекта показывает прежний Casino-Chicken",
        ];
        let facts = claims
            .iter()
            .enumerate()
            .map(|(n, claim)| EstablishedEvidence {
                id: format!("ev-{n}"),
                claim: (*claim).into(),
                origin: "agent established from observation".into(),
                observation_id: Some("obs-1".into()),
                source: Some("api.php".into()),
                revision: None,
            })
            .collect::<Vec<_>>();
        controller.refresh_from_evidence(&TaskMemory::default(), &observations, &facts);
        assert!(
            controller.synthesis_ready(),
            "Russian findings must count as semantic evidence"
        );
        assert!(
            !keyword_matches("main.tsx", "ai"),
            "a substring in an identifier is not AI evidence"
        );
    }

    #[test]
    fn inferential_assessment_can_be_reported_as_uncertain_without_reopening_source_discovery() {
        let mut controller = ResearchController::new("audit backend and AI-assisted development");
        let fact = EstablishedEvidence {
            id: "ev-1".into(),
            claim: "api.php handles backend orders".into(),
            origin: "agent established from observation".into(),
            observation_id: Some("obs-1".into()),
            source: Some("api.php".into()),
            revision: None,
        };
        controller.refresh_from_evidence(
            &TaskMemory::default(),
            &[observed("obs-1", false)],
            &[fact],
        );
        assert!(controller.synthesis_ready());
        assert!(controller.missing_areas().is_empty());
        assert!(controller.final_nudge(true, false).is_none());
        assert_eq!(
            controller.areas["AI-assisted evidence"].coverage,
            Coverage::None
        );
    }

    #[test]
    fn source_association_does_not_pretend_to_verify_a_semantic_claim() {
        let mut controller = ResearchController::new("backend audit");
        let fact = EstablishedEvidence {
            id: "ae-1".into(),
            claim: "api.php might process orders".into(),
            origin: "assistant statement; source-associated".into(),
            observation_id: Some("obs-1".into()),
            source: Some("api.php".into()),
            revision: None,
        };
        controller.refresh_from_evidence(
            &TaskMemory::default(),
            &[observed("obs-1", false)],
            &[fact],
        );
        assert_eq!(
            controller.areas["backend/order flow"].coverage,
            Coverage::Weak
        );
        assert!(!controller.synthesis_ready());
    }

    #[test]
    fn productive_long_research_does_not_finish_from_action_count() {
        let mut controller = ResearchController::new("backend and history audit");
        for n in 0..160 {
            let obs = observed(&format!("obs-{n:08}"), false);
            let fact = EstablishedEvidence {
                id: format!("ev-{n}"),
                claim: format!("backend order detail {n}"),
                origin: "agent established from observation".into(),
                observation_id: Some(obs.id.clone()),
                source: Some("api.php".into()),
                revision: None,
            };
            controller.refresh_from_evidence(&TaskMemory::default(), &[obs], &[fact]);
            assert!(
                !controller.synthesis_ready(),
                "history remains a genuine gap"
            );
        }
    }

    #[test]
    fn deep_coverage_requires_explicit_finding_and_closed_execution_edge() {
        let mut controller = ResearchController::with_depth("audit backend", true);
        let mut ui = observed("obs-ui", false);
        ui.source = Some("/repo/src/Form.tsx".into());
        let frontier = EvidenceFrontier {
            id: "frontier-obs-ui-00".into(),
            from_observation: ui.id.clone(),
            source: ui.source.clone().unwrap(),
            target: "service.php".into(),
            resolved_path: Some("/repo/public/service.php".into()),
            project_relative_path: Some("public/service.php".into()),
            resolution: Some("project public root".into()),
        };
        let memory_fact = EstablishedEvidence {
            id: "mem-1".into(),
            claim: "backend order form posts to service.php".into(),
            origin: "task-memory cited".into(),
            observation_id: Some(ui.id.clone()),
            source: ui.source.clone(),
            revision: None,
        };
        controller.refresh_from_evidence(&TaskMemory::default(), &[ui.clone()], &[memory_fact]);
        controller.refresh_frontiers(&[frontier.clone()], &[], &[ui.clone()], &[]);
        assert_eq!(
            controller.areas["backend/order flow"].coverage,
            Coverage::Weak
        );
        assert!(!controller.synthesis_ready());
        let direct = EstablishedEvidence {
            id: "ev-1".into(),
            claim: "backend order submission reaches local service".into(),
            origin: "agent-reported direct".into(),
            observation_id: Some(ui.id.clone()),
            source: ui.source.clone(),
            revision: None,
        };
        controller.refresh_from_evidence(&TaskMemory::default(), &[ui.clone()], &[direct.clone()]);
        assert!(
            !controller.synthesis_ready(),
            "a direct UI finding cannot close its downstream target"
        );
        let mut target = observed("obs-target", false);
        target.source = Some("/repo/public/service.php".into());
        controller.refresh_frontiers(
            &[frontier.clone()],
            &[],
            &[ui.clone(), target.clone()],
            &[direct.clone()],
        );
        assert!(
            !controller.synthesis_ready(),
            "a target read without an established finding remains partial"
        );
        let target_fact = EstablishedEvidence {
            id: "ev-target".into(),
            claim: "backend order endpoint accepts the submitted form".into(),
            origin: "agent-reported direct".into(),
            observation_id: Some(target.id.clone()),
            source: target.source.clone(),
            revision: None,
        };
        controller.refresh_frontiers(&[frontier], &[], &[ui, target], &[direct, target_fact]);
        assert!(controller.synthesis_ready());
    }

    #[test]
    fn skipped_frontier_differs_from_grounded_blocker_and_replay() {
        let mut controller = ResearchController::with_depth("backend order audit", true);
        let frontier = EvidenceFrontier {
            id: "f".into(),
            from_observation: "obs-ui".into(),
            source: "/repo/Form.tsx".into(),
            target: "endpoint.php".into(),
            resolved_path: Some("/repo/public/endpoint.php".into()),
            project_relative_path: Some("public/endpoint.php".into()),
            resolution: Some("project public root".into()),
        };
        let mut ui = observed("obs-ui", false);
        ui.source = Some(frontier.source.clone());
        let direct = EstablishedEvidence {
            id: "ev".into(),
            claim: "backend order form submits to endpoint".into(),
            origin: "agent-reported direct".into(),
            observation_id: Some(ui.id.clone()),
            source: ui.source.clone(),
            revision: None,
        };
        controller.refresh_from_evidence(&TaskMemory::default(), &[ui.clone()], &[direct.clone()]);
        controller.refresh_frontiers(&[frontier.clone()], &[], &[ui.clone()], &[direct.clone()]);
        assert!(!controller.synthesis_ready());
        let mut replay = ui.clone();
        replay.id = "obs-replay".into();
        controller.refresh_frontiers(
            &[frontier.clone()],
            &[],
            &[ui.clone(), replay],
            &[direct.clone()],
        );
        assert!(!controller.synthesis_ready());
        let blocked = FrontierDisposition {
            id: "f".into(),
            outcome: "blocked".into(),
            reason: "approval denied for the specific target".into(),
            observation_id: Some("obs-error".into()),
        };
        controller.refresh_frontiers(&[frontier], &[blocked], &[ui], &[direct]);
        assert!(controller.synthesis_ready());
        assert!(controller.trace().contains("blocked:f"));
    }

    #[test]
    fn closeout_candidate_narrows_gaps_without_claiming_final_readiness() {
        let mut controller = ResearchController::with_depth("backend and history audit", true);
        assert!(!controller.closeout_candidate());
        controller.evidence(
            "backend/order flow",
            Coverage::Sufficient,
            "direct source finding",
        );
        assert!(controller.closeout_candidate());
        assert!(!controller.synthesis_ready());
        let frontier = EvidenceFrontier {
            id: "f".into(),
            from_observation: "obs-1".into(),
            source: "/repo/Form.tsx".into(),
            target: "endpoint.php".into(),
            resolved_path: Some("/repo/public/endpoint.php".into()),
            project_relative_path: Some("public/endpoint.php".into()),
            resolution: Some("project public root".into()),
        };
        controller.refresh_frontiers(&[frontier], &[], &[], &[]);
        assert!(
            !controller.closeout_candidate(),
            "an open material dependency still needs investigation"
        );
    }
}
