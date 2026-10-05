//! The execution plan: HOW the run intends to get the work done.
//!
//! Three kinds of state stay deliberately apart:
//!
//! * Task Memory records what the run has *learned*.
//! * Deliverables record what the user *asked for* and whether each item is
//!   implemented and verified.
//! * The plan records the model's own *approach*: a short, ordered list of
//!   steps with one active step.
//!
//! A plan step is never a proof of anything. Completing every step does not
//! complete a deliverable, and a deliverable can be unfinished while the plan
//! looks done. The runtime keeps the plan as durable state next to the other
//! two (so it survives compaction, Pause and Continue), shows it on every turn,
//! and never invents or reorders steps.

use serde::{Deserialize, Serialize};

const MAX_STEPS: usize = 16;
const MAX_TEXT_CHARS: usize = 160;
const MAX_NOTE_CHARS: usize = 240;
const VISIBLE_COMPLETED: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    InProgress,
    Completed,
    /// Cannot proceed; `note` says why.
    Blocked,
}

impl StepStatus {
    pub fn parse(value: &str) -> Option<Self> {
        match value
            .trim()
            .to_lowercase()
            .replace([' ', '-'], "_")
            .as_str()
        {
            "pending" | "todo" | "open" => Some(Self::Pending),
            "in_progress" | "active" | "current" | "doing" | "started" => Some(Self::InProgress),
            "completed" | "complete" | "done" | "finished" => Some(Self::Completed),
            "blocked" | "stuck" => Some(Self::Blocked),
            _ => None,
        }
    }

    fn marker(self) -> &'static str {
        match self {
            Self::Pending => "[ ]",
            Self::InProgress => "[>]",
            Self::Completed => "[x]",
            Self::Blocked => "[!]",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanStep {
    pub id: String,
    pub text: String,
    pub status: StepStatus,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    #[serde(default)]
    pub steps: Vec<PlanStep>,
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

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }

    pub fn active(&self) -> Option<&PlanStep> {
        self.steps
            .iter()
            .find(|step| step.status == StepStatus::InProgress)
    }

    fn next_id(&self) -> String {
        let highest = self
            .steps
            .iter()
            .filter_map(|step| step.id.strip_prefix('s')?.parse::<usize>().ok())
            .max()
            .unwrap_or(0);
        format!("s{}", highest + 1)
    }

    fn bump(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }

    /// Exactly one step is active while any step is unfinished and not blocked.
    fn normalize_active(&mut self) {
        if self.active().is_some() {
            return;
        }
        if let Some(step) = self
            .steps
            .iter_mut()
            .find(|step| step.status == StepStatus::Pending)
        {
            step.status = StepStatus::InProgress;
        }
    }

    /// Replaces the unfinished part of the plan. Completed steps are history and
    /// are kept, so revising the approach never un-does recorded progress.
    pub fn set(&mut self, texts: &[String]) -> Result<(), String> {
        let mut cleaned = Vec::new();
        for text in texts {
            let text = clean(text, MAX_TEXT_CHARS, "step")?;
            if !text.is_empty() {
                cleaned.push(text);
            }
        }
        if cleaned.is_empty() {
            return Err("steps is required: a short list of one-line steps".into());
        }
        let completed = self
            .steps
            .iter()
            .filter(|step| step.status == StepStatus::Completed)
            .cloned()
            .collect::<Vec<_>>();
        if completed.len() + cleaned.len() > MAX_STEPS {
            return Err(format!(
                "at most {MAX_STEPS} steps: a plan is a short outline, not a task log"
            ));
        }
        self.steps = completed;
        for text in cleaned {
            let key = normalized(&text);
            if self.steps.iter().any(|step| normalized(&step.text) == key) {
                continue;
            }
            let id = self.next_id();
            self.steps.push(PlanStep {
                id,
                text,
                status: StepStatus::Pending,
                note: String::new(),
            });
        }
        self.normalize_active();
        self.bump();
        Ok(())
    }

    pub fn add(&mut self, text: &str, after: Option<&str>) -> Result<(), String> {
        let text = clean(text, MAX_TEXT_CHARS, "text")?;
        if text.is_empty() {
            return Err("text is required: one short line".into());
        }
        if self.steps.len() >= MAX_STEPS {
            return Err(format!(
                "at most {MAX_STEPS} steps: merge or complete steps first"
            ));
        }
        let position = match after.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => {
                self.steps
                    .iter()
                    .position(|step| step.id == id)
                    .ok_or_else(|| format!("unknown step '{id}'"))?
                    + 1
            }
            None => self.steps.len(),
        };
        let id = self.next_id();
        self.steps.insert(
            position,
            PlanStep {
                id,
                text,
                status: StepStatus::Pending,
                note: String::new(),
            },
        );
        self.normalize_active();
        self.bump();
        Ok(())
    }

