use crate::agent::transcript::{project_accepted_message, prompt_tail_message, Entry, Transcript};
use serde_json::{json, Value};

/// A pure request projection. The first system message is byte-stable within a
/// session. Accepted volatile tails remain at their original transcript
/// position; only genuinely new guidance is appended below history.
#[must_use]
pub fn project(transcript: &Transcript, stable_prefix: &str, dynamic_tail: &str) -> Vec<Value> {
    let (summary, start) = transcript
        .latest_summary()
        .map_or((None, 0), |(summary, covers)| (Some(summary), covers));
    let mut messages = vec![json!({"role":"system", "content":stable_prefix})];
    let mut imported_system = Vec::new();
    for entry in transcript.entries() {
        if let Entry::Message(message) = entry {
            if message.get("role").and_then(Value::as_str) == Some("system") {
                if let Some(content) = message.get("content").and_then(Value::as_str) {
                    imported_system.push(content);
                }
            }
        }
    }
    if let Some(summary) = summary.filter(|text| {
        !transcript.is_finalizing()
            || text.contains("Phase: FINALIZING (authoritative durable runtime state)")
    }) {
        messages.push(json!({"role":"user", "content":format!("[RUNTIME COMPACTION SUMMARY — NOT USER CONTENT]\n{summary}")}));
    }
    if !imported_system.is_empty() {
        messages.push(json!({"role":"user", "content":format!("[IMPORTED SYSTEM CONTEXT — NOT USER CONTENT]\n{}", imported_system.join("\n\n"))}));
    }
    let run_user = transcript
        .entries()
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, entry)| match entry {
            Entry::RunUser(message) => Some((index, message.clone())),
            _ => None,
        });
    let mut included_run_user = false;
    let latest_tail = transcript
        .entries()
        .iter()
        .enumerate()
        .skip(start.max(transcript.finalization_index().unwrap_or(0)))
        .rfind(|(_, entry)| matches!(entry, Entry::PromptTail(_)))
        .map(|(index, _)| index);
    let mut closeout_tail = None;
    if let Some((index, message)) = &run_user {
        if *index < start {
            // The summary may cover the original prompt, but tool-result tail
            // still needs that exact prompt before any retained assistant turn.
            messages.push(message.clone());
            included_run_user = true;
        }
    }
    for (index, entry) in transcript.entries().iter().enumerate().skip(start) {
        match entry {
            Entry::Message(message)
                if message.get("role").and_then(Value::as_str) != Some("system") =>
            {
                // Jan projects the retained structural tail verbatim. A
                // separate per-tool truncation here made the model lose the
                // exact detail it deliberately kept and encouraged rereads.
                messages.push(project_accepted_message(message))
            }
            Entry::RunUser(message) => {
                messages.push(message.clone());
                included_run_user = true;
            }
            Entry::Steering(content) => messages.push(json!({"role":"user", "content":format!("[RUNTIME STEERING — NOT USER CONTENT]\n{content}"), "metadata":{"steering":true}})),
            Entry::PromptTail(content) if dynamic_tail.trim().is_empty() && latest_tail == Some(index) => {
                let tail = prompt_tail_message(content);
                if transcript.is_closeout_requested() && !transcript.is_finalizing() {
                    closeout_tail = Some(tail);
                } else {
                    messages.push(tail);
                }
            },
            Entry::Compaction { .. } | Entry::Reminder(_) | Entry::ClearReminders | Entry::Finalizing | Entry::CloseoutRequested | Entry::RunComplete | Entry::LanguagePreference(_) | Entry::Evidence(_) | Entry::Frontier(_) | Entry::FrontierDisposition(_) | Entry::Message(_) | Entry::PromptTail(_) => {}
        }
    }
    // Retain an exact current prompt even if an unusually small context made
    // the compaction boundary more aggressive than expected.
    if !included_run_user {
        if let Some((_, message)) = run_user {
            messages.push(message);
        }
    }
    // A durable CloseoutRequested event must remain the current provider
    // boundary. A previously accepted tail can otherwise drift behind many
    // unrelated assistant/tool turns while the phase itself remains active.
    if let Some(tail) = closeout_tail {
        messages.push(tail);
    }
    if !dynamic_tail.trim().is_empty() && !transcript.has_active_prompt_tail(dynamic_tail) {
        // Dynamic data belongs after accepted conversation so cache providers
        // can reuse the leading system/history prefix. The run records it only
        // after the provider accepts this exact request.
        messages.push(prompt_tail_message(dynamic_tail));
    }
    messages
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::transcript::Transcript;

    #[test]
    fn durable_closeout_tail_stays_at_the_request_boundary_after_rejected_work() {
        let base = std::env::temp_dir().join(format!(
            "closeout-tail-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let mut transcript = Transcript::durable(&base, "run", &[], None).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.mark_closeout_requested();
        transcript
            .record_prompt_tail("<runtime_closeout>backend/order flow remains</runtime_closeout>");
        transcript.assistant_withheld_draft(String::new(), "a specific evidence gap");
        transcript.assistant_message("Research status after rejected final".into());
        drop(transcript);
        let resumed = Transcript::durable(&base, "resume", &[], None).unwrap();
        assert!(resumed.is_closeout_requested());
        let before = serde_json::to_value(resumed.entries()).unwrap();
        let messages = project(&resumed, "system", "");
        assert!(messages.last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("backend/order flow remains"));
        assert_eq!(serde_json::to_value(resumed.entries()).unwrap(), before);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn dynamic_reminder_stays_outside_stable_prefix() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.remind("update plan".into());
        let tail = transcript.pending_tail("active plan");
        let projected = project(&transcript, "stable", &tail);
        assert_eq!(projected[0]["content"], "stable");
        assert_eq!(projected.last().unwrap()["role"], "user");
        assert!(projected.last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("update plan"));
    }

    #[test]
    fn finalizing_projection_omits_stale_research_checkpoint() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.assistant_message("old research".into());
        transcript.compact("Next useful intent: restart broad discovery".into(), 2);
        transcript.mark_finalizing();
        let projected = project(
            &transcript,
            "system",
            "MODE: FINALIZING; synthesize established evidence",
        );
        assert!(!projected.iter().any(|m| m
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|s| s.contains("restart broad discovery"))));
        assert!(projected.iter().any(|m| m
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|s| s.contains("MODE: FINALIZING"))));
        transcript.compact(
            "Phase: FINALIZING (authoritative durable runtime state). Continue one final response."
                .into(),
            transcript.entries().len(),
        );
        let after = project(
            &transcript,
            "system",
            "MODE: FINALIZING; synthesize established evidence",
        );
        assert!(after.iter().any(|m| m
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|s| s.contains("Phase: FINALIZING"))));
    }

    #[test]
    fn changing_evidence_tail_replaces_stale_projection_without_erasing_events() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.record_prompt_tail("old evidence receipt");
        transcript.assistant_message("work".into());
        transcript.record_prompt_tail("new established evidence");
        assert!(!transcript.has_active_prompt_tail("old evidence receipt"));
        assert!(transcript.has_active_prompt_tail("new established evidence"));
        let messages = project(&transcript, "system", "");
        assert!(!messages.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|s| s.contains("old evidence receipt"))));
        assert!(messages.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|s| s.contains("new established evidence"))));
        assert!(transcript.entries().iter().any(
            |entry| matches!(entry, Entry::PromptTail(value) if value=="old evidence receipt")
        ));
    }

    #[test]
    fn summary_and_recent_tail_are_projected() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"user","content":"old"}));
        transcript.push_run_user(json!({"role":"user","content":"current"}));
        transcript.push_message(json!({"role":"assistant","content":"recent"}));
        transcript.compact("important old decision".into(), 1);
        let projected = project(&transcript, "stable", "");
        assert!(projected.iter().any(|message| message["content"]
            .as_str()
            .is_some_and(|content| content.contains("important old decision"))));
        assert!(projected
            .iter()
            .any(|message| message["content"] == "recent"));
    }

    #[test]
    fn only_the_stable_prefix_uses_the_system_role() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.record_prompt_tail("<task_memory>\nInspect findings\n</task_memory>");
        transcript.push_message(json!({"role":"assistant","content":"reading"}));
        transcript.compact("important finding".into(), 0);
        let projected = project(&transcript, "stable", "");
        assert_eq!(projected[0]["role"], "system");
        assert!(projected
            .iter()
            .skip(1)
            .all(|message| message["role"] != "system"));
        assert!(projected
            .iter()
            .any(|message| message["content"]
                .as_str()
                .is_some_and(|content| content
                    .starts_with("[RUNTIME COMPACTION SUMMARY — NOT USER CONTENT]"))));
    }

    #[test]
    fn assistant_tool_call_and_result_are_replayed_in_order() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"inspect"}));
        transcript.push_message(json!({
            "role":"assistant",
            "content":"",
            "tool_calls":[{"id":"read-1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"src/main.rs\"}"}}]
        }));
        transcript.tool_result("read-1", "read_file", "source contents".into());
        let projected = project(&transcript, "stable", "");
        let assistant = projected
            .iter()
            .position(|message| message["role"] == "assistant")
            .unwrap();
        let tool = projected
            .iter()
            .position(|message| message["role"] == "tool")
            .unwrap();
        assert!(assistant < tool);
        assert_eq!(projected[tool]["tool_call_id"], "read-1");
    }

    #[test]
    fn retained_large_tool_result_is_replayed_verbatim() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"inspect"}));
        transcript.push_message(json!({
            "role":"assistant",
            "tool_calls":[{"id":"read-1","type":"function","function":{"name":"read_file","arguments":"{}"}}]
        }));
        let output = "concrete source detail ".repeat(900);
        transcript.tool_result("read-1", "read_file", output.clone());
        let projected = project(&transcript, "stable", "");
        let tool = projected
            .iter()
            .find(|message| message["role"] == "tool")
            .unwrap();
        assert_eq!(tool["content"], output);
    }

    #[test]
    fn current_user_stays_after_prior_transcript_tail() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"user","content":"old request"}));
        transcript.push_message(json!({"role":"assistant","content":"old response"}));
        transcript.push_run_user(json!({"role":"user","content":"current request"}));
        let projected = project(&transcript, "stable", "");
        let contents = projected
            .iter()
            .filter_map(|message| message["content"].as_str())
            .collect::<Vec<_>>();
        let old = contents
            .iter()
            .position(|content| *content == "old response")
            .unwrap();
        let current = contents
            .iter()
            .position(|content| *content == "current request")
            .unwrap();
        assert!(old < current);
    }

    #[test]
    fn actual_user_turns_are_projected_once_in_chronological_order() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"user","content":"first request"}));
        transcript.push_message(json!({"role":"assistant","content":"first answer"}));
        transcript.push_message(json!({"role":"user","content":"second request"}));
        transcript.push_message(json!({"role":"assistant","content":"second answer"}));
        transcript.push_run_user(json!({"role":"user","content":"current request"}));

        let projected = project(&transcript, "stable", "");
        let user_turns = projected
            .iter()
            .filter(|message| message["role"] == "user")
            .filter_map(|message| message["content"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            user_turns,
            vec!["first request", "second request", "current request"]
        );
    }

    #[test]
    fn realistic_projection_keeps_runtime_messages_out_of_the_system_role() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"user","content":"previous request"}));
        transcript.push_message(json!({"role":"assistant","content":"previous answer"}));
        transcript.push_run_user(json!({"role":"user","content":"current request"}));
        transcript.push_message(json!({
            "role":"assistant",
            "content":"",
            "tool_calls":[{"id":"read-1","type":"function","function":{"name":"read_file","arguments":"{}"}}]
        }));
        transcript.tool_result("read-1", "read_file", "file contents".into());
        transcript.assistant_message("tool follow-up".into());
        transcript.push_message(json!({"role":"system","content":"legacy runtime instruction"}));
        transcript.compact("condensed earlier transcript".into(), 2);
        transcript.remind("verify the result".into());

        let projected = project(
            &transcript,
            "stable prefix",
            &transcript.pending_tail("<task_memory />"),
        );
        let system_positions = projected
            .iter()
            .enumerate()
            .filter_map(|(index, message)| (message["role"] == "system").then_some(index))
            .collect::<Vec<_>>();
        assert_eq!(system_positions, vec![0]);
        assert!(projected.iter().any(|message| message["role"] == "user"
            && message["content"].as_str().is_some_and(
                |content| content.contains("[RUNTIME COMPACTION SUMMARY — NOT USER CONTENT]")
            )));
        assert!(projected.iter().any(|message| message["role"] == "user"
            && message["content"]
                .as_str()
                .is_some_and(|content| content.contains("[RUNTIME GUIDANCE — NOT USER CONTENT]"))));
    }

    #[test]
    fn compaction_does_not_repeat_the_current_user_turn_in_summary() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"user","content":"older request"}));
        transcript.push_message(json!({"role":"assistant","content":"older answer"}));
        transcript.push_run_user(json!({"role":"user","content":"current request appears once"}));
        transcript.compact("summary of older request and answer".into(), 2);

        let projected = project(&transcript, "stable", "");
        let occurrences = projected
            .iter()
            .filter_map(|message| message["content"].as_str())
            .filter(|content| content.contains("current request appears once"))
            .count();
        assert_eq!(occurrences, 1);
        let current_index = projected
            .iter()
            .position(|message| message["content"] == "current request appears once")
            .unwrap();
        assert_eq!(projected[current_index]["role"], "user");
    }

    #[test]
    fn current_user_survives_a_compaction_boundary_past_its_position_once() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"current request exactly once"}));
        for index in 0..6 {
            transcript
                .push_message(json!({"role":"assistant","content":format!("response {index}")}));
            transcript.push_message(json!({"role":"user","content":format!("follow-up {index}")}));
        }
        let plan = transcript.compaction_plan(2).unwrap();
        assert!(plan.covers > 0);
        let summary = plan.render(10_000);
        assert!(!summary.contains("current request exactly once"));
        transcript.compact(summary, plan.covers);

        let projected = project(&transcript, "stable", "");
        let current_occurrences = projected
            .iter()
            .filter_map(|message| message["content"].as_str())
            .filter(|content| content.contains("current request exactly once"))
            .count();
        assert_eq!(current_occurrences, 1);
        let current = projected
            .iter()
            .find(|message| {
                message["content"]
                    .as_str()
                    .is_some_and(|content| content == "current request exactly once")
            })
            .unwrap();
        assert_eq!(current["role"], "user");
    }
}
