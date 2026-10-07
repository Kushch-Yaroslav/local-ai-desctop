//! Mechanical investigation state.
//!
//! A pure view of what this run's tool observations show: which project files
//! were read (and whether completely), which listed entries and statically
//! referenced local files remain unopened, and which operations failed. It
//! never judges relevance, coverage, sufficiency or whether a claim is true;
//! those remain the model's responsibility. Everything here is derived from
//! the transcript, so it survives compaction and restart without becoming a
//! second source of truth.

use crate::agent::transcript::{Entry, Transcript};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_INDEXED_FILES: usize = 20_000;
const MAX_INDEX_DEPTH: usize = 12;
const MAX_LITERAL_CHARS: usize = 200;
const MAX_SCANNED_LINE_CHARS: usize = 4_000;
const MAX_SCANNED_CONTENT_CHARS: usize = 200_000;
const MAX_REFERENCES_PER_SOURCE: usize = 400;
const MAX_CANDIDATES: usize = 3;
const COMPLETION_EXTENSIONS: usize = 8;
/// The unopened neighbourhood of what was just read or listed is working-set
/// context for the next step. It is shown for this many provider turns and
/// then fades: a permanent list of every unopened import and entry would turn
/// the inventory into a crawl frontier for the model to drain. Only request
/// targets (below) stay visible until they are opened.
const WORKING_SET_TURNS: usize = 3;

/// Dependency, build-output and tooling directories. They are filtered only
/// from the *unopened* views; the model can still list or read them.
const IGNORED_DIRECTORIES: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    "__pycache__",
    ".venv",
    "venv",
    "coverage",
    ".cache",
    ".idea",
    ".vscode",
    ".ai-framework",
];

const ASSET_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "svg", "mp4", "webm", "mov", "mp3",
    "wav", "ogg", "woff", "woff2", "ttf", "otf", "eot", "pdf", "zip", "gz", "tar", "map",
];

/// Stylesheets carry no behavior to follow; they stay visible as unopened
/// directory entries but are never offered as references to chase.
const STYLE_EXTENSIONS: &[&str] = &["css", "scss", "sass", "less"];

const NOISE_FILES: &[&str] = &[
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "composer.lock",
    ".DS_Store",
];

fn ignored_directory(name: &str) -> bool {
    IGNORED_DIRECTORIES.contains(&name)
}

fn extension(name: &str) -> Option<&str> {
    let (stem, extension) = name.rsplit_once('.')?;
    (!stem.is_empty()
        && (1..=5).contains(&extension.len())
        && extension.starts_with(|c: char| c.is_ascii_alphabetic())
        && extension.chars().all(|c| c.is_ascii_alphanumeric()))
    .then_some(extension)
}

