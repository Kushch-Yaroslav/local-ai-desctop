//! Durable, append-only accepted events. Large tool bodies live in immutable
//! files; the journal contains only metadata and references to those files.
use crate::agent::transcript::{Entry, ToolResultPolicy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Observation {
    pub id: String,
    pub event_id: String,
    pub call_id: String,
    pub tool: String,
    pub source: Option<String>,
    pub source_revision: Option<String>,
    pub requested_range: Option<String>,
    pub returned_range: Option<String>,
    pub error: bool,
    pub body_sha256: String,
    pub body_bytes: usize,
}

impl Observation {
    pub fn index_line(&self) -> String {
        let revision = self.source_revision.as_deref().unwrap_or("unknown");
        let short_revision = revision.chars().take(12).collect::<String>();
        format!(
            "{} {} {} source={} rev={} range={}",
            self.id,
            self.tool,
            if self.error { "error" } else { "ok" },
            self.source.as_deref().unwrap_or("none"),
            short_revision,
            self.returned_range.as_deref().unwrap_or("unknown")
        )
    }
    pub fn receipt(&self) -> String {
        format!(
            "[historical tool observation] id={} tool={} outcome={} source={} revision={} requested={} returned={} bytes={} sha256={}\nStored historical evidence. Recover with observation_read(id=\"{}\") only for a specific missing exact detail or contradiction; findings you rely on belong in Task Memory.",
            self.id, self.tool, if self.error { "error/blocker" } else { "success" },
            self.source.as_deref().unwrap_or("none"),
            self.source_revision.as_deref().unwrap_or("unknown"),
            self.requested_range.as_deref().unwrap_or("all"),
            self.returned_range.as_deref().unwrap_or("unknown"),
            self.body_bytes, self.body_sha256, self.id
        )
    }
}

pub fn classify_source_read<'a>(
    current: &Observation,
    prior: impl Iterator<Item = &'a Observation>,
) -> &'static str {
    if current.error {
        return "failed_read";
    }
    let Some(source) = current.source.as_deref() else {
        return "unknown_source";
    };
    let same = prior
        .filter(|o| !o.error && o.source.as_deref() == Some(source))
        .collect::<Vec<_>>();
    if same.is_empty() {
        return "first_read";
    }
    if same.iter().any(|o| {
        o.source_revision == current.source_revision && o.requested_range == current.requested_range
    }) {
        return "unchanged_duplicate";
    }
    if same
        .iter()
        .any(|o| o.source_revision == current.source_revision)
    {
        return "new_range";
    }
    "changed_source"
}

#[derive(Serialize, Deserialize)]
struct JournalLine {
    event_id: String,
    entry: Entry,
    observation: Option<Observation>,
}

#[derive(Serialize, Deserialize)]
struct Active {
    run_dir: String,
    expected_history_hash: String,
}

pub struct EvidenceStore {
    dir: PathBuf,
    run_id: String,
    root: Option<PathBuf>,
    journal: File,
    next_event: usize,
    next_observation: usize,
    pub observations: Vec<Observation>,
}

pub fn history_hash(history: &[Value]) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(history).unwrap_or_default())
    )
}

