use serde_json::{json, Value};

/// Append-only canonical record. Compaction records a projection boundary; it
/// never mutates or discards the original tool pairs.
#[derive(Debug, Clone, Default)]
pub struct Transcript {
    events: Vec<Entry>,
}

#[derive(Debug, Clone)]
pub enum Entry {
    Message(Value),
    /// The user prompt that owns the active autonomous run. It survives every
    /// compaction boundary and is projected before retained tool history.
    RunUser(Value),
    Compaction {
        summary: Value,
        covers: usize,
    },
    Steering(String),
    /// Runtime-only completion cue. It is never represented as a user message.
    Reminder(String),
}

impl Transcript {
    pub fn push_message(&mut self, message: Value) {
        self.events.push(Entry::Message(message));
    }
    pub fn push_run_user(&mut self, message: Value) {
        self.events.push(Entry::RunUser(message));
    }
    pub fn push_steering(&mut self, content: String) {
        self.events.push(Entry::Steering(content));
    }
    pub fn compact(&mut self, summary: Value, covers: usize) {
        self.events.push(Entry::Compaction { summary, covers });
    }
    pub fn remind(&mut self, content: String) {
        self.events.push(Entry::Reminder(content));
    }
    pub fn entries(&self) -> &[Entry] {
        &self.events
    }
    pub fn compaction_boundary(&self) -> Option<usize> {
        self.events.iter().rev().find_map(|entry| match entry {
            Entry::Compaction { covers, .. } => Some(*covers),
            _ => None,
        })
    }

    pub fn assistant_tool_turn(&mut self, content: String, calls: &[ValidatedCall]) {
        self.push_message(json!({"role":"assistant", "content":content, "tool_calls": calls.iter().map(ValidatedCall::wire).collect::<Vec<_>>() }));
    }
    /// Preserve a provider-exhausted final prefix so a continuation can resume
    /// the same assistant response without adding an invented user turn.
    pub fn assistant_final_partial(&mut self, content: String) {
        self.push_message(json!({"role":"assistant", "content":content}));
    }
    pub fn tool_result(&mut self, id: &str, name: &str, content: String) {
        self.push_message(
            json!({"role":"tool", "tool_call_id":id, "name":name, "content":content}),
        );
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
        json!({"id":self.id,"type":"function","function":{"name":self.name,"arguments":self.arguments.to_string()}})
    }
}

/// Strictly validate the only executable representation. In particular this
/// never turns malformed JSON into an empty object and never invents an id.
pub fn validate_calls(
    raw: &[Value],
    finish_reason: Option<&str>,
) -> Result<Vec<ValidatedCall>, String> {
    let mut ids = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(raw.len());
    for (index, call) in raw.iter().enumerate() {
        let id = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("tool call {index} has no stable id"))?;
        let name = call
            .pointer("/function/name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
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
        out.push(ValidatedCall {
            id: id.to_owned(),
            name: name.to_owned(),
            arguments,
        });
    }
    if finish_reason == Some("length") && !raw.is_empty() {
        return Err("response was truncated while carrying tool calls".to_owned());
    }
    Ok(out)
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
    fn exhausted_final_prefix_is_kept_as_assistant_history() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"write the audit"}));
        transcript.assistant_final_partial("first complete section\n".into());
        let messages = crate::context::projection::project(&transcript, "control", "");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[2]["content"], "first complete section\n");
    }
}