    /// Changes a step's status, wording or note. Completing the active step
    /// activates the next pending one, so the model never has to do it.
    pub fn update(
        &mut self,
        id: &str,
        status: Option<StepStatus>,
        text: Option<&str>,
        note: Option<&str>,
    ) -> Result<(), String> {
        let text = text
            .map(|text| clean(text, MAX_TEXT_CHARS, "text"))
            .transpose()?;
        let note = note
            .map(|note| clean(note, MAX_NOTE_CHARS, "note"))
            .transpose()?;
        let position = self
            .steps
            .iter()
            .position(|step| step.id == id)
            .ok_or_else(|| format!("unknown step '{id}': use action view to list the steps"))?;
        if status == Some(StepStatus::Blocked)
            && note
                .as_deref()
                .unwrap_or(&self.steps[position].note)
                .chars()
                .count()
                < 8
        {
            return Err("note is required: say concretely what blocks this step".into());
        }
        if status.is_none() && text.is_none() && note.is_none() {
            return Err("nothing to update: pass status, text or note".into());
        }
        if let Some(text) = text.filter(|text| !text.is_empty()) {
            self.steps[position].text = text;
        }
        if let Some(note) = note {
            self.steps[position].note = note;
        }
        if let Some(status) = status {
            if status == StepStatus::InProgress {
                for step in &mut self.steps {
                    if step.status == StepStatus::InProgress {
                        step.status = StepStatus::Pending;
                    }
                }
            }
            self.steps[position].status = status;
            if status != StepStatus::Blocked && status != StepStatus::Pending {
                self.steps[position].note.clear();
            }
            self.normalize_active();
        }
        self.bump();
        Ok(())
    }

