//! Small per-run working memory. This is a handoff list, not project knowledge.
use super::deliverables::Deliverables;
use serde::{Deserialize, Serialize};

/// How well an entry is established. Optional: entries without a status keep
/// their historical meaning (a plain finding).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Confirmed,
    Inferred,
    Unknown,
    Contradicted,
}

impl Status {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_lowercase().as_str() {
            "confirmed" | "verified" | "observed" => Ok(Status::Confirmed),
            "inferred" | "assumed" | "likely" => Ok(Status::Inferred),
            "unknown" | "open" | "unresolved" => Ok(Status::Unknown),
            "contradicted" | "refuted" | "disproved" => Ok(Status::Contradicted),
            other => Err(format!(
                "unsupported task memory status '{other}': use confirmed, inferred, unknown or contradicted"
            )),
        }
    }

    pub fn is_unresolved(self) -> bool {
        matches!(self, Status::Unknown | Status::Contradicted)
    }

    fn label(self) -> &'static str {
        match self {
            Status::Confirmed => "confirmed",
            Status::Inferred => "inferred",
            Status::Unknown => "unknown",
            Status::Contradicted => "contradicted",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskMemoryEntry {
    pub id: String,
    pub finding: String,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub implication: String,
    #[serde(default)]
    pub next: String,
    #[serde(default)]
    pub supersedes: Option<String>,
    #[serde(default)]
    pub invalidated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteKind {
    Record,
    Update,
}

/// A requested write. `None` leaves a field unchanged; `Some("")` clears it.
#[derive(Clone, Debug, Default)]
pub struct Change {
    pub id: Option<String>,
    pub finding: Option<String>,
    pub evidence: Option<String>,
    pub implication: Option<String>,
    pub next: Option<String>,
    pub supersedes: Option<String>,
    pub status: Option<Status>,
}

#[derive(Clone, Debug)]
pub struct Applied {
    pub id: String,
    pub created: bool,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskMemory {
    #[serde(default)]
    pub entries: Vec<TaskMemoryEntry>,
    #[serde(default)]
    pub revision: u64,
    /// What the user asked to be produced, kept beside what the run learned so
    /// both persist, restart and survive compaction together.
    #[serde(default, skip_serializing_if = "Deliverables::is_empty")]
    pub deliverables: Deliverables,
}
impl TaskMemory {
    pub fn upsert(
        &mut self,
        id: Option<&str>,
        finding: String,
        evidence: String,
        implication: String,
        next: String,
        supersedes: Option<String>,
    ) -> Result<String, String> {
        self.upsert_with_status(id, finding, evidence, implication, next, supersedes, None)
    }

    /// A full replace of an entry (or a new one): every field is taken as given.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_with_status(
        &mut self,
        id: Option<&str>,
        finding: String,
        evidence: String,
        implication: String,
        next: String,
        supersedes: Option<String>,
        status: Option<Status>,
    ) -> Result<String, String> {
        self.apply(
            WriteKind::Record,
            Change {
                id: id.map(str::to_owned),
                finding: Some(finding),
                evidence: Some(evidence),
                implication: Some(implication),
                next: Some(next),
                supersedes: Some(supersedes.unwrap_or_default()),
                status,
            },
        )
        .map(|applied| applied.id)
    }

    /// Ids of the entries that still count, for error messages and the prompt.
    pub fn active_ids(&self) -> Vec<&str> {
        self.entries
            .iter()
            .filter(|entry| !entry.invalidated)
            .map(|entry| entry.id.as_str())
            .collect()
    }

    pub fn ids_hint(&self) -> String {
        let ids = self.active_ids();
        if ids.is_empty() {
            return "There are no entries yet; use action=record to create one.".into();
        }
        let shown = ids.iter().take(12).copied().collect::<Vec<_>>().join(", ");
        let more = ids.len().saturating_sub(12);
        if more > 0 {
            format!("Existing ids: {shown} (+{more} more; action=view lists all).")
        } else {
            format!("Existing ids: {shown}.")
        }
    }

    fn next_auto_id(&self) -> String {
        let mut number = self.entries.len() + 1;
        loop {
            let candidate = format!("tm-{number:03}");
            if !self.entries.iter().any(|entry| entry.id == candidate) {
                return candidate;
            }
            number += 1;
        }
    }

    /// Creates an entry or revises one. An update merges: fields that are not
    /// given keep their value, and a field given as an empty string is cleared.
    pub fn apply(&mut self, kind: WriteKind, change: Change) -> Result<Applied, String> {
        let wanted = change
            .id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        let existing = wanted
            .as_deref()
            .and_then(|id| self.entries.iter().position(|entry| entry.id == id));
        let mut notes = Vec::new();
        match (kind, existing, &wanted) {
            (WriteKind::Update, None, None) => {
                return Err(format!(
                    "update needs the id of the entry to revise. {}",
                    self.ids_hint()
                ))
            }
            (WriteKind::Update, None, Some(id)) => {
                return Err(format!(
                    "There is no entry '{id}' to update. {} Use action=record to create a new entry.",
                    self.ids_hint()
                ))
            }
            (WriteKind::Record, Some(_), Some(id)) => {
                notes.push(format!("entry '{id}' already existed, so it was updated instead of duplicated"))
            }
            (WriteKind::Record, None, _) if change.finding.as_deref().is_none_or(|f| f.trim().is_empty()) => {
                return Err(format!(
                    "record needs a finding (one sentence). To change an existing entry use action=update with its id. {}",
                    self.ids_hint()
                ))
            }
            _ => {}
        }
        let target_id = existing
            .map(|index| self.entries[index].id.clone())
            .or_else(|| wanted.clone())
            .unwrap_or_else(|| self.next_auto_id());
        let supersedes = match change.supersedes.as_deref().map(str::trim) {
            Some("") | None => None,
            Some(old) if old == target_id => {
                return Err(format!(
                    "An entry cannot supersede itself ('{old}'). To revise it use action=update."
                ))
            }
            Some(old) => {
                if !self.entries.iter().any(|entry| entry.id == old) {
                    return Err(format!(
                        "supersedes refers to unknown entry '{old}'. {}",
                        self.ids_hint()
                    ));
                }
                Some(old.to_owned())
            }
        };
        let finding = change
            .finding
            .as_deref()
            .map(|f| clean(f, true))
            .transpose()?;
        let evidence = change
            .evidence
            .as_deref()
            .map(|v| clean(v, false))
            .transpose()?;
        let implication = change
            .implication
            .as_deref()
            .map(|v| clean(v, false))
            .transpose()?;
        let next = change
            .next
            .as_deref()
            .map(|v| clean(v, false))
            .transpose()?;
        if existing.is_some()
            && finding.is_none()
            && evidence.is_none()
            && implication.is_none()
            && next.is_none()
            && change.supersedes.is_none()
            && change.status.is_none()
        {
            return Err("update changes nothing: pass at least one of finding, evidence, implication, next, status or supersedes.".into());
        }
        if let Some(old) = &supersedes {
            if let Some(entry) = self.entries.iter_mut().find(|entry| &entry.id == old) {
                entry.invalidated = true;
            }
        }
        match existing {
            Some(index) => {
                let entry = &mut self.entries[index];
                if entry.invalidated {
                    notes.push(format!(
                        "entry '{}' was invalidated and is active again",
                        entry.id
                    ));
                }
                if let Some(value) = finding {
                    entry.finding = value;
                }
                if let Some(value) = evidence {
                    entry.evidence = value;
                }
                if let Some(value) = implication {
                    entry.implication = value;
                }
                if let Some(value) = next {
                    entry.next = value;
                }
                if change.supersedes.is_some() {
                    entry.supersedes = supersedes;
                }
                entry.invalidated = false;
                if change.status.is_some() {
                    entry.status = change.status;
                }
            }
            None => self.entries.push(TaskMemoryEntry {
                id: target_id.clone(),
                finding: finding.unwrap_or_default(),
                evidence: evidence.unwrap_or_default(),
                implication: implication.unwrap_or_default(),
                next: next.unwrap_or_default(),
                supersedes,
                invalidated: false,
                status: change.status,
            }),
        }
        self.revision = self.revision.saturating_add(1);
        Ok(Applied {
            id: target_id,
            created: existing.is_none(),
            notes,
        })
    }

    pub fn invalidate(&mut self, id: &str) -> Result<(), String> {
        let hint = self.ids_hint();
        let entry = self
            .entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| format!("unknown task memory entry '{id}'. {hint}"))?;
        entry.invalidated = true;
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }
    pub fn prompt(&self) -> String {
        self.prompt_for("")
    }

    pub fn prompt_for(&self, objective: &str) -> String {
        self.prompt_for_mode(objective, true)
    }

    /// Once closeout has been requested, findings remain useful but old
    /// procedural `next` fields no longer govern the run.
    pub fn prompt_for_closeout(&self, objective: &str) -> String {
        self.prompt_for_mode(objective, false)
    }

    fn prompt_for_mode(&self, objective: &str, include_next: bool) -> String {
        // Select a small, useful handoff instead of allowing four recent
        // low-value notes to evict a cited blocker or relevant older finding.
        let words = objective
            .split(|c: char| !c.is_alphanumeric())
            .filter(|word| word.chars().count() >= 4)
            .map(str::to_lowercase)
            .collect::<Vec<_>>();
        let mut ranked = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| !e.invalidated)
            .map(|(i, e)| {
                let text = format!("{} {} {}", e.finding, e.evidence, e.implication).to_lowercase();
                let relevance = words
                    .iter()
                    .filter(|word| text.contains(word.as_str()))
                    .count()
                    .min(4);
                let score = relevance * 4
                    + usize::from(include_next && !e.next.is_empty()) * 2
                    + usize::from(e.evidence.contains("obs-")) * 3
                    + usize::from(text.contains("block") || text.contains("contradict")) * 2
                    + usize::from(e.status.is_some_and(Status::is_unresolved)) * 3;
                (score, i, e)
            })
            .collect::<Vec<_>>();
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        let shown = ranked
            .into_iter()
            .take(4)
            .map(|(_, _, e)| e)
            .collect::<Vec<_>>();
        let others = self
            .entries
            .iter()
            .filter(|entry| !entry.invalidated && !shown.iter().any(|s| s.id == entry.id))
            .collect::<Vec<_>>();
        let index = (!others.is_empty()).then(|| {
            let listed = others
                .iter()
                .take(12)
                .map(|entry| match entry.status {
                    Some(status) => format!("{} [{}]", entry.id, status.label()),
                    None => entry.id.clone(),
                })
                .collect::<Vec<_>>()
                .join(", ");
            let more = others.len().saturating_sub(12);
            let tail = if more > 0 {
                format!(", +{more} more")
            } else {
                String::new()
            };
            format!("also stored, not shown (task_memory view to read): {listed}{tail}")
        });
        shown
            .into_iter()
            .map(|e| {
                let mut v = vec![match e.status {
                    Some(status) => format!("{} [{}]: {}", e.id, status.label(), e.finding),
                    None => format!("{}: {}", e.id, e.finding),
                }];
                if !e.evidence.is_empty() {
                    v.push(format!("  evidence: {}", e.evidence));
                }
                if !e.implication.is_empty() {
                    v.push(format!("  implication: {}", e.implication));
                }
                if include_next && !e.next.is_empty() {
                    v.push(format!("  next: {}", e.next));
                }
                v.join("\n")
            })
            .chain(index)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_task_memory_is_bounded_in_the_prompt() {
        let mut memory = TaskMemory::default();
        for (id, finding) in [
            ("tm-001", "product finding"),
            ("tm-002", "architecture finding"),
            ("tm-003", "GLM root cause"),
            ("tm-004", "unrelated completed finding"),
            ("tm-005", "implementation decision"),
            ("tm-006", "verification result"),
        ] {
            memory
                .upsert(
                    Some(id),
                    finding.into(),
                    String::new(),
                    String::new(),
                    "handoff".into(),
                    None,
                )
                .unwrap();
        }
        let prompt = memory.prompt();
        assert!(prompt.contains("tm-006: verification result"));
        assert!(prompt.contains("tm-005: implementation decision"));
        assert!(
            prompt
                .lines()
                .filter(|line| line.starts_with("tm-"))
                .count()
                <= 4
        );
        assert_eq!(
            memory.entries.len(),
            6,
            "older entries remain persisted and retrievable"
        );
    }

    fn change(id: &str) -> Change {
        Change {
            id: Some(id.into()),
            ..Default::default()
        }
    }

    #[test]
    fn update_merges_fields_and_an_empty_string_clears_one() {
        let mut memory = TaskMemory::default();
        memory
            .apply(
                WriteKind::Record,
                Change {
                    finding: Some("flow reads api.php".into()),
                    evidence: Some("obs-00000001".into()),
                    next: Some("check the form".into()),
                    status: Some(Status::Confirmed),
                    ..change("a")
                },
            )
            .unwrap();
        memory
            .apply(
                WriteKind::Update,
                Change {
                    next: Some(String::new()),
                    implication: Some("form is the only entry".into()),
                    ..change("a")
                },
            )
            .unwrap();
        let entry = &memory.entries[0];
        assert_eq!(entry.finding, "flow reads api.php");
        assert_eq!(entry.evidence, "obs-00000001");
        assert_eq!(entry.status, Some(Status::Confirmed));
        assert_eq!(entry.next, "");
        assert_eq!(entry.implication, "form is the only entry");
    }

    #[test]
    fn unknown_ids_are_explained_instead_of_creating_entries() {
        let mut memory = TaskMemory::default();
        memory
            .apply(
                WriteKind::Record,
                Change {
                    finding: Some("x".into()),
                    ..change("a")
                },
            )
            .unwrap();
        let error = memory
            .apply(
                WriteKind::Update,
                Change {
                    status: Some(Status::Unknown),
                    ..change("typo")
                },
            )
            .unwrap_err();
        assert!(
            error.contains("'typo'") && error.contains("Existing ids: a"),
            "{error}"
        );
        assert!(memory
            .invalidate("typo")
            .unwrap_err()
            .contains("Existing ids: a"));
        assert!(
            memory.apply(WriteKind::Update, change("a")).is_err(),
            "an empty update changes nothing"
        );
        let unknown_replaced = memory
            .apply(
                WriteKind::Record,
                Change {
                    finding: Some("y".into()),
                    supersedes: Some("ghost".into()),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(unknown_replaced.contains("ghost"));
        assert_eq!(memory.entries.len(), 1);
    }

    #[test]
    fn record_with_an_existing_id_updates_and_auto_ids_never_collide() {
        let mut memory = TaskMemory::default();
        memory
            .apply(
                WriteKind::Record,
                Change {
                    finding: Some("first".into()),
                    ..change("tm-002")
                },
            )
            .unwrap();
        let applied = memory
            .apply(
                WriteKind::Record,
                Change {
                    finding: Some("auto".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            applied.id, "tm-003",
            "tm-002 is taken, and len+1 would have been tm-002"
        );
        let again = memory
            .apply(
                WriteKind::Record,
                Change {
                    finding: Some("renamed".into()),
                    ..change("tm-002")
                },
            )
            .unwrap();
        assert!(!again.created && !again.notes.is_empty());
        assert_eq!(memory.entries.len(), 2);
        assert_eq!(memory.entries[0].finding, "renamed");
    }

    #[test]
    fn superseding_retires_the_old_entry_for_both_new_and_existing_targets() {
        let mut memory = TaskMemory::default();
        for id in ["a", "b", "c"] {
            memory
                .apply(
                    WriteKind::Record,
                    Change {
                        finding: Some(id.into()),
                        ..change(id)
                    },
                )
                .unwrap();
        }
        memory
            .apply(
                WriteKind::Update,
                Change {
                    supersedes: Some("a".into()),
                    ..change("b")
                },
            )
            .unwrap();
        assert!(memory.entries[0].invalidated);
        assert!(memory
            .apply(
                WriteKind::Update,
                Change {
                    supersedes: Some("c".into()),
                    ..change("c")
                },
            )
            .unwrap_err()
            .contains("itself"));
    }

    #[test]
    fn status_words_models_use_are_understood() {
        for (word, status) in [
            ("open", Status::Unknown),
            ("unresolved", Status::Unknown),
            ("refuted", Status::Contradicted),
            ("assumed", Status::Inferred),
            ("Verified", Status::Confirmed),
        ] {
            assert_eq!(Status::parse(word).unwrap(), status, "{word}");
        }
        assert!(Status::parse("maybe").is_err());
    }

    #[test]
    fn entries_outside_the_prompt_are_still_indexed() {
        let mut memory = TaskMemory::default();
        for n in 0..7 {
            memory
                .upsert(
                    Some(&format!("e{n}")),
                    format!("note {n}"),
                    String::new(),
                    String::new(),
                    String::new(),
                    None,
                )
                .unwrap();
        }
        let prompt = memory.prompt();
        let index = prompt
            .lines()
            .find(|line| line.starts_with("also stored"))
            .expect("hidden entries must be listed by id");
        assert!(index.contains("e0") && index.contains("e1") && index.contains("e2"));
        assert!(
            !index.contains("e6"),
            "shown entries are not repeated in the index"
        );
        memory.invalidate("e0").unwrap();
        assert!(!memory.prompt().contains("e0"));
    }

    #[test]
    fn finding_without_next_remains_available_as_a_handoff() {
        let mut memory = TaskMemory::default();
        memory
            .upsert(
                Some("tm-001"),
                "confirmed project structure".into(),
                "src/main.tsx".into(),
                "architecture stage can begin".into(),
                String::new(),
                None,
            )
            .unwrap();

        let prompt = memory.prompt();
        assert!(prompt.contains("tm-001: confirmed project structure"));
        assert!(prompt.contains("evidence: src/main.tsx"));
    }

    #[test]
    fn closeout_retains_facts_but_drops_stale_research_next_steps() {
        let mut memory = TaskMemory::default();
        memory
            .upsert(
                None,
                "endpoint handles checkout".into(),
                "obs-00000001".into(),
                "business flow established".into(),
                "list every directory again".into(),
                None,
            )
            .unwrap();
        assert!(memory
            .prompt_for("checkout")
            .contains("list every directory again"));
        let closeout = memory.prompt_for_closeout("checkout");
        assert!(closeout.contains("endpoint handles checkout"));
        assert!(closeout.contains("obs-00000001"));
        assert!(!closeout.contains("list every directory again"));
    }

    #[test]
    fn relevant_cited_older_finding_survives_recent_noise() {
        let mut memory = TaskMemory::default();
        memory
            .upsert(
                Some("backend"),
                "api.php handles order submission".into(),
                "obs-00000042".into(),
                "backend exists".into(),
                "".into(),
                None,
            )
            .unwrap();
        for n in 0..6 {
            memory
                .upsert(
                    None,
                    format!("unrelated note {n}"),
                    "".into(),
                    "".into(),
                    "".into(),
                    None,
                )
                .unwrap();
        }
        assert!(memory
            .prompt_for("Explain backend order flow")
            .contains("api.php handles order submission"));
        assert!(!memory
            .prompt_for("Explain backend order flow")
            .contains("unrelated note 0"));
    }
}
fn clean(value: &str, required: bool) -> Result<String, String> {
    let value = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(700)
        .collect::<String>();
    if required && value.is_empty() {
        Err("task memory requires finding".into())
    } else {
        Ok(value)
    }
}
