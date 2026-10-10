//! Evidence that work really behaves as claimed.
//!
//! "I changed the file" and "it works" are different claims. The model makes
//! both in words; only the runtime can observe what actually happened. This
//! ledger therefore holds records the runtime created itself, from tool
//! results it saw: the file read back after a write, a build or test command
//! that exited with a code, a script that was run. A record can never be
//! authored from a tool argument, and any later change to the project makes
//! functional records stale, so "verified" always means "checked after the
//! last change".
//!
//! The ledger decides nothing about the user's intent. It only answers whether
//! a deliverable has fresh, passing evidence of the strength it needs.

use super::deliverables::{Deliverable, Deliverables, VerificationScope};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

const MAX_RECORDS: usize = 24;
const MAX_CHANGED: usize = 48;
const MAX_SUBJECT_CHARS: usize = 100;
const MAX_DETAIL_CHARS: usize = 160;
const SHOWN_RECORDS: usize = 5;

/// How strongly a record shows the work does what was asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    /// The change is on disk as written. Proves nothing about behaviour.
    Readback,
    /// It parses, type-checks, lints or builds. Still not behaviour.
    Static,
    /// It was executed or tested.
    Functional,
}

impl Class {
    pub fn label(self) -> &'static str {
        match self {
            Class::Readback => "readback",
            Class::Static => "static",
            Class::Functional => "functional",
        }
    }
}

/// What a claim needs shown: the smallest set of capabilities that matters.
/// Evidence of the wrong capability never satisfies it, however strong it is
/// in general: a script that exits 0 is runtime evidence, not browser evidence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Need {
    /// The file is on disk as written ("it was created").
    #[serde(rename = "readback")]
    Readback,
    /// It parses, type-checks or lints, or anything stronger passed.
    #[serde(rename = "static", alias = "static_check")]
    Static,
    /// The project builds.
    #[serde(rename = "build")]
    Build,
    /// A test run passed ("tests pass").
    #[serde(rename = "test")]
    Test,
    /// The code was executed (a script, a test, a browser).
    #[serde(rename = "runtime", alias = "functional")]
    Runtime,
    /// A real browser engine ran the page: a browser driver, a test runner for
    /// browsers, or a headless browser. A jsdom or node stand-in does not.
    #[serde(rename = "browser", alias = "browser_interaction")]
    Browser,
}

impl Need {
    pub fn parse(value: &str) -> Option<Need> {
        match value.trim().to_ascii_lowercase().as_str() {
            "readback" | "read" | "file" => Some(Need::Readback),
            "static" | "static_check" | "lint" | "typecheck" => Some(Need::Static),
            "build" | "compile" => Some(Need::Build),
            "test" | "tests" => Some(Need::Test),
            "runtime" | "run" | "functional" | "behavior" | "behaviour" => Some(Need::Runtime),
            "browser" | "browser_interaction" | "ui" => Some(Need::Browser),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Need::Readback => "readback",
            Need::Static => "static check",
            Need::Build => "build",
            Need::Test => "test",
            Need::Runtime => "runtime",
            Need::Browser => "browser",
        }
    }

    pub fn class(self) -> Class {
        match self {
            Need::Readback => Class::Readback,
            Need::Static | Need::Build => Class::Static,
            Need::Test | Need::Runtime | Need::Browser => Class::Functional,
        }
    }

