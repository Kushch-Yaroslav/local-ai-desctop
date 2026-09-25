use crate::agent::transcript::{Entry, Transcript};
use serde_json::{json, Value};

/// A pure view over append-only history. llama.cpp's Qwen template requires
/// every system instruction at the beginning, so all runtime control material
/// is folded into the first system message instead of becoming pseudo-turns.
#[must_use]
pub fn project(transcript: &Transcript, system: &str, runtime_working_state: &str) -> Vec<Value> {
    let boundary = transcript
        .entries()
        .iter()
        .rev()
        .find_map(|entry| match entry {
            Entry::Compaction { summary, covers } => Some((summary, *covers)),
            _ => None,
        });
    let start = boundary.as_ref().map_or(0, |(_, covers)| *covers);
    let mut control = system.to_owned();
    if let Some((summary, _)) = boundary {
        control.push_str(&format!("\n<context_summary>{summary}</context_summary>"));
    }
    if !runtime_working_state.is_empty() {
        // The caller already separates Plan, Notes and source evidence. The
        // former wrapper mislabeled all of that control data as Task Notes,
        // making compaction state look self-contradictory to Qwen.
        control.push_str(&format!(
            "\n<runtime_working_state>{runtime_working_state}</runtime_working_state>"
        ));
    }
    // Jan's `Transcript::from_history` records historic system nodes as
    // prompts, then projects them at the system boundary. Imported Electron
    // attachment/reference context has the same meaning. It must never become
    // a synthetic user query: Qwen's multi-step-tool template treats user
    // nodes as ownership boundaries.
    for entry in transcript.entries() {
        if let Entry::Message(message) = entry {
            if message.get("role").and_then(Value::as_str) == Some("system") {
                if let Some(content) = message.get("content").and_then(Value::as_str) {
                    control.push_str(&format!("\n<imported_context>{content}</imported_context>"));
                }
            }
        }
    }
    for entry in transcript.entries().iter().skip(start) {
        if let Entry::Reminder(reminder) = entry {
            control.push_str(&format!(
                "\n<runtime_reminder>{reminder}</runtime_reminder>"
            ));
        }
    }
    let mut messages = vec![json!({"role":"system", "content":control})];
    // Jan keeps the placed prompt outside of a compacted conversation. The
    // active run has the same invariant: its user query must precede any
    // retained assistant/tool suffix even if its canonical entry was covered.
    for entry in transcript.entries() {
        if let Entry::RunUser(message) = entry {
            messages.push(message.clone());
        }
    }
    for entry in transcript.entries().iter().skip(start) {
        append(&mut messages, entry);
    }
    messages
}

fn append(messages: &mut Vec<Value>, entry: &Entry) {
    match entry {
        Entry::Message(message) => {
            if message.get("role").and_then(Value::as_str) != Some("system") {
                messages.push(compact_tool_payload(message));
            }
        }
        Entry::RunUser(_) => {}
        Entry::Steering(content) => {
            messages.push(json!({"role":"user","content":content,"metadata":{"steering":true}}))
        }
        Entry::Compaction { .. } | Entry::Reminder(_) => {}
    }
}

/// Context projection is a bounded working set. Full tool results remain in
/// the append-only transcript/UI; large raw results are shaped only here.
#[must_use]
pub fn compact_tool_payload(message: &Value) -> Value {
    if message.get("role").and_then(Value::as_str) != Some("tool") {
        return message.clone();
    }
    let Some(content) = message.get("content").and_then(Value::as_str) else {
        return message.clone();
    };
    const KEEP: usize = 3_000;
    if content.len() <= KEEP {
        return message.clone();
    }
    // Tool output is UTF-8. Byte offsets can land in the middle of a Cyrillic
    // or other multi-byte character, so retain by scalar values rather than
    // slicing arbitrary bytes.
    let head = content.chars().take(1_800).collect::<String>();
    let tail = content
        .chars()
        .rev()
        .take(900)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    let mut projected = message.clone();
    projected["content"] = json!(json!({
        "context_compacted": true,
        "original_chars": content.len(),
        "important_result": format!("{head}\n… [raw output omitted; canonical transcript preserved] …\n{tail}"),
    })
    .to_string());
    projected
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::transcript::Transcript;
    #[test]
    fn compaction_is_a_projection_boundary_not_deletion() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"user","content":"a"}));
        transcript.compact(json!("a"), 1);
        assert_eq!(transcript.entries().len(), 2);
        let projected = project(&transcript, "s", "");
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0]["role"], "system");
    }
    #[test]
    fn runtime_control_remains_at_system_boundary() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"user","content":"work"}));
        transcript.remind("finish verification".into());
        let projected = project(&transcript, "base", "note");
        assert_eq!(projected[0]["role"], "system");
        assert_eq!(projected[1]["role"], "user");
    }
    #[test]
    fn runtime_working_state_is_not_recast_as_task_notes_or_conversation() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        let projected = project(&transcript, "base", "<task_plan>inspect</task_plan><investigated_evidence>SOURCE: App.tsx</investigated_evidence>");
        assert_eq!(projected.len(), 2);
        assert_eq!(projected[0]["role"], "system");
        let control = projected[0]["content"].as_str().unwrap();
        assert!(control.contains("<runtime_working_state>"));
        assert!(!control.contains("<task_notes><task_plan>"));
        assert_eq!(projected[1]["role"], "user");
    }
    #[test]
    fn imported_system_history_is_hoisted_not_recast_as_user() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"system","content":"attachment context"}));
        transcript.push_message(json!({"role":"user","content":"current query"}));
        let projected = project(&transcript, "base", "");
        assert_eq!(projected.len(), 2);
        assert_eq!(projected[0]["role"], "system");
        assert!(projected[0]["content"]
            .as_str()
            .unwrap()
            .contains("attachment context"));
        assert_eq!(projected[1]["role"], "user");
    }
    #[test]
    fn compaction_keeps_run_user_and_bounds_raw_tool_payload() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"current"}));
        transcript.push_message(json!({"role":"assistant","content":"","tool_calls":[{"id":"call","function":{"name":"read_file","arguments":"{}"}}]}));
        transcript.push_message(
            json!({"role":"tool","tool_call_id":"call","content":"x".repeat(12_000)}),
        );
        transcript.compact(json!({"summary":"older"}), 1);
        let projected = project(&transcript, "base", "notes");
        assert_eq!(projected[1]["role"], "user");
        assert_eq!(projected[1]["content"], "current");
        assert!(projected[3]["content"].as_str().unwrap().len() < 3_000);
        let Entry::Message(raw_tool) = &transcript.entries()[2] else {
            panic!("tool result must remain canonical")
        };
        assert!(raw_tool["content"].as_str().unwrap().len() > 10_000);
    }
}
