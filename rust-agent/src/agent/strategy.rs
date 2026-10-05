//! Fast and Deep are two investigation strategies, not two token budgets.
//!
//! Both modes share the same tools, context window and evidence rules. They
//! differ in how the model is told to *spend* its observations (guidance) and
//! in a few bounded, deterministic runtime mechanisms that only Deep enables:
//! a periodic checkpoint that asks the model to separate confirmed facts from
//! inferences and unknowns, and one convergence review before a final answer
//! while unresolved items are still recorded. Nothing here names a model, a
//! language, a framework, a file type or a benchmark.

use super::task_memory::TaskMemory;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Strategy {
    #[default]
    Fast,
    Deep,
}

/// Tool calls without a Task Memory update after which Deep asks for a
/// checkpoint. Small enough to catch drift, large enough not to interrupt a
/// batch of related reads.
pub const CHECKPOINT_INTERVAL: usize = 6;

/// Task Memory is a compact working record, not a transcript of every fact.
/// A model that answers a checkpoint by dumping dozens of one-line entries
/// bloats every later prompt, so writes beyond this per turn are refused.
pub const MAX_MEMORY_WRITES_PER_TURN: usize = 2;

impl Strategy {
    pub fn from_mode(mode: &str) -> Self {
        if mode == "deep" {
            Strategy::Deep
        } else {
            Strategy::Fast
        }
    }

    pub fn is_deep(self) -> bool {
        self == Strategy::Deep
    }

    pub fn guidance(self) -> &'static str {
        match self {
            Strategy::Fast => FAST_GUIDANCE,
            Strategy::Deep => DEEP_GUIDANCE,
        }
    }
}

const FAST_GUIDANCE: &str = r#"
# Investigation strategy: Fast
- Aim for the smallest set of observations that supports a correct, honest answer. Orient once, pick the few sources most likely to decide each question, and read those.
- Request independent reads/listings together in one turn instead of one per turn.
- Do not widen the search to be thorough. Follow a reference only if your answer would be materially wrong or empty without it; otherwise say it was not inspected.
- Stop investigating as soon as the questions are answerable from what you hold, then answer. Prefer a precise, compact answer over an exhaustive one.
"#;

const DEEP_GUIDANCE: &str = r#"
# Investigation strategy: Deep
Deep means a more rigorous investigation, not a longer one. Spend observations where they remove the most uncertainty.
- Frame first. Before the first tool call, state in a few lines what the answer must establish and which unknowns would most change it. Rank them by impact, not by how easy they are to inspect.
- Orient cheaply, then go deep on the few decisive threads. On a large or unfamiliar codebase, do not read broadly for coverage; read the sources that decide the highest-impact questions.
- Follow each important behavior across boundaries (caller, interface, handler, storage, external service) to where its real effect or side effect happens. A description of one layer is not evidence about the layer behind it: if a claim depends on the next hop and you have not opened it, open it or mark the claim unverified.
- Verify a claim at its source rather than from a name, a comment, a summary, or an earlier inference. Actively look for evidence that would contradict your current understanding, for example a second code path, an override, a config switch, or a mismatch between layers.
- Keep Task Memory current as a compact working record of a few entries (revise an entry by id instead of adding near-duplicates; never one entry per fact), using its status field: confirmed (observed and cited), inferred (reasoned, not observed), unknown (still open, with the step that would resolve it), contradicted (evidence disagrees). Update a status when new evidence changes it.
- Choose the next step by information gain: prefer the single observation that resolves the most important open item. Do not re-read what you already hold, and do not chase low-impact items.
- Check completion against what you observed, not what you intended to build: before you finish, compare each requested deliverable with evidence that it works.
- Converge. When the central questions are answered from observed evidence and the remaining unknowns are low-impact, stop and answer. In the answer, state which conclusions are confirmed, which are inferred, and what stayed unverified.
"#;

/// Unresolved items that Deep should surface at each turn: things the model
/// itself recorded as still unknown or contradicted.
pub fn open_unknowns(memory: &TaskMemory) -> Vec<String> {
    memory
        .entries
        .iter()
        .filter(|entry| !entry.invalidated && entry.status.is_some_and(|s| s.is_unresolved()))
        .map(|entry| {
            if entry.next.is_empty() {
                format!("{}: {}", entry.id, entry.finding)
            } else {
                format!(
                    "{}: {} (to resolve: {})",
                    entry.id, entry.finding, entry.next
                )
            }
        })
        .collect()
}

pub fn checkpoint_due(strategy: Strategy, calls_since_memory: usize) -> bool {
    strategy.is_deep() && calls_since_memory >= CHECKPOINT_INTERVAL
}

