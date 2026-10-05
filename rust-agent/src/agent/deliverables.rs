//! The execution contract: what the user asked to be produced or changed, and
//! whether each item is done.
//!
//! Task Memory records what the run has *learned*. That is not the same thing
//! as what the user still *expects*: a run can accumulate confirmed findings
//! for a hundred turns and never produce the requested result, and nothing in
//! a findings store says so. Deliverables are the model's own compact list of
//! the separate things the user asked for, kept as durable runtime state so
//! they survive compaction, interruption and restart, and checked before a
//! run is allowed to present itself as finished.
//!
//! The runtime never invents entries and never decides what the user wanted.
//! It only keeps the list the model recorded, shows all of it on every turn,
//! and refuses to let an unfinished list pass silently.

use serde::{Deserialize, Serialize};

const MAX_ITEMS: usize = 24;
const MAX_TEXT_CHARS: usize = 240;
const MAX_TASK_CHARS: usize = 80;
const MAX_NOTE_CHARS: usize = 400;
const VISIBLE_DONE: usize = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeliverableStatus {
    Pending,
    Done,
    /// Cannot be completed; `reason` says why.
    Blocked,
    /// Not (or no longer) required; `reason` says why.
    Dropped,
}

impl DeliverableStatus {
    fn label(self) -> &'static str {
        match self {
            DeliverableStatus::Pending => "pending",
            DeliverableStatus::Done => "done",
            DeliverableStatus::Blocked => "blocked",
            DeliverableStatus::Dropped => "dropped",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deliverable {
    pub id: String,
    /// The user's task this belongs to, when the request has several.
    #[serde(default)]
    pub task: String,
    pub text: String,
    pub status: DeliverableStatus,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deliverables {
    #[serde(default)]
    pub items: Vec<Deliverable>,
    #[serde(default)]
    pub revision: u64,
}

fn clean(value: &str, limit: usize, field: &str) -> Result<String, String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.chars().count() > limit {
        return Err(format!(
            "{field} is too long ({} characters, limit {limit}): keep it to one short line",
            value.chars().count()
        ));
    }
    Ok(value)
}

fn normalized(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

impl Deliverables {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn pending(&self) -> Vec<&Deliverable> {
        self.items
            .iter()
            .filter(|item| item.status == DeliverableStatus::Pending)
            .collect()
    }

    pub fn has_pending(&self) -> bool {
        self.items
            .iter()
            .any(|item| item.status == DeliverableStatus::Pending)
    }

    fn find_mut(&mut self, id: &str) -> Result<&mut Deliverable, String> {
        self.items
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| format!("unknown deliverable '{id}': use action view to list them"))
    }

    fn next_id(&self) -> String {
        let mut number = self.items.len() + 1;
        loop {
            let id = format!("d-{number:03}");
            if self.items.iter().all(|item| item.id != id) {
                return id;
            }
            number += 1;
        }
    }

    /// Records one requested deliverable. Re-adding the same wording returns
    /// the existing entry instead of duplicating it.
    pub fn add(&mut self, id: Option<&str>, task: &str, text: &str) -> Result<String, String> {
        let text = clean(text, MAX_TEXT_CHARS, "text")?;
        if text.is_empty() {
            return Err("text is required: one short line saying what must exist or work".into());
        }
        let task = clean(task, MAX_TASK_CHARS, "task")?;
        let key = normalized(&text);
        if let Some(existing) = self
            .items
            .iter()
            .find(|item| item.status != DeliverableStatus::Dropped && normalized(&item.text) == key)
        {
            return Ok(existing.id.clone());
        }
        if let Some(id) = id.map(str::trim).filter(|id| !id.is_empty()) {
            if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
                if item.status == DeliverableStatus::Done {
                    return Err(format!(
                        "deliverable '{id}' is already done; add a new one instead of rewording it"
                    ));
                }
                item.text = text;
                item.task = task;
                item.status = DeliverableStatus::Pending;
                item.reason.clear();
                self.revision = self.revision.saturating_add(1);
                return Ok(id.to_owned());
            }
        }
        let open = self
            .items
            .iter()
            .filter(|item| item.status != DeliverableStatus::Dropped)
            .count();
        if open >= MAX_ITEMS {
            return Err(format!(
                "at most {MAX_ITEMS} deliverables: merge related items instead of listing every step"
            ));
        }
        let id = id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map_or_else(|| self.next_id(), str::to_owned);
        self.items.push(Deliverable {
            id: id.clone(),
            task,
            text,
            status: DeliverableStatus::Pending,
            evidence: String::new(),
            reason: String::new(),
        });
        self.revision = self.revision.saturating_add(1);
        Ok(id)
    }

    pub fn complete(&mut self, id: &str, evidence: &str) -> Result<(), String> {
        let evidence = clean(evidence, MAX_NOTE_CHARS, "evidence")?;
        let item = self.find_mut(id)?;
        item.status = DeliverableStatus::Done;
        item.evidence = evidence;
        item.reason.clear();
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    pub fn block(&mut self, id: &str, reason: &str) -> Result<(), String> {
        let reason = clean(reason, MAX_NOTE_CHARS, "reason")?;
        if reason.chars().count() < 8 {
            return Err("reason is required: say concretely why this cannot be completed".into());
        }
        let item = self.find_mut(id)?;
        item.status = DeliverableStatus::Blocked;
        item.reason = reason;
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    pub fn drop_item(&mut self, id: &str, reason: &str) -> Result<(), String> {
        let reason = clean(reason, MAX_NOTE_CHARS, "reason")?;
        if reason.chars().count() < 8 {
            return Err(
                "reason is required: say why this is not (or no longer) a requested deliverable"
                    .into(),
            );
        }
        let item = self.find_mut(id)?;
        item.status = DeliverableStatus::Dropped;
        item.reason = reason;
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    /// Every pending and blocked item is always shown; only the oldest
    /// finished ones are summarized so the block stays small on long runs.
    pub fn prompt(&self) -> String {
        let live = self
            .items
            .iter()
            .filter(|item| item.status != DeliverableStatus::Dropped)
            .collect::<Vec<_>>();
        if live.is_empty() {
            return String::new();
        }
        let done = live
            .iter()
            .filter(|item| item.status == DeliverableStatus::Done)
            .count();
        let hidden_done = done.saturating_sub(VISIBLE_DONE);
        let mut skipped = 0;
        let mut lines = Vec::new();
        let mut group: Option<&str> = None;
        for item in &live {
            if item.status == DeliverableStatus::Done && skipped < hidden_done {
                skipped += 1;
                continue;
            }
            if group != Some(item.task.as_str()) {
                group = Some(item.task.as_str());
                if !item.task.is_empty() {
                    lines.push(format!("Task: {}", item.task));
                }
            }
            let mut line = format!("  [{}] {} {}", item.status.label(), item.id, item.text);
            match item.status {
                DeliverableStatus::Blocked if !item.reason.is_empty() => {
                    line.push_str(&format!(" (blocked: {})", item.reason));
                }
                DeliverableStatus::Done if !item.evidence.is_empty() => {
                    line.push_str(&format!(" (evidence: {})", item.evidence));
                }
                _ => {}
            }
            lines.push(line);
        }
        if hidden_done > 0 {
            lines.push(format!("  (+{hidden_done} earlier deliverables done)"));
        }
        format!("<deliverables>\n{}\n</deliverables>", lines.join("\n"))
    }

    /// One line per unfinished item, for reminders and the final report.
    pub fn pending_summary(&self) -> String {
        self.pending()
            .iter()
            .map(|item| {
                if item.task.is_empty() {
                    format!("{} {}", item.id, item.text)
                } else {
                    format!("{} {} ({})", item.id, item.text, item.task)
                }
            })
            .collect::<Vec<_>>()
            .join("; ")
    }
}

/// Reminder shown instead of letting a run with unfinished deliverables end.
pub fn pending_review(pending: &str, created_files: &[String], deep: bool) -> String {
    let files = if created_files.is_empty() {
        String::new()
    } else {
        let listed = created_files
            .iter()
            .rev()
            .take(10)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        format!(" Files you created in this run: {listed}. Before you finish, delete the ones that existed only for diagnostics and are not part of the result (delete_file).")
    };
    let verify = if deep {
        " When you mark an item done, cite the observation or file that shows it working."
    } else {
        ""
    };
    format!("Before finishing: the deliverables you recorded are not all complete: {pending}. Continue with the unfinished ones now, starting with what the user will see or use. If one cannot be completed, mark it blocked with the concrete reason and say so plainly in your answer. Do not describe unfinished work as done.{verify}{files}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_tasks() -> Deliverables {
        let mut list = Deliverables::default();
        list.add(None, "bot", "bot engine exists").unwrap();
        list.add(None, "bot", "mode selector in the UI").unwrap();
        list.add(None, "theme", "theme switch in the UI").unwrap();
        list
    }

    #[test]
    fn items_get_stable_ids_and_duplicates_are_not_created() {
        let mut list = two_tasks();
        assert_eq!(
            list.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            ["d-001", "d-002", "d-003"]
        );
        assert_eq!(
            list.add(None, "bot", "Bot engine   EXISTS!").unwrap(),
            "d-001"
        );
        assert_eq!(list.items.len(), 3);
    }

    #[test]
    fn status_changes_are_explicit_and_blocking_needs_a_concrete_reason() {
        let mut list = two_tasks();
        list.complete("d-001", "bot.js read in obs-00000004")
            .unwrap();
        assert!(list.block("d-002", "no").is_err());
        list.block("d-002", "the page cannot be opened without a browser here")
            .unwrap();
        assert!(list.drop_item("d-003", "").is_err());
        assert!(list.complete("d-999", "").is_err());
        assert_eq!(list.pending().len(), 1);
        list.complete("d-003", "").unwrap();
        assert!(!list.has_pending());
    }

    #[test]
    fn a_dropped_item_no_longer_counts_and_its_wording_can_be_reused() {
        let mut list = two_tasks();
        list.drop_item("d-003", "the user withdrew this request")
            .unwrap();
        assert_eq!(list.pending().len(), 2);
        assert!(!list.prompt().contains("theme switch"));
        let id = list.add(None, "theme", "theme switch in the UI").unwrap();
        assert_ne!(id, "d-003");
    }

    #[test]
    fn a_finished_item_cannot_be_silently_reworded_back_to_pending() {
        let mut list = two_tasks();
        list.complete("d-001", "").unwrap();
        assert!(list
            .add(Some("d-001"), "bot", "something else entirely")
            .is_err());
        assert_eq!(list.items[0].status, DeliverableStatus::Done);
    }

    #[test]
    fn the_list_is_bounded_and_text_must_stay_short() {
        let mut list = Deliverables::default();
        for index in 0..MAX_ITEMS {
            list.add(None, "", &format!("deliverable number {index} to produce"))
                .unwrap();
        }
        assert!(list.add(None, "", "one more distinct deliverable").is_err());
        assert!(Deliverables::default()
            .add(None, "", &"x".repeat(MAX_TEXT_CHARS + 1))
            .is_err());
        assert!(Deliverables::default().add(None, "", "   ").is_err());
    }

    #[test]
    fn the_prompt_groups_by_task_and_never_hides_unfinished_work() {
        let mut list = Deliverables::default();
        for index in 0..10 {
            let id = list
                .add(None, "analysis", &format!("finished step {index}"))
                .unwrap();
            list.complete(&id, "").unwrap();
        }
        list.add(None, "build", "the pending piece").unwrap();
        list.add(None, "build", "the blocked piece").unwrap();
        list.block("d-012", "needs a service that is not reachable")
            .unwrap();
        let prompt = list.prompt();
        assert!(prompt.contains("[pending] d-011 the pending piece"));
        assert!(prompt.contains("[blocked] d-012 the blocked piece (blocked: needs a service"));
        assert!(prompt.contains("Task: build"));
        assert!(prompt.contains("(+4 earlier deliverables done)"));
        assert!(!prompt.contains("finished step 0"));
        assert!(prompt.contains("finished step 9"));
    }

    #[test]
    fn saved_state_round_trips_and_older_memory_without_deliverables_still_loads() {
        let list = two_tasks();
        let value = serde_json::to_value(&list).unwrap();
        assert_eq!(serde_json::from_value::<Deliverables>(value).unwrap(), list);
        let legacy: Deliverables = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(legacy.is_empty());
    }

    #[test]
    fn the_review_names_every_unfinished_item_and_only_deep_asks_for_proof() {
        let list = two_tasks();
        let fast = pending_review(&list.pending_summary(), &[], false);
        assert!(fast.contains("d-002 mode selector in the UI (bot)"));
        assert!(fast.contains("d-003 theme switch in the UI (theme)"));
        assert!(!fast.contains("cite the observation"));
        let deep = pending_review(&list.pending_summary(), &["scratch.js".into()], true);
        assert!(deep.contains("cite the observation"));
        assert!(deep.contains("scratch.js"));
    }
}
