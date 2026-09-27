use serde_json::{json, Value};

/// Append-only canonical agent conversation. Compaction records a projection
/// boundary; covered raw messages remain available to the runtime and UI.
#[derive(Debug, Clone, Default)]
pub struct Transcript {
    entries: Vec<Entry>,
}

#[derive(Debug, Clone)]
pub enum Entry {
    Message(Value),
    RunUser(Value),
    Compaction { summary: String, covers: usize },
    Steering(String),
    Reminder(String),
}

impl Transcript {
    pub fn push_message(&mut self, message: Value) {
        self.entries.push(Entry::Message(message));
    }

    pub fn push_run_user(&mut self, message: Value) {
        self.entries.push(Entry::RunUser(message));
    }

    pub fn push_steering(&mut self, content: String) {
        self.entries.push(Entry::Steering(content));
    }

    pub fn assistant_tool_turn(&mut self, content: String, calls: &[ValidatedCall]) {
        self.push_message(json!({
            "role": "assistant",
            "content": content,
            "tool_calls": calls.iter().map(ValidatedCall::wire).collect::<Vec<_>>(),
        }));
    }

    pub fn assistant_message(&mut self, content: String) {
        self.push_message(json!({"role":"assistant", "content":content}));
    }

    pub fn tool_result(&mut self, id: &str, name: &str, content: String) {
        self.push_message(json!({
            "role": "tool",
            "tool_call_id": id,
            "name": name,
            "content": content,
        }));
    }

    pub fn remind(&mut self, content: String) {
        self.entries.push(Entry::Reminder(content));
    }

    /// Reminders are intentionally one-request tail instructions. Retiring old
    /// ones keeps the stable system prefix and prevents policy loops.
    pub fn clear_reminders(&mut self) {
        self.entries
            .retain(|entry| !matches!(entry, Entry::Reminder(_)));
    }

    pub fn compact(&mut self, summary: String, covers: usize) {
        self.entries.push(Entry::Compaction { summary, covers });
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn compaction_boundary(&self) -> Option<usize> {
        self.entries.iter().rev().find_map(|entry| match entry {
            Entry::Compaction { covers, .. } => Some(*covers),
            _ => None,
        })
    }

    pub fn latest_summary(&self) -> Option<(&str, usize)> {
        self.entries.iter().rev().find_map(|entry| match entry {
            Entry::Compaction { summary, covers } => Some((summary.as_str(), *covers)),
            _ => None,
        })
    }

    /// Select a boundary retaining `keep_recent` non-system messages. The
    /// boundary is moved back if needed so retained history never starts with a
    /// tool result whose assistant tool-call was discarded.
    pub fn compaction_plan(&self, keep_recent: usize) -> Option<usize> {
        let message_indices = self
            .entries
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| match entry {
                Entry::Message(message)
                    if message.get("role").and_then(Value::as_str) != Some("system") =>
                {
                    Some(index)
                }
                Entry::RunUser(_) => Some(index),
                _ => None,
            })
            .collect::<Vec<_>>();
        if message_indices.len() <= keep_recent.saturating_add(1) {
            return None;
        }
        let mut boundary = message_indices[message_indices.len() - keep_recent];
        while boundary > 0 && is_tool(&self.entries[boundary]) {
            boundary -= 1;
        }
        // A summary adds one message; a boundary that covers no meaningful
        // history is not an optimization.
        (boundary >= 1).then_some(boundary)
    }

    pub fn render_span(&self, covers: usize, max_chars: usize) -> String {
        let mut out = String::new();
        let current_run_user = self
            .entries
            .iter()
            .rposition(|entry| matches!(entry, Entry::RunUser(_)));
        for (index, entry) in self.entries.iter().take(covers).enumerate() {
            match entry {
                Entry::RunUser(_) if Some(index) == current_run_user => {}
                Entry::Message(message) | Entry::RunUser(message) => {
                    render_message(&mut out, message)
                }
                Entry::Steering(content) => {
                    out.push_str("[steering]\n");
                    out.push_str(content);
                    out.push('\n');
                }
                Entry::Compaction { summary, .. } => {
                    out.push_str("[earlier summary]\n");
                    out.push_str(summary);
                    out.push('\n');
                }
                Entry::Reminder(_) => {}
            }
            if out.chars().count() >= max_chars {
                let chars = out.chars().collect::<Vec<_>>();
                let head = max_chars / 2;
                let tail = max_chars.saturating_sub(head + 48);
                return format!(
                    "{}\n[… middle of transcript omitted …]\n{}",
                    chars[..head].iter().collect::<String>(),
                    chars[chars.len().saturating_sub(tail)..]
                        .iter()
                        .collect::<String>()
                );
            }
        }
        out
    }
}

