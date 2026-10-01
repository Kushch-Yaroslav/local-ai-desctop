use crate::agent::evidence::{EvidenceStore, Observation};
use crate::agent::frontiers::{EvidenceFrontier, FrontierDisposition};
use crate::agent::working_evidence::EstablishedEvidence;
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
}

impl Default for Transcript {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            store: None,
            evidence_base: None,
            project_root: None,
            storage_error: None,
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
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Entry {
    Message(Value),
    RunUser(Value),
    Compaction {
        summary: String,
        covers: usize,
    },
    Steering(String),
    Reminder(String),
    ClearReminders,
    Finalizing,
    /// The model requested closeout or the runtime detected grounded coverage
    /// with only specific gaps left. This is a research substate, not a plan.
    CloseoutRequested,
    RunComplete,
    LanguagePreference(String),
    Evidence(EstablishedEvidence),
    Frontier(EvidenceFrontier),
    FrontierDisposition(FrontierDisposition),
    /// Volatile guidance becomes durable only after the provider accepted the
    /// request. Keeping it at this exact point prevents a moving synthetic
    /// tail from rewriting model history on every tool turn.
    PromptTail(String),
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
    pub fn set_project_root(&mut self, root: Option<&Path>) {
        self.project_root = root.and_then(|path| path.canonicalize().ok());
    }
    pub fn is_closeout_requested(&self) -> bool {
        let start = self
            .entries
            .iter()
            .rposition(|e| matches!(e, Entry::RunUser(_)))
            .unwrap_or(0);
        self.entries
            .iter()
            .skip(start)
            .any(|e| matches!(e, Entry::CloseoutRequested))
    }
    pub fn mark_closeout_requested(&mut self) {
        if !self.is_closeout_requested() && !self.is_finalizing() {
            self.record(Entry::CloseoutRequested);
        }
    }
    /// Only an explicit source-backed finding is semantic gain. Replaying a
    /// stored body, reading fresh Project Knowledge, or touching a new file is
    /// not itself a new established conclusion.
    pub fn last_tool_turn_gained_evidence(&self) -> bool {
        let run_start = self
            .entries
            .iter()
            .rposition(|e| matches!(e, Entry::RunUser(_)))
            .unwrap_or(0);
        let Some(start) = self.entries.iter().enumerate().skip(run_start).filter_map(|(i,entry)| matches!(entry, Entry::Message(m) if m.get("role").and_then(Value::as_str)==Some("assistant") && m.get("tool_calls").is_some()).then_some(i)).last() else { return false; };
        self.entries
            .iter()
            .skip(start + 1)
            .any(|entry| matches!(entry, Entry::Evidence(_)))
    }
    pub fn frontiers(&self) -> Vec<EvidenceFrontier> {
        let start = self
            .entries
            .iter()
            .rposition(|e| matches!(e, Entry::RunUser(_)))
            .unwrap_or(0);
        self.entries
            .iter()
            .skip(start)
            .filter_map(|entry| match entry {
                Entry::Frontier(frontier) => {
                    let mut frontier = frontier.clone();
                    if frontier.resolved_path.is_none() {
                        let (path, provenance) = crate::agent::frontiers::resolve_local_target(
                            &frontier.source,
                            &frontier.target,
                            self.project_root.as_deref()?,
                        )?;
                        frontier.resolved_path = Some(path.to_string_lossy().into_owned());
                        frontier.project_relative_path = path
                            .strip_prefix(self.project_root.as_deref()?)
                            .ok()
                            .map(|relative| relative.to_string_lossy().into_owned());
                        frontier.resolution = Some(provenance);
                    }
                    Some(frontier)
                }
                _ => None,
            })
            .collect()
    }
    pub fn frontier_dispositions(&self) -> Vec<FrontierDisposition> {
        let start = self
            .entries
            .iter()
            .rposition(|e| matches!(e, Entry::RunUser(_)))
            .unwrap_or(0);
        self.entries
            .iter()
            .skip(start)
            .filter_map(|entry| match entry {
                Entry::FrontierDisposition(disposition) => Some(disposition.clone()),
                _ => None,
            })
            .collect()
    }
    pub fn discover_frontiers(&mut self, call_id: &str, result: &str) -> Vec<EvidenceFrontier> {
        let Some(observation) = self.observation_for_call(call_id) else {
            return Vec::new();
        };
        let found =
            crate::agent::frontiers::discover(observation, result, self.project_root.as_deref());
        let mut accepted = Vec::new();
        for frontier in found {
            if !self
                .frontiers()
                .iter()
                .any(|old| old.source == frontier.source && old.target == frontier.target)
            {
                self.record(Entry::Frontier(frontier.clone()));
                accepted.push(frontier);
            }
        }
        accepted
    }
    pub fn dispose_frontier(
        &mut self,
        id: &str,
        outcome: &str,
        reason: &str,
        observation_id: Option<&str>,
    ) -> Result<(), String> {
        let frontiers = self.frontiers();
        let frontier = frontiers.iter().find(|frontier| frontier.id == id).or_else(|| {
            let mut from_source = frontiers.iter().filter(|frontier| frontier.from_observation == id);
            let unique = from_source.next()?;
            from_source.next().is_none().then_some(unique)
        }).ok_or_else(|| {
            let known = frontiers.iter().map(|f| f.id.as_str()).collect::<Vec<_>>().join(", ");
            format!("unknown evidence frontier: {id}; use frontier ID (not source observation ID). Open IDs: {known}")
        })?;
        let canonical_id = frontier.id.clone();
        if !matches!(outcome, "blocked" | "irrelevant") || reason.trim().chars().count() < 12 {
            return Err(
                "frontier disposition requires blocked/irrelevant and a concrete reason".into(),
            );
        }
        if outcome == "blocked"
            && !observation_id.is_some_and(|id| {
                self.observation(id).is_some_and(|o| {
                    o.error
                        && o.source.as_deref().is_some_and(|source| {
                            crate::agent::frontiers::matches_target_source(frontier, source)
                        })
                })
            })
        {
            return Err("blocked requires an error/approval observation for the resolved target; an abandoned attempt is still open".into());
        }
        if outcome == "irrelevant" {
            let grounded = observation_id.is_some_and(|id| {
                self.observation(id).is_some_and(|observation| {
                    !observation.error
                        && observation.source.as_deref().is_some_and(|source| {
                            crate::agent::frontiers::matches_target_source(frontier, source)
                        })
                        && self.entries.iter().any(|entry| {
                            matches!(entry, Entry::Evidence(fact)
                            if fact.observation_id.as_deref() == Some(observation.id.as_str())
                            && fact.origin == "agent-reported direct")
                        })
                })
            });
            if !grounded {
                return Err("irrelevant requires a direct finding from a read of the actual local target; a source-side assertion that it is external is insufficient".into());
            }
        }
        self.record(Entry::FrontierDisposition(FrontierDisposition {
            id: canonical_id,
            outcome: outcome.into(),
            reason: reason.trim().chars().take(300).collect(),
            observation_id: observation_id.map(str::to_owned),
        }));
        Ok(())
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
                    Some(message.get("content").and_then(Value::as_str) == Some(content))
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
    pub fn record_established_evidence(
        &mut self,
        claim: &str,
        id: &str,
        inference: bool,
    ) -> Result<EstablishedEvidence, String> {
        let claim = claim.split_whitespace().collect::<Vec<_>>().join(" ");
        if claim.is_empty() || claim.chars().count() > 800 {
            return Err("evidence claim must contain 1-800 characters".into());
        }
        let observation = self
            .observation(id)
            .ok_or_else(|| format!("unknown observation id: {id}; use observation_index"))?;
        if observation.error && !inference {
            return Err("an error observation cannot establish a direct success claim".into());
        }
        if let Some(existing) = self.entries.iter().find_map(|entry| match entry {
            Entry::Evidence(fact)
                if fact.claim == claim
                    && fact.observation_id.as_deref() == Some(observation.id.as_str()) =>
            {
                Some(fact.clone())
            }
            _ => None,
        }) {
            return Ok(existing);
        }
        let fact = EstablishedEvidence {
            id: format!("ev-{:08}", self.entries.len() + 1),
            claim,
            origin: if inference {
                "agent inference"
            } else {
                "agent-reported direct"
            }
            .into(),
            observation_id: Some(observation.id.clone()),
            source: observation.source.clone(),
            revision: observation.source_revision.clone(),
        };
        self.record(Entry::Evidence(fact.clone()));
        Ok(fact)
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
        json!({"observations":selected,"offset":offset,"total":all.len(),"more":offset+selected.len()<all.len()})
    }
    pub fn read_observation(&self, id: &str, offset: usize, limit: usize) -> Result<Value, String> {
        self.store
            .as_ref()
            .ok_or("observation store unavailable")?
            .read(id, offset, limit)
    }
    pub fn finish_durable(
        &self,
        history: &[Value],
        user: &str,
        final_text: &str,
    ) -> Result<(), String> {
        if let (Some(store), Some(base)) = (&self.store, &self.evidence_base) {
            store.finish(base, history, user, final_text)
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

    pub fn language_preference(&self) -> String {
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
        self.push_message(json!({
            "role": "assistant",
            "content": content,
            "tool_calls": calls.iter().map(ValidatedCall::wire).collect::<Vec<_>>(),
        }));
    }

    pub fn assistant_message(&mut self, content: String) {
        self.push_message(json!({"role":"assistant", "content":content}));
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
            "MODE: FINALIZING. The answer is being finalized. Broad investigation is complete. Synthesize the final answer from established evidence, state each conclusion once, and recover an observation only for a specific unresolved contradiction or critical exact detail."
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

    /// Only the latest accepted dynamic tail is current. Older snapshots stay
    /// canonical but do not accumulate as stale user-shaped prompt messages.
    pub fn has_active_prompt_tail(&self, content: &str) -> bool {
        let boundary = self
            .compaction_boundary()
            .unwrap_or(0)
            .max(self.finalization_index().unwrap_or(0));
        self.entries
            .iter()
            .skip(boundary)
            .rev()
            .find_map(|entry| match entry {
                Entry::PromptTail(existing) => Some(existing == content),
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
        let active_tail = self
            .entries
            .iter()
            .enumerate()
            .skip(boundary.max(self.finalization_index().unwrap_or(0)))
            .rfind(|(_, entry)| matches!(entry, Entry::PromptTail(_)))
            .map(|(index, _)| index);
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
                    messages.push(project_accepted_message(message));
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
                Entry::PromptTail(content) if active_tail == Some(index) => {
                    messages.push(prompt_tail_message(content));
                    sources.push(index);
                }
                Entry::Compaction { .. }
                | Entry::Reminder(_)
                | Entry::ClearReminders
                | Entry::Finalizing
                | Entry::CloseoutRequested
                | Entry::RunComplete
                | Entry::LanguagePreference(_)
                | Entry::Evidence(_)
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
    json!({"role":"user", "content":format!("[RUNTIME GUIDANCE — NOT USER CONTENT]\n{content}")})
}

pub fn project_accepted_message(message: &Value) -> Value {
    if message.get("_runtime_draft_status").and_then(Value::as_str) == Some("withheld") {
        let reason = message
            .get("_runtime_draft_reason")
            .and_then(Value::as_str)
            .unwrap_or("runtime review");
        json!({"role":"assistant","content":format!("[An earlier answer draft was withheld for {reason}; continue from established evidence without repeating that draft.]")})
    } else {
        message.clone()
    }
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
    fn frontier_and_source_observation_survive_compaction_and_restart() {
        let base = std::env::temp_dir().join(format!(
            "frontier-restart-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let project = base.join("project");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::create_dir_all(project.join("public")).unwrap();
        std::fs::write(project.join("index.html"), "<base href=\"/\">").unwrap();
        std::fs::write(
            project.join("package.json"),
            r#"{"devDependencies":{"vite":"*"}}"#,
        )
        .unwrap();
        std::fs::write(
            project.join("vite.config.ts"),
            "export default defineConfig({})",
        )
        .unwrap();
        std::fs::write(project.join("src/Form.tsx"), "fetch('service.php')").unwrap();
        std::fs::write(project.join("public/service.php"), "<?php").unwrap();
        let source = project.join("src/Form.tsx").to_string_lossy().into_owned();
        let target = project
            .join("public/service.php")
            .to_string_lossy()
            .into_owned();
        let mut transcript =
            Transcript::durable(&base, "frontier-run", &[], Some(project.to_str().unwrap()))
                .unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit local flow"}));
        let call = ValidatedCall {
            id: "call-ui".into(),
            name: "read_file".into(),
            arguments: json!({"path":source}),
        };
        transcript.assistant_tool_turn(String::new(), &[call]);
        let result = json!({"content":"await fetch('service.php', {method:'POST'})"}).to_string();
        transcript.tool_result("call-ui", "read_file", result.clone());
        let edges = transcript.discover_frontiers("call-ui", &result);
        assert_eq!(edges.len(), 1);
        let detailed_finding = "local service accepts submitted form details ".repeat(12);
        assert!(detailed_finding.chars().count() > 420);
        assert!(
            transcript
                .record_established_evidence(&detailed_finding, &edges[0].from_observation, false)
                .is_ok(),
            "a useful bounded finding must not be discarded just above the old 420-character cap"
        );
        let id = edges[0].id.clone();
        assert_eq!(id, format!("frontier-{}-00", edges[0].from_observation));
        assert_eq!(edges[0].resolved_path.as_deref(), Some(target.as_str()));
        assert!(transcript
            .dispose_frontier("unknown-id", "blocked", "grounded target error", None)
            .unwrap_err()
            .contains(&id));
        assert!(transcript
            .dispose_frontier(
                &edges[0].from_observation,
                "irrelevant",
                "the local target is external",
                None
            )
            .unwrap_err()
            .contains("actual local target"));
        assert!(transcript.frontier_dispositions().is_empty());
        assert!(transcript
            .dispose_frontier(&id, "blocked", "I skipped this target", None)
            .is_err());
        let mut projected_state = crate::agent::research::ResearchController::new("audit backend");
        projected_state.refresh_frontiers(
            &transcript.frontiers(),
            &transcript.frontier_dispositions(),
            transcript.observations(),
            &[],
        );
        assert!(projected_state.open_frontier_summary().contains(&id));
        let failed = ValidatedCall {
            id: "call-denied".into(),
            name: "read_file".into(),
            arguments: json!({"path":target}),
        };
        transcript.assistant_tool_turn(String::new(), &[failed]);
        transcript.tool_result(
            "call-denied",
            "read_file",
            json!({"path":target,"error":"permission denied"}).to_string(),
        );
        let denied_id = transcript
            .observation_for_call("call-denied")
            .unwrap()
            .id
            .clone();
        assert!(transcript.observation(&denied_id).unwrap().error);
        transcript
            .dispose_frontier(
                &id,
                "blocked",
                "permission denied for the exact local target",
                Some(&denied_id),
            )
            .unwrap();
        assert_eq!(transcript.frontier_dispositions()[0].id, id);
        transcript
            .dispose_frontier(
                &edges[0].from_observation,
                "blocked",
                "permission denied for the exact local target",
                Some(&denied_id),
            )
            .unwrap();
        assert_eq!(transcript.frontier_dispositions().last().unwrap().id, id);
        transcript.compact("checkpoint".into(), transcript.entries().len());
        drop(transcript);
        let mut restored =
            Transcript::durable(&base, "new-worker", &[], Some(project.to_str().unwrap())).unwrap();
        assert_eq!(restored.frontiers()[0].id, id);
        assert_eq!(restored.frontiers()[0].target, "service.php");
        let call = ValidatedCall {
            id: "call-target".into(),
            name: "read_file".into(),
            arguments: json!({"path":"public/service.php"}),
        };
        restored.assistant_tool_turn(String::new(), &[call]);
        restored.tool_result(
            "call-target",
            "read_file",
            json!({"path":"public/service.php","content":"<?php receives orders"}).to_string(),
        );
        let target_obs = restored
            .observation_for_call("call-target")
            .unwrap()
            .id
            .clone();
        restored
            .record_established_evidence(
                "The local service receives submitted orders",
                &target_obs,
                false,
            )
            .unwrap();
        restored
            .dispose_frontier(
                &id,
                "irrelevant",
                "the inspected target is outside the requested scope",
                Some(&target_obs),
            )
            .unwrap();
        let facts = crate::agent::working_evidence::collect(
            &restored,
            &crate::agent::task_memory::TaskMemory::default(),
        );
        assert!(crate::agent::frontiers::resolved_by_evidence(
            &restored.frontiers()[0],
            restored.observations(),
            &facts
        ));
        assert!(restored
            .read_observation(&edges[0].from_observation, 0, 500)
            .unwrap()
            .to_string()
            .contains("service.php"));
        restored.push_run_user(json!({"role":"user","content":"new task"}));
        assert!(restored.frontiers().is_empty());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn observation_alias_is_rejected_when_it_names_multiple_frontiers() {
        let mut transcript = Transcript::default();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        for (suffix, target) in [("00", "first.php"), ("01", "second.php")] {
            transcript.record(Entry::Frontier(EvidenceFrontier {
                id: format!("frontier-obs-00000030-{suffix}"),
                from_observation: "obs-00000030".into(),
                source: "/project/src/Form.tsx".into(),
                target: target.into(),
                resolved_path: Some(format!("/project/public/{target}")),
                project_relative_path: Some(format!("public/{target}")),
                resolution: Some("configured static public root".into()),
            }));
        }
        let error = transcript
            .dispose_frontier("obs-00000030", "irrelevant", "out of requested scope", None)
            .unwrap_err();
        assert!(
            error.contains("unknown evidence frontier")
                && error.contains("frontier-obs-00000030-00")
                && error.contains("frontier-obs-00000030-01")
        );
        assert!(transcript.frontier_dispositions().is_empty());
    }

    #[test]
    fn open_frontier_identity_survives_failed_close_compaction_and_restart() {
        let base = std::env::temp_dir().join(format!(
            "open-frontier-restart-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let mut transcript = Transcript::durable(&base, "first", &[], None).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit backend"}));
        let id = "frontier-obs-00000030-00";
        transcript.record(Entry::Frontier(EvidenceFrontier {
            id: id.into(),
            from_observation: "obs-00000030".into(),
            source: "/project/src/Form.tsx".into(),
            target: "api.php".into(),
            resolved_path: Some("/project/public/api.php".into()),
            project_relative_path: Some("public/api.php".into()),
            resolution: Some("configured static public root".into()),
        }));
        assert!(transcript
            .dispose_frontier(id, "blocked", "target was not inspected", None)
            .is_err());
        assert!(transcript.frontier_dispositions().is_empty());
        transcript.compact("research checkpoint".into(), transcript.entries().len());
        drop(transcript);
        let mut resumed = Transcript::durable(&base, "second", &[], None).unwrap();
        assert_eq!(resumed.frontiers()[0].id, id);
        assert!(resumed
            .dispose_frontier(id, "irrelevant", "the endpoint is external", None)
            .unwrap_err()
            .contains("actual local target"));
        let mut research = crate::agent::research::ResearchController::new("audit backend");
        research.refresh_frontiers(
            &resumed.frontiers(),
            &resumed.frontier_dispositions(),
            resumed.observations(),
            &[],
        );
        assert!(research.open_frontier_summary().contains(id));
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
    fn closeout_and_finalization_are_monotonic_across_compaction_and_restart() {
        let base = std::env::temp_dir().join(format!(
            "lifecycle-restart-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let mut transcript = Transcript::durable(&base, "run-one", &[], None).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.mark_closeout_requested();
        transcript.compact(
            "old research next: inspect everything".into(),
            transcript.entries().len(),
        );
        drop(transcript);
        let mut resumed = Transcript::durable(&base, "run-two", &[], None).unwrap();
        assert!(resumed.is_closeout_requested());
        assert!(!resumed.is_finalizing());
        resumed.mark_finalizing();
        resumed.compact("final synthesis".into(), resumed.entries().len());
        drop(resumed);
        let mut again = Transcript::durable(&base, "run-three", &[], None).unwrap();
        assert!(again.is_finalizing());
        again.mark_closeout_requested();
        assert!(again.is_finalizing());
        again.push_run_user(json!({"role":"user","content":"new task"}));
        assert!(!again.is_finalizing());
        assert!(!again.is_closeout_requested());
        drop(again);
        std::fs::remove_dir_all(base).unwrap();
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
        assert!(t.pending_tail("").contains("being finalized"));
        assert!(t
            .pending_tail("")
            .contains("specific unresolved contradiction"));
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
