//! Small per-run working memory. This is a handoff list, not project knowledge.
use serde::{Deserialize, Serialize};

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
    pub todo_id: Option<String>,
    #[serde(default)]
    pub supersedes: Option<String>,
    #[serde(default)]
    pub invalidated: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskMemory {
    #[serde(default)]
    pub entries: Vec<TaskMemoryEntry>,
    #[serde(default)]
    pub revision: u64,
}
impl TaskMemory {
    pub fn upsert(
        &mut self,
        id: Option<&str>,
        finding: String,
        evidence: String,
        implication: String,
        next: String,
        todo_id: Option<String>,
        supersedes: Option<String>,
    ) -> Result<String, String> {
        let finding = clean(&finding, true)?;
        let id = id
            .filter(|v| !v.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("tm-{:03}", self.entries.len() + 1));
        if let Some(entry) = self.entries.iter_mut().find(|e| e.id == id) {
            entry.finding = finding;
            entry.evidence = clean(&evidence, false)?;
            entry.implication = clean(&implication, false)?;
            entry.next = clean(&next, false)?;
            entry.todo_id = todo_id;
            entry.supersedes = supersedes;
            entry.invalidated = false;
        } else {
            if let Some(old) = supersedes
                .as_deref()
                .and_then(|old| self.entries.iter_mut().find(|e| e.id == old))
            {
                old.invalidated = true;
            }
            self.entries.push(TaskMemoryEntry {
                id: id.clone(),
                finding,
                evidence: clean(&evidence, false)?,
                implication: clean(&implication, false)?,
                next: clean(&next, false)?,
                todo_id,
                supersedes,
                invalidated: false,
            });
        }
        self.revision = self.revision.saturating_add(1);
        Ok(id)
    }
    pub fn invalidate(&mut self, id: &str) -> Result<(), String> {
        let entry = self
            .entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| format!("unknown task memory: {id}"))?;
        entry.invalidated = true;
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }
    pub fn prompt(&self, active: Option<&str>) -> String {
        // Active-Todo links are authoritative. Fill only the remaining small
        // window with recent handoffs, so an older dependency cannot disappear
        // merely because unrelated work happened later.
        let mut entries = self
            .entries
            .iter()
            .filter(|entry| {
                !entry.invalidated && active.is_some_and(|id| entry.todo_id.as_deref() == Some(id))
            })
            .take(4)
            .collect::<Vec<_>>();
        for entry in self.entries.iter().rev() {
            if entries.len() == 4 {
                break;
            }
            if entry.invalidated || entries.iter().any(|selected| selected.id == entry.id) {
                continue;
            }
            entries.push(entry);
        }
        entries
            .into_iter()
            .map(|e| {
                let mut v = vec![format!("{}: {}", e.id, e.finding)];
                if !e.evidence.is_empty() {
                    v.push(format!("  evidence: {}", e.evidence));
                }
                if !e.implication.is_empty() {
                    v.push(format!("  implication: {}", e.implication));
                }
                if !e.next.is_empty() {
                    v.push(format!("  next: {}", e.next));
                }
                v.join("\n")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_task_memory_beats_recency_with_a_bounded_prompt() {
        let mut memory = TaskMemory::default();
        for (id, finding, todo_id) in [
            ("tm-001", "product finding", None),
            ("tm-002", "architecture finding", None),
            ("tm-003", "GLM root cause", Some("todo-implement")),
            ("tm-004", "unrelated completed finding", None),
            ("tm-005", "implementation decision", Some("todo-implement")),
            ("tm-006", "verification result", None),
        ] {
            memory
                .upsert(
                    Some(id),
                    finding.into(),
                    String::new(),
                    String::new(),
                    "handoff".into(),
                    todo_id.map(str::to_owned),
                    None,
                )
                .unwrap();
        }
        let prompt = memory.prompt(Some("todo-implement"));
        assert!(prompt.contains("tm-003: GLM root cause"));
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

    #[test]
    fn completed_todo_finding_without_next_remains_available_as_a_handoff() {
        let mut memory = TaskMemory::default();
        memory
            .upsert(
                Some("tm-001"),
                "confirmed project structure".into(),
                "src/main.tsx".into(),
                "architecture stage can begin".into(),
                String::new(),
                Some("todo-1".into()),
                None,
            )
            .unwrap();

        let prompt = memory.prompt(Some("todo-2"));
        assert!(prompt.contains("tm-001: confirmed project structure"));
        assert!(prompt.contains("evidence: src/main.tsx"));
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