    /// Compact block shown on every turn. Older completed steps collapse into a count.
    pub fn prompt(&self) -> String {
        if self.steps.is_empty() {
            return String::new();
        }
        let completed = self
            .steps
            .iter()
            .filter(|step| step.status == StepStatus::Completed)
            .count();
        let hidden = completed.saturating_sub(VISIBLE_COMPLETED);
        let mut skipped = 0;
        let mut lines = Vec::new();
        for step in &self.steps {
            if step.status == StepStatus::Completed && skipped < hidden {
                skipped += 1;
                continue;
            }
            let mut line = format!("  {} {} {}", step.status.marker(), step.id, step.text);
            if !step.note.is_empty() {
                line.push_str(&format!(" ({})", step.note));
            }
            lines.push(line);
        }
        if hidden > 0 {
            lines.push(format!("  (+{hidden} earlier steps completed)"));
        }
        format!("<plan>\n{}\n</plan>", lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn setting_a_plan_activates_exactly_the_first_step() {
        let mut plan = Plan::default();
        plan.set(&texts(&["inspect", "edit", "check"])).unwrap();
        let statuses = plan
            .steps
            .iter()
            .map(|step| step.status)
            .collect::<Vec<_>>();
        assert_eq!(
            statuses,
            [
                StepStatus::InProgress,
                StepStatus::Pending,
                StepStatus::Pending
            ]
        );
        assert_eq!(plan.active().unwrap().id, "s1");
    }

    #[test]
    fn completing_the_active_step_activates_the_next_one() {
        let mut plan = Plan::default();
        plan.set(&texts(&["inspect", "edit", "check"])).unwrap();
        plan.update("s1", Some(StepStatus::Completed), None, None)
            .unwrap();
        assert_eq!(plan.active().unwrap().id, "s2");
        plan.update("s2", Some(StepStatus::Completed), None, None)
            .unwrap();
        plan.update("s3", Some(StepStatus::Completed), None, None)
            .unwrap();
        assert!(plan.active().is_none());
    }

    #[test]
    fn only_one_step_is_ever_active() {
        let mut plan = Plan::default();
        plan.set(&texts(&["a one", "b two", "c three"])).unwrap();
        plan.update("s3", Some(StepStatus::InProgress), None, None)
            .unwrap();
        assert_eq!(
            plan.steps
                .iter()
                .filter(|step| step.status == StepStatus::InProgress)
                .count(),
            1
        );
        assert_eq!(plan.active().unwrap().id, "s3");
    }

    #[test]
    fn replanning_keeps_completed_history_and_does_not_duplicate_it() {
        let mut plan = Plan::default();
        plan.set(&texts(&["inspect", "edit"])).unwrap();
        plan.update("s1", Some(StepStatus::Completed), None, None)
            .unwrap();
        plan.set(&texts(&["Inspect", "rewrite the board", "run it"]))
            .unwrap();
        let steps = plan
            .steps
            .iter()
            .map(|step| (step.id.as_str(), step.text.as_str(), step.status))
            .collect::<Vec<_>>();
        assert_eq!(steps[0], ("s1", "inspect", StepStatus::Completed));
        assert_eq!(steps.len(), 3, "{steps:?}");
        assert_eq!(plan.active().unwrap().text, "rewrite the board");
    }

    #[test]
    fn a_blocked_step_needs_a_concrete_note_and_does_not_hold_the_active_slot() {
        let mut plan = Plan::default();
        plan.set(&texts(&["fetch data", "write report"])).unwrap();
        assert!(plan
            .update("s1", Some(StepStatus::Blocked), None, None)
            .is_err());
        plan.update(
            "s1",
            Some(StepStatus::Blocked),
            None,
            Some("the API requires a key"),
        )
        .unwrap();
        assert_eq!(plan.active().unwrap().id, "s2");
        assert!(plan
            .prompt()
            .contains("[!] s1 fetch data (the API requires a key)"));
    }

    #[test]
    fn the_plan_stays_a_short_outline() {
        let mut plan = Plan::default();
        let many = (0..17)
            .map(|index| format!("step {index}"))
            .collect::<Vec<_>>();
        assert!(plan.set(&many).unwrap_err().contains("at most"));
        assert!(plan.is_empty(), "a rejected plan changes nothing");
        assert!(plan.set(&texts(&["x".repeat(200).as_str()])).is_err());
    }

    #[test]
    fn add_inserts_after_a_step_and_unknown_ids_are_explained() {
        let mut plan = Plan::default();
        plan.set(&texts(&["first thing", "last thing"])).unwrap();
        plan.add("middle thing", Some("s1")).unwrap();
        assert_eq!(plan.steps[1].text, "middle thing");
        assert!(plan
            .add("x thing", Some("s9"))
            .unwrap_err()
            .contains("unknown step"));
        assert!(plan
            .update("s9", Some(StepStatus::Completed), None, None)
            .is_err());
    }

    #[test]
    fn the_prompt_marks_state_and_collapses_old_completed_steps() {
        let mut plan = Plan::default();
        let many = (0..8)
            .map(|index| format!("step number {index}"))
            .collect::<Vec<_>>();
        plan.set(&many).unwrap();
        for index in 1..=6 {
            plan.update(
                &format!("s{index}"),
                Some(StepStatus::Completed),
                None,
                None,
            )
            .unwrap();
        }
        let prompt = plan.prompt();
        assert!(prompt.starts_with("<plan>") && prompt.ends_with("</plan>"));
        assert!(prompt.contains("[>] s7"), "{prompt}");
        assert!(prompt.contains("(+2 earlier steps completed)"), "{prompt}");
        assert!(!prompt.contains("s1 step"), "{prompt}");
        assert_eq!(Plan::default().prompt(), "");
    }

    #[test]
    fn a_plan_round_trips_through_json_and_loads_when_absent() {
        let mut plan = Plan::default();
        plan.set(&texts(&["alpha step"])).unwrap();
        let restored: Plan = serde_json::from_value(serde_json::to_value(&plan).unwrap()).unwrap();
        assert_eq!(restored, plan);
        let empty: Plan = serde_json::from_str("{}").unwrap();
        assert!(empty.is_empty());
    }
}
