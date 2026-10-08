use crate::agent::evidence::{EvidenceStore, Observation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Append-only canonical agent conversation. Compaction records a projection
/// boundary; covered raw messages remain available to the runtime and UI.
pub struct Transcript {
    entries: Vec<Entry>,
    store: Option<EvidenceStore>,
    evidence_base: Option<PathBuf>,
    project_root: Option<PathBuf>,
    storage_error: Option<String>,
    ui_language: Option<String>,
}

impl Default for Transcript {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            store: None,
            evidence_base: None,
            project_root: None,
            storage_error: None,
            ui_language: None,
        }
    }
}

// Fit simulations must never append trial checkpoints to the real journal.
impl Clone for Transcript {
    fn clone(&self) -> Self {
        Self {
            entries: self.entries.clone(),
            store: None,
            evidence_base: None,
            project_root: self.project_root.clone(),
            storage_error: None,
            ui_language: self.ui_language.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Entry {
    WorkBudget(super::work_budget::WorkBudget),
    Message(Value),
    RunUser(Value),
    Compaction {
        summary: String,
        covers: usize,
    },
    Steering(String),
    Reminder(String),
    ClearReminders,
    /// Synthesis-only phase: the runtime stopped offering tools (for example
    /// because the turn budget ended) and the next response is the answer.
    Finalizing,
    RunComplete,
    LanguagePreference(String),
    /// Volatile guidance becomes durable only after the provider accepted the
    /// request. Keeping it at this exact point prevents a moving synthetic
    /// tail from rewriting model history on every tool turn.
    PromptTail(String),
    /// Written by earlier runtimes that graded model claims, tracked
    /// execution frontiers and gated finalization. Journals containing them
    /// stay readable; they carry no meaning and are never written or projected.
    CloseoutRequested,
    Evidence(Value),
    EvidenceRejection {
        claim: String,
        observation_id: String,
    },
    Frontier(Value),
    FrontierDisposition(Value),
}

/// Projection/storage semantics for a completed tool result. Recovery is a
/// bounded view of an existing observation, never a fresh observation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolResultPolicy {
    Archivable,
    Inline,
    Rehydrated,
}

impl ToolResultPolicy {
    pub fn from_message(message: &Value) -> Self {
        match message.get("_result_policy").and_then(Value::as_str) {
            Some("inline") => Self::Inline,
            Some("rehydrated") => Self::Rehydrated,
            _ => Self::Archivable,
        }
    }
    pub const fn marker(self) -> &'static str {
        match self {
            Self::Archivable => "archivable",
            Self::Inline => "inline",
            Self::Rehydrated => "rehydrated",
        }
    }
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
    pub fn checkpoint_work_budget(&mut self, budget: super::work_budget::WorkBudget) {
        self.record(Entry::WorkBudget(budget));
    }
    pub fn set_project_root(&mut self, root: Option<&Path>) {
        self.project_root = root.and_then(|path| path.canonicalize().ok());
    }

    pub fn set_secondary_project_root(&mut self, root: Option<&Path>) {
        if let Some(store) = &mut self.store {
            store.set_secondary_root(root);
        }
    }
    pub fn durable(
        base: &Path,
        run_id: &str,
        history: &[Value],
        root: Option<&str>,
    ) -> Result<Self, String> {
        let (store, entries) = EvidenceStore::open(base, run_id, history, root)?;
        let mut transcript = Self {
            entries,
            store: Some(store),
            evidence_base: Some(base.to_path_buf()),
            project_root: root.and_then(|path| Path::new(path).canonicalize().ok()),
            storage_error: None,
            ui_language: None,
        };
        if transcript.entries.is_empty() {
            for message in history {
                transcript.push_message(message.clone());
            }
        }
        Ok(transcript)
    }

    fn record(&mut self, mut entry: Entry) {
        let args = if let Entry::Message(message) = &entry {
            let call_id = message.get("tool_call_id").and_then(Value::as_str);
            call_id.and_then(|id| {
                self.entries.iter().rev().find_map(|prior| {
                    let Entry::Message(assistant) = prior else {
                        return None;
                    };
                    assistant
                        .get("tool_calls")?
                        .as_array()?
                        .iter()
                        .find(|call| call.get("id").and_then(Value::as_str) == Some(id))
                        .and_then(|call| call.pointer("/function/arguments"))
                        .and_then(Value::as_str)
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                })
            })
        } else {
            None
        };
        if let Some(store) = self.store.as_mut() {
            match store.append(&entry, args.as_ref()) {
                Ok(Some(observation)) => {
                    if let Entry::Message(message) = &mut entry {
                        message["_observation_id"] = json!(observation.id);
                    }
                }
                Ok(None) => {}
                Err(error) => self.storage_error = Some(error),
            }
        }
        self.entries.push(entry);
    }

    pub fn storage_error(&self) -> Option<&str> {
        self.storage_error.as_deref()
    }
    pub fn has_current_run_user(&self, content: &str) -> bool {
        self.has_current_run_input(content, &[])
    }
    pub fn has_current_run_input(&self, content: &str, image_refs: &[String]) -> bool {
        let completed = self
            .entries
            .iter()
            .rposition(|entry| matches!(entry, Entry::RunComplete));
        self.entries
            .iter()
            .enumerate()
            .rev()
            .find_map(|(i, entry)| match entry {
                Entry::RunUser(message) if completed.is_none_or(|done| i > done) => {
                    let refs: Vec<String> = message.get("image_refs").and_then(Value::as_array).map(|refs| refs.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
                    Some(message.get("content").and_then(Value::as_str) == Some(content) && refs == image_refs)
                }
                _ => None,
            })
            .unwrap_or(false)
    }
    pub fn mark_run_complete(&mut self) {
        self.record(Entry::RunComplete);
    }
    pub fn mark_finalizing(&mut self) {
        if !self.is_finalizing() {
            self.clear_reminders();
            self.record(Entry::Finalizing);
        }
    }
    pub fn is_finalizing(&self) -> bool {
        self.finalization_index().is_some()
    }
    pub fn finalization_index(&self) -> Option<usize> {
        let last_user = self
            .entries
            .iter()
            .rposition(|e| matches!(e, Entry::RunUser(_)))
            .unwrap_or(0);
        self.entries
            .iter()
            .enumerate()
            .skip(last_user)
            .find_map(|(index, entry)| matches!(entry, Entry::Finalizing).then_some(index))
    }
    pub fn observations(&self) -> &[Observation] {
        self.store
            .as_ref()
            .map_or(&[], |s| s.observations.as_slice())
    }
    pub fn observation(&self, id: &str) -> Option<&Observation> {
        let canonical = id
            .strip_prefix("obs-")
            .and_then(|digits| {
                (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some(digits)
            })
            .and_then(|digits| digits.parse::<usize>().ok())
            .map(|number| format!("obs-{number:08}"));
        self.observations()
            .iter()
            .find(|o| o.id == id || canonical.as_deref() == Some(o.id.as_str()))
    }
    fn observation_id_error(&self, id: &str) -> String {
        format!(
            "unknown observation id: {id}; observation IDs start with obs- and are listed in the investigation state and by observation_index"
        )
    }
    pub fn observation_for_call(&self, call_id: &str) -> Option<&Observation> {
        self.observations()
            .iter()
            .rev()
            .find(|o| o.call_id == call_id)
    }
    pub fn observation_index(&self, offset: usize, limit: usize) -> Value {
        let all = self.observations();
        let selected = all.iter().skip(offset).take(limit.min(50)).map(|o| serde_json::json!({
            "id":o.id,"tool":o.tool,"source":o.source,"source_revision":o.source_revision,
            "requested_range":o.requested_range,"returned_range":o.returned_range,"error":o.error,
            "body_bytes":o.body_bytes,"recoverable":true
        })).collect::<Vec<_>>();
        let next_offset = (offset + selected.len() < all.len()).then_some(offset + selected.len());
        json!({"observations":selected,"offset":offset,"total":all.len(),"more":next_offset.is_some(),"next_offset":next_offset})
    }
    pub fn read_observation(&self, id: &str, offset: usize, limit: usize) -> Result<Value, String> {
        let Some(store) = &self.store else {
            return Err("observation store unavailable".into());
        };
        if self.observation(id).is_none() {
            return Err(self.observation_id_error(id));
        }
        store.read(id, offset, limit)
    }
    pub fn finish_durable(
        &self,
        history: &[Value],
        user: &str,
        final_text: &str,
    ) -> Result<(), String> {
        if let (Some(store), Some(base)) = (&self.store, &self.evidence_base) {
            let current = self
                .entries
                .iter()
                .rposition(|entry| matches!(entry, Entry::RunUser(_)))
                .unwrap_or(0);
            let steering = self.entries[current..]
                .iter()
                .filter_map(|entry| match entry {
                    Entry::Steering(content) => Some(content.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            let image_refs: Vec<String> = self.entries.iter().rev().find_map(|entry| match entry {
                Entry::RunUser(value) => Some(value.get("image_refs").and_then(Value::as_array).map(|refs| refs.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()),
                _ => None,
            }).unwrap_or_default();
            store.finish(base, history, user, &image_refs, &steering, final_text)
        } else {
            Ok(())
        }
    }

    pub fn push_message(&mut self, message: Value) {
        self.record(Entry::Message(message));
    }

    pub fn push_run_user(&mut self, message: Value) {
        let language = preferred_visible_language(
            message.get("content").and_then(Value::as_str).unwrap_or(""),
        );
        self.record(Entry::RunUser(message));
        self.record(Entry::LanguagePreference(language));
    }

    pub fn set_ui_language(&mut self, language: Option<&str>) {
        self.ui_language = match language {
            Some("ru") => Some("Russian".into()),
            Some("en") => Some("English".into()),
            _ => None,
        };
    }

    pub fn language_preference(&self) -> String {
        if let Some(language) = &self.ui_language { return language.clone(); }
        let last_user = self
            .entries
            .iter()
            .rposition(|entry| matches!(entry, Entry::RunUser(_)))
            .unwrap_or(0);
        self.entries
            .iter()
            .skip(last_user)
            .find_map(|entry| match entry {
                Entry::LanguagePreference(value) => Some(value.clone()),
                _ => None,
            })
            .or_else(|| {
                self.entries.get(last_user).and_then(|entry| match entry {
                    Entry::RunUser(value) => Some(preferred_visible_language(
                        value.get("content").and_then(Value::as_str).unwrap_or(""),
                    )),
                    _ => None,
                })
            })
            .unwrap_or_else(|| "the latest user's language".into())
    }

    pub fn push_steering(&mut self, content: String) {
        self.record(Entry::Steering(content));
    }

    pub fn assistant_tool_turn(&mut self, content: String, calls: &[ValidatedCall]) {
        self.assistant_tool_turn_with_reasoning(content, String::new(), calls);
    }

    /// The assistant record carries the model's own reasoning beside its
    /// content and calls. Thinking templates render prior reasoning back into
    /// the prompt (interleaved/preserved thinking); a record without it makes
    /// the model re-derive its plan on every turn. Whether the field reaches
    /// the wire is a projection decision, never a record edit.
    pub fn assistant_tool_turn_with_reasoning(
        &mut self,
        content: String,
        reasoning: String,
        calls: &[ValidatedCall],
    ) {
        let mut message = json!({
            "role": "assistant",
            "content": content,
            "tool_calls": calls.iter().map(ValidatedCall::wire).collect::<Vec<_>>(),
        });
        attach_reasoning(&mut message, reasoning);
        self.push_message(message);
    }

    pub fn assistant_message(&mut self, content: String) {
        self.assistant_message_with_reasoning(content, String::new());
    }

    pub fn assistant_message_with_reasoning(&mut self, content: String, reasoning: String) {
        let mut message = json!({"role":"assistant", "content":content});
        attach_reasoning(&mut message, reasoning);
        self.push_message(message);
    }

    pub fn assistant_withheld_draft(&mut self, content: String, reason: &str) {
        self.push_message(json!({"role":"assistant","content":content,
            "_runtime_draft_status":"withheld","_runtime_draft_reason":reason}));
    }

    pub fn tool_result(&mut self, id: &str, name: &str, content: String) {
        self.push_message(json!({
            "role": "tool",
            "tool_call_id": id,
            "name": name,
            "content": content,
        }));
    }

    /// A recovery result is a bounded view of an existing observation, not a
    /// new observation. The journal stores its locator and rematerializes the
    /// view on restart; projection keeps the current view readable.
    pub fn rehydrated_tool_result(
        &mut self,
        call_id: &str,
        name: &str,
        source_id: &str,
        offset_chars: usize,
        max_chars: usize,
        result: &Value,
    ) {
        self.push_message(json!({
            "role":"tool", "tool_call_id":call_id, "name":name,
            "content":result.to_string(),
            "_result_policy":ToolResultPolicy::Rehydrated.marker(),
            "_rehydration":{"id":source_id,"offset_chars":offset_chars,"max_chars":max_chars}
        }));
    }

    pub fn inline_tool_result(&mut self, call_id: &str, name: &str, content: String) {
        self.push_message(json!({
            "role":"tool", "tool_call_id":call_id, "name":name,
            "content":content, "_result_policy":ToolResultPolicy::Inline.marker()
        }));
    }

    pub fn remind(&mut self, content: String) {
        self.record(Entry::Reminder(content));
    }

    pub fn record_prompt_tail(&mut self, content: &str) {
        if !content.trim().is_empty() && !self.has_active_prompt_tail(content) {
            self.record(Entry::PromptTail(content.to_owned()));
        }
    }

    pub fn pending_tail(&self, volatile: &str) -> String {
        let start = self
            .entries
            .iter()
            .rposition(|entry| matches!(entry, Entry::ClearReminders))
            .map_or(0, |i| i + 1);
        let reminders = self
            .entries
            .iter()
            .skip(start)
            .filter_map(|entry| match entry {
                Entry::Reminder(value) => Some(value.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let finalizing = if self.is_finalizing() {
            "MODE: FINALIZING. The investigation budget for this run is exhausted and tools are unavailable. Write the final answer now from the findings and observations already in context, answer the requested sections directly, state each conclusion once, say plainly what remained unexamined, and add no progress narration or promises to continue."
        } else {
            ""
        };
        let language = format!("Preferred language for visible prose: {}. Preserve code, paths, commands, identifiers, protocol syntax, and literal source quotations.", self.language_preference());
        [
            volatile.trim(),
            reminders.trim(),
            finalizing,
            language.as_str(),
        ]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
    }

    /// Tool substeps do not invalidate accepted state. Compaction/finalization
    /// boundaries do: the first request after them needs a fresh full snapshot.
    pub fn has_active_prompt_tail(&self, content: &str) -> bool {
        let boundary = self
            .compaction_boundary()
            .unwrap_or(0)
            .max(self.finalization_index().unwrap_or(0))
            .max(self.entries.iter().rposition(|entry| matches!(entry, Entry::RunUser(_))).unwrap_or(0));
        self.entries
            .iter()
            .skip(boundary)
            .rev()
            .find_map(|entry| match entry {
                Entry::PromptTail(existing) => Some(existing == content),
                // Assistant/tool substeps do not change accepted runtime state.
                _ => None,
            })
            .unwrap_or(false)
    }

    /// Reminders are intentionally one-request tail instructions. Retiring old
    /// ones keeps the stable system prefix and prevents policy loops.
    pub fn clear_reminders(&mut self) {
        if self
            .entries
            .iter()
            .rev()
            .take_while(|entry| !matches!(entry, Entry::ClearReminders))
            .any(|entry| matches!(entry, Entry::Reminder(_)))
        {
            self.record(Entry::ClearReminders);
        }
    }

    pub fn compact(&mut self, summary: String, covers: usize) {
        self.record(Entry::Compaction { summary, covers });
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
        let mut previous_state: Option<&str> = None;
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
                    messages.push(project_accepted_message(message));
                    sources.push(index);
                }
                Entry::RunUser(message) => {
                    previous_state = None;
                    messages.push(message.clone());
                    sources.push(index);
                }
                Entry::Steering(content) => {
                    messages.push(
                        json!({"role":"user", "content":content, "metadata":{"steering":true}}),
                    );
                    sources.push(index);
                }
                Entry::PromptTail(content) if index >= self.finalization_index().unwrap_or(0) => {
                    if let Some(message) = crate::context::runtime_state::message(previous_state, content) {
                        messages.push(message);
                        sources.push(index);
                    }
                    previous_state = Some(content);
                }
                Entry::Compaction { .. }
                | Entry::Reminder(_)
                | Entry::ClearReminders
                | Entry::Finalizing
                | Entry::WorkBudget(_)
                | Entry::CloseoutRequested
                | Entry::RunComplete
                | Entry::LanguagePreference(_)
                | Entry::Evidence(_)
                | Entry::EvidenceRejection { .. }
                | Entry::Frontier(_)
                | Entry::FrontierDisposition(_)
                | Entry::PromptTail(_)
                | Entry::Message(_) => {}
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

pub fn preferred_visible_language(user: &str) -> String {
    let cyrillic = user
        .chars()
        .filter(|c| ('\u{0400}'..='\u{052f}').contains(c))
        .count();
    let latin = user.chars().filter(|c| c.is_ascii_alphabetic()).count();
    if cyrillic > latin {
        if user.chars().any(|c| "іїєґІЇЄҐ".contains(c)) {
            "Ukrainian".into()
        } else if user.chars().any(|c| "ыэъёЫЭЪЁ".contains(c)) {
            "Russian".into()
        } else {
            "the latest user's Cyrillic language".into()
        }
    } else {
        "the latest user's language".into()
    }
}

pub fn prompt_tail_message(content: &str) -> Value {
    crate::context::runtime_state::message(None, content)
        .unwrap_or_else(|| json!({"role":"runtime", "content":""}))
}

fn attach_reasoning(message: &mut Value, reasoning: String) {
    if !reasoning.trim().is_empty() {
        message["reasoning_content"] = Value::String(reasoning);
    }
}

pub fn project_accepted_message(message: &Value) -> Value {
    if message.get("_runtime_draft_status").and_then(Value::as_str) == Some("withheld") {
        let reason = message
            .get("_runtime_draft_reason")
            .and_then(Value::as_str)
            .unwrap_or("runtime review");
        json!({"role":"assistant","content":format!("[An earlier answer draft was withheld for {reason}; continue from the findings so far without repeating that draft.]")})
    } else {
        message.clone()
    }
}

fn is_tool_message(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("tool")
}

/// Text view of a span for the summarizer. Tool results are exact, immutable
/// and recoverable by observation ID, so each one is shown as a bounded
/// excerpt; that keeps the whole span, including its most recent work, inside
/// the budget instead of letting the first large results consume it.
fn render_messages(messages: &[Value], max_chars: usize) -> String {
    let per_result = (max_chars / messages.len().max(1)).clamp(600, 6_000);
    let mut out = String::new();
    for message in messages {
        render_message(&mut out, message, per_result);
    }
    clamp_middle(&out, max_chars)
}

/// Keeps the start of the span and its end, dropping the middle.
fn clamp_middle(text: &str, max_chars: usize) -> String {
    let chars = text.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return text.to_owned();
    }
    let head = max_chars / 4;
    let tail = max_chars.saturating_sub(head + 48);
    format!(
        "{}\n[… middle of transcript omitted …]\n{}",
        chars[..head].iter().collect::<String>(),
        chars[chars.len() - tail..].iter().collect::<String>()
    )
}

fn render_message(out: &mut String, message: &Value, per_result: usize) {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    out.push_str(&format!("[{role}]\n"));
    if let Some(content) = message.get("content").and_then(Value::as_str) {
        if role == "tool" && content.chars().count() > per_result {
            let excerpt = content.chars().take(per_result).collect::<String>();
            let omitted = content.chars().count() - per_result;
            let id = message
                .get("_observation_id")
                .and_then(Value::as_str)
                .map_or(String::new(), |id| format!(" ({id})"));
            out.push_str(&format!(
                "{excerpt}\n[… {omitted} more characters of this tool result omitted{id}]"
            ));
        } else {
            out.push_str(content);
        }
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
    fn terminal_partial_success_is_an_observation_but_failed_output_is_an_error_observation() {
        let base = std::env::temp_dir().join(format!(
            "terminal-observation-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let mut transcript = Transcript::durable(&base, "run", &[], None).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"inspect API source"}));
        transcript.assistant_tool_turn(
            String::new(),
            &[ValidatedCall {
                id: "partial".into(),
                name: "run_terminal".into(),
                arguments: json!({"command":"rg api src | head -n 1"}),
            }],
        );
        transcript.tool_result(
            "partial",
            "run_terminal",
            json!({
                "command":"rg api src | head -n 1",
                "exit_code":141,
                "pipeline_statuses":[141,0],
                "status":"partial_success",
                "stdout":"src/OrderForm.tsx: await fetch('/api/orders', { method:'POST' });"
            })
            .to_string(),
        );
        let partial_id = transcript
            .observation_for_call("partial")
            .unwrap()
            .id
            .clone();
        assert!(!transcript.observation(&partial_id).unwrap().error);

        transcript.assistant_tool_turn(
            String::new(),
            &[ValidatedCall {
                id: "failed".into(),
                name: "run_terminal".into(),
                arguments: json!({"command":"grep no-match src"}),
            }],
        );
        transcript.tool_result(
            "failed",
            "run_terminal",
            json!({
                "error":"terminal execution failed",
                "execution":{
                    "command":"grep no-match src",
                    "exit_code":2,
                    "status":"error",
                    "stdout":"useful diagnostic stdout"
                }
            })
            .to_string(),
        );
        let failed_id = transcript
            .observation_for_call("failed")
            .unwrap()
            .id
            .clone();
        assert!(transcript.observation(&failed_id).unwrap().error);
        assert!(
            transcript.read_observation(&failed_id, 0, 2_000).unwrap()["content"]
                .as_str()
                .unwrap()
                .contains("useful diagnostic stdout")
        );
        drop(transcript);
        std::fs::remove_dir_all(base).unwrap();
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

        transcript.compact("factual handoff".into(), 3);
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
    fn finalization_is_monotonic_across_compaction_and_restart() {
        let base = std::env::temp_dir().join(format!(
            "lifecycle-restart-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let mut transcript = Transcript::durable(&base, "run-one", &[], None).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.mark_finalizing();
        transcript.compact("final synthesis".into(), transcript.entries().len());
        drop(transcript);
        let mut resumed = Transcript::durable(&base, "run-two", &[], None).unwrap();
        assert!(resumed.is_finalizing());
        resumed.push_run_user(json!({"role":"user","content":"new task"}));
        assert!(!resumed.is_finalizing());
        drop(resumed);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn accepted_state_deltas_resume_identically_and_compaction_refreshes_full_state() {
        let base = std::env::temp_dir().join(format!(
            "state-restart-{}-{:?}", std::process::id(), std::thread::current().id()
        ));
        let mut transcript = Transcript::durable(&base, "first", &[], None).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"implement"}));
        let old = "<plan>\ns1 active\n</plan>\n<deliverables>\nd1 pending\n</deliverables>";
        let current = old.replace("s1 active", "s1 done");
        transcript.record_prompt_tail(old);
        transcript.assistant_message("working".into());
        transcript.record_prompt_tail(&current);
        let before = crate::context::projection::project(&transcript, "stable", "");
        drop(transcript);
        let mut resumed = Transcript::durable(&base, "second", &[], None).unwrap();
        assert_eq!(crate::context::projection::project(&resumed, "stable", ""), before);
        assert!(resumed.has_active_prompt_tail(&current));
        let count = resumed.entries().len();
        resumed.record_prompt_tail(&current);
        assert_eq!(resumed.entries().len(), count);
        resumed.compact("implementation checkpoint".into(), count);
        assert!(!resumed.has_active_prompt_tail(&current));
        let refreshed = crate::context::projection::project(&resumed, "stable", &current);
        let state = refreshed.last().unwrap()["content"].as_str().unwrap();
        assert!(state.contains("s1 done") && state.contains("d1 pending"));
        assert!(state.contains("Current runtime state"));
        drop(resumed);
        std::fs::remove_dir_all(base).unwrap();
    }

    /// Journals written while the runtime graded claims and gated finalization
    /// must keep loading: an unparseable line would otherwise be treated as a
    /// torn tail and the rest of the run truncated from disk.
    #[test]
    fn journals_with_retired_lifecycle_entries_still_resume_intact() {
        let base = std::env::temp_dir().join(format!(
            "legacy-journal-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let run = base.join("legacy");
        std::fs::create_dir_all(run.join("observations")).unwrap();
        let entries = [
            json!({"RunUser":{"role":"user","content":"audit"}}),
            json!("CloseoutRequested"),
            json!({"Evidence":{"id":"ev-1","claim":"c","origin":"agent-reported direct","observation_id":"obs-00000001","source":"a.rs","revision":null}}),
            json!({"EvidenceRejection":{"claim":"x","observation_id":"obs-00000001"}}),
            json!({"Frontier":{"id":"f-1","from_observation":"obs-00000001","source":"a.rs","target":"api.php"}}),
            json!({"FrontierDisposition":{"id":"f-1","outcome":"blocked","reason":"r","observation_id":null}}),
            json!({"Message":{"role":"assistant","content":"earlier finding"}}),
        ];
        let journal = entries
            .iter()
            .enumerate()
            .map(|(i, entry)| {
                json!({"event_id":format!("evt-{:08}", i + 1),"entry":entry,"observation":null})
                    .to_string()
                    + "\n"
            })
            .collect::<String>();
        std::fs::write(run.join("events.jsonl"), &journal).unwrap();
        std::fs::write(
            base.join("active.json"),
            json!({"run_dir":"legacy","expected_history_hash":crate::agent::evidence::history_hash(&[])}).to_string(),
        )
        .unwrap();
        let transcript = Transcript::durable(&base, "resumed", &[], None).unwrap();
        assert_eq!(transcript.entries().len(), entries.len());
        assert!(!transcript.is_finalizing());
        assert_eq!(
            std::fs::read_to_string(run.join("events.jsonl")).unwrap(),
            journal
        );
        let projected = crate::context::projection::project(&transcript, "system", "");
        assert!(projected.iter().any(|m| m["content"] == "earlier finding"));
        assert!(!serde_json::to_string(&projected)
            .unwrap()
            .contains("api.php"));
        std::fs::remove_dir_all(base).unwrap();
    }

    /// Failure shape: the summarizer input stopped at the first message that
    /// pushed the rendering over budget, so after a large burst of tool results
    /// the summary never saw most of the span (everything after the first few
    /// results) and the model lost its findings through compaction.
    #[test]
    fn the_summary_input_covers_the_whole_span_not_just_its_first_large_results() {
        let mut t = Transcript::default();
        t.push_run_user(json!({"role":"user","content":"audit"}));
        for n in 0..40 {
            t.assistant_tool_turn(
                format!("reading {n}"),
                &[ValidatedCall {
                    id: format!("c{n}"),
                    name: "read_file".into(),
                    arguments: json!({"path": format!("f{n}.ts")}),
                }],
            );
            t.tool_result(
                &format!("c{n}"),
                "read_file",
                json!({"path": format!("f{n}.ts"), "content": format!("MARK-{n} {}", "x".repeat(60_000))}).to_string(),
            );
        }
        t.assistant_message("recent".into());
        let plan = t.compaction_plan(2).unwrap();
        let rendered = plan.render(48_000);
        assert!(
            rendered.chars().count() <= 48_100,
            "{}",
            rendered.chars().count()
        );
        for n in [0, 10, 20, 39] {
            assert!(
                rendered.contains(&format!("MARK-{n} ")),
                "result {n} must be visible to the summarizer"
            );
        }
        assert!(
            rendered.contains("reading 39"),
            "the latest work is the most important"
        );
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

    #[test]
    fn an_identical_tail_does_not_repeat_after_an_assistant_substep() {
        let mut t = Transcript::default();
        t.push_run_user(json!({"role":"user","content":"task"}));
        t.record_prompt_tail("same tail");
        assert!(t.has_active_prompt_tail("same tail"));
        t.assistant_withheld_draft("draft".into(), "unverified changes");
        assert!(
            t.has_active_prompt_tail("same tail"),
            "an assistant substep does not change runtime-owned state"
        );
    }

    #[test]
    fn finalization_state_survives_compaction_and_new_user_resets_it() {
        let mut t = Transcript::default();
        t.push_run_user(json!({"role":"user","content":"audit"}));
        for n in 0..10 {
            t.assistant_message(format!("finding {n}"));
        }
        t.remind("restart broad research".into());
        t.record_prompt_tail("old research guidance");
        t.mark_finalizing();
        let plan = t.compaction_plan(2).unwrap();
        t.compact("earlier findings".into(), plan.covers);
        assert!(t.is_finalizing());
        assert!(t.pending_tail("").contains("MODE: FINALIZING"));
        assert!(t.pending_tail("").contains("tools are unavailable"));
        assert!(!t.pending_tail("").contains("restart broad research"));
        t.record_prompt_tail("current finalization guidance");
        let projected = crate::context::projection::project(&t, "system", "");
        assert!(!projected.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|s| s.contains("old research guidance"))));
        assert!(projected.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|s| s.contains("current finalization guidance"))));
        t.mark_run_complete();
        t.push_run_user(json!({"role":"user","content":"new task"}));
        assert!(!t.is_finalizing());
    }

    #[test]
    fn rejected_tool_free_draft_is_canonical_but_not_replayed_as_a_second_answer() {
        let mut t = Transcript::default();
        t.push_run_user(json!({"role":"user","content":"audit"}));
        t.assistant_withheld_draft("FULL DUPLICATE REPORT".into(), "a specific evidence gap");
        assert!(t.entries().iter().any(
            |entry| matches!(entry, Entry::Message(m) if m["content"] == "FULL DUPLICATE REPORT")
        ));
        let projected = crate::context::projection::project(&t, "system", "");
        assert!(!projected
            .iter()
            .any(|m| m["content"] == "FULL DUPLICATE REPORT"));
        assert!(projected.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|s| s.contains("draft was withheld"))));
        t.assistant_message("Accepted concise report".into());
        assert!(crate::context::projection::project(&t, "system", "")
            .iter()
            .any(|m| m["content"] == "Accepted concise report"));
    }
}
