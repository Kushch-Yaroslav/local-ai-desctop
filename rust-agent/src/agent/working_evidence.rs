//! A bounded, deterministic view of findings already accepted into canonical
//! task memory or assistant turns. This is an index, not another source of truth.
use crate::agent::task_memory::TaskMemory;
use crate::agent::transcript::{Entry, Transcript};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EstablishedEvidence {
    pub id: String,
    pub claim: String,
    pub origin: String,
    pub observation_id: Option<String>,
    pub source: Option<String>,
    pub revision: Option<String>,
}

impl EstablishedEvidence {
    pub fn line(&self) -> String {
        format!(
            "{} [{}] {} | source={} | observation={} | historical_revision={} | exact recovery: observation_read only for a specific missing detail or contradiction",
            self.id,
            self.origin,
            self.claim,
            self.source.as_deref().unwrap_or("unattributed"),
            self.observation_id.as_deref().unwrap_or("none"),
            self.revision.as_deref().unwrap_or("unknown"),
        )
    }
}

fn concise(text: &str, max_chars: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = text.chars().take(max_chars).collect::<String>();
    if out.chars().count() < text.chars().count() {
        out.push('…');
    }
    out
}

fn existed_at(o: &crate::agent::evidence::Observation, entry_index: Option<usize>) -> bool {
    entry_index.is_none_or(|index| {
        o.event_id
            .strip_prefix("evt-")
            .and_then(|s| s.parse::<usize>().ok())
            .is_some_and(|event| event <= index + 1)
    })
}

fn cited_observation<'a>(
    text: &str,
    transcript: &'a Transcript,
    entry_index: Option<usize>,
) -> Option<&'a crate::agent::evidence::Observation> {
    transcript
        .observations()
        .iter()
        .rev()
        .filter(|o| existed_at(o, entry_index))
        .find(|o| {
            // A citation is an exact token, not a substring of another ID.
            text.match_indices(&o.id).any(|(start, _)| {
                let end = start + o.id.len();
                !text[..start]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '-')
                    && !text[end..]
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '-')
            })
        })
}

fn named_observation<'a>(
    text: &str,
    transcript: &'a Transcript,
    entry_index: Option<usize>,
) -> Option<&'a crate::agent::evidence::Observation> {
    let sources = transcript
        .observations()
        .iter()
        .filter(|o| existed_at(o, entry_index))
        .filter_map(|o| o.source.as_deref())
        .collect::<HashSet<_>>();
    transcript
        .observations()
        .iter()
        .rev()
        .filter(|o| existed_at(o, entry_index))
        .filter_map(|o| {
            if o.error
                || !matches!(
                    o.tool.as_str(),
                    "read_file" | "run_terminal" | "project_knowledge_read"
                )
            {
                return None;
            }
            let source = o.source.as_deref()?;
            let name = source.rsplit('/').next().unwrap_or(source);
            text.find(source)
                .or_else(|| {
                    (name.chars().count() >= 5
                        && sources
                            .iter()
                            .filter(|other| other.rsplit('/').next() == Some(name))
                            .count()
                            == 1)
                        .then(|| text.find(name))
                        .flatten()
                })
                .map(|position| (position, o))
        })
        .min_by_key(|(position, _)| *position)
        .map(|(_, observation)| observation)
}

fn provenance<'a>(
    text: &str,
    transcript: &'a Transcript,
    entry_index: Option<usize>,
) -> Option<&'a crate::agent::evidence::Observation> {
    cited_observation(text, transcript, entry_index)
        .or_else(|| named_observation(text, transcript, entry_index))
}

pub fn collect(transcript: &Transcript, memory: &TaskMemory) -> Vec<EstablishedEvidence> {
    let mut facts = Vec::new();
    let start = transcript
        .entries()
        .iter()
        .rposition(|entry| matches!(entry, Entry::RunUser(_)))
        .unwrap_or(0);
    for entry in transcript.entries().iter().skip(start) {
        if let Entry::Evidence(fact) = entry {
            facts.push(fact.clone());
        }
    }
    for entry in memory.entries.iter().filter(|entry| !entry.invalidated) {
        let text = format!("{} {} {}", entry.finding, entry.evidence, entry.implication);
        let reference = provenance(&text, transcript, None);
        facts.push(EstablishedEvidence {
            id: entry.id.clone(),
            claim: concise(&entry.finding, 420),
            origin: if cited_observation(&entry.evidence, transcript, None).is_some() {
                "task-memory cited"
            } else {
                "task-memory source-associated"
            }
            .into(),
            observation_id: reference.map(|o| o.id.clone()),
            source: reference.and_then(|o| o.source.clone()),
            revision: reference.and_then(|o| o.source_revision.clone()),
        });
    }
    for (index, entry) in transcript.entries().iter().enumerate().skip(start) {
        let Entry::Message(message) = entry else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant")
            || message.get("_runtime_draft_status").is_some()
        {
            continue;
        }
        let content = message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if content.is_empty() {
            continue;
        }
        let Some(reference) = provenance(content, transcript, Some(index)) else {
            continue;
        };
        // The statement is the assistant's accepted words. A source association
        // is provenance, not a claim that the runtime verified its semantics.
        facts.push(EstablishedEvidence {
            id: format!("ae-{index:08}"),
            claim: concise(content, 420),
            origin: "assistant statement; source-associated".into(),
            observation_id: Some(reference.id.clone()),
            source: reference.source.clone(),
            revision: reference.source_revision.clone(),
        });
    }
    facts
}

