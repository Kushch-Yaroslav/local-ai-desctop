//! Local V2 adaptation of Jan's ordered `TodoList`; the GUI calls it Task Plan.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pending,
    InProgress,
    Completed,
    Abandoned,
}
impl Default for Status {
    fn default() -> Self {
        Self::Pending
    }
}
impl Status {
    fn open(self) -> bool {
        matches!(self, Self::Pending | Self::InProgress)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub content: String,
    #[serde(default)]
    pub status: Status,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Phase {
    pub name: String,
    pub tasks: Vec<Item>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskPlan {
    pub phases: Vec<Phase>,
}

impl TaskPlan {
    pub fn has_open(&self) -> bool {
        self.items().any(|task| task.status.open())
    }
    pub fn progress(&self) -> (usize, usize) {
        let tasks: Vec<_> = self.items().collect();
        (
            tasks
                .iter()
                .filter(|task| matches!(task.status, Status::Completed | Status::Abandoned))
                .count(),
            tasks.len(),
        )
    }
    pub fn active_phase(&self) -> Option<&str> {
        self.phases
            .iter()
            .find(|phase| {
                phase
                    .tasks
                    .iter()
                    .any(|item| item.status == Status::InProgress)
            })
            .map(|phase| phase.name.as_str())
    }
    pub fn open_summary(&self) -> Option<String> {
        let entries: Vec<_> = self
            .phases
            .iter()
            .flat_map(|phase| {
                phase
                    .tasks
                    .iter()
                    .filter_map(move |task| match task.status {
                        Status::Pending => Some(format!("• [{}] {}", phase.name, task.content)),
                        Status::InProgress => Some(format!("→ [{}] {}", phase.name, task.content)),
                        _ => None,
                    })
            })
            .collect();
        (!entries.is_empty()).then(|| entries.join("\n"))
    }
    pub fn init(&mut self, mut phases: Vec<Phase>) -> Result<(), String> {
        // A plan may be refined as investigation uncovers scope. Preserve the
        // terminal state of unchanged task labels so refinement never makes
        // evidence look unexplored again. New labels remain model-authored
        // pending work and ordering is still normalized below.
        let previous = self
            .items()
            .map(|item| (item.content.clone(), item.status))
            .collect::<std::collections::HashMap<_, _>>();
        let mut phase_names = std::collections::HashSet::new();
        let mut task_names = std::collections::HashSet::new();
        for phase in &mut phases {
            if phase.name.trim().is_empty() || !phase_names.insert(phase.name.clone()) {
                return Err("Task Plan phases must have unique names".into());
            }
            for task in &mut phase.tasks {
                if task.content.trim().is_empty() || !task_names.insert(task.content.clone()) {
                    return Err("Task Plan tasks must be non-empty and unique".into());
                }
                task.status = previous
                    .get(&task.content)
                    .copied()
                    .unwrap_or(Status::Pending);
            }
        }
        self.phases = phases;
        self.promote_next();
        Ok(())
    }
    pub fn start(&mut self, task: &str) -> Result<(), String> {
        let target = self
            .index_of(task)
            .ok_or_else(|| format!("unknown Task Plan item: {task}"))?;
        for (index, prior) in self.items().enumerate() {
            if index >= target {
                break;
            }
            if prior.status.open() {
                return Err("cannot start work before earlier Task Plan items are closed".into());
            }
        }
        for item in self.items_mut() {
            if item.status == Status::InProgress {
                item.status = Status::Pending;
            }
        }
        self.item_mut(target).expect("known item").status = Status::InProgress;
        Ok(())
    }
    pub fn finish(&mut self, task: &str, abandoned: bool) -> Result<(), String> {
        let index = self
            .index_of(task)
            .ok_or_else(|| format!("unknown Task Plan item: {task}"))?;
        self.item_mut(index).expect("known item").status = if abandoned {
            Status::Abandoned
        } else {
            Status::Completed
        };
        self.promote_next();
        Ok(())
    }
    fn items(&self) -> impl Iterator<Item = &Item> {
        self.phases.iter().flat_map(|phase| phase.tasks.iter())
    }
    fn items_mut(&mut self) -> impl Iterator<Item = &mut Item> {
        self.phases
            .iter_mut()
            .flat_map(|phase| phase.tasks.iter_mut())
    }
    fn index_of(&self, task: &str) -> Option<usize> {
        self.items().position(|item| item.content == task)
    }
    fn item_mut(&mut self, mut index: usize) -> Option<&mut Item> {
        for phase in &mut self.phases {
            if index < phase.tasks.len() {
                return phase.tasks.get_mut(index);
            }
            index -= phase.tasks.len();
        }
        None
    }
    fn promote_next(&mut self) {
        if self.items().any(|item| item.status == Status::InProgress) {
            return;
        }
        if let Some(item) = self.items_mut().find(|item| item.status == Status::Pending) {
            item.status = Status::InProgress;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn phase(name: &str, tasks: &[&str]) -> Phase {
        Phase {
            name: name.into(),
            tasks: tasks
                .iter()
                .map(|content| Item {
                    content: (*content).into(),
                    status: Status::Completed,
                })
                .collect(),
        }
    }
    #[test]
    fn orders_and_promotes_items() {
        let mut plan = TaskPlan::default();
        plan.init(vec![
            phase("Setup", &["scaffold"]),
            phase("Verify", &["test"]),
        ])
        .unwrap();
        assert_eq!(plan.active_phase(), Some("Setup"));
        assert!(plan.start("test").is_err());
        plan.finish("scaffold", false).unwrap();
        assert_eq!(plan.active_phase(), Some("Verify"));
        plan.finish("test", false).unwrap();
        assert!(!plan.has_open());
        assert_eq!(plan.progress(), (2, 2));
    }

    #[test]
    fn refinement_keeps_terminal_status_for_same_task() {
        let mut plan = TaskPlan::default();
        plan.init(vec![phase(
            "Setup",
            &["inspect structure", "identify flow"],
        )])
        .unwrap();
        plan.finish("inspect structure", false).unwrap();
        plan.init(vec![
            phase("Setup", &["inspect structure", "identify flow"]),
            phase("Synthesis", &["write audit"]),
        ])
        .unwrap();
        let setup = &plan.phases[0].tasks;
        assert_eq!(setup[0].status, Status::Completed);
        assert_eq!(setup[1].status, Status::InProgress);
    }
}