fn noise_file(name: &str) -> bool {
    NOISE_FILES.contains(&name)
        // Credentials are never useful to advertise as something to open.
        || name.starts_with(".env")
        || name.ends_with(".min.js")
        || extension(name)
            .is_some_and(|ext| ASSET_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Project-relative file paths (never directory entries), used to resolve a
/// literal found in source to an existing local file.
pub struct ProjectIndex {
    files: BTreeSet<String>,
    by_name: HashMap<String, Vec<String>>,
    extensions: Vec<String>,
}

impl ProjectIndex {
    pub fn empty() -> Self {
        Self::from_paths(Vec::new())
    }

    /// Bounded, deterministic walk. Symlinked directories are not followed.
    pub fn scan(root: &Path) -> Self {
        let mut paths = Vec::new();
        let mut stack = vec![(root.to_path_buf(), String::new(), 0_usize)];
        while let Some((directory, relative, depth)) = stack.pop() {
            let Ok(read) = fs::read_dir(&directory) else {
                continue;
            };
            let mut entries = read.filter_map(Result::ok).collect::<Vec<_>>();
            entries.sort_by_key(fs::DirEntry::file_name);
            for entry in entries {
                if paths.len() >= MAX_INDEXED_FILES {
                    break;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                let child = if relative.is_empty() {
                    name.clone()
                } else {
                    format!("{relative}/{name}")
                };
                if kind.is_dir() {
                    if depth < MAX_INDEX_DEPTH && !ignored_directory(&name) {
                        stack.push((entry.path(), child, depth + 1));
                    }
                } else if kind.is_file() && !noise_file(&name) {
                    paths.push(child);
                }
            }
        }
        Self::from_paths(paths)
    }

    pub fn from_paths(paths: Vec<String>) -> Self {
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
        for path in &paths {
            let name = path.rsplit('/').next().unwrap_or(path);
            by_name
                .entry(name.to_owned())
                .or_default()
                .push(path.clone());
            if let Some(ext) = extension(name) {
                *counts.entry(ext.to_owned()).or_default() += 1;
            }
        }
        let mut ranked = counts.into_iter().collect::<Vec<_>>();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Self {
            files: paths.into_iter().collect(),
            by_name,
            extensions: ranked
                .into_iter()
                .take(COMPLETION_EXTENSIONS)
                .map(|(ext, _)| ext)
                .collect(),
        }
    }

    /// Existing project files a source literal can denote. Resolution is
    /// structural: relative to the referencing file, relative to the project
    /// root, or by unique path suffix (which covers import aliases and
    /// directories served from a sub-folder). An ambiguous literal resolves to
    /// nothing instead of guessing.
    pub fn resolve(&self, source: &str, literal: &str) -> Vec<String> {
        let Some(target) = normalize_literal(literal) else {
            return Vec::new();
        };
        let source_directory = source
            .rsplit_once('/')
            .map_or("", |(directory, _)| directory);
        let mut found = BTreeSet::new();
        for base in [source_directory, ""] {
            if let Some(path) = join_normalized(base, &target) {
                self.add_with_completions(&path, &mut found);
            }
            if !found.is_empty() {
                break;
            }
        }
        if found.is_empty() {
            let segments = target
                .split('/')
                .filter(|s| !matches!(*s, "" | "." | ".."))
                .collect::<Vec<_>>();
            for start in 0..segments.len() {
                let suffix = segments[start..].join("/");
                if segments.len() - start == 1 && extension(&suffix).is_none() {
                    break;
                }
                self.add_suffix_matches(&suffix, &mut found);
                if !found.is_empty() {
                    break;
                }
            }
        }
        if found.len() > MAX_CANDIDATES {
            return Vec::new();
        }
        found.into_iter().filter(|path| path != source).collect()
    }

    fn add_with_completions(&self, path: &str, found: &mut BTreeSet<String>) {
        if self.files.contains(path) {
            found.insert(path.to_owned());
            return;
        }
        if extension(path.rsplit('/').next().unwrap_or(path)).is_some() {
            return;
        }
        for ext in &self.extensions {
            for candidate in [format!("{path}.{ext}"), format!("{path}/index.{ext}")] {
                if self.files.contains(&candidate) {
                    found.insert(candidate);
                }
            }
        }
    }

    fn add_suffix_matches(&self, suffix: &str, found: &mut BTreeSet<String>) {
        let last = suffix.rsplit('/').next().unwrap_or(suffix);
        let mut candidates: Vec<(String, String)> = Vec::new();
        if extension(last).is_some() {
            candidates.push((last.to_owned(), suffix.to_owned()));
        } else {
            for ext in &self.extensions {
                candidates.push((format!("{last}.{ext}"), format!("{suffix}.{ext}")));
                let directory_suffix = format!("{suffix}/index.{ext}");
                candidates.push((format!("index.{ext}"), directory_suffix));
            }
        }
        for (name, wanted) in candidates {
            for path in self.by_name.get(&name).into_iter().flatten() {
                if path == &wanted || path.ends_with(&format!("/{wanted}")) {
                    found.insert(path.clone());
                }
            }
        }
    }
}

/// Reduces a source literal to a project-style path, or `None` when it cannot
/// denote a local file (URL, template, prose, bare package name, asset).
fn normalize_literal(literal: &str) -> Option<String> {
    let literal = literal.trim();
    if literal.is_empty()
        || literal.chars().count() > MAX_LITERAL_CHARS
        || literal.starts_with("//")
        || literal.starts_with('#')
        || literal.contains("://")
        || literal.starts_with("data:")
        || literal.starts_with("mailto:")
        || literal.starts_with("tel:")
        || literal.contains(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '$' | '{' | '}' | '\\' | '*' | '<' | '>' | '|' | '(' | ')'
                )
        })
    {
        return None;
    }
    let literal = literal.split(['?', '#']).next()?;
    let relative = literal.starts_with("./") || literal.starts_with("../");
    let path = if relative {
        literal
    } else {
        literal.trim_start_matches(['@', '~', '#', '$', '/'])
    };
    if path.is_empty() || !path.chars().any(char::is_alphanumeric) {
        return None;
    }
    let last = path.rsplit('/').next().unwrap_or(path);
    if !path.contains('/') && extension(last).is_none() {
        return None;
    }
    if extension(last)
        .is_some_and(|ext| ASSET_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
    {
        return None;
    }
    Some(path.to_owned())
}

fn join_normalized(base: &str, relative: &str) -> Option<String> {
    let mut parts = base
        .split('/')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

/// How a literal is used at its call site. This only labels a lead; it never
/// decides anything. The order is display priority.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReferenceKind {
    Request,
    Include,
    Path,
}

impl ReferenceKind {
    fn label(self) -> &'static str {
        match self {
            Self::Request => "request/submit target",
            Self::Include => "import",
            Self::Path => "path literal",
        }
    }
}

fn reference_kind(prefix: &str) -> ReferenceKind {
    let prefix = prefix.to_lowercase();
    if [
        "fetch(",
        "axios",
        ".open(",
        "ajax",
        "action=",
        "action =",
        "sendbeacon",
        "websocket(",
        "eventsource(",
        "xmlhttprequest",
    ]
    .iter()
    .any(|marker| prefix.contains(marker))
    {
        ReferenceKind::Request
    } else if ["import", "from ", "require", "include"]
        .iter()
        .any(|marker| prefix.contains(marker))
    {
        ReferenceKind::Include
    } else {
        ReferenceKind::Path
    }
}

/// Quoted string literals with the kind of their call site. Line-local, so a
/// stray apostrophe cannot swallow the rest of a file.
fn extract_references(content: &str) -> Vec<(String, ReferenceKind)> {
    let mut found = Vec::new();
    let bounded = content
        .chars()
        .take(MAX_SCANNED_CONTENT_CHARS)
        .collect::<String>();
    for line in bounded.lines() {
        if line.chars().count() > MAX_SCANNED_LINE_CHARS {
            continue;
        }
        let chars = line.char_indices().collect::<Vec<_>>();
        let mut index = 0;
        while index < chars.len() {
            let (start, quote) = chars[index];
            index += 1;
            if !matches!(quote, '\'' | '"' | '`') {
                continue;
            }
            let mut end = None;
            let mut cursor = index;
            while cursor < chars.len() {
                match chars[cursor].1 {
                    '\\' => cursor += 2,
                    c if c == quote => {
                        end = Some(cursor);
                        break;
                    }
                    _ => cursor += 1,
                }
            }
            let Some(end) = end else {
                continue;
            };
            let literal = &line[start + 1..chars[end].0];
            let prefix_start = line[..start]
                .char_indices()
                .rev()
                .nth(40)
                .map_or(0, |(position, _)| position);
            found.push((
                literal.to_owned(),
                reference_kind(&line[prefix_start..start]),
            ));
            index = end + 1;
            if found.len() >= MAX_REFERENCES_PER_SOURCE {
                return found;
            }
        }
    }
    found
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadSource {
    pub path: String,
    pub observation: String,
    pub complete: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListedDirectory {
    pub path: String,
    pub complete: bool,
    /// Entries with no recorded read or listing at or beneath them; directories
    /// carry a trailing slash.
    pub unopened: Vec<String>,
    /// Provider turn in which the directory was last listed.
    pub turn: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailedOperation {
    pub tool: String,
    pub target: String,
    pub observation: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandRun {
    pub command: String,
    pub outcome: String,
    pub observation: String,
}

/// An existing local file referenced by a source that was read, but never
/// opened itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lead {
    pub target: String,
    pub kind: ReferenceKind,
    /// Referencing sources, most recently read first.
    pub from: Vec<String>,
    pub literal: String,
    /// Read order of the most recently read referencing source.
    pub recency: usize,
    /// Provider turn in which the most recent referencing source was read.
    pub turn: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ledger {
    pub read: Vec<ReadSource>,
    pub listed: Vec<ListedDirectory>,
    pub failed: Vec<FailedOperation>,
    pub commands: Vec<CommandRun>,
    pub leads: Vec<Lead>,
    /// Number of provider turns that issued tool calls.
    pub turn: usize,
}

fn project_relative(root: &Path, raw: &str) -> Option<String> {
    let path = Path::new(raw);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    let relative = normalized.strip_prefix(root).ok()?;
    Some(relative.to_string_lossy().replace('\\', "/"))
}

fn short(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = flat.chars().take(max).collect::<String>();
    if out.chars().count() < flat.chars().count() {
        out.push('…');
    }
    out
}

fn tool_calls(entries: &[Entry]) -> HashMap<String, (String, Value)> {
    let mut calls = HashMap::new();
    for entry in entries {
        let Entry::Message(message) = entry else {
            continue;
        };
        for call in message
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(id), Some(name)) = (
                call.get("id").and_then(Value::as_str),
                call.pointer("/function/name").and_then(Value::as_str),
            ) else {
                continue;
            };
            let arguments = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .unwrap_or(Value::Null);
            calls.insert(id.to_owned(), (name.to_owned(), arguments));
        }
    }
    calls
}

impl Ledger {
    pub fn build(transcript: &Transcript, root: &Path, index: &ProjectIndex) -> Self {
        // Observations persist for the whole conversation lineage, and an
        // unchanged re-read of any of them is redirected rather than repeated,
        // so the inventory spans the lineage rather than the latest request.
        let entries = transcript.entries();
        let calls = tool_calls(entries);

        let mut ledger = Self::default();
        let mut touched: BTreeSet<String> = BTreeSet::new();
        let mut listings: Vec<(String, bool, Vec<String>, usize)> = Vec::new();
        let mut bodies: Vec<(String, String, usize)> = Vec::new();
        let mut turn = 0_usize;

        for entry in entries {
            let Entry::Message(message) = entry else {
                continue;
            };
            if message.get("role").and_then(Value::as_str) == Some("assistant")
                && message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .is_some_and(|calls| !calls.is_empty())
            {
                turn += 1;
            }
            if message.get("role").and_then(Value::as_str) != Some("tool")
                || message.get("_result_policy").is_some()
            {
                continue;
            }
            let Some(call_id) = message.get("tool_call_id").and_then(Value::as_str) else {
                continue;
            };
            let Some((name, arguments)) = calls.get(call_id) else {
                continue;
            };
            let observation = message
                .get("_observation_id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            let body: Value = serde_json::from_str(content).unwrap_or(Value::Null);
            let error = body.get("error").and_then(Value::as_str);
            match name.as_str() {
                "read_file" | "list_directory" => {
                    let raw = arguments.get("path").and_then(Value::as_str).unwrap_or(".");
                    let Some(path) = project_relative(root, raw) else {
                        continue;
                    };
                    if observation.is_none() {
                        // A rejected duplicate read creates no observation and
                        // is not a new fact about the project.
                        continue;
                    }
                    touched.insert(path.clone());
                    if let Some(error) = error {
                        ledger.failed.push(FailedOperation {
                            tool: name.clone(),
                            target: path,
                            observation,
                            reason: short(error, 90),
                        });
                    } else if name == "list_directory" {
                        let names = body
                            .get("entries")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(|n| n.trim_end_matches('/').to_owned())
                            .collect::<Vec<_>>();
                        let complete = body
                            .get("complete")
                            .and_then(Value::as_bool)
                            .unwrap_or(true);
                        listings.push((path, complete, names, turn));
                    } else {
                        let truncated = body
                            .get("truncated")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let targeted = body
                            .get("targeted")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let offset = body
                            .get("offset_chars")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let complete = !truncated && !targeted && offset == 0;
                        let observation = observation.unwrap_or_default();
                        match ledger.read.iter_mut().find(|r| r.path == path) {
                            Some(existing) => {
                                if complete && !existing.complete {
                                    existing.complete = true;
                                    existing.observation = observation;
                                }
                            }
                            None => ledger.read.push(ReadSource {
                                path: path.clone(),
                                observation,
                                complete,
                            }),
                        }
                        if let Some(text) = body.get("content").and_then(Value::as_str) {
                            bodies.push((path, text.to_owned(), turn));
                        }
                    }
                }
                "write_file" | "create_file" | "delete_file" | "apply_patch" | "replace_text" => {
                    // Files the run itself wrote are not unexplored code.
                    let mut written = Vec::new();
                    if let Some(path) = arguments.get("path").and_then(Value::as_str) {
                        written.push(path.to_owned());
                    }
                    if let Some(patch) = arguments.get("patch").and_then(Value::as_str) {
                        written.extend(patch.lines().filter_map(|line| {
                            ["*** Add File: ", "*** Update File: ", "*** Delete File: "]
                                .iter()
                                .find_map(|marker| line.strip_prefix(marker))
                                .map(|path| path.trim().to_owned())
                        }));
                    }
                    touched.extend(
                        written
                            .iter()
                            .filter_map(|path| project_relative(root, path)),
                    );
                }
                "run_terminal" => {
                    let Some(observation) = observation else {
                        continue;
                    };
                    let command = arguments
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let outcome = if let Some(error) = error {
                        match body.get("execution") {
                            Some(_) => "failed".to_owned(),
                            None => short(error, 60),
                        }
                    } else {
                        let code = body.get("exit_code").and_then(Value::as_i64);
                        let stdout = body.get("stdout").and_then(Value::as_str).unwrap_or("");
                        let lines = stdout.lines().filter(|l| !l.trim().is_empty()).count();
                        let code = code.map_or("unknown".to_owned(), |c| c.to_string());
                        if lines == 0 {
                            format!("exit {code}, no output")
                        } else {
                            format!("exit {code}, {lines} output lines")
                        }
                    };
                    ledger.commands.push(CommandRun {
                        command: short(command, 100),
                        outcome,
                        observation,
                    });
                }
                _ => {}
            }
        }

        ledger
            .failed
            .retain(|failure| !ledger.read.iter().any(|read| read.path == failure.target));

        for (directory, complete, names, listed_turn) in listings.iter().rev() {
            if ledger.listed.iter().any(|listed| &listed.path == directory) {
                continue;
            }
            let mut unopened = Vec::new();
            for name in names {
                let child = if directory.is_empty() {
                    name.clone()
                } else {
                    format!("{directory}/{name}")
                };
                let is_directory = root.join(&child).is_dir();
                if (is_directory && ignored_directory(name)) || (!is_directory && noise_file(name))
                {
                    continue;
                }
                let prefix = format!("{child}/");
                if touched
                    .iter()
                    .any(|path| path == &child || path.starts_with(&prefix))
                {
                    continue;
                }
                unopened.push((is_directory, name.clone()));
            }
            unopened.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            ledger.listed.push(ListedDirectory {
                path: directory.clone(),
                complete: *complete,
                unopened: unopened
                    .into_iter()
                    .map(|(is_directory, name)| {
                        if is_directory {
                            format!("{name}/")
                        } else {
                            name
                        }
                    })
                    .collect(),
                turn: *listed_turn,
            });
        }
        // Most recent listing first.
        ledger.listed.retain(|listed| !listed.unopened.is_empty());

        let mut leads: BTreeMap<String, Lead> = BTreeMap::new();
        for (order, (source, content, read_turn)) in bodies.iter().enumerate() {
            for (literal, kind) in extract_references(content) {
                for target in index.resolve(source, &literal) {
                    if touched.contains(&target)
                        || extension(target.rsplit('/').next().unwrap_or(&target))
                            .is_some_and(|ext| STYLE_EXTENSIONS.contains(&ext))
                    {
                        continue;
                    }
                    let lead = leads.entry(target.clone()).or_insert_with(|| Lead {
                        target: target.clone(),
                        kind,
                        from: Vec::new(),
                        literal: literal.clone(),
                        recency: order,
                        turn: *read_turn,
                    });
                    if kind < lead.kind {
                        lead.kind = kind;
                        lead.literal = literal.clone();
                    }
                    lead.recency = order;
                    lead.turn = *read_turn;
                    lead.from.retain(|existing| existing != source);
                    lead.from.insert(0, source.clone());
                    lead.from.truncate(3);
                }
            }
        }
        let mut leads = leads.into_values().collect::<Vec<_>>();
        leads.sort_by(|a, b| {
            a.kind
                .cmp(&b.kind)
                .then_with(|| b.recency.cmp(&a.recency))
                .then_with(|| a.target.cmp(&b.target))
        });
        ledger.leads = leads;
        ledger.turn = turn;
        ledger
    }

    /// Unopened local files that sources actually request or submit to. They
    /// are the strongest structural sign that behavior crosses a file boundary.
    pub fn unopened_requests(&self) -> Vec<&Lead> {
        self.leads
            .iter()
            .filter(|lead| lead.kind == ReferenceKind::Request)
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.read.is_empty()
            && self.listed.is_empty()
            && self.failed.is_empty()
            && self.commands.is_empty()
    }

    /// Non-request leads grouped by the source that references them, so a
    /// source's whole unread neighbourhood reads as one line and the target
    /// names stay visible for the model to judge relevance itself.
    fn reference_groups(&self, budget: usize) -> Vec<String> {
        let mut groups: Vec<(&str, usize, Vec<&Lead>)> = Vec::new();
        for lead in self.leads.iter().filter(|l| {
            l.kind != ReferenceKind::Request && self.turn.saturating_sub(l.turn) < WORKING_SET_TURNS
        }) {
            let source = lead.from[0].as_str();
            match groups.iter_mut().find(|g| g.0 == source) {
                Some(group) => group.2.push(lead),
                None => groups.push((source, lead.recency, vec![lead])),
            }
        }
        groups.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        let mut lines = Vec::new();
        let mut used = 0;
        for (index, (source, _, leads)) in groups.iter().enumerate() {
            let directory = source.rsplit_once('/').map_or("", |(d, _)| d);
            let mut names = leads
                .iter()
                .map(|lead| {
                    lead.target
                        .strip_prefix(&format!("{directory}/"))
                        .filter(|_| !directory.is_empty())
                        .unwrap_or(&lead.target)
                        .to_owned()
                })
                .collect::<Vec<_>>();
            names.sort();
            let shown = names.iter().take(4).cloned().collect::<Vec<_>>();
            let more = names.len() - shown.len();
            let line = format!(
                "- {source} -> {}{}",
                shown.join(", "),
                if more > 0 {
                    format!(" (+{more} more)")
                } else {
                    String::new()
                }
            );
            if used + line.len() + 1 > budget {
                let remaining = groups.len() - index;
                lines.push(format!("- (+{remaining} more referencing sources)"));
                break;
            }
            used += line.len() + 1;
            lines.push(line);
        }
        lines
    }

    pub fn render(&self, max_chars: usize) -> String {
        self.render_for(max_chars, true)
    }

    /// `recoverable` states whether `observation_read` is offered this turn.
    pub fn render_for(&self, max_chars: usize, recoverable: bool) -> String {
        if self.is_empty() {
            return String::new();
        }
        let mut sections: Vec<(String, Vec<String>)> = Vec::new();
        let requests = self.unopened_requests();
        if !requests.is_empty() {
            sections.push((
                "Local files that sources you read request or submit to, not opened yet:".into(),
                requests
                    .iter()
                    .take(5)
                    .map(|lead| {
                        format!(
                            "- {} <- {} '{}' in {}",
                            lead.target,
                            lead.kind.label(),
                            short(&lead.literal, 60),
                            lead.from[0]
                        )
                    })
                    .collect(),
            ));
        }
        let references = self.reference_groups(max_chars / 3);
        if !references.is_empty() {
            sections.push((
                "Local files referenced by the sources you read most recently, not opened yet:"
                    .into(),
                references,
            ));
        }
        let recent_listings = self
            .listed
            .iter()
            .filter(|listed| self.turn.saturating_sub(listed.turn) < WORKING_SET_TURNS)
            .collect::<Vec<_>>();
        if !recent_listings.is_empty() {
            sections.push((
                "Recently listed directories with entries not opened yet:".into(),
                recent_listings
                    .iter()
                    .take(5)
                    .map(|listed| {
                        let shown = listed.unopened.iter().take(8).cloned().collect::<Vec<_>>();
                        let more = listed.unopened.len().saturating_sub(shown.len());
                        format!(
                            "- {}/{}: {}{}",
                            listed.path,
                            if listed.complete {
                                ""
                            } else {
                                " (partial listing)"
                            },
                            shown.join(", "),
                            if more > 0 {
                                format!(" (+{more} more)")
                            } else {
                                String::new()
                            }
                        )
                    })
                    .collect(),
            ));
        }
        if !self.failed.is_empty() {
            sections.push((
                "Failed operations:".into(),
                self.failed
                    .iter()
                    .rev()
                    .take(3)
                    .map(|failure| {
                        format!(
                            "- {} {}: {}{}",
                            failure.tool,
                            failure.target,
                            failure.reason,
                            failure
                                .observation
                                .as_ref()
                                .map_or(String::new(), |id| format!(" [{id}]"))
                        )
                    })
                    .collect(),
            ));
        }
        if !self.commands.is_empty() {
            sections.push((
                "Commands run:".into(),
                self.commands
                    .iter()
                    .rev()
                    .take(3)
                    .map(|run| {
                        format!(
                            "- `{}` -> {} [{}]",
                            run.command, run.outcome, run.observation
                        )
                    })
                    .collect(),
            ));
        }
        let header = format!(
            "<investigation_state>\nMechanical inventory of this conversation's tool observations. It is not a plan, a judgement of relevance, or evidence that anything unopened matters.{}",
            if recoverable { " Recover an exact body with observation_read(id)." } else { "" }
        );
        let footer = "</investigation_state>";
        let mut used = header.len() + footer.len() + 2;
        let mut lines = Vec::new();
        for (title, items) in sections {
            let mut block = vec![title];
            block.extend(items);
            let text = block.join("\n");
            if used + text.len() + 1 > max_chars {
                continue;
            }
            used += text.len() + 1;
            lines.push(text);
        }
        if !self.read.is_empty() {
            let budget = max_chars.saturating_sub(used).max(200);
            let mut shown: Vec<String> = Vec::new();
            let mut size = 40;
            for read in self.read.iter().rev() {
                let item = format!(
                    "{}[{}{}]",
                    read.path,
                    read.observation,
                    if read.complete { "" } else { ", partial" }
                );
                if size + item.len() + 2 > budget {
                    break;
                }
                size += item.len() + 2;
                shown.push(item);
            }
            shown.reverse();
            let earlier = self.read.len() - shown.len();
            lines.push(format!(
                "Files read ({}){}: {}",
                self.read.len(),
                if earlier > 0 {
                    format!(", {earlier} earlier omitted (observation_index lists all)")
                } else {
                    String::new()
                },
                shown.join(", ")
            ));
        }
        format!("{header}\n{}\n{footer}", lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::transcript::ValidatedCall;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn index(paths: &[&str]) -> ProjectIndex {
        ProjectIndex::from_paths(paths.iter().map(|p| (*p).to_owned()).collect())
    }

    #[test]
    fn literals_resolve_structurally_and_ambiguity_resolves_to_nothing() {
        let index = index(&[
            "public/api.php",
            "src/Module/Home/Home.tsx",
            "src/Module/Home/Widgets/Purchase/Section.tsx",
            "src/Shared/Hooks/useLang.ts",
            "src/a/index.js",
            "src/b/index.js",
            "src/c/index.js",
            "src/d/index.js",
        ]);
        // bare file served from a sub-folder
        assert_eq!(index.resolve("src/Form.tsx", "api.php"), ["public/api.php"]);
        // import alias plus extension completion
        assert_eq!(
            index.resolve(
                "src/Module/Home/Home.tsx",
                "@/Module/Home/Widgets/Purchase/Section"
            ),
            ["src/Module/Home/Widgets/Purchase/Section.tsx"]
        );
        // relative to the referencing file
        assert_eq!(
            index.resolve("src/Module/Home/Home.tsx", "./Widgets/Purchase/Section.tsx"),
            ["src/Module/Home/Widgets/Purchase/Section.tsx"]
        );
        assert_eq!(
            index.resolve("src/Module/Home/Home.tsx", "../../Shared/Hooks/useLang"),
            ["src/Shared/Hooks/useLang.ts"]
        );
        // not local files
        for literal in [
            "https://example.com/api.php",
            "//cdn.example.com/x.js",
            "react",
            "api.php?x=1&y=2 and prose",
            "`${base}/api.php`",
            "./missing.ts",
            "logo.png",
        ] {
            assert!(index.resolve("src/x.ts", literal).is_empty(), "{literal}");
        }
        // too ambiguous to be a useful lead
        assert!(index.resolve("src/x.ts", "index.js").is_empty());
    }

    #[test]
    fn references_are_labelled_by_call_site_without_deciding_anything() {
        let found = extract_references(
            "import Form from \"@/Form\";\nawait fetch('api.php', {method:'POST'});\nconst x = `./data.json`;\nconst t = \"don't\"; // it's fine",
        );
        let kinds = found
            .iter()
            .map(|(literal, kind)| (literal.as_str(), *kind))
            .collect::<Vec<_>>();
        assert!(kinds.contains(&("@/Form", ReferenceKind::Include)));
        assert!(kinds.contains(&("api.php", ReferenceKind::Request)));
        assert!(kinds.contains(&("./data.json", ReferenceKind::Path)));
    }

    struct Fixture {
        root: PathBuf,
        transcript: Transcript,
        calls: usize,
    }

    impl Fixture {
        fn new(files: &[(&str, &str)]) -> Self {
            let base = std::env::temp_dir().join(format!(
                "ledger-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let root = base.join("project");
            for (path, content) in files {
                let full = root.join(path);
                fs::create_dir_all(full.parent().unwrap()).unwrap();
                fs::write(full, content).unwrap();
            }
            let root = root.canonicalize().unwrap();
            let mut transcript =
                Transcript::durable(&base.join("evidence"), "run", &[], root.to_str()).unwrap();
            transcript.push_run_user(json!({"role":"user","content":"audit"}));
            Self {
                root,
                transcript,
                calls: 0,
            }
        }

        fn call(&mut self, name: &str, arguments: Value) -> Value {
            self.calls += 1;
            let id = format!("call-{}", self.calls);
            let result = crate::tools::filesystem::execute(&self.root, name, &arguments)
                .map_or_else(|error| json!({"error": error}), |(value, _)| value);
            self.transcript.assistant_tool_turn(
                String::new(),
                &[ValidatedCall {
                    id: id.clone(),
                    name: name.into(),
                    arguments,
                }],
            );
            self.transcript.tool_result(&id, name, result.to_string());
            result
        }

        fn ledger(&self) -> Ledger {
            Ledger::build(
                &self.transcript,
                &self.root,
                &ProjectIndex::scan(&self.root),
            )
        }
    }

    const PROJECT: &[(&str, &str)] = &[
        ("package.json", "{\"name\":\"shop\"}"),
        (
            "src/Home.tsx",
            "import Form from './Widgets/Form.tsx';\nexport default () => Form;",
        ),
        (
            "src/Widgets/Form.tsx",
            "export default async () => { await fetch('api.php', { method: 'POST' }); };",
        ),
        ("src/Widgets/Other.tsx", "export const other = 1;"),
        ("public/api.php", "<?php echo 'ok';"),
        ("node_modules/pkg/index.js", "x"),
    ];

    #[test]
    fn unopened_leads_follow_actual_reads_and_close_when_opened() {
        let mut f = Fixture::new(PROJECT);
        f.call("list_directory", json!({"path": "."}));
        f.call("read_file", json!({"path": "src/Home.tsx"}));
        let ledger = f.ledger();
        assert_eq!(ledger.read.len(), 1);
        assert!(ledger.read[0].complete);
        assert_eq!(ledger.leads.len(), 1);
        assert_eq!(ledger.leads[0].target, "src/Widgets/Form.tsx");
        assert!(ledger.unopened_requests().is_empty());
        // dependency directories are not offered as unopened entries
        let root_listing = ledger.listed.iter().find(|l| l.path.is_empty()).unwrap();
        assert!(root_listing.unopened.contains(&"public/".to_owned()));
        assert!(!root_listing
            .unopened
            .iter()
            .any(|e| e.starts_with("node_modules")));
        assert!(
            !root_listing.unopened.contains(&"src/".to_owned()),
            "src was entered via a read"
        );

        f.call("read_file", json!({"path": "src/Widgets/Form.tsx"}));
        let ledger = f.ledger();
        assert_eq!(ledger.unopened_requests().len(), 1);
        assert_eq!(ledger.unopened_requests()[0].target, "public/api.php");
        let rendered = ledger.render(3_000);
        assert!(rendered.contains("public/api.php <- request/submit target 'api.php'"));

        f.call("read_file", json!({"path": "public/api.php"}));
        let ledger = f.ledger();
        assert!(ledger.unopened_requests().is_empty());
        assert!(!ledger.render(3_000).contains("public/api.php <-"));
    }

    #[test]
    fn an_unrelated_observation_never_closes_a_lead_or_marks_a_directory_opened() {
        let mut f = Fixture::new(PROJECT);
        f.call("read_file", json!({"path": "src/Widgets/Form.tsx"}));
        f.call("read_file", json!({"path": "src/Widgets/Other.tsx"}));
        f.call("read_file", json!({"path": "package.json"}));
        let ledger = f.ledger();
        assert_eq!(ledger.unopened_requests()[0].target, "public/api.php");
    }

    #[test]
    fn partial_reads_failures_and_commands_are_reported_honestly() {
        let mut f = Fixture::new(PROJECT);
        f.call(
            "read_file",
            json!({"path": "src/Home.tsx", "start_line": 1, "end_line": 1}),
        );
        f.call("read_file", json!({"path": "src/Missing.tsx"}));
        let ledger = f.ledger();
        assert!(!ledger.read[0].complete);
        assert_eq!(ledger.failed.len(), 1);
        assert_eq!(ledger.failed[0].target, "src/Missing.tsx");
        let rendered = ledger.render(3_000);
        assert!(rendered.contains("src/Home.tsx[obs-00000001, partial]"));
        assert!(rendered.contains("Failed operations"));
        // a later complete read supersedes both the partial state and a failure
        f.call("read_file", json!({"path": "src/Home.tsx"}));
        let ledger = f.ledger();
        assert!(ledger.read[0].complete);
        assert_eq!(ledger.read[0].observation, "obs-00000003");
    }

    #[test]
    fn rendering_is_bounded_and_prefers_actionable_facts_over_the_read_inventory() {
        let mut files = (0..120)
            .map(|i| {
                (
                    format!("src/m{i}/file{i}.ts"),
                    format!("export const v{i} = {i};"),
                )
            })
            .collect::<Vec<_>>();
        files.push(("src/Widgets/Form.tsx".into(), "fetch('api.php')".into()));
        files.push(("public/api.php".into(), "<?php".into()));
        let refs = files
            .iter()
            .map(|(p, c)| (p.as_str(), c.as_str()))
            .collect::<Vec<_>>();
        let mut f = Fixture::new(&refs);
        for i in 0..120 {
            f.call("read_file", json!({"path": format!("src/m{i}/file{i}.ts")}));
        }
        f.call("read_file", json!({"path": "src/Widgets/Form.tsx"}));
        let ledger = f.ledger();
        let rendered = ledger.render(1_500);
        assert!(rendered.len() <= 1_700, "{} chars", rendered.len());
        assert!(rendered.contains("public/api.php"));
        assert!(rendered.contains("earlier omitted"));
        assert!(rendered.contains("src/Widgets/Form.tsx[obs-00000121]"));
        assert!(Ledger::default().render(1_500).is_empty());
    }
    /// Failure shape: files the run itself wrote were offered back as
    /// "unopened" leads, and reads from an earlier request of the same
    /// conversation (whose unchanged re-reads are redirected) never counted.
    #[test]
    fn authored_files_and_earlier_requests_count_as_opened() {
        let mut f = Fixture::new(&[(
            "src/Form.tsx",
            "export const send = () => fetch('api.php', { method: 'POST' });",
        )]);
        f.call("read_file", json!({"path": "src/Form.tsx"}));
        assert_eq!(
            f.ledger().unopened_requests().len(),
            0,
            "target does not exist yet"
        );
        std::fs::create_dir_all(f.root.join("public")).unwrap();
        std::fs::write(f.root.join("public/api.php"), "<?php").unwrap();
        // the run wrote the file through a mutation tool
        f.transcript.assistant_tool_turn(
            String::new(),
            &[ValidatedCall {
                id: "write".into(),
                name: "write_file".into(),
                arguments: json!({"path": "public/api.php", "content": "<?php"}),
            }],
        );
        f.transcript
            .tool_result("write", "write_file", json!({"ok": true}).to_string());
        assert!(f.ledger().unopened_requests().is_empty());

        // a later user request keeps the earlier observations in the inventory
        f.transcript
            .push_run_user(json!({"role":"user","content":"follow-up"}));
        let ledger = f.ledger();
        assert_eq!(ledger.read.len(), 1);
        assert_eq!(ledger.read[0].path, "src/Form.tsx");
    }

    #[test]
    fn patches_mark_every_touched_path_as_authored() {
        let mut f = Fixture::new(PROJECT);
        f.call("read_file", json!({"path": "src/Widgets/Form.tsx"}));
        assert_eq!(f.ledger().unopened_requests().len(), 1);
        f.transcript.assistant_tool_turn(
            String::new(),
            &[ValidatedCall {
                id: "patch".into(),
                name: "apply_patch".into(),
                arguments: json!({"patch": "*** Begin Patch\n*** Update File: public/api.php\n@@\n-a\n+b\n*** End Patch"}),
            }],
        );
        f.transcript
            .tool_result("patch", "apply_patch", json!({"ok": true}).to_string());
        assert!(f.ledger().unopened_requests().is_empty());
    }

    #[test]
    fn the_recovery_hint_is_only_shown_while_recovery_is_available() {
        let mut f = Fixture::new(PROJECT);
        f.call("read_file", json!({"path": "package.json"}));
        let ledger = f.ledger();
        assert!(ledger.render_for(3_000, true).contains("observation_read"));
        assert!(!ledger.render_for(3_000, false).contains("observation_read"));
    }
    /// Failure shape: a permanent list of every unopened import and directory
    /// entry reads as a task list and pushes breadth-first crawling. Only the
    /// neighbourhood of recent reads stays visible; request targets persist.
    #[test]
    fn unopened_neighbourhoods_fade_but_request_targets_persist() {
        let mut files = vec![
            (
                "src/Home.tsx".to_owned(),
                "import Form from './Widgets/Form.tsx';".to_owned(),
            ),
            (
                "src/Widgets/Form.tsx".to_owned(),
                "export const x = 1;".to_owned(),
            ),
            (
                "src/Widgets/Send.tsx".to_owned(),
                "fetch('api.php');".to_owned(),
            ),
            ("public/api.php".to_owned(), "<?php".to_owned()),
        ];
        for i in 0..5 {
            files.push((
                format!("src/misc/m{i}.ts"),
                format!("export const m{i} = {i};"),
            ));
        }
        let refs = files
            .iter()
            .map(|(p, c)| (p.as_str(), c.as_str()))
            .collect::<Vec<_>>();
        let mut f = Fixture::new(&refs);
        f.call("list_directory", json!({"path": "src/Widgets"}));
        f.call("read_file", json!({"path": "src/Home.tsx"}));
        f.call("read_file", json!({"path": "src/Widgets/Send.tsx"}));
        let fresh = f.ledger().render(4_000);
        assert!(
            fresh.contains("src/Home.tsx -> Widgets/Form.tsx"),
            "{fresh}"
        );
        assert!(fresh.contains("Recently listed directories"), "{fresh}");
        assert!(fresh.contains("public/api.php <- request/submit target"));

        for i in 0..4 {
            f.call("read_file", json!({"path": format!("src/misc/m{i}.ts")}));
        }
        let ledger = f.ledger();
        let later = ledger.render(4_000);
        assert!(!later.contains("Widgets/Form.tsx"), "faded: {later}");
        assert!(
            !later.contains("Recently listed directories"),
            "faded: {later}"
        );
        assert!(
            later.contains("public/api.php <- request/submit target"),
            "persists: {later}"
        );
        // nothing is lost: the facts remain derivable, and opening closes them
        assert!(ledger
            .leads
            .iter()
            .any(|l| l.target == "src/Widgets/Form.tsx"));
        assert!(ledger.read.len() >= 6);
    }
}
