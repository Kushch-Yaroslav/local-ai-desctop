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
                    + usize::from(text.contains("block") || text.contains("contradict")) * 2;
                (score, i, e)
            })
            .collect::<Vec<_>>();
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        let entries = ranked
            .into_iter()
            .take(4)
            .map(|(_, _, e)| e)
            .collect::<Vec<_>>();
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
                if include_next && !e.next.is_empty() {
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
