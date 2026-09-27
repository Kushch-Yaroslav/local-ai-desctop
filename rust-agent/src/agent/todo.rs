//! Persistent planning primitives for the Local AI Desktop agent.
//!
//! Jan's useful invariant is retained here: work moves in a predictable
//! milestone/task order and the next pending item is promoted automatically.
//! Unlike Jan, identities are stable, refinement is patch based, and completed
//! work is never silently replaced by a new plan.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    #[default]
    Pending,
    InProgress,
    Completed,
    Abandoned,
}

impl Status {
    pub fn is_open(self) -> bool {
        matches!(self, Self::Pending | Self::InProgress)
    }

    pub fn is_terminal(self) -> bool {
        !self.is_open()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkTask {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub status: Status,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkPlan {
    #[serde(default)]
    pub tasks: Vec<WorkTask>,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Milestone {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub status: Status,
    #[serde(default)]
    pub revision: u64,
    #[serde(default, alias = "workPlan")]
    pub work_plan: WorkPlan,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalPlan {
    #[serde(default)]
    pub milestones: Vec<Milestone>,
    #[serde(default, alias = "activeMilestoneId")]
    pub active_milestone_id: Option<String>,
    #[serde(default)]
    pub revision: u64,
}

impl GoalPlan {
    /// Restores the one-active-milestone invariant for snapshots written by an
    /// interrupted run or an older renderer. This is state normalization, not
    /// a semantic decision about whether any work is complete.
    pub fn normalize_active(&mut self) {
        let active_is_valid = self
            .active_milestone()
            .is_some_and(|milestone| milestone.status.is_open());
        if !active_is_valid {
            if let Some(milestone) = self
                .milestones
                .iter()
                .find(|milestone| milestone.status == Status::InProgress)
            {
                self.active_milestone_id = Some(milestone.id.clone());
            } else {
                self.active_milestone_id = None;
                self.promote_next_milestone();
            }
        }
        self.promote_next_task();
    }

    pub fn has_open_work(&self) -> bool {
        self.milestones
            .iter()
            .any(|milestone| milestone.status.is_open())
    }

    pub fn active_milestone(&self) -> Option<&Milestone> {
        self.active_milestone_id
            .as_deref()
            .and_then(|id| self.milestones.iter().find(|milestone| milestone.id == id))
    }

    pub fn active_milestone_mut(&mut self) -> Option<&mut Milestone> {
        let id = self.active_milestone_id.clone()?;
        self.milestones
            .iter_mut()
            .find(|milestone| milestone.id == id)
    }

    pub fn active_work_task(&self) -> Option<&WorkTask> {
        self.active_milestone()?
            .work_plan
            .tasks
            .iter()
            .find(|task| task.status == Status::InProgress)
    }

    pub fn open_summary(&self) -> Option<String> {
        let milestone = self.active_milestone()?;
        let tasks = milestone
            .work_plan
            .tasks
            .iter()
            .filter(|task| task.status.is_open())
            .map(|task| {
                let marker = if task.status == Status::InProgress {
                    "→"
                } else {
                    "•"
                };
                format!("{marker} {} — {}", task.id, task.label)
            })
            .collect::<Vec<_>>();
        Some(if tasks.is_empty() {
            format!("Active milestone: {} — {}", milestone.id, milestone.label)
        } else {
            format!(
                "Active milestone: {} — {}\n{}",
                milestone.id,
                milestone.label,
                tasks.join("\n")
            )
        })
    }

    /// Creates the initial stable goal plan. It is intentionally unavailable
    /// once a plan exists: later changes must be explicit patches so completed
    /// history cannot disappear as a side effect of replanning.
    pub fn init(&mut self, labels: Vec<String>) -> Result<(), String> {
        if !self.milestones.is_empty() {
            return Err("Goal Plan already exists; use append or refine instead of init".into());
        }
        if labels.is_empty() {
            return Err("Goal Plan requires at least one milestone".into());
        }
        for label in labels {
            self.insert_milestone(label, None)?;
        }
        self.promote_next_milestone();
        Ok(())
    }

    pub fn append_milestone(
        &mut self,
        label: String,
        after_id: Option<&str>,
    ) -> Result<(), String> {
        self.insert_milestone(label, after_id)
    }

    fn insert_milestone(&mut self, label: String, after_id: Option<&str>) -> Result<(), String> {
        let label = clean_label(&label, "milestone")?;
        if self
            .milestones
            .iter()
            .any(|milestone| milestone.label == label)
        {
            return Err("Goal Plan milestone labels must be unique".into());
        }
        let milestone = Milestone {
            id: format!("milestone-{}", self.next_number("milestone-")),
            label,
            status: Status::Pending,
            revision: self.revision.saturating_add(1),
            work_plan: WorkPlan::default(),
        };
        if let Some(after_id) = after_id {
            let position = self
                .milestones
                .iter()
                .position(|candidate| candidate.id == after_id)
                .ok_or_else(|| format!("unknown milestone: {after_id}"))?;
            self.milestones.insert(position + 1, milestone);
        } else {
            self.milestones.push(milestone);
        }
        self.bump();
        self.promote_next_milestone();
        Ok(())
    }

    pub fn refine_milestone(&mut self, id: &str, label: String) -> Result<(), String> {
        let label = clean_label(&label, "milestone")?;
        let index = self
            .milestones
            .iter()
            .position(|milestone| milestone.id == id)
            .ok_or_else(|| format!("unknown milestone: {id}"))?;
        if self.milestones[index].status.is_terminal() {
            return Err(
                "completed or dropped milestones are retained history and cannot be refined".into(),
            );
        }
        if self
            .milestones
            .iter()
            .any(|milestone| milestone.id != id && milestone.label == label)
        {
            return Err("Goal Plan milestone labels must be unique".into());
        }
        let revision = self.revision.saturating_add(1);
        let milestone = &mut self.milestones[index];
        milestone.label = label;
        milestone.revision = revision;
        self.bump();
        Ok(())
    }

    pub fn finish_milestone(&mut self, id: &str, abandoned: bool) -> Result<(), String> {
        let index = self
            .milestones
            .iter()
            .position(|milestone| milestone.id == id)
            .ok_or_else(|| format!("unknown milestone: {id}"))?;
        if self.milestones[index]
            .work_plan
            .tasks
            .iter()
            .any(|task| task.status.is_open())
        {
            return Err(
                "close or drop the active Work Plan tasks before completing a milestone".into(),
            );
        }
        self.milestones[index].status = if abandoned {
            Status::Abandoned
        } else {
            Status::Completed
        };
        self.milestones[index].revision = self.revision.saturating_add(1);
        if self.active_milestone_id.as_deref() == Some(id) {
            self.active_milestone_id = None;
        }
        self.bump();
        self.promote_next_milestone();
        Ok(())
    }

    pub fn drop_milestone(&mut self, id: &str) -> Result<(), String> {
        let index = self
            .milestones
            .iter()
            .position(|milestone| milestone.id == id)
            .ok_or_else(|| format!("unknown milestone: {id}"))?;
        if self.milestones[index].status.is_terminal() {
            return Err("milestone is already completed or dropped".into());
        }
        // Dropping is an explicit model decision. Mark remaining children as
        // abandoned rather than asking the model to erase its history one
        // work item at a time.
        let revision = self.revision.saturating_add(1);
        let milestone = &mut self.milestones[index];
        for task in &mut milestone.work_plan.tasks {
            if task.status.is_open() {
                task.status = Status::Abandoned;
                task.revision = revision;
            }
        }
        milestone.work_plan.revision = milestone.work_plan.revision.saturating_add(1);
        milestone.status = Status::Abandoned;
        milestone.revision = revision;
        if self.active_milestone_id.as_deref() == Some(id) {
            self.active_milestone_id = None;
        }
        self.bump();
        self.promote_next_milestone();
        Ok(())
    }

    pub fn init_work(&mut self, labels: Vec<String>) -> Result<(), String> {
        if labels.is_empty() {
            return Err("Work Plan requires at least one task".into());
        }
        let next = self.next_number("task-");
        let revision = self.revision.saturating_add(1);
        let labels = labels
            .into_iter()
            .map(|label| clean_label(&label, "work task"))
            .collect::<Result<Vec<_>, _>>()?;
        if has_duplicates(&labels) {
            return Err("Work Plan task labels must be unique within a milestone".into());
        }
        let milestone = self
            .active_milestone_mut()
            .ok_or_else(|| "there is no active milestone".to_owned())?;
        if !milestone.work_plan.tasks.is_empty() {
            return Err(
                "Work Plan already exists; use append, refine, split, done, or drop".into(),
            );
        }
        milestone.work_plan.tasks = labels
            .into_iter()
            .enumerate()
            .map(|(offset, label)| WorkTask {
                id: format!("task-{}", next + offset),
                label,
                status: Status::Pending,
                revision,
            })
            .collect();
        milestone.work_plan.revision = milestone.work_plan.revision.saturating_add(1);
        self.bump();
        self.promote_next_task();
        Ok(())
    }

    pub fn append_work(&mut self, label: String, after_id: Option<&str>) -> Result<(), String> {
        let label = clean_label(&label, "work task")?;
        let next = self.next_number("task-");
        let revision = self.revision.saturating_add(1);
        let milestone = self
            .active_milestone_mut()
            .ok_or_else(|| "there is no active milestone".to_owned())?;
        if milestone
            .work_plan
            .tasks
            .iter()
            .any(|task| task.label == label)
        {
            return Err("Work Plan task labels must be unique within a milestone".into());
        }
        let task = WorkTask {
            id: format!("task-{next}"),
            label,
            status: Status::Pending,
            revision,
        };
        if let Some(after_id) = after_id {
            let position = milestone
                .work_plan
                .tasks
                .iter()
                .position(|candidate| candidate.id == after_id)
                .ok_or_else(|| format!("unknown work task: {after_id}"))?;
            milestone.work_plan.tasks.insert(position + 1, task);
        } else {
            milestone.work_plan.tasks.push(task);
        }
        milestone.work_plan.revision = milestone.work_plan.revision.saturating_add(1);
        self.bump();
        self.promote_next_task();
        Ok(())
    }

    pub fn refine_work(&mut self, id: &str, label: String) -> Result<(), String> {
        let label = clean_label(&label, "work task")?;
        let revision = self.revision.saturating_add(1);
        let milestone = self
            .active_milestone_mut()
            .ok_or_else(|| "there is no active milestone".to_owned())?;
        if milestone
            .work_plan
            .tasks
            .iter()
            .any(|task| task.id != id && task.label == label)
        {
            return Err("Work Plan task labels must be unique within a milestone".into());
        }
        let task = milestone
            .work_plan
            .tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| format!("unknown work task: {id}"))?;
        if task.status.is_terminal() {
            return Err(
                "completed or dropped work tasks are retained history and cannot be refined".into(),
            );
        }
        task.label = label;
        task.revision = revision;
        milestone.work_plan.revision = milestone.work_plan.revision.saturating_add(1);
        self.bump();
        Ok(())
    }

    /// Splitting preserves the original task as abandoned history and inserts
    /// replacement tasks immediately after it. It never erases a completed
    /// task or changes a stable id into a different task.
    pub fn split_work(&mut self, id: &str, labels: Vec<String>) -> Result<(), String> {
        if labels.len() < 2 {
            return Err("split requires at least two replacement tasks".into());
        }
        let labels = labels
            .into_iter()
            .map(|label| clean_label(&label, "work task"))
            .collect::<Result<Vec<_>, _>>()?;
        if has_duplicates(&labels) {
            return Err("split task labels must be unique".into());
        }
        let start = self.next_number("task-");
        let revision = self.revision.saturating_add(1);
        let milestone = self
            .active_milestone_mut()
            .ok_or_else(|| "there is no active milestone".to_owned())?;
        let position = milestone
            .work_plan
            .tasks
            .iter()
            .position(|task| task.id == id)
            .ok_or_else(|| format!("unknown work task: {id}"))?;
        if milestone.work_plan.tasks[position].status.is_terminal() {
            return Err("completed or dropped work task cannot be split".into());
        }
        milestone.work_plan.tasks[position].status = Status::Abandoned;
        milestone.work_plan.tasks[position].revision = revision;
        for (offset, label) in labels.into_iter().enumerate() {
            milestone.work_plan.tasks.insert(
                position + 1 + offset,
                WorkTask {
                    id: format!("task-{}", start + offset),
                    label,
                    status: Status::Pending,
                    revision,
                },
            );
        }
        milestone.work_plan.revision = milestone.work_plan.revision.saturating_add(1);
        self.bump();
        self.promote_next_task();
        Ok(())
    }

    pub fn start_work(&mut self, id: &str) -> Result<(), String> {
        let milestone = self
            .active_milestone_mut()
            .ok_or_else(|| "there is no active milestone".to_owned())?;
        let position = milestone
            .work_plan
            .tasks
            .iter()
            .position(|task| task.id == id)
            .ok_or_else(|| format!("unknown work task: {id}"))?;
        if milestone.work_plan.tasks[position].status.is_terminal() {
            return Err("completed or dropped work task cannot be started".into());
        }
        if milestone.work_plan.tasks[..position]
            .iter()
            .any(|task| task.status.is_open())
        {
            return Err("cannot start a work task before earlier open tasks".into());
        }
        for task in &mut milestone.work_plan.tasks {
            if task.status == Status::InProgress {
                task.status = Status::Pending;
            }
        }
        milestone.work_plan.tasks[position].status = Status::InProgress;
        milestone.work_plan.revision = milestone.work_plan.revision.saturating_add(1);
        self.bump();
        Ok(())
    }

    pub fn finish_work(&mut self, id: &str, abandoned: bool) -> Result<(), String> {
        let revision = self.revision.saturating_add(1);
        let milestone = self
            .active_milestone_mut()
            .ok_or_else(|| "there is no active milestone".to_owned())?;
        let task = milestone
            .work_plan
            .tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| format!("unknown work task: {id}"))?;
        if task.status.is_terminal() {
            return Err("work task is already completed or dropped".into());
        }
        task.status = if abandoned {
            Status::Abandoned
        } else {
            Status::Completed
        };
        task.revision = revision;
        milestone.work_plan.revision = milestone.work_plan.revision.saturating_add(1);
        self.bump();
        self.promote_next_task();
        Ok(())
    }

    fn promote_next_milestone(&mut self) {
        if self
            .active_milestone()
            .is_some_and(|milestone| milestone.status.is_open())
        {
            return;
        }
        if let Some(milestone) = self
            .milestones
            .iter_mut()
            .find(|milestone| milestone.status == Status::Pending)
        {
            milestone.status = Status::InProgress;
            self.active_milestone_id = Some(milestone.id.clone());
        }
    }

    fn promote_next_task(&mut self) {
        let Some(milestone) = self.active_milestone_mut() else {
            return;
        };
        if milestone
            .work_plan
            .tasks
            .iter()
            .any(|task| task.status == Status::InProgress)
        {
            return;
        }
        if let Some(task) = milestone
            .work_plan
            .tasks
            .iter_mut()
            .find(|task| task.status == Status::Pending)
        {
            task.status = Status::InProgress;
        }
    }

    fn next_number(&self, prefix: &str) -> usize {
        let milestone_ids = self
            .milestones
            .iter()
            .map(|milestone| milestone.id.as_str());
        let task_ids = self.milestones.iter().flat_map(|milestone| {
            milestone
                .work_plan
                .tasks
                .iter()
                .map(|task| task.id.as_str())
        });
        milestone_ids
            .chain(task_ids)
            .filter_map(|id| id.strip_prefix(prefix)?.parse::<usize>().ok())
            .max()
            .unwrap_or(0)
            + 1
    }

    fn bump(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }
}

fn clean_label(label: &str, kind: &str) -> Result<String, String> {
    let label = label.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.is_empty() {
        Err(format!("{kind} label must not be empty"))
    } else if label.chars().count() > 180 {
        Err(format!("{kind} label is too long"))
    } else {
        Ok(label)
    }
}

fn has_duplicates(values: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    values.iter().any(|value| !seen.insert(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_ids_and_history_survive_refinement() {
        let mut plan = GoalPlan::default();
        plan.init(vec!["Inspect project".into(), "Implement".into()])
            .unwrap();
        let milestone = plan.active_milestone().unwrap().id.clone();
        plan.init_work(vec!["Read entry point".into(), "Map routing".into()])
            .unwrap();
        let task = plan.active_work_task().unwrap().id.clone();
        plan.finish_work(&task, false).unwrap();
        let active = plan.active_work_task().unwrap().id.clone();
        plan.refine_work(&active, "Map application routing".into())
            .unwrap();
        assert_eq!(plan.active_milestone().unwrap().id, milestone);
        let saved = plan.active_milestone().unwrap().work_plan.tasks[0].clone();
        assert_eq!(saved.id, task);
        assert_eq!(saved.status, Status::Completed);
        assert_eq!(saved.label, "Read entry point");
        assert_eq!(
            plan.active_milestone().unwrap().work_plan.tasks[1].label,
            "Map application routing"
        );
        assert!(plan
            .refine_work(&task, "Cannot rewrite history".into())
            .is_err());
    }

    #[test]
    fn promotes_tasks_then_next_milestone() {
        let mut plan = GoalPlan::default();
        plan.init(vec!["Research".into(), "Report".into()]).unwrap();
        let research = plan.active_milestone().unwrap().id.clone();
        plan.init_work(vec!["Files".into(), "Architecture".into()])
            .unwrap();
        let first = plan.active_work_task().unwrap().id.clone();
        plan.finish_work(&first, false).unwrap();
        assert_eq!(plan.active_work_task().unwrap().label, "Architecture");
        let second = plan.active_work_task().unwrap().id.clone();
        plan.finish_work(&second, false).unwrap();
        plan.finish_milestone(&research, false).unwrap();
        assert_eq!(plan.active_milestone().unwrap().label, "Report");
        assert!(plan.active_milestone().unwrap().work_plan.tasks.is_empty());
    }

    #[test]
    fn split_keeps_original_history_and_creates_new_ids() {
        let mut plan = GoalPlan::default();
        plan.init(vec!["Implement".into()]).unwrap();
        plan.init_work(vec!["Build feature".into()]).unwrap();
        let old = plan.active_work_task().unwrap().id.clone();
        plan.split_work(&old, vec!["Build UI".into(), "Build API".into()])
            .unwrap();
        let tasks = &plan.active_milestone().unwrap().work_plan.tasks;
        assert_eq!(tasks[0].id, old);
        assert_eq!(tasks[0].status, Status::Abandoned);
        assert_eq!(tasks[1].status, Status::InProgress);
        assert_ne!(tasks[1].id, tasks[2].id);
    }

    #[test]
    fn model_can_complete_work_without_runtime_evidence() {
        let mut plan = GoalPlan::default();
        plan.init(vec!["Implement".into()]).unwrap();
        plan.init_work(vec!["Change source".into()]).unwrap();
        let task = plan.active_work_task().unwrap().id.clone();
        plan.finish_work(&task, false).unwrap();
        assert_eq!(
            plan.active_milestone().unwrap().work_plan.tasks[0].status,
            Status::Completed
        );
    }

    #[test]
    fn resume_accepts_the_persisted_electron_plan_shape() {
        let plan: GoalPlan = serde_json::from_value(serde_json::json!({
            "milestones":[{
                "id":"milestone-1",
                "label":"Inspect",
                "status":"in_progress",
                "workPlan":{"tasks":[{"id":"task-1","label":"Read runtime","status":"in_progress"}]}
            }],
            "activeMilestoneId":"milestone-1"
        }))
        .unwrap();
        assert_eq!(plan.active_milestone_id.as_deref(), Some("milestone-1"));
        assert_eq!(plan.active_work_task().unwrap().id, "task-1");
    }

    #[test]
    fn dropping_active_milestone_preserves_children_and_promotes_next() {
        let mut plan = GoalPlan::default();
        plan.init(vec!["Investigate".into(), "Report".into()])
            .unwrap();
        let first = plan.active_milestone().unwrap().id.clone();
        plan.init_work(vec!["Read source".into()]).unwrap();
        plan.drop_milestone(&first).unwrap();
        let dropped = plan
            .milestones
            .iter()
            .find(|item| item.id == first)
            .unwrap();
        assert_eq!(dropped.status, Status::Abandoned);
        assert_eq!(dropped.work_plan.tasks[0].status, Status::Abandoned);
        assert_eq!(plan.active_milestone().unwrap().label, "Report");
    }

    #[test]
    fn resume_normalizes_missing_active_id_without_resetting_history() {
        let mut plan = GoalPlan::default();
        plan.init(vec!["Inspect".into()]).unwrap();
        plan.active_milestone_id = None;
        plan.normalize_active();
        assert_eq!(plan.active_milestone().unwrap().label, "Inspect");
    }
}