fn is_tool(entry: &Entry) -> bool {
    matches!(entry, Entry::Message(message) if message.get("role").and_then(Value::as_str) == Some("tool"))
}

fn render_message(out: &mut String, message: &Value) {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    out.push_str(&format!("[{role}]\n"));
    if let Some(content) = message.get("content").and_then(Value::as_str) {
        out.push_str(content);
        out.push('\n');
    }
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let name = call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let arguments = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            out.push_str(&format!("[tool call] {name}({arguments})\n"));
        }
    }
}

#[derive(Debug, Clone)]
pub struct ValidatedCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

impl ValidatedCall {
    pub fn wire(&self) -> Value {
        json!({
            "id": self.id,
            "type": "function",
            "function": {"name": self.name, "arguments": self.arguments.to_string()},
        })
    }
}

/// Strictly validate the only executable representation. In particular, a
/// length-truncated tool call can never reach the executor.
pub fn validate_calls(
    raw: &[Value],
    finish_reason: Option<&str>,
) -> Result<Vec<ValidatedCall>, String> {
    if finish_reason == Some("length") && !raw.is_empty() {
        return Err("response was truncated while carrying tool calls".into());
    }
    let mut ids = std::collections::HashSet::new();
    raw.iter()
        .enumerate()
        .map(|(index, call)| {
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| format!("tool call {index} has no stable id"))?;
            let name = call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| format!("tool call {id} has no name"))?;
            let raw_args = call
                .pointer("/function/arguments")
                .ok_or_else(|| format!("tool call {id} has no arguments"))?;
            let arguments = match raw_args {
                Value::String(text) => serde_json::from_str::<Value>(text)
                    .map_err(|_| format!("tool call {id} has malformed JSON arguments"))?,
                value => value.clone(),
            };
            if !arguments.is_object() {
                return Err(format!("tool call {id} arguments must be a JSON object"));
            }
            if !ids.insert(id.to_owned()) {
                return Err(format!("tool call {id} duplicates a prior id"));
            }
            Ok(ValidatedCall {
                id: id.to_owned(),
                name: name.to_owned(),
                arguments,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_and_truncated_calls_cannot_be_executed() {
        let malformed = json!([{"id":"x","function":{"name":"write_file","arguments":"{"}}]);
        assert!(validate_calls(malformed.as_array().unwrap(), Some("tool_calls")).is_err());
        let complete = json!([{"id":"x","function":{"name":"write_file","arguments":"{}"}}]);
        assert!(validate_calls(complete.as_array().unwrap(), Some("length")).is_err());
    }

    #[test]
    fn compaction_keeps_valid_tool_pair_tail() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"user","content":"old"}));
        transcript.push_message(json!({"role":"assistant","tool_calls":[{"id":"a","function":{"name":"read_file","arguments":"{}"}}]}));
        transcript.tool_result("a", "read_file", "result".into());
        transcript.push_message(json!({"role":"assistant","content":"recent"}));
        let boundary = transcript.compaction_plan(2).unwrap();
        assert!(!is_tool(&transcript.entries()[boundary]));
    }

    #[test]
    fn compaction_never_summarizes_the_current_run_user() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"user","content":"older request"}));
        transcript.push_message(json!({"role":"assistant","content":"older answer"}));
        transcript.push_run_user(json!({"role":"user","content":"current request"}));
        transcript.assistant_message("first response".into());
        transcript.push_message(json!({"role":"user","content":"later historic user"}));
        transcript.assistant_message("later historic answer".into());

        let boundary = transcript.compaction_plan(2).unwrap();
        assert!(boundary > 2);
        assert!(!transcript
            .render_span(boundary, 10_000)
            .contains("current request"));
    }
}
