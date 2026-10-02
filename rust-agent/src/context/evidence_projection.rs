//! Deterministic evidence projection. Canonical tool bodies are never changed.
use crate::agent::transcript::Transcript;
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn attach_historical_index(
    transcript: &Transcript,
    messages: &mut Vec<Value>,
    max_chars: usize,
) {
    let visible: HashSet<&str> = messages
        .iter()
        .filter(|m| m.get("role").and_then(Value::as_str) == Some("tool"))
        .filter_map(|m| m.get("_observation_id").and_then(Value::as_str))
        .collect();
    let hidden = transcript
        .observations()
        .iter()
        .filter(|o| {
            !visible.contains(o.id.as_str())
                && !matches!(o.tool.as_str(), "observation_index" | "observation_read")
        })
        .collect::<Vec<_>>();
    if hidden.is_empty() {
        return;
    }
    let mut selected = Vec::new();
    let mut size = 0;
    for observation in hidden.iter().rev() {
        let receipt = observation.index_line();
        if size + receipt.len() > max_chars {
            break;
        }
        size += receipt.len();
        selected.push(receipt);
    }
    selected.reverse();
    let content = format!("[HISTORICAL OBSERVATION LOCATORS — NOT USER CONTENT]\n{} of {} older observations listed; observation_index retrieves all IDs. These are locators, not missing research. Rely on Task Memory findings for synthesis; observation_read(id) is for a specific exact detail or contradiction. Exact bodies remain in canonical storage.\n{}",
        selected.len(), hidden.len(), selected.join("\n"));
    // Before the current user turn and recent assistant/tool tail.
    let insert = messages
        .iter()
        .position(|m| {
            m.get("role").and_then(Value::as_str) == Some("user")
                && !m
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("[RUNTIME COMPACTION SUMMARY")
        })
        .unwrap_or(1);
    messages.insert(insert, json!({"role":"user","content":content}));
}

