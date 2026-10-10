//! Runtime-owned work allowance. Claims, planning and narration never enter
//! this policy. A recent changed-code/check pair can buy one bounded block.
use super::deliverables::{DeliverableStatus, Deliverables};
use super::verification::{self, Evidence, Kind, Verification};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const INITIAL: usize = 128;
pub const BLOCK: usize = 32;
pub const MAXIMUM: usize = 256;
pub const RECENT: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetView {
    pub used: usize,
    pub limit: usize,
    pub maximum: usize,
    pub extensions: usize,
    pub decision: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub basis: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Change {
    turn: usize,
    existing: bool,
    #[serde(default)]
    path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Check {
    key: String,
    outcome: String,
    revision: String,
    pass: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Progress {
    turn: usize,
    reason: String,
    evidence: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkBudget {
    pub used: usize,
    pub limit: usize,
    pub extensions: usize,
    pub decision: String,
    pub reason: String,
    /// Only a normal, reconciled terminal result opens a fresh allowance for
    /// the next request. Partial results, Pause, Stop and restart retain it.
    pub closed: bool,
    basis: Option<String>,
    revisions: BTreeMap<String, String>,
    #[serde(default)]
    created: BTreeSet<String>,
    change: Option<Change>,
    changed_revisions: BTreeMap<String, String>,
    checks: Vec<Check>,
    progress: Option<Progress>,
    failed_edits: usize,
    verification_grace_used: bool,
    failed_check_turn: Option<usize>,
}

impl Default for WorkBudget {
    fn default() -> Self {
        Self {
            used: 0,
            limit: INITIAL,
            extensions: 0,
            decision: "initial".into(),
            reason: "initial_allowance".into(),
            closed: false,
            basis: None,
            revisions: BTreeMap::new(),
            created: BTreeSet::new(),
            change: None,
            changed_revisions: BTreeMap::new(),
            checks: Vec::new(),
            progress: None,
            failed_edits: 0,
            verification_grace_used: false,
            failed_check_turn: None,
        }
    }
}

impl WorkBudget {
    pub fn view(&self) -> BudgetView {
        BudgetView {
            used: self.used,
            limit: self.limit,
            maximum: MAXIMUM,
            extensions: self.extensions,
            decision: self.decision.clone(),
            reason: self.reason.clone(),
            basis: self.basis.clone(),
        }
    }

    /// Returns false at a denied boundary; never starts work above MAXIMUM.
    pub fn allow_next(&mut self) -> bool {
        if self.decision == "denied" {
            return false;
        }
        if self.used < self.limit.min(MAXIMUM) {
            return true;
        }
        if self.used >= MAXIMUM {
            self.deny("absolute_maximum");
            return false;
        }
        let Some(progress) = self
            .progress
            .take()
            .filter(|p| self.used.saturating_sub(p.turn) < RECENT)
        else {
            let reason = if self.failed_edits >= 3 {
                "repeated_failed_edits"
            } else if self
                .failed_check_turn
                .is_some_and(|turn| self.used.saturating_sub(turn) < RECENT)
            {
                "verification_grace_exhausted"
            } else {
                "no_recent_checked_progress"
            };
            self.deny(reason);
            return false;
        };
        self.limit = (self.limit + BLOCK).min(MAXIMUM);
        self.extensions += 1;
        self.decision = "extended".into();
        if progress.reason == "bounded_verification_started" {
            self.verification_grace_used = true;
        }
        self.reason = progress.reason;
        self.basis = Some(progress.evidence);
        true
    }

    fn deny(&mut self, reason: &str) {
        self.decision = "denied".into();
        self.reason = reason.into();
        self.basis = None;
    }

    pub fn start_turn(&mut self) {
        self.used = (self.used + 1).min(MAXIMUM);
    }
    pub fn has_changed_code(&self) -> bool {
        self.change.is_some()
    }

    pub fn observe_file(&mut self, path: &str, revision: &str) {
        if verification::is_code_path(path) && self.revisions.len() < 256 {
            self.revisions
                .entry(path.into())
                .or_insert_with(|| revision.into());
        }
    }

    pub fn changed_file(&mut self, path: &str, revision: &str) {
        if !verification::is_code_path(path) {
            return;
        }
        let previous = self.revisions.get(path);
        if previous.is_some_and(|known| known == revision) {
            return;
        }
        let existing = previous.is_some() && !self.created.contains(path);
        if previous.is_none() && self.created.len() < 256 {
            self.created.insert(path.into());
        }
        self.change = Some(Change {
            turn: self.used,
            existing,
            path: path.into(),
        });
        self.failed_edits = 0;
        if self.revisions.len() < 256 || self.revisions.contains_key(path) {
            self.revisions.insert(path.into(), revision.into());
            self.changed_revisions.insert(path.into(), revision.into());
        }
    }

    pub fn failed_edit(&mut self) {
        self.failed_edits += 1;
        if self.failed_edits >= 3 {
            self.progress = None;
        }
    }

    pub fn checked(&mut self, record: &Evidence, ledger: &Verification, items: &Deliverables) {
        if !matches!(
            record.kind,
            Kind::Build | Kind::Test | Kind::Run | Kind::Browser
        ) || !ledger.fresh(record)
        {
            return;
        }
        let relevant = if items.is_empty() {
            ledger.effective_need(None).accepts(record.kind)
                || record.kind == Kind::Build && !ledger.page_changed
        } else {
            items.items.iter().any(|item| {
                !matches!(
                    item.status,
                    DeliverableStatus::Dropped | DeliverableStatus::Blocked
                ) && ledger.relevant(record, item)
                    && (ledger.effective_need(item.check) != verification::Need::Browser
                        || record.kind == Kind::Browser)
            })
        };
        if !relevant {
            return;
        }
        let key = if record.check_key.is_empty() {
            &record.subject
        } else {
            &record.check_key
        };
        let revision = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&self.changed_revisions).unwrap_or_default())
        );
        let duplicate = self.checks.iter().any(|check| {
            check.key == *key && check.revision == revision && (!record.pass || check.pass)
        });
        let previous = self.checks.iter().rev().find(|check| check.key == *key);
        let reason = if record.pass && previous.is_some_and(|check| !check.pass) {
            "relevant_failure_resolved"
        } else if record.pass {
            "changed_code_check_passed"
        } else {
            "bounded_verification_started"
        };
        let paired = self.change.as_ref().is_some_and(|change| {
            self.used.saturating_sub(change.turn) < RECENT
                && (change.existing
                    || record.pass
                        && verification::mentioned_code_paths(key).iter().any(|path| {
                            path.trim_start_matches("./") == change.path.trim_start_matches("./")
                        }))
        });
        if paired && !record.pass && self.verification_grace_used {
            self.failed_check_turn = Some(self.used);
        }
        if !duplicate && (record.pass || !self.verification_grace_used) && paired {
            if record.pass {
                self.failed_check_turn = None;
                self.failed_edits = 0;
            }
            self.progress = Some(Progress {
                turn: self.used,
                reason: reason.into(),
                evidence: record.id.clone(),
            });
        }
        // Refuse further credits if the bounded identity ledger is full; do
        // not evict spent outcomes to make an old loop look new.
        if self.checks.len() < 256 {
            self.checks.push(Check {
                key: key.clone(),
                outcome: record.outcome_hash.clone(),
                revision,
                pass: record.pass,
            });
        } else {
            self.progress = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::verification::Need;
    use super::*;

    fn result(
        budget: &mut WorkBudget,
        ledger: &mut Verification,
        items: &Deliverables,
        pass: bool,
    ) {
        let id = ledger.record_outcome(
            Kind::Run,
            "node check.js",
            pass,
            "result",
            budget.used,
            if pass { "ok" } else { "failure" },
        );
        budget.checked(ledger.get(&id).unwrap(), ledger, items);
    }
    fn change(budget: &mut WorkBudget, ledger: &mut Verification, revision: &str) {
        budget.changed_file("app.js", revision);
        ledger.note_change(Some("app.js"));
    }

    #[test]
    fn changed_checked_work_without_deliverables_extends_once_then_stalls() {
        let mut budget = WorkBudget::default();
        let mut ledger = Verification::default();
        budget.observe_file("app.js", "old");
        budget.used = 126;
        change(&mut budget, &mut ledger, "new");
        result(&mut budget, &mut ledger, &Deliverables::default(), true);
        budget.used = INITIAL;
        assert!(budget.allow_next());
        assert_eq!((budget.limit, budget.extensions), (160, 1));
        // Even changed stdout/timing cannot spend the same passing revision twice.
        budget.used = 159;
        let id = ledger.record_outcome(Kind::Run, "node check.js", true, "ok", 159, "new timing");
        budget.checked(ledger.get(&id).unwrap(), &ledger, &Deliverables::default());
        budget.used = 160;
        assert!(!budget.allow_next());
    }

    #[test]
    fn resolved_relevant_failure_is_observable_progress_but_unrelated_pass_is_not() {
        let mut budget = WorkBudget::default();
        let mut ledger = Verification::default();
        budget.observe_file("app.js", "old");
        let mut items = Deliverables::default();
        items
            .add_checked(Some("runtime"), "", "runtime result", Some(Need::Runtime))
            .unwrap();
        budget.used = 120;
        result(&mut budget, &mut ledger, &items, false);
        budget.used = 126;
        change(&mut budget, &mut ledger, "new");
        result(&mut budget, &mut ledger, &items, true);
        budget.used = 128;
        assert!(
            !budget.allow_next(),
            "unselected pass cannot buy time for the runtime item"
        );
        budget.decision = "initial".into();
        ledger.bind("node check.js", &["runtime".into()]).unwrap();
        budget.used = 127;
        result(&mut budget, &mut ledger, &items, false);
        change(&mut budget, &mut ledger, "fixed");
        result(&mut budget, &mut ledger, &items, true);
        budget.used = 128;
        assert!(budget.allow_next());
        assert_eq!(budget.reason, "relevant_failure_resolved");
    }

    #[test]
    fn verification_grace_is_single_use_and_requires_real_existing_code_change() {
        let mut budget = WorkBudget::default();
        let mut ledger = Verification::default();
        budget.observe_file("app.js", "old");
        budget.used = 126;
        change(&mut budget, &mut ledger, "new");
        result(&mut budget, &mut ledger, &Deliverables::default(), false);
        budget.used = 128;
        assert!(budget.allow_next());
        assert_eq!(budget.reason, "bounded_verification_started");
        budget.used = 159;
        change(&mut budget, &mut ledger, "another");
        result(&mut budget, &mut ledger, &Deliverables::default(), false);
        budget.used = 160;
        assert!(
            !budget.allow_next(),
            "failure-only work gets no second grace"
        );
    }

    #[test]
    fn edits_claims_creation_reads_and_failed_patches_alone_never_extend() {
        for mode in ["edit", "create-fail", "three-failed-edits", "old-progress"] {
            let mut budget = WorkBudget::default();
            let mut ledger = Verification::default();
            if mode == "three-failed-edits" || mode == "old-progress" {
                budget.observe_file("app.js", "old");
            }
            budget.used = if mode == "old-progress" { 100 } else { 126 };
            change(&mut budget, &mut ledger, "new");
            if mode == "create-fail" {
                result(&mut budget, &mut ledger, &Deliverables::default(), false);
            }
            if mode == "three-failed-edits" || mode == "old-progress" {
                result(&mut budget, &mut ledger, &Deliverables::default(), true);
                if mode == "three-failed-edits" {
                    for _ in 0..3 {
                        budget.failed_edit();
                    }
                }
            }
            budget.used = 128;
            assert!(!budget.allow_next(), "{mode}");
        }
    }

    #[test]
    fn unchanged_failures_and_same_content_writes_do_not_create_progress() {
        let mut budget = WorkBudget::default();
        let mut ledger = Verification::default();
        budget.used = 100;
        budget.observe_file("app.js", "old");
        change(&mut budget, &mut ledger, "new");
        result(&mut budget, &mut ledger, &Deliverables::default(), false);
        budget.used = 126;
        budget.changed_file("app.js", "new");
        for _ in 0..20 {
            result(&mut budget, &mut ledger, &Deliverables::default(), false);
        }
        budget.used = 128;
        assert!(!budget.allow_next());
    }

    #[test]
    fn absolute_maximum_wins_over_fresh_progress_and_serialization_preserves_allowance() {
        let mut budget = WorkBudget::default();
        let mut ledger = Verification::default();
        budget.observe_file("app.js", "old");
        for boundary in [128, 160, 192, 224] {
            budget.used = boundary - 1;
            change(&mut budget, &mut ledger, &boundary.to_string());
            result(&mut budget, &mut ledger, &Deliverables::default(), true);
            budget.used = boundary;
            assert!(budget.allow_next());
            budget = serde_json::from_value(serde_json::to_value(&budget).unwrap()).unwrap();
        }
        assert_eq!((budget.limit, budget.extensions), (256, 4));
        budget.used = 255;
        change(&mut budget, &mut ledger, "still productive");
        result(&mut budget, &mut ledger, &Deliverables::default(), true);
        budget.start_turn();
        assert!(!budget.allow_next());
        assert_eq!(budget.reason, "absolute_maximum");
        assert_eq!(budget.used, 256);
    }

    #[test]
    fn irrelevant_creation_and_old_test_pass_cannot_buy_time_but_direct_new_code_check_can() {
        for directly_checked in [false, true] {
            let mut budget = WorkBudget::default();
            let mut ledger = Verification::default();
            budget.used = 126;
            let path = if directly_checked {
                "check.js"
            } else {
                "unrelated.js"
            };
            budget.changed_file(path, "new");
            budget.observe_file(path, "new");
            budget.changed_file(path, "edited again");
            ledger.note_change(Some(path));
            result(&mut budget, &mut ledger, &Deliverables::default(), true);
            budget.used = 128;
            assert_eq!(budget.allow_next(), directly_checked);
        }
    }

    #[test]
    fn stale_and_weak_browser_evidence_never_authorize_extensions() {
        let mut budget = WorkBudget::default();
        let mut ledger = Verification::default();
        let mut items = Deliverables::default();
        items
            .add_checked(Some("page"), "", "page responds", Some(Need::Browser))
            .unwrap();
        ledger.bind("node check.js", &["page".into()]).unwrap();
        budget.observe_file("app.js", "old");
        budget.used = 126;
        change(&mut budget, &mut ledger, "new");
        for kind in [Kind::Readback, Kind::Static, Kind::Run] {
            let id = ledger.record(kind, "node check.js", true, "pass", 126);
            budget.checked(ledger.get(&id).unwrap(), &ledger, &items);
        }
        let id = ledger.record(Kind::Browser, "node check.js", true, "pass", 126);
        ledger.note_change(Some("app.js"));
        budget.checked(ledger.get(&id).unwrap(), &ledger, &items);
        budget.used = 128;
        assert!(!budget.allow_next());
    }
}