pub fn checkpoint_text(calls_since_memory: usize) -> String {
    format!("<investigation_checkpoint>{calls_since_memory} tool calls since Task Memory was last updated. Make one consolidated Task Memory update (revise an existing entry by id rather than adding one entry per fact) covering what is now confirmed, inferred, unknown or contradicted, then take the single next observation with the highest information gain, or conclude if the central questions are answered.</investigation_checkpoint>")
}

pub fn open_unknowns_text(memory: &TaskMemory) -> String {
    let items = open_unknowns(memory);
    if items.is_empty() {
        return String::new();
    }
    let listed = items
        .iter()
        .take(4)
        .map(|item| format!("- {item}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("<open_unknowns>\n{listed}\n</open_unknowns>")
}

/// One-shot review at a tool-free final candidate. It never blocks the answer
/// twice, so it cannot deadlock the run.
pub fn convergence_review(strategy: Strategy, memory: &TaskMemory) -> Option<String> {
    if !strategy.is_deep() {
        return None;
    }
    let items = open_unknowns(memory);
    if items.is_empty() {
        return None;
    }
    let listed = items
        .iter()
        .take(4)
        .map(|item| format!("- {item}"))
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!("Before finishing: Task Memory still records unresolved items:\n{listed}\nFor each one that bears on a claim you are about to make, resolve it with the most targeted inspection available now and update its status. For the rest, finish and report them explicitly as unverified or unknown; do not state them as fact."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::task_memory::Status;

    fn memory_with(entries: &[(&str, Option<Status>, &str)]) -> TaskMemory {
        let mut memory = TaskMemory::default();
        for (finding, status, next) in entries {
            memory
                .upsert_with_status(
                    None,
                    (*finding).into(),
                    String::new(),
                    String::new(),
                    (*next).into(),
                    None,
                    *status,
                )
                .unwrap();
        }
        memory
    }

    #[test]
    fn mode_selects_strategy() {
        assert_eq!(Strategy::from_mode("deep"), Strategy::Deep);
        assert_eq!(Strategy::from_mode("fast"), Strategy::Fast);
        assert_eq!(Strategy::from_mode("anything else"), Strategy::Fast);
    }

    #[test]
    fn guidance_differs_and_stays_generic() {
        let fast = Strategy::Fast.guidance();
        let deep = Strategy::Deep.guidance();
        assert_ne!(fast, deep);
        assert!(deep.contains("across boundaries"));
        assert!(fast.contains("smallest set"));
        for text in [fast, deep] {
            let lower = text.to_lowercase();
            for banned in [
                "qwen",
                "glm",
                "react",
                "php",
                ".tsx",
                ".json",
                "online-shop",
                "benchmark",
            ] {
                assert!(!lower.contains(banned), "guidance mentions {banned}");
            }
        }
    }

    #[test]
    fn checkpoint_is_deep_only_and_interval_gated() {
        assert!(!checkpoint_due(Strategy::Fast, 100));
        assert!(!checkpoint_due(Strategy::Deep, CHECKPOINT_INTERVAL - 1));
        assert!(checkpoint_due(Strategy::Deep, CHECKPOINT_INTERVAL));
    }

    #[test]
    fn only_unresolved_valid_entries_are_open_unknowns() {
        let mut memory = memory_with(&[
            ("confirmed fact", Some(Status::Confirmed), ""),
            ("inferred hop", Some(Status::Inferred), ""),
            (
                "what handles the submit",
                Some(Status::Unknown),
                "open the handler",
            ),
            ("layers disagree", Some(Status::Contradicted), ""),
            ("legacy entry without status", None, ""),
        ]);
        let open = open_unknowns(&memory);
        assert_eq!(open.len(), 2);
        assert!(open[0].contains("to resolve: open the handler"));
        memory.invalidate("tm-003").unwrap();
        assert_eq!(open_unknowns(&memory).len(), 1);
        assert!(open_unknowns_text(&memory).starts_with("<open_unknowns>"));
    }

    #[test]
    fn convergence_review_needs_deep_and_open_unknowns() {
        let open = memory_with(&[("unverified hop", Some(Status::Unknown), "")]);
        let closed = memory_with(&[("done", Some(Status::Confirmed), "")]);
        assert!(convergence_review(Strategy::Fast, &open).is_none());
        assert!(convergence_review(Strategy::Deep, &closed).is_none());
        let text = convergence_review(Strategy::Deep, &open).unwrap();
        assert!(text.contains("unverified hop"));
    }
}