    pub fn accepts(self, kind: Kind) -> bool {
        match self {
            Need::Readback => true,
            Need::Static => kind.class() >= Class::Static,
            Need::Build => kind == Kind::Build,
            Need::Test => matches!(kind, Kind::Test | Kind::Browser),
            Need::Runtime => kind.class() == Class::Functional,
            Need::Browser => kind == Kind::Browser,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Readback,
    Static,
    Test,
    Build,
    /// A script or program was executed.
    Run,
    /// A real browser engine executed the page.
    Browser,
}

impl Kind {
    pub fn class(self) -> Class {
        match self {
            Kind::Readback => Class::Readback,
            Kind::Static | Kind::Build => Class::Static,
            Kind::Test | Kind::Run | Kind::Browser => Class::Functional,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Kind::Readback => "readback",
            Kind::Static => "static",
            Kind::Test => "test",
            Kind::Build => "build",
            Kind::Run => "run",
            Kind::Browser => "browser",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    pub id: String,
    pub kind: Kind,
    pub class: Class,
    /// What was checked: the command or the file path.
    pub subject: String,
    pub pass: bool,
    /// The project state this was observed against.
    pub epoch: u64,
    pub turn: usize,
    #[serde(default)]
    pub detail: String,
    /// Exact identity, separate from the shortened display subject.
    #[serde(default)]
    pub check_key: String,
    /// Runtime-captured associations, never a post-result exclusion flag.
    #[serde(default)]
    pub deliverable_ids: Vec<String>,
    #[serde(default)]
    pub baseline: bool,
    #[serde(default)]
    pub outcome_hash: String,
    /// An identical failure observed before the lineage's first mutation.
    /// This is provenance, not proof that the behaviour is unaffected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_failure: Option<String>,
}

impl Evidence {
    fn key(&self) -> &str {
        if self.check_key.is_empty() {
            &self.subject
        } else {
            &self.check_key
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verification {
    /// Increases on every project change.
    #[serde(default)]
    pub epoch: u64,
    #[serde(default)]
    next: u64,
    #[serde(default)]
    pub records: Vec<Evidence>,
    /// Project files changed in this task and the epoch of their last change.
    #[serde(default)]
    pub changed: BTreeMap<String, u64>,
    /// A code or markup file was changed (or deleted): behaviour must be shown.
    #[serde(default)]
    pub code_changed: bool,
    /// An HTML page was changed (or deleted): its behaviour in a browser must
    /// be shown by a real browser run, not by a script standing in for one.
    #[serde(default)]
    pub page_changed: bool,
    /// Content revision of each tracked file when the runtime last saw it, so
    /// a change made outside the file tools is noticed by comparing.
    #[serde(default)]
    pub revisions: BTreeMap<String, String>,
    /// Append-only command-to-deliverable relationships. Survive record
    /// eviction, mutations and Continue; retries cannot shed a failing link.
    #[serde(default)]
    pub bindings: BTreeMap<String, Vec<String>>,
}

const CODE_EXTENSIONS: [&str; 30] = [
    "js", "jsx", "ts", "tsx", "mjs", "cjs", "html", "htm", "svelte", "vue", "py", "rs", "go",
    "java", "kt", "c", "cc", "cpp", "h", "hpp", "cs", "rb", "php", "swift", "sh", "lua", "dart",
    "scala", "ex", "css",
];

pub fn is_page_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
}

pub fn is_code_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            CODE_EXTENSIONS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(extension))
        })
}

fn shorten(value: &str, limit: usize) -> String {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.chars().count() <= limit {
        return value;
    }
    let keep = limit.saturating_sub(1);
    let tail = value
        .chars()
        .rev()
        .take(keep)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    format!("…{tail}")
}

impl Verification {
    pub fn is_empty(&self) -> bool {
        self.epoch == 0 && self.records.is_empty() && self.changed.is_empty()
    }

    /// A new run starts against a project that may have changed in between, so
    /// earlier functional records can no longer vouch for it.
    pub fn start_run(&mut self) {
        if !self.is_empty() {
            self.epoch = self.epoch.saturating_add(1);
        }
    }

    /// The project changed. `path` is `None` when it is unknown.
    pub fn note_change(&mut self, path: Option<&str>) {
        self.epoch = self.epoch.saturating_add(1);
        if let Some(path) = path.filter(|path| !path.is_empty()) {
            if is_code_path(path) {
                self.code_changed = true;
            }
            if is_page_path(path) {
                self.page_changed = true;
            }
            self.changed.insert(path.to_owned(), self.epoch);
            while self.changed.len() > MAX_CHANGED {
                if let Some(oldest) = self
                    .changed
                    .iter()
                    .min_by_key(|(_, epoch)| **epoch)
                    .map(|(path, _)| path.clone())
                {
                    self.changed.remove(&oldest);
                    self.revisions.remove(&oldest);
                }
            }
        }
    }

    /// A deleted file has nothing to read back.
    pub fn note_deletion(&mut self, path: &str) {
        self.note_change(None);
        if is_code_path(path) {
            self.code_changed = true;
        }
        if is_page_path(path) {
            self.page_changed = true;
        }
        self.changed.remove(path);
        self.revisions.remove(path);
    }

    pub fn record(
        &mut self,
        kind: Kind,
        subject: &str,
        pass: bool,
        detail: &str,
        turn: usize,
    ) -> String {
        self.record_outcome(kind, subject, pass, detail, turn, detail)
    }

    pub fn record_outcome(
        &mut self,
        kind: Kind,
        subject: &str,
        pass: bool,
        detail: &str,
        turn: usize,
        outcome: &str,
    ) -> String {
        self.next += 1;
        let id = format!("ev-{:03}", self.next);
        let key = subject.trim();
        let outcome_hash = format!("{:x}", Sha256::digest(outcome.as_bytes()));
        let baseline = self.epoch == 0 && self.changed.is_empty() && !self.code_changed;
        let baseline_failure = (!pass && !baseline)
            .then(|| {
                self.records
                    .iter()
                    .find(|record| {
                        record.baseline
                            && !record.pass
                            && record.kind == kind
                            && record.key() == key
                            && record.outcome_hash == outcome_hash
                    })
                    .map(|record| record.id.clone())
            })
            .flatten();
        self.records.push(Evidence {
            id: id.clone(),
            kind,
            class: kind.class(),
            subject: shorten(subject, MAX_SUBJECT_CHARS),
            pass,
            epoch: self.epoch,
            turn,
            detail: shorten(detail, MAX_DETAIL_CHARS),
            check_key: key.to_owned(),
            deliverable_ids: self.bindings.get(key).cloned().unwrap_or_default(),
            baseline,
            outcome_hash,
            baseline_failure,
        });
        while self.records.len() > MAX_RECORDS {
            let drop = (0..self.records.len())
                .find(|&index| !self.fresh(&self.records[index]))
                .or_else(|| {
                    let active = self.active_failures();
                    (0..self.records.len()).find(|&index| {
                        !active
                            .iter()
                            .any(|failure| failure.id == self.records[index].id)
                    })
                });
            // Active contradictions cannot be forgotten to make room for
            // passes. In an all-fail ledger keep them until a mutation or a
            // successful retry; the run's existing tool budget bounds growth.
            let Some(drop) = drop else {
                break;
            };
            self.records.remove(drop);
        }
        id
    }

    /// Associations can only be added. There is deliberately no remove,
    /// replace, unrelated or ignore operation. Exact command identity avoids
    /// collisions from truncated display subjects.
    ///
    /// # Errors
    /// Rejects an empty check identity. Previously stored bindings remain.
    pub fn bind(&mut self, subject: &str, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let key = subject.trim();
        if key.is_empty() {
            return Err("a verification check must have a nonempty command/path".into());
        }
        let targets = self.bindings.entry(key.to_owned()).or_default();
        for id in ids {
            if !targets.contains(id) {
                targets.push(id.clone());
            }
        }
        // A later citation also attaches the earlier result, including a
        // failure. Selection never erases contradictory evidence of this check.
        for record in &mut self.records {
            if record.key() == key {
                record.deliverable_ids.clone_from(targets);
            }
        }
        Ok(())
    }

    /// Permanently attaches every known citation, even if another ID is invalid.
    ///
    /// # Errors
    /// Reports unknown IDs or invalid check identities without rolling back
    /// valid associations. Callers must sync failure state even on error.
    pub fn attach(&mut self, id: &str, cited: &[String]) -> Result<(), String> {
        let mut keys = Vec::new();
        let mut error = None;
        for evidence_id in cited {
            if let Some(record) = self.get(evidence_id) {
                keys.push(record.key().to_owned());
            } else {
                error = Some(format!(
                    "unknown evidence '{evidence_id}': ids are issued by the runtime"
                ));
            }
        }
        for key in keys {
            self.bind(&key, &[id.to_owned()])?;
        }
        // An extra invalid ID must not roll back a valid failed selection.
        error.map_or(Ok(()), Err)
    }

    #[must_use]
    pub fn relevant(&self, record: &Evidence, item: &Deliverable) -> bool {
        // Full-test requirements cannot be narrowed by selecting one pass.
        // Legacy items retain their previous project-wide scope. A named build
        // requirement structurally covers build checks, not unrelated tests.
        item.verification_scope == VerificationScope::Project
            || item.check == Some(Need::Test)
            || item.check == Some(Need::Build) && record.kind == Kind::Build
            || record.deliverable_ids.contains(&item.id)
            || self.bindings.get(record.key()).is_some_and(|ids| ids.contains(&item.id))
            || item.proof.iter().any(|id| self.get(id).is_some_and(|proof| proof.key() == record.key()))
            // Readback remains per-file and runtime-produced; no terminal
            // selection is necessary for a file-existence claim.
            || self.effective_need(item.check) == Need::Readback && record.kind == Kind::Readback
    }

    #[must_use]
    pub fn failure_for(&self, item: &Deliverable) -> Option<&Evidence> {
        self.active_failures()
            .into_iter()
            .rev()
            .find(|record| self.relevant(record, item))
    }

    #[must_use]
    pub fn blocking_failure(&self, items: &Deliverables) -> Option<&Evidence> {
        self.active_failures().into_iter().rev().find(|record| {
            if items.is_empty() {
                return record.class >= Class::Static;
            }
            items.items.iter().any(|item| {
                matches!(
                    item.status,
                    super::deliverables::DeliverableStatus::Implemented
                        | super::deliverables::DeliverableStatus::Verified
                ) && self.relevant(record, item)
            })
        })
    }

    /// Resolves proof within the item's immutable check relationships.
    ///
    /// # Errors
    /// Refuses relevant failures, unavailable capabilities, missing or stale
    /// evidence, and insufficient proof. This never authors a passing result.
    pub fn proof_for_item(
        &self,
        item: &Deliverable,
        cited: &[String],
        deep: bool,
        browser_available: bool,
    ) -> Result<Vec<String>, String> {
        let need = self.effective_need(item.check);
        if let Some(failure) = self.failure_for(item) {
            return Err(format!("{} is a relevant failed check for {} ({}): {}. Run this check successfully before verifying the item.", failure.id, item.id, failure.subject, failure.detail));
        }
        let mut scoped = self.clone();
        scoped.records.retain(|record| self.relevant(record, item));
        scoped.proof_for(cited, need, deep, browser_available)
    }

    /// Whether the record still describes the project as it is now. Functional
    /// and static records die with any change; a read-back only with a change
    /// to that very file.
    pub fn fresh(&self, record: &Evidence) -> bool {
        if record.kind == Kind::Readback {
            return self
                .changed
                .get(record.key())
                .is_none_or(|changed| *changed <= record.epoch);
        }
        record.epoch == self.epoch
    }

    pub fn get(&self, id: &str) -> Option<&Evidence> {
        self.records
            .iter()
            .find(|record| record.id.eq_ignore_ascii_case(id.trim()))
    }

    /// Fresh failures that no later fresh pass of the same check has replaced.
    pub fn active_failures(&self) -> Vec<&Evidence> {
        self.records
            .iter()
            .enumerate()
            .filter(|(index, record)| {
                !record.pass
                    && self.fresh(record)
                    && !self.records[index + 1..].iter().any(|later| {
                        later.pass
                            && later.kind == record.kind
                            && later.key() == record.key()
                            && self.fresh(later)
                    })
            })
            .map(|(_, record)| record)
            .collect()
    }

    pub fn active_failure_at_least(&self, class: Class) -> Option<&Evidence> {
        self.active_failures()
            .into_iter()
            .rev()
            .find(|record| record.class >= class)
    }

    pub fn best_passing(&self, need: Need) -> Option<&Evidence> {
        self.records
            .iter()
            .rev()
            .find(|record| record.pass && need.accepts(record.kind) && self.fresh(record))
    }

    pub fn has_fresh_pass_of(&self, kind: Kind) -> bool {
        self.records
            .iter()
            .any(|record| record.kind == kind && record.pass && self.fresh(record))
    }

    /// What a claim needs shown. Unless the deliverable names a capability,
    /// the run's changes decide: a readback for non-code, a run for code. A
    /// page's behaviour is a browser's to show, so changing a page raises a
    /// plain runtime need to a browser one.
    pub fn effective_need(&self, declared: Option<Need>) -> Need {
        let base = declared.unwrap_or(if self.code_changed {
            Need::Runtime
        } else {
            Need::Readback
        });
        if base == Need::Runtime && self.page_changed {
            Need::Browser
        } else {
            base
        }
    }

    /// Whether `need` can be shown in this environment at all.
    pub fn reachable(&self, need: Need, browser_available: bool) -> bool {
        need != Need::Browser || browser_available || self.best_passing(need).is_some()
    }

    /// Unverified deliverables whose needed capability does not exist here.
    /// They stay implemented; the run must say so instead of looking for a
    /// substitute.
    pub fn unreachable<'a>(
        &self,
        deliverables: &'a Deliverables,
        browser_available: bool,
    ) -> Vec<&'a Deliverable> {
        deliverables
            .unverified()
            .into_iter()
            .filter(|item| !self.reachable(self.effective_need(item.check), browser_available))
            .collect()
    }