/// Fold completed old results first. The last assistant call group stays exact
/// unless it alone makes the request exceed the target. Pairing remains intact.
pub fn fold_to_budget<F>(
    transcript: &Transcript,
    messages: &mut [Value],
    target: usize,
    mut estimate: F,
) -> Vec<String>
where
    F: FnMut(&[Value]) -> usize,
{
    if estimate(messages) <= target {
        return Vec::new();
    }
    let mut complete = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        let Some(calls) = message.get("tool_calls").and_then(Value::as_array) else {
            continue;
        };
        let ids: Vec<&str> = calls
            .iter()
            .filter_map(|c| c.get("id").and_then(Value::as_str))
            .collect();
        if ids.len() != calls.len() || ids.is_empty() {
            continue;
        }
        let results: Vec<usize> = ids
            .iter()
            .filter_map(|id| {
                messages
                    .iter()
                    .enumerate()
                    .skip(index + 1)
                    .find(|(_, m)| {
                        m.get("role").and_then(Value::as_str) == Some("tool")
                            && m.get("tool_call_id").and_then(Value::as_str) == Some(id)
                    })
                    .map(|(i, _)| i)
            })
            .collect();
        if results.len() == ids.len() {
            complete.push(results);
        }
    }
    let mut folded = Vec::new();
    for group in complete {
        for index in group {
            if estimate(messages) <= target {
                return folded;
            }
            let Some(id) = messages[index]
                .get("_observation_id")
                .and_then(Value::as_str)
            else {
                continue;
            };
            let Some(meta) = transcript.observation(id) else {
                continue;
            };
            if messages[index].get("content").and_then(Value::as_str)
                == Some(meta.receipt().as_str())
            {
                continue;
            }
            messages[index]["content"] = json!(meta.receipt());
            folded.push(meta.id.clone());
        }
    }
    folded
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::transcript::{Transcript, ValidatedCall};
    use crate::context::projection::project;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn fixture() -> (std::path::PathBuf, std::path::PathBuf, Transcript) {
        let base = std::env::temp_dir().join(format!(
            "local-evidence-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("api.php"), "<?php submit_order();").unwrap();
        let transcript =
            Transcript::durable(&base.join("evidence"), "run-1", &[], root.to_str()).unwrap();
        (base, root, transcript)
    }

    fn read_step(t: &mut Transcript, id: &str, body: &str) {
        t.assistant_tool_turn(
            "".into(),
            &[ValidatedCall {
                id: id.into(),
                name: "read_file".into(),
                arguments: json!({"path":"api.php"}),
            }],
        );
        t.tool_result(id, "read_file", body.into());
    }

    #[test]
    fn historical_read_round_trip_never_becomes_an_observation_chain() {
        let (base, root, mut t) = fixture();
        t.push_run_user(json!({"role":"user","content":"audit api.php"}));
        let body = format!("{}ORDER_SUBMISSION_EXACT\n", "x".repeat(90_000));
        read_step(&mut t, "original", &body);
        let source_id = t.observations()[0].id.clone();
        t.assistant_message("Order submission found".into());
        let plan = t.compaction_plan(2).unwrap();
        t.compact("The backend was inspected".into(), plan.covers);
        let mut compacted = project(&t, "system", "");
        attach_historical_index(&t, &mut compacted, 10_000);
        assert!(compacted.iter().any(|m| m
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|s| s.contains(&source_id))));

        for (index, (offset, limit)) in [(90_000, 64), (0, 8), (89_990, 40)].into_iter().enumerate()
        {
            let result = t.read_observation(&source_id, offset, limit).unwrap();
            let call = format!("recover-{index}");
            t.assistant_tool_turn(
                "".into(),
                &[ValidatedCall {
                    id: call.clone(),
                    name: "observation_read".into(),
                    arguments: json!({"id":source_id,"offset_chars":offset,"max_chars":limit}),
                }],
            );
            t.rehydrated_tool_result(
                &call,
                "observation_read",
                &source_id,
                offset,
                limit,
                &result,
            );
            assert_eq!(t.observations().len(), 1, "recovery must not mint obs-B");
            let mut visible = project(&t, "system", "");
            attach_historical_index(&t, &mut visible, 10_000);
            fold_to_budget(&t, &mut visible, 200, |m| {
                serde_json::to_string(m).unwrap().len() / 3
            });
            let recovered = visible.iter().find(|m| m["tool_call_id"] == call).unwrap();
            assert_eq!(recovered["_result_policy"], "rehydrated");
            let recovered_result: Value =
                serde_json::from_str(recovered["content"].as_str().unwrap()).unwrap();
            assert_eq!(recovered_result["content"], result["content"]);
            assert_ne!(recovered["content"], t.observations()[0].receipt());
        }
        let plan = t.compaction_plan(2).unwrap();
        t.compact("Later checkpoint".into(), plan.covers);
        let after_second_compaction = project(&t, "system", "");
        assert!(after_second_compaction
            .iter()
            .any(|m| m["tool_call_id"] == "recover-2"
                && m["content"]
                    .as_str()
                    .is_some_and(|s| s.contains("ORDER_SUBMISSION_EXACT"))));
        let again = t.read_observation(&source_id, 90_000, 64).unwrap();
        assert!(again["content"]
            .as_str()
            .unwrap()
            .contains("ORDER_SUBMISSION_EXACT"));
        let journal = fs::read_to_string(base.join("evidence/run-1/events.jsonl")).unwrap();
        assert!(
            !journal.contains("ORDER_SUBMISSION_EXACT"),
            "rehydrated body must not be recopied into the event journal"
        );
        drop(t);
        let resumed =
            Transcript::durable(&base.join("evidence"), "resumed", &[], root.to_str()).unwrap();
        assert_eq!(resumed.observations().len(), 1);
        let rehydrated = resumed
            .entries()
            .iter()
            .filter_map(|entry| match entry {
                crate::agent::transcript::Entry::Message(m)
                    if m["_result_policy"] == "rehydrated" =>
                {
                    Some(m)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(rehydrated.len(), 3);
        assert!(rehydrated.iter().any(|m| m["content"]
            .as_str()
            .unwrap()
            .contains("ORDER_SUBMISSION_EXACT")));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn no_store_does_not_invent_receipts() {
        let transcript = Transcript::default();
        let mut messages = vec![json!({"role":"system","content":"s"})];
        attach_historical_index(&transcript, &mut messages, 1000);
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn exact_large_observation_survives_folding_compaction_and_restart() {
        let (base, root, mut t) = fixture();
        let user = "Audit the backend";
        t.push_run_user(json!({"role":"user","content":user}));
        let exact =
            json!({"path":"api.php","content":"submit_order();".repeat(20_000),"total_lines":1})
                .to_string();
        read_step(&mut t, "call-1", &exact);
        let id = t.observations()[0].id.clone();
        t.assistant_message(format!("Found order submission in observation {id}"));
        let mut messages = project(&t, "system", "");
        let folded = fold_to_budget(&t, &mut messages, 600, |m| {
            serde_json::to_string(m).unwrap().len() / 3
        });
        assert_eq!(folded, vec![id.clone()]);
        assert!(messages.iter().any(|m| m
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|s| s.contains(&id) && s.contains("observation_read"))));
        let call = messages
            .iter()
            .position(|m| m.get("tool_calls").is_some())
            .unwrap();
        assert_eq!(messages[call + 1]["tool_call_id"], "call-1");
        for n in 1..=10 {
            t.assistant_message(format!("useful new finding {n}"));
            t.push_message(json!({"role":"user","content":format!("follow-up {n}")}));
            let plan = t.compaction_plan(2).unwrap();
            t.compact(format!("checkpoint {n}"), plan.covers);
            if [2, 5, 10].contains(&n) {
                let mut projection = project(&t, "system", "");
                attach_historical_index(&t, &mut projection, 10_000);
                assert!(projection.iter().any(|m| m
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.contains(&id))));
                assert_eq!(
                    t.read_observation(&id, 0, exact.chars().count()).unwrap()["content"]
                        .as_str()
                        .unwrap()
                        .chars()
                        .count(),
                    16_000
                );
            }
        }
        t.assistant_message("final".into());
        t.mark_run_complete();
        t.finish_durable(&[], user, "final").unwrap();
        let history = vec![
            json!({"role":"user","content":user}),
            json!({"role":"assistant","content":"final"}),
        ];
        let resumed =
            Transcript::durable(&base.join("evidence"), "run-2", &history, root.to_str()).unwrap();
        assert_eq!(resumed.observations()[0].id, id);
        let first = resumed.read_observation(&id, 0, 16_000).unwrap();
        assert_eq!(first["source_changed"], false);
        fs::write(root.join("api.php"), "<?php changed();").unwrap();
        let changed = resumed.read_observation(&id, 0, 100).unwrap();
        assert_eq!(changed["historical"], true);
        assert_eq!(changed["source_changed"], true);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn legacy_history_and_error_receipt_are_preserved() {
        let (base, root, mut t) = fixture();
        t.push_run_user(json!({"role":"user","content":"inspect"}));
        read_step(&mut t, "failed", "{\"error\":\"access denied\"}");
        assert!(t.observations()[0].error);
        assert!(t.observations()[0].receipt().contains("error/blocker"));
        let old = vec![json!({"role":"user","content":"legacy request"})];
        let imported =
            Transcript::durable(&base.join("legacy"), "legacy-run", &old, root.to_str()).unwrap();
        assert!(imported.entries().iter().any(|e| matches!(e, crate::agent::transcript::Entry::Message(m) if m["content"] == "legacy request")));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn interrupted_worker_can_resume_unfinished_journal_without_duplicate_user() {
        let (base, root, mut t) = fixture();
        t.push_run_user(json!({"role":"user","content":"audit"}));
        read_step(&mut t, "first", "exact historical output");
        let id = t.observations()[0].id.clone();
        drop(t);
        let resumed =
            Transcript::durable(&base.join("evidence"), "run-2", &[], root.to_str()).unwrap();
        assert!(resumed.has_current_run_user("audit"));
        assert_eq!(resumed.observations()[0].id, id);
        assert_eq!(
            resumed.read_observation(&id, 0, 100).unwrap()["content"],
            "exact historical output"
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn durable_finalization_survives_worker_restart_and_compaction() {
        let (base, root, mut transcript) = fixture();
        transcript.push_run_user(json!({"role":"user","content":"audit backend"}));
        read_step(
            &mut transcript,
            "backend",
            "api.php handles order submission",
        );
        transcript.assistant_message("backend evidence complete".into());
        transcript.mark_finalizing();
        let plan = transcript.compaction_plan(2).unwrap();
        transcript.compact("backend evidence established".into(), plan.covers);
        drop(transcript);
        let resumed =
            Transcript::durable(&base.join("evidence"), "worker-2", &[], root.to_str()).unwrap();
        assert!(resumed.is_finalizing());
        assert!(resumed.pending_tail("").contains("tools are unavailable"));
        assert!(project(&resumed, "system", &resumed.pending_tail(""))
            .iter()
            .any(|m| m["content"]
                .as_str()
                .is_some_and(|s| s.contains("MODE: FINALIZING"))));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn many_novel_observations_have_stable_distinct_ids_and_paged_lookup() {
        let (base, _, mut t) = fixture();
        t.push_run_user(json!({"role":"user","content":"audit"}));
        for i in 0..151 {
            read_step(
                &mut t,
                &format!("call-{i}"),
                &json!({"path":"api.php","content":format!("finding-{i}")}).to_string(),
            );
        }
        assert_eq!(t.observations().len(), 151);
        assert_eq!(t.observations()[150].id, "obs-00000151");
        assert_eq!(
            t.observation_index(150, 20)["observations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn one_projection_algorithm_scales_with_context_capacity() {
        let (base, _, mut t) = fixture();
        t.push_run_user(json!({"role":"user","content":"audit"}));
        read_step(&mut t, "large", &"x".repeat(150_000));
        for (window, expect_fold) in [(32_768, true), (65_536, true), (131_072, false)] {
            let mut messages = project(&t, "system", "");
            let target = window * 55 / 100;
            let folded = fold_to_budget(&t, &mut messages, target, |m| {
                serde_json::to_string(m).unwrap().len() / 3
            });
            assert_eq!(!folded.is_empty(), expect_fold, "window {window}");
            assert_eq!(messages.iter().filter(|m| m["role"] == "tool").count(), 1);
        }
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn read_novelty_distinguishes_duplicate_range_and_source_change() {
        use crate::agent::evidence::classify_source_read;
        let (base, root, mut t) = fixture();
        t.push_run_user(json!({"role":"user","content":"audit"}));
        read_step(&mut t, "first", "first");
        read_step(&mut t, "same", "same");
        assert_eq!(
            classify_source_read(&t.observations()[1], t.observations()[..1].iter()),
            "unchanged_duplicate"
        );
        t.assistant_tool_turn(
            "".into(),
            &[ValidatedCall {
                id: "range".into(),
                name: "read_file".into(),
                arguments: json!({"path":"api.php","start_line":1,"end_line":2}),
            }],
        );
        t.tool_result("range", "read_file", "range".into());
        assert_eq!(
            classify_source_read(&t.observations()[2], t.observations()[..2].iter()),
            "new_range"
        );
        fs::write(root.join("api.php"), "new version").unwrap();
        read_step(&mut t, "changed", "changed");
        assert_eq!(
            classify_source_read(&t.observations()[3], t.observations()[..3].iter()),
            "changed_source"
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn every_indexed_id_reads_after_folding_restart_and_numeric_copy_errors() {
        let (base, root, mut t) = fixture();
        t.push_run_user(json!({"role":"user","content":"audit"}));
        for n in 0..115 {
            read_step(&mut t, &format!("read-{n}"), &format!("exact-{n}"));
        }
        let plan = t.compaction_plan(2).unwrap();
        t.compact("older work".into(), plan.covers);
        drop(t);
        let resumed =
            Transcript::durable(&base.join("evidence"), "restart", &[], root.to_str()).unwrap();
        for offset in (0..115).step_by(50) {
            let page = resumed.observation_index(offset, 50);
            for item in page["observations"].as_array().unwrap() {
                assert_eq!(item["recoverable"], true);
                let id = item["id"].as_str().unwrap();
                assert_eq!(
                    resumed.read_observation(id, 0, 10).unwrap()["observation"]["id"],
                    id
                );
            }
        }
        assert_eq!(
            resumed.read_observation("obs-000000115", 0, 10).unwrap()["observation"]["id"],
            "obs-00000115"
        );
        assert_eq!(
            resumed.read_observation("obs-000020", 0, 10).unwrap()["observation"]["id"],
            "obs-00000020"
        );
        assert!(resumed.read_observation("obs-99999999", 0, 10).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn interrupted_partial_answer_keeps_evidence_lineage_on_next_worker() {
        let (base, root, mut t) = fixture();
        let first_user = json!({"role":"user","content":"audit"});
        t.push_run_user(first_user.clone());
        read_step(&mut t, "source", "durable exact result");
        let id = t.observations()[0].id.clone();
        drop(t);
        let prior = vec![
            first_user,
            json!({"role":"assistant","content":"partial visible answer"}),
        ];
        let resumed =
            Transcript::durable(&base.join("evidence"), "new-worker", &prior, root.to_str())
                .unwrap();
        assert_eq!(resumed.observations()[0].id, id);
        assert_eq!(
            resumed.read_observation(&id, 0, 100).unwrap()["content"],
            "durable exact result"
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn russian_visible_language_survives_compaction_restart_and_finalization() {
        let (base, root, mut t) = fixture();
        t.push_run_user(
            json!({"role":"user","content":"Проанализируй этот проект и подготовь русский отчёт"}),
        );
        assert_eq!(t.language_preference(), "Russian");
        read_step(&mut t, "source", "source result");
        for n in 0..3 {
            t.assistant_message(format!("finding {n}"));
        }
        t.mark_finalizing();
        let plan = t.compaction_plan(2).unwrap();
        t.compact("checkpoint".into(), plan.covers);
        drop(t);
        let resumed =
            Transcript::durable(&base.join("evidence"), "restart", &[], root.to_str()).unwrap();
        assert_eq!(resumed.language_preference(), "Russian");
        assert!(resumed.is_finalizing());
        let projected = project(&resumed, "system", &resumed.pending_tail(""));
        assert!(projected.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|s| s.contains("Preferred language for visible prose: Russian"))));
        assert!(projected.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|s| s.contains("MODE: FINALIZING"))));
        fs::remove_dir_all(base).unwrap();
    }
}