impl EvidenceStore {
    /// Matching V2 history resumes exact events. An edited/legacy chat starts a
    /// new lineage without deleting the older files.
    pub fn open(
        base: &Path,
        run_id: &str,
        history: &[Value],
        root: Option<&str>,
    ) -> Result<(Self, Vec<Entry>), String> {
        fs::create_dir_all(base).map_err(|e| e.to_string())?;
        let active_path = base.join("active.json");
        let active = fs::read(&active_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Active>(&bytes).ok());
        let hash = history_hash(history);
        let resume = active.as_ref().is_some_and(|a| {
            a.expected_history_hash == hash || can_resume_interrupted(base, a, history)
        });
        let run_dir = if resume {
            active.unwrap().run_dir
        } else {
            safe_name(run_id)
        };
        let dir = base.join(run_dir);
        let canonical_root = root.and_then(|r| fs::canonicalize(r).ok());
        fs::create_dir_all(dir.join("observations")).map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        let mut observations = Vec::new();
        let journal_path = dir.join("events.jsonl");
        if resume && journal_path.exists() {
            let bytes = fs::read(&journal_path).map_err(|e| e.to_string())?;
            let mut valid_bytes = 0;
            for line in bytes.split_inclusive(|byte| *byte == b'\n') {
                if !line.ends_with(b"\n") {
                    break;
                }
                let Ok(mut item) = serde_json::from_slice::<JournalLine>(line) else {
                    break;
                }; // tolerate an interrupted final append
                if let Some(meta) = item.observation.take() {
                    let body = fs::read_to_string(
                        dir.join("observations").join(format!("{}.txt", meta.id)),
                    )
                    .map_err(|e| e.to_string())?;
                    if format!("{:x}", Sha256::digest(body.as_bytes())) != meta.body_sha256 {
                        return Err(format!("observation {} checksum mismatch", meta.id));
                    }
                    if let Entry::Message(message) = &mut item.entry {
                        message["content"] = json!(body);
                        message["_observation_id"] = json!(meta.id);
                    }
                    observations.push(meta);
                }
                if let Entry::Message(message) = &mut item.entry {
                    if ToolResultPolicy::from_message(message) == ToolResultPolicy::Rehydrated {
                        let reference = message
                            .get("_rehydration")
                            .ok_or("missing rehydration locator")?;
                        let id = reference
                            .get("id")
                            .and_then(Value::as_str)
                            .ok_or("missing source observation")?;
                        let offset = reference
                            .get("offset_chars")
                            .and_then(Value::as_u64)
                            .ok_or("missing recovery offset")?
                            as usize;
                        let limit = reference
                            .get("max_chars")
                            .and_then(Value::as_u64)
                            .ok_or("missing recovery limit")?
                            as usize;
                        let result = read_stored_observation(
                            &dir,
                            canonical_root.as_deref(),
                            &observations,
                            id,
                            offset,
                            limit,
                        )?;
                        let mut accepted: Value = serde_json::from_str(
                            message
                                .get("content")
                                .and_then(Value::as_str)
                                .ok_or("missing recovery snapshot")?,
                        )
                        .map_err(|e| e.to_string())?;
                        accepted["content"] = result["content"].clone();
                        message["content"] = json!(accepted.to_string());
                    }
                }
                entries.push(item.entry);
                valid_bytes += line.len();
            }
            if valid_bytes < bytes.len() {
                OpenOptions::new()
                    .write(true)
                    .open(&journal_path)
                    .map_err(|e| e.to_string())?
                    .set_len(valid_bytes as u64)
                    .map_err(|e| e.to_string())?;
            }
        }
        let journal = OpenOptions::new()
            .create(true)
            .append(true)
            .open(journal_path)
            .map_err(|e| e.to_string())?;
        if !resume {
            let active = Active {
                run_dir: dir.file_name().unwrap().to_string_lossy().into_owned(),
                expected_history_hash: hash,
            };
            let tmp = base.join("active.json.tmp");
            fs::write(
                &tmp,
                serde_json::to_vec(&active).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            fs::rename(tmp, &active_path).map_err(|e| e.to_string())?;
        }
        let next_event = entries.len() + 1;
        let next_observation = fs::read_dir(dir.join("observations"))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                entry.file_name().to_str().and_then(|name| {
                    name.strip_prefix("obs-")
                        .and_then(|s| s.strip_suffix(".txt"))
                        .and_then(|n| n.parse::<usize>().ok())
                })
            })
            .max()
            .unwrap_or(0)
            + 1;
        Ok((
            Self {
                dir,
                run_id: run_id.into(),
                root: canonical_root,
                journal,
                next_event,
                next_observation,
                observations,
            },
            entries,
        ))
    }

    pub fn append(
        &mut self,
        entry: &Entry,
        call_args: Option<&Value>,
    ) -> Result<Option<Observation>, String> {
        let event_id = format!("evt-{:08}", self.next_event);
        let mut stored = entry.clone();
        let mut observation = None;
        if let Entry::Message(message) = &mut stored {
            if message.get("role").and_then(Value::as_str) == Some("tool") {
                if ToolResultPolicy::from_message(message) == ToolResultPolicy::Rehydrated {
                    // This event points at an earlier immutable observation.
                    // Persist accepted provenance/status metadata but no
                    // second copy of the exact historical payload slice.
                    let mut snapshot: Value = serde_json::from_str(
                        message
                            .get("content")
                            .and_then(Value::as_str)
                            .ok_or("missing recovery result")?,
                    )
                    .map_err(|e| e.to_string())?;
                    snapshot["content"] = Value::Null;
                    message["content"] = json!(snapshot.to_string());
                } else if ToolResultPolicy::from_message(message) == ToolResultPolicy::Archivable {
                    let body = message.get("content").and_then(Value::as_str).unwrap_or("");
                    let id = format!("obs-{:08}", self.next_observation);
                    let tool = message
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_owned();
                    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
                    let source = parsed
                        .get("path")
                        .or_else(|| call_args.and_then(|a| a.get("path")))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let source_revision = source.as_ref().and_then(|p| {
                        self.root.as_ref().and_then(|root| {
                            let file = fs::canonicalize(root.join(p)).ok()?;
                            if !file.starts_with(root) {
                                return None;
                            }
                            fs::read(file)
                                .ok()
                                .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
                        })
                    });
                    let requested_range = call_args.map(|a| {
                        let lines = a.get("start_line").and_then(Value::as_u64).map(|start| {
                            format!(
                                "lines {}-{}",
                                start,
                                a.get("end_line")
                                    .and_then(Value::as_u64)
                                    .map_or("end".into(), |n| n.to_string())
                            )
                        });
                        let offset = a.get("offset_chars").and_then(Value::as_u64).unwrap_or(0);
                        format!("{} offset_chars={offset}", lines.unwrap_or("all".into()))
                    });
                    let returned_range = parsed
                        .get("start_line")
                        .and_then(Value::as_u64)
                        .map(|n| {
                            format!(
                                "lines {}-{}",
                                n,
                                parsed
                                    .get("end_line")
                                    .and_then(Value::as_u64)
                                    .map_or("end".into(), |end| end.to_string())
                            )
                        })
                        .or_else(|| {
                            parsed
                                .get("total_lines")
                                .and_then(Value::as_u64)
                                .map(|n| format!("lines 1-{n}"))
                        })
                        .map(|range| {
                            if let Some(next) =
                                parsed.get("next_offset_chars").and_then(Value::as_u64)
                            {
                                format!(
                                    "{range} next_offset_chars={next} truncated={}",
                                    parsed
                                        .get("truncated")
                                        .and_then(Value::as_bool)
                                        .unwrap_or(false)
                                )
                            } else {
                                range
                            }
                        });
                    let meta = Observation {
                        id: id.clone(),
                        event_id: event_id.clone(),
                        call_id: message
                            .get("tool_call_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .into(),
                        tool,
                        source,
                        source_revision,
                        requested_range,
                        returned_range,
                        error: parsed.get("error").is_some() || body.starts_with("ERROR"),
                        body_sha256: format!("{:x}", Sha256::digest(body.as_bytes())),
                        body_bytes: body.len(),
                    };
                    let path = self.dir.join("observations").join(format!("{id}.txt"));
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(path)
                        .map_err(|e| e.to_string())?;
                    file.write_all(body.as_bytes())
                        .and_then(|_| file.sync_all())
                        .map_err(|e| e.to_string())?;
                    message["content"] = json!(format!("[exact result stored as {id}]"));
                    observation = Some(meta);
                }
            }
        }
        let line = JournalLine {
            event_id: event_id.clone(),
            entry: stored,
            observation: observation.clone(),
        };
        serde_json::to_writer(&mut self.journal, &line).map_err(|e| e.to_string())?;
        self.journal
            .write_all(b"\n")
            .and_then(|_| self.journal.sync_all())
            .map_err(|e| e.to_string())?;
        self.next_event += 1;
        if let Ok(path) = std::env::var("LOCAL_AI_AGENT_TRACE_PATH") {
            let kind = match entry {
                Entry::Message(m) => m.get("role").and_then(Value::as_str).unwrap_or("message"),
                Entry::RunUser(_) => "run_user",
                Entry::Compaction { .. } => "compaction",
                Entry::Steering(_) => "steering",
                Entry::Reminder(_) => "reminder",
                Entry::ClearReminders => "clear_reminders",
                Entry::PromptTail(_) => "prompt_tail",
                Entry::Finalizing => "finalizing",
                Entry::CloseoutRequested => "closeout_requested",
                Entry::RunComplete => "run_complete",
                Entry::LanguagePreference(_) => "language_preference",
                Entry::Evidence(_) => "established_evidence",
                Entry::EvidenceRejection { .. } => "evidence_rejection",
                Entry::Frontier(_) => "evidence_frontier",
                Entry::FrontierDisposition(_) => "frontier_disposition",
            };
            let record = json!({"run_id":self.run_id,"kind":"canonical_event","data":{
                "event_id":event_id,"event_type":kind,"observation_id":observation.as_ref().map(|o|&o.id),
                "tool_call_id":observation.as_ref().map(|o|&o.call_id),"source":observation.as_ref().and_then(|o|o.source.as_ref()),
                "revision":observation.as_ref().and_then(|o|o.source_revision.as_ref()),"body_bytes":observation.as_ref().map(|o|o.body_bytes)
            }});
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(file, "{record}");
            }
        }
        if let Some(meta) = &observation {
            self.next_observation += 1;
            self.observations.push(meta.clone());
        }
        Ok(observation)
    }

    pub fn finish(
        &self,
        base: &Path,
        history: &[Value],
        user: &str,
        final_text: &str,
    ) -> Result<(), String> {
        let mut next = history.to_vec();
        next.push(json!({"role":"user","content":user}));
        next.push(json!({"role":"assistant","content":final_text}));
        let active = Active {
            run_dir: self.dir.file_name().unwrap().to_string_lossy().into_owned(),
            expected_history_hash: history_hash(&next),
        };
        let tmp = base.join("active.json.tmp");
        fs::write(
            &tmp,
            serde_json::to_vec(&active).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(tmp, base.join("active.json")).map_err(|e| e.to_string())
    }

    pub fn read(&self, id: &str, offset: usize, limit: usize) -> Result<Value, String> {
        read_stored_observation(
            &self.dir,
            self.root.as_deref(),
            &self.observations,
            id,
            offset,
            limit,
        )
    }
}