    pub fn evidence_since(&self, mark: usize) -> usize {
        self.records
            .iter()
            .filter(|record| record.class >= Class::Static)
            .count()
            .saturating_sub(mark)
    }

    pub fn checks_recorded(&self) -> usize {
        self.records
            .iter()
            .filter(|record| record.class >= Class::Static)
            .count()
    }

    /// Resolves the evidence a deliverable is verified with, or says exactly
    /// what is missing. With no ids given, Fast attaches the best fresh passing
    /// record of the needed capability; Deep requires the model to name it.
    pub fn proof_for(
        &self,
        cited: &[String],
        need: Need,
        deep: bool,
        browser_available: bool,
    ) -> Result<Vec<String>, String> {
        if !self.reachable(need, browser_available) {
            return Err("This needs a real browser run and none is available here (no headless browser, playwright, puppeteer or cypress was found). A jsdom or node script does not stand in for it. Leave the item implemented and say it was not checked in a browser; do not look for a substitute.".to_owned());
        }
        if let Some(failure) = self.active_failure_at_least(need.class()) {
            return Err(format!(
                "{} failed after the last change ({}): {}. Fix it and run it again, or mark the item blocked and say what fails.",
                failure.id, failure.subject, failure.detail
            ));
        }
        if cited.is_empty() {
            if deep {
                return Err(format!("In Deep mode name the evidence ids that show it (ev-…, listed in <verification_state>). {}", self.missing(need, browser_available)));
            }
            return match self.best_passing(need) {
                Some(record) => Ok(vec![record.id.clone()]),
                None => Err(self.missing(need, browser_available)),
            };
        }
        let mut proof = Vec::new();
        for id in cited {
            let record = self.get(id).ok_or_else(|| {
                format!("unknown evidence '{id}': ids are issued by the runtime and listed in <verification_state>")
            })?;
            if !record.pass {
                return Err(format!("{} is a failed check; it cannot verify anything. Fix the problem and run the check again.", record.id));
            }
            if !self.fresh(record) {
                return Err(format!(
                    "{} is stale: the project changed after it was recorded. Run the check again.",
                    record.id
                ));
            }
            proof.push(record.id.clone());
        }
        if !proof
            .iter()
            .filter_map(|id| self.get(id))
            .any(|record| need.accepts(record.kind))
        {
            let shown = proof
                .iter()
                .filter_map(|id| self.get(id))
                .map(|record| format!("{} is {} evidence", record.id, record.kind.label()))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "{shown}, which does not show what this needs ({}). {}",
                need.label(),
                self.missing(need, browser_available)
            ));
        }
        Ok(proof)
    }

    fn missing(&self, need: Need, browser_available: bool) -> String {
        format!(
            "No fresh passing {} evidence exists after the last change. {}",
            need.label(),
            Self::how_to_get(need, browser_available)
        )
    }

    fn how_to_get(need: Need, browser_available: bool) -> &'static str {
        match need {
            Need::Browser if browser_available => "Run the page in a real browser: a headless browser (for example google-chrome --headless --dump-dom <file>), or a playwright/puppeteer/cypress script when one is installed. A jsdom or node script is not a browser.",
            Need::Browser => "A real browser run is not available here.",
            Need::Runtime => "Run the code: the project's tests, or a short script that exercises the behaviour. Reading the file back does not show it works.",
            Need::Test => "Run the project's tests.",
            Need::Build => "Run the project's build.",
            Need::Static => "Run the project's type-check or lint, or build or execute the code.",
            Need::Readback => "Read the changed file back.",
        }
    }

    /// The state the model must report from. Rebuilt on every turn, so
    /// compaction can never turn "implemented" into "verified".
    pub fn prompt(
        &self,
        deliverables: &Deliverables,
        closed: bool,
        browser_available: bool,
    ) -> String {
        if self.is_empty() && deliverables.is_empty() {
            return String::new();
        }
        let mut lines = Vec::new();
        let changed = self.changed.len();
        if changed > 0 || self.code_changed {
            lines.push(format!(
                "Files changed in this task: {changed}. Behaviour check required: {}.",
                if self.code_changed { "yes" } else { "no" }
            ));
        }
        let fresh = self
            .records
            .iter()
            .filter(|record| record.class >= Class::Static && self.fresh(record))
            .collect::<Vec<_>>();
        let stale = self
            .records
            .iter()
            .filter(|record| record.class >= Class::Static && !self.fresh(record))
            .count();
        if fresh.is_empty() && changed > 0 {
            lines.push("Checks since the last change: none.".to_owned());
        }
        for record in fresh.iter().rev().take(SHOWN_RECORDS).rev() {
            lines.push(format!(
                "  {} [{} {}] {}{}",
                record.id,
                record.kind.label(),
                if record.pass { "pass" } else { "FAIL" },
                record.subject,
                if record.pass || record.detail.is_empty() {
                    String::new()
                } else {
                    format!(" — {}", record.detail)
                }
            ));
            lines.push(format!(
                "    scope: {}{}",
                if record.deliverable_ids.is_empty() {
                    "project check (not selected for an acceptance item)".to_owned()
                } else {
                    record.deliverable_ids.join(", ")
                },
                record
                    .baseline_failure
                    .as_ref()
                    .map_or(String::new(), |id| format!(
                        "; pre-existing observed failure, identical to {id}"
                    ))
            ));
        }
        // Never hide an active failure merely because five newer passes exist.
        for failure in self.active_failures() {
            if fresh
                .iter()
                .rev()
                .take(SHOWN_RECORDS)
                .any(|record| record.id == failure.id)
            {
                continue;
            }
            lines.push(format!(
                "  {} [project warning FAIL] {} — {}",
                failure.id, failure.subject, failure.detail
            ));
        }
        if stale > 0 {
            lines.push(format!(
                "  ({stale} earlier checks are stale: the project changed after them)"
            ));
        }
        let unverified = deliverables.unverified_summary();
        if !unverified.is_empty() {
            lines.push(format!("Implemented, not verified: {unverified}."));
        }
        let unreachable =
            Deliverables::summarize(&self.unreachable(deliverables, browser_available));
        if !unreachable.is_empty() {
            lines.push(format!("Cannot be verified here (needs a real browser run, none available): {unreachable}. Report it as implemented, not checked in a browser."));
        } else if self.page_changed
            && deliverables.is_empty()
            && !self.reachable(Need::Browser, browser_available)
        {
            lines.push("A page was changed and no real browser is available here: report its behaviour as not checked in a browser.".to_owned());
        }
        if self.page_changed && self.best_passing(Need::Browser).is_none() && browser_available {
            lines.push("A page was changed; no real-browser run has passed since the last change. A jsdom or node script is not a browser: report page behaviour only from a browser run.".to_owned());
        }
        if closed {
            lines.push("The verification budget is used up: run no more checks. Report exactly what is verified and what is not.".to_owned());
        }
        lines.push("Say \"verified\" or \"works\" only for deliverables marked verified. An implemented deliverable is \"implemented, not verified\". Never write a result, count or behaviour you did not see in a check above.".to_owned());
        lines.push("Select run_terminal deliverable_ids before running acceptance checks. Associations are permanent, including failed verification citations. Unselected project failures remain warnings and must be reported; full-test requirements and legacy items retain project-wide failure blocking, and build requirements cover build checks.".to_owned());
        format!(
            "<verification_state>\n{}\n</verification_state>",
            lines.join("\n")
        )
    }
}

