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
    Compaction {
        summary: String,
        covers: usize,
    },
    Steering(String),
    Reminder(String),
    /// Volatile guidance becomes durable only after the provider accepted the
    /// request. Keeping it at this exact point prevents a moving synthetic
    /// tail from rewriting model history on every tool turn.
    PromptTail(String),
}

/// A Jan-style compaction decision: the concrete projected messages to
/// summarize and the record index where the verbatim tail begins.
#[derive(Debug, Clone)]
pub struct CompactionPlan {
    pub covers: usize,
    summarize: Vec<Value>,
    retained_message_count: usize,
}

impl CompactionPlan {
    pub fn render(&self, max_chars: usize) -> String {
        render_messages(&self.summarize, max_chars)
    }

    pub fn message_count(&self) -> usize {
        self.summarize.len()
    }

    pub fn retained_message_count(&self) -> usize {
        self.retained_message_count
    }
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

    pub fn record_prompt_tail(&mut self, content: &str) {
        if !content.trim().is_empty() && !self.has_active_prompt_tail(content) {
            self.entries.push(Entry::PromptTail(content.to_owned()));
        }
    }

    pub fn pending_tail(&self, volatile: &str) -> String {
        let reminders = self
            .entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Reminder(value) => Some(value.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        [volatile.trim(), reminders.trim()]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// A covered tail is not projected, so it must be allowed to reappear
    /// below a later compaction summary exactly as Jan does.
    pub fn has_active_prompt_tail(&self, content: &str) -> bool {
        let boundary = self.compaction_boundary().unwrap_or(0);
        self.entries
            .iter()
            .skip(boundary)
            .any(|entry| matches!(entry, Entry::PromptTail(existing) if existing == content))
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

    /// Project the current summary plus only raw entries after its boundary.
    /// This is deliberately separate from the append-only record: a later
    /// compaction must summarize the latest summary and its tail, never count
    /// covered raw history again.
    fn conversation(&self) -> (Vec<Value>, Vec<usize>) {
        let boundary = self.compaction_boundary().unwrap_or(0);
        let mut messages = Vec::new();
        let mut sources = Vec::new();
        if let Some((summary, _)) = self.latest_summary() {
            messages.push(
                json!({"role":"assistant", "content":format!("[earlier summary]\n{summary}")}),
            );
            sources.push(boundary);
        }
        for (index, entry) in self.entries.iter().enumerate().skip(boundary) {
            match entry {
                Entry::Message(message)
                    if message.get("role").and_then(Value::as_str) != Some("system") =>
                {
                    messages.push(message.clone());
                    sources.push(index);
                }
                Entry::RunUser(message) => {
                    messages.push(message.clone());
                    sources.push(index);
                }
                Entry::Steering(content) => {
                    messages.push(
                        json!({"role":"user", "content":content, "metadata":{"steering":true}}),
                    );
                    sources.push(index);
                }
                Entry::PromptTail(content) => {
                    messages.push(prompt_tail_message(content));
                    sources.push(index);
                }
                Entry::Compaction { .. } | Entry::Reminder(_) | Entry::Message(_) => {}
            }
        }
        (messages, sources)
    }

    /// Select Jan's structural tail boundary. Prefer moving forward over a
    /// tool-result batch so the dropped span is as large as possible; when a
    /// batch reaches the end, move back to its owning assistant call instead.
    /// Either choice keeps every projected assistant/tool relationship valid.
    pub fn compaction_plan(&self, keep_recent: usize) -> Option<CompactionPlan> {
        let (messages, sources) = self.conversation();
        if messages.len() <= keep_recent {
            return None;
        }
        let target = messages.len() - keep_recent;
        let mut cut = target;
        while cut < messages.len() && is_tool_message(&messages[cut]) {
            cut += 1;
        }
        if cut >= messages.len() {
            cut = target;
            while cut > 0 && is_tool_message(&messages[cut]) {
                cut -= 1;
            }
        }
        // Jan does not add a summary when it would replace fewer than two
        // message entries, because the summary message itself would not shrink
        // the request enough to be useful.
        if cut < 2 {
            return None;
        }
        let current_run_user = self
            .entries
            .iter()
            .rposition(|entry| matches!(entry, Entry::RunUser(_)));
        let summarize = messages[..cut]
            .iter()
            .zip(&sources[..cut])
            .filter(|(_, source)| Some(**source) != current_run_user)
            .map(|(message, _)| message.clone())
            .collect::<Vec<_>>();
        Some(CompactionPlan {
            covers: sources[cut],
            summarize,
            retained_message_count: messages.len().saturating_sub(cut),
        })
    }
}

pub fn prompt_tail_message(content: &str) -> Value {
    json!({"role":"user", "content":format!("[RUNTIME GUIDANCE — NOT USER CONTENT]\n{content}")})
}

fn is_tool_message(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("tool")
}

fn render_messages(messages: &[Value], max_chars: usize) -> String {
    let mut out = String::new();
    for message in messages {
        render_message(&mut out, message);
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
    fn accepted_prompt_tail_stays_before_the_following_tool_turn_and_reappears_after_compaction() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.record_prompt_tail("<task_memory>\nInspect findings\n</task_memory>");
        transcript.assistant_message("I will inspect the project.".into());
        let projected = crate::context::projection::project(&transcript, "stable", "");
        let tail = projected
            .iter()
            .position(|message| {
                message["content"]
                    .as_str()
                    .is_some_and(|content| content.contains("task_memory"))
            })
            .unwrap();
        let assistant = projected
            .iter()
            .position(|message| message["role"] == "assistant")
            .unwrap();
        assert!(tail < assistant);

        transcript.compact("factual handoff".into(), 2);
        assert!(
            !transcript.has_active_prompt_tail("<task_memory>\nInspect findings\n</task_memory>")
        );
    }

    #[test]
    fn compaction_keeps_valid_tool_pair_tail() {
        let mut transcript = Transcript::default();
        transcript.push_message(json!({"role":"user","content":"old"}));
        transcript.push_message(json!({"role":"assistant","tool_calls":[{"id":"a","function":{"name":"read_file","arguments":"{}"}}]}));
        transcript.tool_result("a", "read_file", "result".into());
        transcript.push_message(json!({"role":"assistant","content":"recent"}));
        let plan = transcript.compaction_plan(2).unwrap();
        assert!(!matches!(
            &transcript.entries()[plan.covers],
            Entry::Message(message) if is_tool_message(message)
        ));
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

        let plan = transcript.compaction_plan(2).unwrap();
        assert!(plan.covers > 2);
        assert!(!plan.render(10_000).contains("current request"));
    }

    #[test]
    fn later_compaction_summarizes_the_prior_handoff_instead_of_covered_raw_history() {
        let mut transcript = Transcript::default();
        for index in 0..12 {
            transcript.push_message(
                json!({"role":if index % 2 == 0 {"user"} else {"assistant"},"content":format!("old finding {index}")}),
            );
        }
        let first = transcript.compaction_plan(8).unwrap();
        let first_boundary = first.covers;
        transcript.compact("verified first handoff: old findings".into(), first.covers);
        for index in 0..10 {
            transcript.push_message(
                json!({"role":if index % 2 == 0 {"assistant"} else {"tool"},"content":format!("new finding {index}")}),
            );
        }

        let second = transcript.compaction_plan(8).unwrap();
        assert!(second.covers > first_boundary);
        assert!(second.render(10_000).contains("verified first handoff"));
        assert!(!second.render(10_000).contains("old finding 0"));
    }
}