/// A stopped worker can leave a partial assistant answer in Electron history
/// without calling `finish`. The next worker may extend the same conversation
/// lineage if the original history and user turn still match exactly. An edit
/// of that prefix starts a fresh lineage instead of attaching unrelated data.
fn can_resume_interrupted(base: &Path, active: &Active, history: &[Value]) -> bool {
    let Ok(bytes) = fs::read(base.join(&active.run_dir).join("events.jsonl")) else {
        return false;
    };
    let mut prefix = Vec::new();
    let mut first_user = None;
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let Ok(item) = serde_json::from_slice::<JournalLine>(line) else {
            return false;
        };
        match item.entry {
            Entry::RunComplete => return false,
            Entry::Message(value) if first_user.is_none() => prefix.push(value),
            Entry::RunUser(value) if first_user.is_none() => first_user = Some(value),
            _ => {}
        }
    }
    let Some(user) = first_user else { return false };
    history.len() > prefix.len()
        && history.starts_with(&prefix)
        && history.get(prefix.len()) == Some(&user)
}

fn read_stored_observation(
    dir: &Path,
    root: Option<&Path>,
    observations: &[Observation],
    id: &str,
    offset: usize,
    limit: usize,
) -> Result<Value, String> {
    // Models sometimes omit or add zeroes when copying an indexed ID. Resolve
    // only a numeric spelling of an already indexed observation; never infer a
    // different observation or read an arbitrary path from an ID argument.
    let canonical = id
        .strip_prefix("obs-")
        .and_then(|digits| {
            (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some(digits)
        })
        .and_then(|digits| digits.parse::<usize>().ok())
        .map(|number| format!("obs-{number:08}"));
    let meta = observations
        .iter()
        .find(|m| m.id == id || canonical.as_deref() == Some(m.id.as_str()))
        .ok_or_else(|| format!("unknown observation id: {id}; use an ID from observation_index"))?;
    let body = fs::read_to_string(dir.join("observations").join(format!("{}.txt", meta.id)))
        .map_err(|e| e.to_string())?;
    if format!("{:x}", Sha256::digest(body.as_bytes())) != meta.body_sha256 {
        return Err("historical observation checksum mismatch".into());
    }
    let chars: Vec<char> = body.chars().collect();
    let start = offset.min(chars.len());
    let end = (start + limit.min(16_000)).min(chars.len());
    let live = meta.source.as_ref().and_then(|p| {
        root.and_then(|root| {
            let path = fs::canonicalize(root.join(p)).ok()?;
            if !path.starts_with(root) {
                return None;
            }
            fs::read(path)
                .ok()
                .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
        })
    });
    let freshness = match (&meta.source, &meta.source_revision, &live) {
        (Some(_), _, None) => "missing",
        (_, Some(old), Some(now)) if old == now => "unchanged",
        (_, Some(_), Some(_)) => "changed",
        _ => "unknown",
    };
    Ok(
        json!({"observation":meta,"historical":true,"content":chars[start..end].iter().collect::<String>(),"offset_chars":start,"total_chars":chars.len(),"more":end<chars.len(),"live_source_revision":live,"live_source_status":freshness,"source_changed":matches!(freshness,"changed"|"missing")}),
    )
}

fn safe_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}