/// How a terminal command checks the work, from its text alone. Compound
/// commands (pipes, `;`, `&&`, redirects) are never evidence: their exit code
/// does not say which part succeeded.
pub fn classify_command(command: &str, changed: &[&str]) -> Option<Kind> {
    let tokens = simple_tokens(command)?;
    let mut words: Vec<String> = tokens
        .iter()
        .map(|token| token.to_ascii_lowercase())
        .collect();
    while let Some(first) = words.first() {
        let skip = first.contains('=') && !first.starts_with('-')
            || matches!(first.as_str(), "npx" | "bunx" | "env" | "time")
            || first.starts_with("--yes")
            || first == "-y";
        if !skip {
            break;
        }
        words.remove(0);
    }
    if words.first().map(String::as_str) == Some("timeout") && words.len() > 2 {
        words.drain(0..2);
    }
    let program = Path::new(words.first()?.as_str())
        .file_name()?
        .to_str()?
        .to_owned();
    let args: Vec<&str> = words[1..].iter().map(String::as_str).collect();
    let sub = args.iter().copied().find(|arg| !arg.starts_with('-'));
    let has = |flag: &str| args.contains(&flag);
    let script_runner = |args: &[&str]| -> Option<Kind> {
        let target = args.iter().copied().find(|arg| !arg.starts_with('-'))?;
        let inline = args
            .iter()
            .any(|arg| matches!(*arg, "-e" | "-p" | "--eval" | "-c" | "--print"));
        if inline {
            let code = tokens.join(" ");
            let mentions_project = changed.iter().any(|path| {
                Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| code.contains(name))
            });
            return mentions_project.then_some(Kind::Run);
        }
        let _ = target;
        Some(Kind::Run)
    };
    match program.as_str() {
        "cargo" => match sub? {
            "test" | "nextest" | "bench" => Some(Kind::Test),
            "check" | "clippy" | "doc" => Some(Kind::Static),
            "fmt" => None,
            "build" => Some(Kind::Build),
            "run" => Some(Kind::Run),
            _ => None,
        },
        "npm" | "pnpm" | "yarn" | "bun" => match sub? {
            "test" | "t" | "vitest" | "jest" => Some(Kind::Test),
            "build" => Some(Kind::Build),
            "lint" | "typecheck" | "type-check" | "check" | "tsc" => Some(Kind::Static),
            "run" | "exec" => {
                let script = args
                    .iter()
                    .copied()
                    .filter(|arg| !arg.starts_with('-'))
                    .nth(1)?;
                if script.contains("test") || script.contains("spec") || script.contains("e2e") {
                    Some(Kind::Test)
                } else if script.contains("build") || script.contains("compile") {
                    Some(Kind::Build)
                } else if script.contains("lint")
                    || script.contains("type")
                    || script.contains("check")
                {
                    Some(Kind::Static)
                } else {
                    None
                }
            }
            _ => None,
        },
        "vitest" | "jest" | "mocha" | "ava" | "pytest" | "phpunit" | "rspec" | "tap" | "bats" => {
            Some(Kind::Test)
        }
        "playwright" | "cypress" | "puppeteer" | "chromium" | "chromium-browser" | "chrome"
        | "google-chrome" | "firefox" => {
            if matches!(
                program.as_str(),
                "chromium" | "chromium-browser" | "chrome" | "google-chrome" | "firefox"
            ) && !args.iter().any(|arg| arg.starts_with("--headless"))
            {
                None
            } else {
                Some(Kind::Browser)
            }
        }
        "go" => match sub? {
            "test" => Some(Kind::Test),
            "build" => Some(Kind::Build),
            "vet" => Some(Kind::Static),
            "run" => Some(Kind::Run),
            _ => None,
        },
        "tsc" => Some(if has("--noemit") {
            Kind::Static
        } else {
            Kind::Build
        }),
        "eslint" | "ruff" | "flake8" | "mypy" | "pyright" | "shellcheck" | "biome" | "pylint" => {
            Some(Kind::Static)
        }
        "node" | "deno" | "bun-run" => {
            if has("--test") || sub == Some("test") {
                Some(Kind::Test)
            } else if has("--check") || has("-c") || sub == Some("check") {
                Some(Kind::Static)
            } else if program == "deno" && sub == Some("run") {
                Some(Kind::Run)
            } else {
                script_runner(&args)
            }
        }
        "python" | "python3" | "python2" | "py" => {
            if let Some(position) = args.iter().position(|arg| *arg == "-m") {
                return match args.get(position + 1).copied()? {
                    "pytest" | "unittest" | "nose" | "doctest" => Some(Kind::Test),
                    "py_compile" | "compileall" | "mypy" | "ruff" | "flake8" | "pylint" => {
                        Some(Kind::Static)
                    }
                    "http.server" | "pip" | "venv" | "ensurepip" => None,
                    _ => Some(Kind::Run),
                };
            }
            script_runner(&args)
        }
        "ruby" | "php" | "lua" | "perl" | "dart" => {
            if has("-c") || has("-l") {
                Some(Kind::Static)
            } else {
                script_runner(&args)
            }
        }
        "bash" | "sh" | "zsh" => {
            if has("-n") {
                Some(Kind::Static)
            } else if has("-c") {
                None
            } else {
                script_runner(&args)
            }
        }
        "make" | "gmake" | "just" => match sub {
            Some("test" | "check" | "tests") => Some(Kind::Test),
            Some("lint") => Some(Kind::Static),
            Some("run" | "start" | "serve" | "dev" | "clean" | "install") => None,
            _ => Some(Kind::Build),
        },
        "mvn" | "gradle" | "gradlew" | "./gradlew" | "mvnw" => {
            if args
                .iter()
                .any(|arg| arg.contains("test") || *arg == "verify")
            {
                Some(Kind::Test)
            } else if args
                .iter()
                .any(|arg| matches!(*arg, "build" | "compile" | "package"))
            {
                Some(Kind::Build)
            } else {
                None
            }
        }
        "dotnet" => match sub? {
            "test" => Some(Kind::Test),
            "build" => Some(Kind::Build),
            "run" => Some(Kind::Run),
            _ => None,
        },
        "javac" | "tsup" | "vite" | "webpack" | "esbuild" | "rollup" => {
            if program == "vite" && sub != Some("build") {
                None
            } else {
                Some(Kind::Build)
            }
        }
        _ => None,
    }
}

