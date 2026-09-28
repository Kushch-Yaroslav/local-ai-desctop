use crate::agent::transcript::{Entry, Transcript};
use serde_json::{json, Value};

/// A pure request projection. The first system message is byte-stable within a
/// session. Summaries and transient reminders are placed after it so they do
/// not rewrite the cacheable prefix.
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
    if let Some(summary) = summary {
        messages.push(json!({"role":"user", "content":format!("[RUNTIME SUMMARY — NOT USER CONTENT]\n{summary}")}));
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
    if let Some((index, message)) = &run_user {
        if *index < start {
            // The summary may cover the original prompt, but tool-result tail
            // still needs that exact prompt before any retained assistant turn.
            messages.push(message.clone());
            included_run_user = true;
        }
    }
    for entry in transcript.entries().iter().skip(start) {
        match entry {
            Entry::Message(message)
                if message.get("role").and_then(Value::as_str) != Some("system") =>
            {
                // Jan projects the retained structural tail verbatim. A
                // separate per-tool truncation here made the model lose the
                // exact detail it deliberately kept and encouraged rereads.
                messages.push(message.clone())
            }
            Entry::RunUser(message) => {
                messages.push(message.clone());
                included_run_user = true;
            }
            Entry::Steering(content) => messages
                .push(json!({"role":"user", "content":content, "metadata":{"steering":true}})),
            Entry::Compaction { .. } | Entry::Reminder(_) | Entry::Message(_) => {}
        }
    }
    // Retain an exact current prompt even if an unusually small context made
    // the compaction boundary more aggressive than expected.
    if !included_run_user {
        if let Some((_, message)) = run_user {
            messages.push(message);
        }
    }
    let reminders = transcript
        .entries()
        .iter()
        .filter_map(|entry| match entry {
            Entry::Reminder(value) => Some(value.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let tail = [dynamic_tail.trim(), &reminders.join("\n\n")]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if !tail.is_empty() {
        // Dynamic data belongs after accepted conversation so cache providers
        // can reuse the leading system/history prefix.
        messages.push(json!({"role":"user", "content":format!("[RUNTIME GUIDANCE — NOT USER CONTENT]\n{tail}")}));
    }
    messages
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::transcript::Transcript;

    #[test]
    fn dynamic_reminder_stays_outside_stable_prefix() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.remind("update plan".into());
        let projected = project(&transcript, "stable", "active plan");
        assert_eq!(projected[0]["content"], "stable");
        assert_eq!(projected.last().unwrap()["role"], "user");
        assert!(projected.last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("update plan"));
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
    fn realistic_projection_has_only_a_leading_system_message() {
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

        let projected = project(&transcript, "stable prefix", "<planning_state />");
        let system_positions = projected
            .iter()
            .enumerate()
            .filter_map(|(index, message)| (message["role"] == "system").then_some(index))
            .collect::<Vec<_>>();
        assert_eq!(system_positions, vec![0]);
        assert!(projected.iter().any(|message| message["role"] == "user"
            && message["content"]
                .as_str()
                .is_some_and(|content| content.contains("[RUNTIME SUMMARY — NOT USER CONTENT]"))));
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
