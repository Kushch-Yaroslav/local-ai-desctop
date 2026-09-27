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
    // Imported historic system context must remain at the system boundary.
    for entry in transcript.entries() {
        if let Entry::Message(message) = entry {
            if message.get("role").and_then(Value::as_str) == Some("system") {
                if let Some(content) = message.get("content").and_then(Value::as_str) {
                    messages.push(json!({"role":"system", "content":content}));
                }
            }
        }
    }
    if let Some(summary) = summary {
        messages.push(json!({"role":"system", "content":format!("[Summary of earlier conversation, condensed to save context]\n{summary}")}));
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
                messages.push(compact_tool_payload(message))
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
        messages.push(json!({"role":"user", "content":format!("<SYSTEM>{tail}</SYSTEM>")}));
    }
    messages
}

#[must_use]
pub fn compact_tool_payload(message: &Value) -> Value {
    if message.get("role").and_then(Value::as_str) != Some("tool") {
        return message.clone();
    }
    let Some(content) = message.get("content").and_then(Value::as_str) else {
        return message.clone();
    };
    const KEEP: usize = 6_000;
    if content.chars().count() <= KEEP {
        return message.clone();
    }
    let head = content.chars().take(3_800).collect::<String>();
    let tail = content
        .chars()
        .rev()
        .take(1_800)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    let mut projected = message.clone();
    projected["content"] = json!(format!("{head}\n… [large raw tool result omitted from projection; canonical transcript retained] …\n{tail}"));
    projected
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
}