/// Splits a command into words, honouring quotes. `None` for anything with
/// shell control syntax outside quotes.
fn simple_tokens(command: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut has_token = false;
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();
    while let Some(character) = chars.next() {
        match quote {
            Some(open) if character == open => quote = None,
            // Inside double quotes the shell still substitutes commands.
            Some('"') if character == '`' || (character == '$' && chars.peek() == Some(&'(')) => {
                return None
            }
            Some('"') if character == '\\' => return None,
            Some(_) => current.push(character),
            None => match character {
                '\'' | '"' => {
                    quote = Some(character);
                    has_token = true;
                }
                // An escape changes where the shell sees a quote or separator
                // end, so a command using one is never trusted as simple.
                '|' | ';' | '&' | '<' | '>' | '`' | '\n' | '\\' | '(' | ')' => return None,
                '$' if chars.peek() == Some(&'(') => return None,
                character if character.is_whitespace() => {
                    if has_token {
                        tokens.push(std::mem::take(&mut current));
                        has_token = false;
                    }
                }
                _ => {
                    current.push(character);
                    has_token = true;
                }
            },
        }
    }
    if quote.is_some() {
        return None;
    }
    if has_token {
        tokens.push(current);
    }
    (!tokens.is_empty()).then_some(tokens)
}

/// What a terminal command does to the project, judged from its text alone and
/// never optimistically: anything not recognised as a check or as plainly
/// read-only is treated as a possible change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    /// A recognised test, build, lint or run. Its exit code is evidence.
    Check(Kind),
    /// Cannot change project files.
    ReadOnly,
    /// May change project files; which ones is unknown.
    Mutating,
}

pub fn terminal_effect(command: &str, changed: &[&str]) -> Effect {
    if let Some(kind) = classify_command(command, changed) {
        return Effect::Check(kind);
    }
    if is_read_only(command) {
        Effect::ReadOnly
    } else {
        Effect::Mutating
    }
}

const READ_ONLY_PROGRAMS: [&str; 34] = [
    "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "pwd", "echo", "printf",
    "which", "whoami", "id", "uname", "stat", "file", "du", "df", "tree", "diff", "cmp",
    "basename", "dirname", "realpath", "readlink", "nl", "cut", "tr", "true", "false", "test",
    "jq",
];

const READ_ONLY_GIT: [&str; 12] = [
    "status",
    "log",
    "diff",
    "show",
    "rev-parse",
    "ls-files",
    "blame",
    "describe",
    "shortlog",
    "ls-tree",
    "cat-file",
    "rev-list",
];

/// A single command or a pipeline of single commands, every one of which is a
/// known inspector with no flag that writes or executes. Everything else,
/// including `;`, `&&`, redirects and substitutions, is not read-only.
fn is_read_only(command: &str) -> bool {
    let Some(stages) = split_pipeline(command) else {
        return false;
    };
    stages
        .iter()
        .all(|stage| simple_tokens(stage).is_some_and(|tokens| read_only_words(&tokens)))
}

/// Splits at unquoted single `|`. `None` for `||` or any backslash outside
/// single quotes; the stages are re-checked by `simple_tokens`.
fn split_pipeline(command: &str) -> Option<Vec<String>> {
    let mut stages = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();
    while let Some(character) = chars.next() {
        match quote {
            Some(open) => {
                if character == '\\' && open != '\'' {
                    return None;
                }
                if character == open {
                    quote = None;
                }
                current.push(character);
            }
            None => match character {
                '\\' => return None,
                '\'' | '"' => {
                    quote = Some(character);
                    current.push(character);
                }
                '|' => {
                    if chars.peek() == Some(&'|') {
                        return None;
                    }
                    stages.push(std::mem::take(&mut current));
                }
                _ => current.push(character),
            },
        }
    }
    stages.push(current);
    Some(stages)
}

fn read_only_words(tokens: &[String]) -> bool {
    let Some(first) = tokens.first() else {
        return false;
    };
    if first.contains('=') {
        return false;
    }
    let Some(program) = Path::new(first).file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let args = tokens[1..].iter().map(String::as_str).collect::<Vec<_>>();
    if args.len() == 1 && matches!(args[0], "--version" | "-V" | "--help") {
        return true;
    }
    let any = |flags: &[&str]| {
        args.iter().any(|arg| {
            flags
                .iter()
                .any(|flag| arg == flag || arg.starts_with(&format!("{flag}=")))
        })
    };
    match program {
        "find" => !any(&[
            "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf",
            "-fls",
        ]),
        "rg" => !any(&["--pre"]),
        "tree" => !any(&["-o"]),
        "git" => {
            let mut index = 0;
            while index < args.len() && args[index].starts_with('-') {
                index += if args[index] == "-C" { 2 } else { 1 };
            }
            args.get(index)
                .is_some_and(|sub| READ_ONLY_GIT.contains(sub))
                && !any(&["--output", "--ext-diff", "--textconv"])
        }
        program => READ_ONLY_PROGRAMS.contains(&program),
    }
}

/// Words of a command that look like code files, wherever they sit in it. Not
/// a parse: a mutating command naming a file is assumed to have changed it.
pub fn mentioned_code_paths(command: &str) -> Vec<String> {
    let mut paths = command
        .split(|character: char| character.is_whitespace() || "'\"`;&|<>()=,".contains(character))
        .filter(|word| !word.is_empty() && !word.starts_with('-') && is_code_path(word))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths.truncate(MAX_CHANGED);
    paths
}

const BROWSER_PROGRAMS: [&str; 6] = [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "chrome",
    "firefox",
];
const BROWSER_DRIVERS: [&str; 7] = [
    "playwright",
    "@playwright/test",
    "puppeteer",
    "puppeteer-core",
    "cypress",
    "selenium-webdriver",
    "webdriverio",
];

/// Whether a real browser can be used here: a browser driver in the project, or
/// a browser or driver executable on PATH.
pub fn browser_available(root: &Path) -> bool {
    if BROWSER_DRIVERS
        .iter()
        .any(|driver| root.join("node_modules").join(driver).is_dir())
    {
        return true;
    }
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|directory| {
        BROWSER_PROGRAMS
            .iter()
            .chain(["playwright", "cypress"].iter())
            .any(|program| directory.join(program).is_file())
    })
}