pub fn project(
    facts: &[EstablishedEvidence],
    objective: &str,
    max_chars: usize,
) -> (String, Vec<String>) {
    let words = objective
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| s.chars().count() >= 5)
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    let mut ranked = facts
        .iter()
        .enumerate()
        .filter(|(_, f)| f.observation_id.is_some())
        .map(|(index, fact)| {
            let text =
                format!("{} {}", fact.claim, fact.source.as_deref().unwrap_or("")).to_lowercase();
            let relevance = words
                .iter()
                .filter(|word| text.contains(word.as_str()))
                .count()
                .min(8);
            let authority = if matches!(
                fact.origin.as_str(),
                "agent-reported direct" | "task-memory cited"
            ) {
                2
            } else if fact.origin == "agent inference" {
                0
            } else {
                1
            };
            (authority, relevance, index, fact)
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| b.2.cmp(&a.2))
    });
    let mut lines = Vec::new();
    let mut ids = Vec::new();
    let mut used = 0;
    for (_, _, _, fact) in ranked {
        let line = fact.line();
        if used + line.chars().count() + 1 > max_chars {
            continue;
        }
        used += line.chars().count() + 1;
        ids.push(fact.id.clone());
        lines.push(line);
    }
    (lines.join("\n"), ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::transcript::ValidatedCall;
    use serde_json::json;
    use std::fs;

    #[test]
    fn precise_evidence_is_stable_bounded_and_recoverable_across_compactions_and_restart() {
        let base = std::env::temp_dir().join(format!(
            "working-evidence-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("api.php"), "<?php WorldFilia submit_order();").unwrap();
        fs::write(root.join("route.ts"), "export const route = 'checkout';").unwrap();
        let store = base.join("evidence");
        let mut t = Transcript::durable(&store, "run", &[], root.to_str()).unwrap();
        t.push_run_user(json!({"role":"user","content":"audit api.php routing"}));
        let mut ids = Vec::new();
        for (n, path, claim) in [
            ("a", "api.php", "api.php sends orders to WorldFilia"),
            ("b", "route.ts", "route.ts owns routing to checkout"),
        ] {
            t.assistant_tool_turn(
                "".into(),
                &[ValidatedCall {
                    id: n.into(),
                    name: "read_file".into(),
                    arguments: json!({"path":path}),
                }],
            );
            t.tool_result(n, "read_file", format!("{}{}", claim, "x".repeat(50_000)));
            let id = t.observations().last().unwrap().id.clone();
            t.record_established_evidence(claim, &id, false).unwrap();
            ids.push(id);
        }
        let original = collect(&t, &TaskMemory::default());
        let (first, selected) = project(&original, "audit api.php routing", 2_000);
        assert!(first.contains("WorldFilia") && first.contains("checkout"));
        assert!(first.chars().count() <= 2_000);
        assert_eq!(selected.len(), 2);
        for cycle in 0..3 {
            for step in 0..3 {
                t.assistant_message(format!("more work {cycle}.{step}"));
            }
            let plan = t.compaction_plan(2).unwrap();
            t.compact(format!("checkpoint generation {cycle}"), plan.covers);
            let (again, again_ids) = project(
                &collect(&t, &TaskMemory::default()),
                "audit api.php routing",
                2_000,
            );
            assert_eq!(again, first, "evidence must not be summarized again");
            assert_eq!(again_ids, selected);
        }
        assert_eq!(
            t.read_observation(&ids[0], 0, 14).unwrap()["content"],
            "api.php sends "
        );
        t.mark_finalizing();
        let journal = fs::read_to_string(store.join("run/events.jsonl")).unwrap();
        assert!(!journal.contains(&"x".repeat(1_000)));
        drop(t);
        let resumed = Transcript::durable(&store, "restart", &[], root.to_str()).unwrap();
        assert!(resumed.is_finalizing());
        assert_eq!(
            project(
                &collect(&resumed, &TaskMemory::default()),
                "audit api.php routing",
                2_000
            )
            .0,
            first
        );
        assert!(resumed.read_observation(&ids[1], 0, 30).is_ok());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn many_findings_use_a_deterministic_projection_budget() {
        let facts = (0..180)
            .map(|i| EstablishedEvidence {
                id: format!("ev-{i}"),
                claim: format!(
                    "finding {i} about {}",
                    if i == 0 {
                        "backend api.php"
                    } else {
                        "unrelated module"
                    }
                ),
                origin: "agent established from observation".into(),
                observation_id: Some(format!("obs-{i:08}")),
                source: Some(format!("file-{i}.ts")),
                revision: None,
            })
            .collect::<Vec<_>>();
        let (a, ids) = project(&facts, "audit backend api.php", 1_000);
        let (b, again) = project(&facts, "audit backend api.php", 1_000);
        assert_eq!(a, b);
        assert_eq!(ids, again);
        assert!(a.chars().count() <= 1_000);
        assert!(ids.contains(&"ev-0".to_owned()));
        assert!(ids.len() < facts.len());
    }
}