/// A script run that imports a browser driver drives a real browser; one that
/// imports jsdom does not. Looks at the script's own import lines only.
pub fn script_drives_browser(root: &Path, command: &str) -> bool {
    let Some(tokens) = simple_tokens(command) else {
        return false;
    };
    tokens
        .iter()
        .filter(|token| {
            [".js", ".mjs", ".cjs", ".ts", ".py"]
                .iter()
                .any(|extension| token.ends_with(extension))
        })
        .filter_map(|token| std::fs::read_to_string(root.join(token)).ok())
        .any(|source| {
            source.lines().take(200).any(|line| {
                let line = line.trim_start();
                (line.contains("require(")
                    || line.starts_with("import ")
                    || line.starts_with("from "))
                    && (BROWSER_DRIVERS.iter().any(|driver| line.contains(driver))
                        || line.contains("selenium"))
            })
        })
}

/// The project's own test command, when it plainly has one.
pub fn detect_test_command(root: &Path) -> Option<String> {
    if let Ok(text) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            let script = value
                .get("scripts")
                .and_then(|scripts| scripts.get("test"))
                .and_then(serde_json::Value::as_str);
            if let Some(script) = script {
                if !script.contains("no test specified") {
                    return Some("npm test".into());
                }
            }
        }
    }
    if root.join("Cargo.toml").is_file() && root.join("src").is_dir() {
        let has_tests = root.join("tests").is_dir()
            || std::fs::read_to_string(root.join("src/lib.rs"))
                .is_ok_and(|source| source.contains("#[cfg(test)]") || source.contains("#[test]"));
        if has_tests {
            return Some("cargo test".into());
        }
    }
    let pytest = ["pytest.ini", "tox.ini", "conftest.py"]
        .iter()
        .any(|file| root.join(file).is_file())
        || root.join("tests").is_dir() && root.join("pyproject.toml").is_file();
    pytest.then(|| "pytest".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(command: &str) -> Option<Kind> {
        classify_command(command, &["app.js"])
    }

    #[test]
    fn project_checks_are_classified_and_plain_commands_are_not_evidence() {
        assert_eq!(kind("npm test"), Some(Kind::Test));
        assert_eq!(kind("npm run test:unit"), Some(Kind::Test));
        assert_eq!(kind("cargo test --lib"), Some(Kind::Test));
        assert_eq!(kind("npx vitest run"), Some(Kind::Test));
        assert_eq!(kind("python -m pytest -q"), Some(Kind::Test));
        assert_eq!(kind("node --test"), Some(Kind::Test));
        assert_eq!(kind("npx tsc --noEmit"), Some(Kind::Static));
        assert_eq!(kind("node --check app.js"), Some(Kind::Static));
        assert_eq!(kind("python -m py_compile app.py"), Some(Kind::Static));
        assert_eq!(kind("npm run build"), Some(Kind::Build));
        assert_eq!(kind("cargo build"), Some(Kind::Build));
        assert_eq!(kind("node check.js"), Some(Kind::Run));
        assert_eq!(kind("python3 verify.py"), Some(Kind::Run));
        assert_eq!(kind("npx playwright test"), Some(Kind::Browser));
        for plain in [
            "ls",
            "cat app.js",
            "grep -r foo .",
            "git status",
            "echo run test ok",
            "pwd",
            "sed -n 1,5p app.js",
            "cd app",
            "mkdir out",
        ] {
            assert_eq!(kind(plain), None, "{plain}");
        }
    }

    #[test]
    fn compound_commands_and_look_alikes_are_never_evidence() {
        for compound in [
            "npm test | tail -5",
            "npm test; true",
            "node a.js || true",
            "npm test > out.txt",
            "echo $(npm test)",
        ] {
            assert_eq!(kind(compound), None, "{compound}");
        }
        assert_eq!(kind("echo 'npm test'"), None);
    }

    #[test]
    fn an_inline_script_counts_only_when_it_touches_the_changed_files() {
        assert_eq!(kind("node -e \"console.log('ok')\""), None);
        assert_eq!(
            kind("node -e \"require('./app.js').start()\""),
            Some(Kind::Run)
        );
        assert_eq!(kind("python -c 'print(1)'"), None);
    }

    #[test]
    fn a_change_makes_functional_evidence_stale_and_readback_is_per_file() {
        let mut ledger = Verification::default();
        ledger.note_change(Some("app.js"));
        let read = ledger.record(Kind::Readback, "app.js", true, "ok", 1);
        let test = ledger.record(Kind::Test, "npm test", true, "exit 0", 2);
        assert!(ledger.fresh(ledger.get(&read).unwrap()));
        assert!(ledger.fresh(ledger.get(&test).unwrap()));
        ledger.note_change(Some("style.css"));
        assert!(
            ledger.fresh(ledger.get(&read).unwrap()),
            "another file changed"
        );
        assert!(!ledger.fresh(ledger.get(&test).unwrap()));
        ledger.note_change(Some("app.js"));
        assert!(!ledger.fresh(ledger.get(&read).unwrap()));
        assert!(ledger.best_passing(Need::Readback).is_none());
    }

    #[test]
    fn a_failure_blocks_verification_until_the_same_check_passes_again() {
        let mut ledger = Verification::default();
        ledger.note_change(Some("app.js"));
        ledger.record(Kind::Readback, "app.js", true, "", 1);
        let failed = ledger.record(Kind::Run, "node check.js", false, "TypeError: x", 2);
        assert_eq!(ledger.active_failures().len(), 1);
        let error = ledger
            .proof_for(&[], Need::Runtime, false, false)
            .unwrap_err();
        assert!(
            error.contains(&failed) && error.contains("TypeError"),
            "{error}"
        );
        let passed = ledger.record(Kind::Run, "node other.js", true, "exit 0", 3);
        let error = ledger
            .proof_for(&[passed.clone()], Need::Runtime, false, false)
            .unwrap_err();
        assert!(
            error.contains(&failed) && error.contains("TypeError"),
            "{error}"
        );
        ledger.record(Kind::Run, "node check.js", true, "exit 0", 4);
        assert!(ledger.active_failures().is_empty());
        assert!(ledger.proof_for(&[], Need::Runtime, false, false).is_ok());
    }

    #[test]
    fn acceptance_proof_is_scoped_and_project_failures_stay_visible() {
        let mut items = Deliverables::default();
        let id = items
            .add_checked(
                None,
                "",
                "automatic response continues",
                Some(Need::Browser),
            )
            .unwrap();
        items.implement(&id, "built").unwrap();
        let mut ledger = Verification::default();
        ledger.note_change(Some("app.js"));
        ledger
            .bind("browser interaction", std::slice::from_ref(&id))
            .unwrap();
        let pass = ledger.record(
            Kind::Browser,
            "browser interaction",
            true,
            "several turns continued",
            1,
        );
        let failure = ledger.record(Kind::Test, "project suite", false, "strategy assertion", 2);
        for deep in [false, true] {
            let cited = if deep { vec![pass.clone()] } else { vec![] };
            assert_eq!(
                ledger
                    .proof_for_item(&items.items[0], &cited, deep, true)
                    .unwrap(),
                vec![pass.clone()]
            );
        }
        items.verify(&id, vec![pass.clone()]).unwrap();
        assert!(!items.sync_failures(&ledger));
        assert!(ledger.blocking_failure(&items).is_none());
        assert_eq!(ledger.active_failures()[0].id, failure);
        assert!(ledger
            .prompt(&items, false, true)
            .contains("strategy assertion"));

        let broad = items
            .add_checked(None, "", "all project tests pass", Some(Need::Test))
            .unwrap();
        items.implement(&broad, "built").unwrap();
        assert!(ledger
            .proof_for_item(&items.items[1], &[pass], false, true)
            .unwrap_err()
            .contains(&failure));
        items.sync_failures(&ledger);
        assert!(!items.items[1].failing.is_empty());
        assert_eq!(
            items.items[0].status,
            super::super::deliverables::DeliverableStatus::Verified
        );
    }

    #[test]
    fn selected_failures_cannot_be_detached_by_retry_citation_or_ledger_eviction() {
        let mut items = Deliverables::default();
        let id = items
            .add_checked(None, "", "runtime responds", Some(Need::Runtime))
            .unwrap();
        items.implement(&id, "built").unwrap();
        let mut ledger = Verification::default();
        ledger.note_change(Some("app.js"));
        ledger
            .bind("runtime check", std::slice::from_ref(&id))
            .unwrap();
        let failure = ledger.record(Kind::Run, "runtime check", false, "did not respond", 1);
        ledger.bind("runtime check", &[]).unwrap();
        ledger
            .bind("other check", std::slice::from_ref(&id))
            .unwrap();
        let pass = ledger.record(Kind::Run, "other check", true, "exit 0", 2);
        assert!(ledger
            .proof_for_item(&items.items[0], std::slice::from_ref(&pass), false, false)
            .unwrap_err()
            .contains(&failure));
        for n in 3..70 {
            ledger.record(Kind::Test, &format!("suite-{n}"), true, "exit 0", n);
        }
        assert!(
            ledger.get(&failure).is_some(),
            "active contradictions must not be evicted by passes"
        );
        assert!(ledger
            .proof_for_item(&items.items[0], &[], false, false)
            .is_err());
        ledger.record(Kind::Run, "runtime check", true, "exit 0", 70);
        assert!(ledger
            .proof_for_item(&items.items[0], &[], false, false)
            .is_ok());

        // Rejected post-result citations are also permanent selections.
        let failed_citation =
            ledger.record(Kind::Run, "another failure", false, "runtime failed", 71);
        assert!(ledger
            .attach(&id, &[failed_citation, "ev-unknown".into()])
            .is_err());
        assert!(ledger
            .proof_for_item(&items.items[0], &[], false, false)
            .is_err());
        let mut resumed: Verification =
            serde_json::from_value(serde_json::to_value(&ledger).unwrap()).unwrap();
        resumed.start_run();
        let retry = resumed.record(Kind::Run, "another failure", false, "runtime failed", 0);
        assert!(resumed.get(&retry).unwrap().deliverable_ids.contains(&id));
        assert!(resumed
            .proof_for_item(&items.items[0], &[], false, false)
            .is_err());
    }

    #[test]
    fn exact_baseline_failure_is_provenance_and_never_an_exemption() {
        let mut ledger = Verification::default();
        let baseline = ledger.record(Kind::Test, "suite", false, "assertion B", 0);
        ledger.note_change(Some("app.js"));
        let after = ledger.record(Kind::Test, "suite", false, "assertion B", 1);
        assert_eq!(
            ledger.get(&after).unwrap().baseline_failure.as_deref(),
            Some(baseline.as_str())
        );
        let different = ledger.record(Kind::Test, "suite", false, "assertion C", 2);
        assert!(ledger.get(&different).unwrap().baseline_failure.is_none());
        let mut items = Deliverables::default();
        let id = items
            .add_checked(None, "", "runtime works", Some(Need::Runtime))
            .unwrap();
        items.implement(&id, "built").unwrap();
        ledger
            .bind("targeted runtime", std::slice::from_ref(&id))
            .unwrap();
        ledger.record(Kind::Run, "targeted runtime", true, "exit 0", 3);
        assert!(ledger
            .proof_for_item(&items.items[0], &[], false, false)
            .is_ok());
        ledger.attach(&id, &[after]).unwrap();
        assert!(ledger
            .proof_for_item(&items.items[0], &[], false, false)
            .is_err());
    }

    #[test]
    fn scoped_evidence_stales_on_mutation_and_legacy_items_remain_conservative() {
        let mut items = Deliverables::default();
        let id = items.add(None, "", "runtime works").unwrap();
        items.implement(&id, "built").unwrap();
        let mut ledger = Verification::default();
        ledger.note_change(Some("app.js"));
        ledger.bind("runtime", &[id]).unwrap();
        let pass = ledger.record(Kind::Run, "runtime", true, "exit 0", 1);
        assert!(ledger
            .proof_for_item(&items.items[0], std::slice::from_ref(&pass), true, false)
            .is_ok());
        ledger.note_change(Some("app.js"));
        assert!(ledger
            .proof_for_item(&items.items[0], &[pass], true, false)
            .unwrap_err()
            .contains("stale"));
        let legacy: Deliverables = serde_json::from_value(serde_json::json!({"items":[{"id":"old","text":"runtime works","status":"implemented"}]})).unwrap();
        ledger.record(Kind::Run, "runtime", true, "exit 0", 2);
        ledger.record(Kind::Test, "unselected suite", false, "failed", 3);
        assert!(ledger
            .proof_for_item(&legacy.items[0], &[], false, false)
            .is_err());
        assert_eq!(
            legacy.items[0].verification_scope,
            VerificationScope::Project
        );
    }

    #[test]
    fn display_truncation_does_not_merge_different_check_bindings() {
        let mut ledger = Verification::default();
        let tail = "x".repeat(MAX_SUBJECT_CHARS + 20);
        let first = format!("node first.js {tail}");
        let second = format!("node second.js {tail}");
        ledger.bind(&first, &["d-001".into()]).unwrap();
        let failed = ledger.record(Kind::Run, &first, false, "failure", 1);
        ledger.record(Kind::Run, &second, true, "exit 0", 2);
        assert_eq!(ledger.active_failures()[0].id, failed);
        assert!(ledger.records[1].deliverable_ids.is_empty());
        let path = format!("{tail}/app.js");
        let readback = ledger.record(Kind::Readback, &path, true, "on disk", 3);
        ledger.note_change(Some(&path));
        assert!(!ledger.fresh(ledger.get(&readback).unwrap()));
    }

    #[test]
    fn build_requirements_cover_build_results_without_project_test_poisoning() {
        let mut items = Deliverables::default();
        let id = items
            .add_checked(None, "", "project builds", Some(Need::Build))
            .unwrap();
        items.implement(&id, "built").unwrap();
        let mut ledger = Verification::default();
        ledger.note_change(Some("app.js"));
        ledger.record(
            Kind::Test,
            "unselected tests",
            false,
            "quality assertion",
            1,
        );
        let pass = ledger.record(Kind::Build, "build", true, "exit 0", 2);
        assert_eq!(
            ledger
                .proof_for_item(&items.items[0], &[], false, false)
                .unwrap(),
            vec![pass]
        );
        ledger.record(Kind::Build, "build", false, "compiler failed", 3);
        assert!(ledger
            .proof_for_item(&items.items[0], &[], false, false)
            .is_err());
    }

    #[test]
    fn readback_and_static_evidence_cannot_verify_behaviour() {
        let mut ledger = Verification::default();
        ledger.note_change(Some("app.js"));
        let read = ledger.record(Kind::Readback, "app.js", true, "", 1);
        let build = ledger.record(Kind::Build, "npm run build", true, "exit 0", 2);
        for cited in [vec![], vec![read.clone()], vec![read, build.clone()]] {
            assert!(ledger
                .proof_for(&cited, Need::Runtime, false, false)
                .is_err());
        }
        assert!(ledger
            .proof_for(&[build], Need::Static, true, false)
            .is_ok());
        assert!(ledger.proof_for(&[], Need::Static, true, false).is_err());
        assert!(ledger
            .proof_for(&["ev-999".into()], Need::Static, false, false)
            .is_err());
    }

    #[test]
    fn the_ledger_is_bounded_and_round_trips() {
        let mut ledger = Verification::default();
        ledger.note_change(Some("a.js"));
        for index in 0..60 {
            ledger.record(Kind::Run, &format!("node {index}.js"), true, "", index);
        }
        assert_eq!(ledger.records.len(), MAX_RECORDS);
        let value = serde_json::to_value(&ledger).unwrap();
        assert_eq!(
            serde_json::from_value::<Verification>(value).unwrap(),
            ledger
        );
        assert!(
            serde_json::from_value::<Verification>(serde_json::json!({}))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn required_class_follows_what_was_changed() {
        let mut ledger = Verification::default();
        ledger.note_change(Some("notes.md"));
        assert_eq!(ledger.effective_need(None), Need::Readback);
        ledger.note_change(Some("src/app.tsx"));
        assert_eq!(ledger.effective_need(None), Need::Runtime);
        ledger.note_change(Some("index.html"));
        assert_eq!(ledger.effective_need(None), Need::Browser);
        assert_eq!(ledger.effective_need(Some(Need::Test)), Need::Test);
    }

    #[test]
    fn a_project_test_command_is_detected_only_when_one_plainly_exists() {
        let base = std::env::temp_dir().join(format!("verify-detect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        assert_eq!(detect_test_command(&base), None);
        std::fs::write(
            base.join("package.json"),
            r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#,
        )
        .unwrap();
        assert_eq!(detect_test_command(&base), None);
        std::fs::write(
            base.join("package.json"),
            r#"{"scripts":{"test":"vitest run"}}"#,
        )
        .unwrap();
        assert_eq!(detect_test_command(&base).as_deref(), Some("npm test"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_prompt_lists_fresh_checks_and_forbids_unearned_claims() {
        let mut ledger = Verification::default();
        let mut deliverables = Deliverables::default();
        deliverables.add(None, "", "the button works").unwrap();
        deliverables.implement("d-001", "").unwrap();
        ledger.note_change(Some("app.js"));
        let failed = ledger.record(Kind::Run, "node check.js", false, "TypeError: x", 2);
        let prompt = ledger.prompt(&deliverables, false, true);
        assert!(prompt.contains(&format!("{failed} [run FAIL] node check.js — TypeError: x")));
        assert!(prompt.contains("Implemented, not verified: d-001"));
        assert!(prompt.contains("only for deliverables marked verified"));
        assert!(Verification::default()
            .prompt(&Deliverables::default(), false, true)
            .is_empty());
    }

    #[test]
    fn evidence_capabilities_accept_only_what_can_show_the_claim() {
        let table = [
            (Need::Readback, [true, true, true, true, true, true]),
            (Need::Static, [false, true, true, true, true, true]),
            (Need::Build, [false, false, true, false, false, false]),
            (Need::Test, [false, false, false, true, false, true]),
            (Need::Runtime, [false, false, false, true, true, true]),
            (Need::Browser, [false, false, false, false, false, true]),
        ];
        let kinds = [
            Kind::Readback,
            Kind::Static,
            Kind::Build,
            Kind::Test,
            Kind::Run,
            Kind::Browser,
        ];
        for (need, expected) in table {
            for (kind, expected) in kinds.iter().zip(expected) {
                assert_eq!(need.accepts(*kind), expected, "{need:?} vs {kind:?}");
            }
        }
        assert_eq!(Need::parse("functional"), Some(Need::Runtime));
        assert_eq!(Need::parse("browser_interaction"), Some(Need::Browser));
        assert_eq!(Need::parse("static_check"), Some(Need::Static));
        assert_eq!(Need::parse("magic"), None);
        let legacy: Deliverables = serde_json::from_value(serde_json::json!({
            "items": [{"id":"d-001","text":"x","status":"pending","check":"functional"}]
        }))
        .unwrap();
        assert_eq!(legacy.items[0].check, Some(Need::Runtime));
    }

    #[test]
    fn a_changed_page_needs_a_browser_and_a_stand_in_script_cannot_supply_it() {
        let mut ledger = Verification::default();
        ledger.note_change(Some("index.html"));
        assert_eq!(ledger.effective_need(None), Need::Browser);
        assert_eq!(ledger.effective_need(Some(Need::Runtime)), Need::Browser);
        assert_eq!(ledger.effective_need(Some(Need::Build)), Need::Build);
        let stand_in = ledger.record(Kind::Run, "node jsdom-check.js", true, "exit 0", 1);
        let error = ledger
            .proof_for(&[stand_in.clone()], Need::Browser, false, true)
            .unwrap_err();
        assert!(error.contains("browser"), "{error}");
        let unreachable = ledger
            .proof_for(&[stand_in], Need::Browser, false, false)
            .unwrap_err();
        assert!(unreachable.contains("none is available"), "{unreachable}");
        assert!(!ledger.reachable(Need::Browser, false));
        assert!(ledger.reachable(Need::Runtime, false));
        let real = ledger.record(Kind::Browser, "chromium --headless page", true, "exit 0", 2);
        assert!(ledger
            .proof_for(&[real], Need::Browser, false, true)
            .is_ok());
    }

    fn effect(command: &str) -> Effect {
        terminal_effect(command, &["app.js"])
    }

    #[test]
    fn plainly_read_only_commands_are_not_mutations() {
        for command in [
            "cat app.js",
            "ls -la",
            "grep -rn foo src | head -20",
            "git status",
            "git -C sub log --oneline",
            "git diff HEAD~1",
            "find . -name '*.js'",
            "wc -l app.js",
            "node --version",
            "echo 'a > b'",
            "rg --no-heading foo",
        ] {
            assert_eq!(effect(command), Effect::ReadOnly, "{command}");
        }
    }

    #[test]
    fn anything_that_may_write_is_treated_as_a_mutation() {
        for command in [
            "sed -i 's/a/b/' app.js",
            "mv app.js old.js",
            "echo hi > app.js",
            "cat a >> b.txt",
            "cat app.js | tee out.js",
            "ls; rm -rf build",
            "ls && touch x",
            "cat app.js || touch x",
            "echo \\\" ; touch f ; echo \\\"",
            "echo \"a\\\" ; touch f ; echo \"",
            "echo \"$(touch f)\"",
            "echo `touch f`",
            "echo $(touch f)",
            "(touch f)",
            "find . -name '*.js' -delete",
            "find . -exec rm {} +",
            "git checkout -- app.js",
            "git commit -am x",
            "git diff --output=out.patch",
            "rg --pre ./hook foo",
            "awk '{print}' app.js",
            "sort -o app.js app.js",
            "npm install",
            "cp a b",
            "chmod +x run.sh",
            "FOO=1 cat app.js",
            "python3 -c 'open(\"a\",\"w\")'",
        ] {
            assert_eq!(effect(command), Effect::Mutating, "{command}");
        }
    }

    #[test]
    fn a_recognised_check_is_a_check_not_a_mutation() {
        assert_eq!(effect("node check.js"), Effect::Check(Kind::Run));
        assert_eq!(effect("npm test"), Effect::Check(Kind::Test));
    }

    #[test]
    fn code_files_named_by_a_command_are_found_without_parsing_it() {
        assert_eq!(
            mentioned_code_paths("sed -i 's/a/b/' src/app.js && mv a.ts \"b.ts\" notes.md"),
            vec!["a.ts", "b.ts", "src/app.js"]
        );
        assert!(mentioned_code_paths("npm install").is_empty());
    }
}
