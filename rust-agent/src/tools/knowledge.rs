//! Project-local `.ai-framework` knowledge cache.
//!
//! This is an external, model-neutral semantic cache. It is deliberately not
//! part of the canonical transcript or the GoalPlan: source remains the
//! authority and cache writes are always optional.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DIRECTORY: &str = ".ai-framework";
const MANIFEST: &str = "manifest.json";
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_READ_BYTES: usize = 48 * 1024;
const MAX_FILE_CHARS: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    #[serde(default)]
    revision: u64,
    project: Project,
    project_knowledge: ProjectKnowledge,
    #[serde(default)]
    modules: BTreeMap<String, String>,
    #[serde(default)]
    sources: BTreeMap<String, SourceEntry>,
    #[serde(default)]
    tasks: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    name: String,
    root_fingerprint: String,
    last_updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectKnowledge {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    overview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    architecture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    product: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conventions: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceEntry {
    cache: String,
    fingerprint: String,
    updated_at: String,
}

impl Manifest {
    fn fresh(root: &Path) -> Self {
        let name = root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("project")
            .to_owned();
        Self {
            version: 1,
            revision: 0,
            project: Project {
                name,
                root_fingerprint: digest(root.to_string_lossy().as_bytes()),
                last_updated_at: now(),
            },
            project_knowledge: ProjectKnowledge {
                overview: None,
                architecture: None,
                product: None,
                conventions: None,
            },
            modules: BTreeMap::new(),
            sources: BTreeMap::new(),
            tasks: BTreeMap::new(),
        }
    }
}

pub fn bootstrap(root: &Path) -> Result<(), String> {
    let root = canonical_root(root)?;
    let framework = root.join(DIRECTORY);
    fs::create_dir_all(&framework).map_err(|error| error.to_string())?;
    let manifest_path = framework.join(MANIFEST);
    if !manifest_path.exists() {
        write_manifest(&framework, &Manifest::fresh(&root))?;
    } else {
        // Invalid manifests must never terminate an Agent run. Preserve the
        // damaged file for inspection and replace only the small index.
        let _ = load_manifest(&root, true)?;
    }
    Ok(())
}

pub fn index(root: &Path) -> Result<Value, String> {
    let root = canonical_root(root)?;
    bootstrap(&root)?;
    let manifest = load_manifest(&root, true)?;
    let mut stale = 0_usize;
    let sources = manifest
        .sources
        .iter()
        .map(|(path, entry)| {
            let status = source_status(&root, path, entry);
            if status != "fresh" {
                stale = stale.saturating_add(1);
            }
            json!({"path":path,"cache":entry.cache,"fingerprint":entry.fingerprint,"updatedAt":entry.updated_at,"freshness":status})
        })
        .collect::<Vec<_>>();
    let (total_files, approximate_bytes) = directory_stats(&root.join(DIRECTORY));
    let project_knowledge = materialized_project_knowledge(&root, &manifest.project_knowledge);
    Ok(json!({
        "version": manifest.version, "revision": manifest.revision,
        "project": manifest.project,
        "projectKnowledge": project_knowledge,
        "modules": manifest.modules,
        "sources": sources,
        "tasks": manifest.tasks,
        "stats": {"exists":true,"totalFiles":total_files,"approximateBytes":approximate_bytes,"staleSourceEntries":stale}
    }))
}

pub fn read(root: &Path, args: &Value) -> Result<Value, String> {
    let root = canonical_root(root)?;
    bootstrap(&root)?;
    let paths = args
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| "project_knowledge_read requires paths".to_owned())?;
    let mut remaining = MAX_READ_BYTES;
    let mut entries = Vec::new();
    for path in paths.iter().filter_map(Value::as_str).take(12) {
        let target = cache_path(&root, path)?;
        if !target.is_file() {
            entries.push(json!({"status":"missing","path":path,"cacheRevision":manifest_revision(&root),"message":"This knowledge document has not been created yet. Do not retry alternate path spellings; continue source research and populate the cache later."}));
            continue;
        }
        let content = fs::read_to_string(&target).map_err(|error| error.to_string())?;
        let take = content.len().min(remaining);
        let mut bounded = content[..take].to_owned();
        let truncated = take < content.len();
        if truncated {
            bounded.push_str("\n[knowledge projection truncated]\n");
        }
        remaining = remaining.saturating_sub(take);
        entries.push(json!({"status":"ok","path":path,"content":bounded,"truncated":truncated,"cacheRevision":manifest_revision(&root)}));
        if remaining == 0 {
            break;
        }
    }
    Ok(json!({"entries":entries,"bounded":true}))
}

pub fn update(root: &Path, args: &Value) -> Result<Value, String> {
    let root = canonical_root(root)?;
    bootstrap(&root)?;
    let framework = root.join(DIRECTORY);
    let mut manifest = load_manifest(&root, true)?;
    let updates = args
        .get("updates")
        .and_then(Value::as_array)
        .ok_or_else(|| "project_knowledge_update requires updates".to_owned())?;
    let mut written = Vec::new();
    for update in updates.iter().take(16) {
        let path = update
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "knowledge update requires path".to_owned())?;
        validate_cache_document(path)?;
        let content = update
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| "knowledge update requires content".to_owned())?;
        let mode = update
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("merge");
        if !matches!(mode, "replace" | "merge") {
            return Err("knowledge update mode must be replace or merge".into());
        }
        let target = cache_path(&root, path)?;
        let incoming = redact(content);
        let next = if mode == "merge" && target.exists() {
            merge_markdown(
                &fs::read_to_string(&target).map_err(|error| error.to_string())?,
                &incoming,
            )
        } else {
            incoming
        };
        atomic_write(&target, &limit_chars(&next, MAX_FILE_CHARS))?;
        if let Some(module) = path
            .strip_prefix("modules/")
            .and_then(|value| value.strip_suffix(".md"))
        {
            manifest.modules.insert(module.to_owned(), path.to_owned());
        }
        match path {
            "project/overview.md" => manifest.project_knowledge.overview = Some(path.to_owned()),
            "project/architecture.md" => {
                manifest.project_knowledge.architecture = Some(path.to_owned())
            }
            "project/product.md" => manifest.project_knowledge.product = Some(path.to_owned()),
            "project/conventions.md" => {
                manifest.project_knowledge.conventions = Some(path.to_owned())
            }
            _ => {}
        }
        if let Some(task) = path
            .strip_prefix("tasks/")
            .and_then(|value| value.strip_suffix(".md"))
        {
            manifest.tasks.insert(task.to_owned(), path.to_owned());
        }
        written.push(path.to_owned());
    }
    let mut source_statuses = Vec::new();
    for source in args
        .get("source_paths")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .take(32)
    {
        validate_source_path(source)?;
        let source_path = root.join(source);
        let cache = source_cache_path(source);
        let status = if source_path.is_file() {
            let bytes = fs::read(&source_path).map_err(|error| error.to_string())?;
            let fingerprint = digest(&bytes);
            manifest.sources.insert(
                source.to_owned(),
                SourceEntry {
                    cache: cache.clone(),
                    fingerprint,
                    updated_at: now(),
                },
            );
            "fresh"
        } else {
            "missing"
        };
        source_statuses.push(json!({"path":source,"cache":cache,"freshness":status}));
    }
    if !written.is_empty() || !source_statuses.is_empty() {
        manifest.revision = manifest.revision.saturating_add(1);
    }
    manifest.project.last_updated_at = now();
    write_manifest(&framework, &manifest)?;
    Ok(
        json!({"updated":written,"sources":source_statuses,"manifestVersion":manifest.version,"cacheRevision":manifest.revision}),
    )
}

/// Small progressive-disclosure catalog for the model. It advertises only
/// available knowledge categories and paths; no document body is injected
/// automatically. Full content remains an explicit `project_knowledge_read`.
pub fn prompt_catalog(root: Option<&str>) -> String {
    let Some(root) = root else {
        return String::new();
    };
    let root = Path::new(root);
    let Ok(root) = canonical_root(root) else {
        return String::new();
    };
    if bootstrap(&root).is_err() {
        return String::new();
    }
    let Ok(manifest) = load_manifest(&root, true) else {
        return String::new();
    };
    let mut available = Vec::new();
    for (name, path) in [
        (
            "project overview",
            manifest.project_knowledge.overview.as_ref(),
        ),
        (
            "architecture",
            manifest.project_knowledge.architecture.as_ref(),
        ),
        ("product", manifest.project_knowledge.product.as_ref()),
        (
            "conventions",
            manifest.project_knowledge.conventions.as_ref(),
        ),
    ] {
        if let Some(path) = path {
            available.push(format!("- {name}: `{path}`"));
        }
    }
    let modules = manifest
        .modules
        .keys()
        .take(12)
        .cloned()
        .collect::<Vec<_>>();
    if !modules.is_empty() {
        available.push(format!("- modules: {}", modules.join(", ")));
    }
    if !manifest.tasks.is_empty() {
        available.push(format!(
            "- task notes: {}",
            manifest
                .tasks
                .values()
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let stale = manifest
        .sources
        .iter()
        .filter(|(path, entry)| source_status(&root, path, entry) != "fresh")
        .count();
    available.push(format!(
        "- cached source observations: {}{}",
        manifest.sources.len(),
        if stale > 0 {
            format!(" ({stale} stale)")
        } else {
            String::new()
        }
    ));
    format!(
        "<project_knowledge_catalog>\n{}\nUse project_knowledge_index for paths/freshness and project_knowledge_read for selected documents.\n</project_knowledge_catalog>",
        limit_chars(&available.join("\n"), 1_800)
    )
}

/// Deterministic V1 ingestion. Successful normal project inspection creates
/// materialized runtime observations even when a compaction model emits no
/// semantic update block.
pub fn observe_tool(
    root: &Path,
    run_id: &str,
    objective: &str,
    milestone: Option<&str>,
    task: Option<&str>,
    tool: &str,
    args: &Value,
    result: &Value,
) -> Result<Value, String> {
    let root = canonical_root(root)?;
    bootstrap(&root)?;
    let mut updates = Vec::new();
    let mut source_paths = Vec::new();
    match tool {
        "read_file" => {
            let path = result
                .get("path")
                .or_else(|| args.get("path"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if path.is_empty() || path.starts_with(DIRECTORY) || is_sensitive_path(path) {
                return Ok(json!({"observation":"skipped_sensitive_or_internal"}));
            }
            validate_source_path(path)?;
            let content = result
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if content.trim().is_empty() {
                return Ok(json!({"observation":"skipped_empty"}));
            }
            let cache = source_cache_path(path);
            let existing = fs::read_to_string(framework(&root).join(&cache)).unwrap_or_default();
            let coverage = match (
                args.get("start_line").and_then(Value::as_u64),
                args.get("end_line").and_then(Value::as_u64),
            ) {
                (Some(start), Some(end)) => format!("lines {start}-{end}"),
                (Some(start), None) => format!("lines {start}+"),
                _ => "full file or provider-visible full projection".into(),
            };
            let fingerprint = fs::read(root.join(path))
                .map(|bytes| digest(&bytes))
                .unwrap_or_else(|_| digest(content.as_bytes()));
            let source_doc =
                merge_source_observation(&existing, path, &fingerprint, &coverage, content);
            updates.push(json!({"path":cache,"content":source_doc,"mode":"replace"}));
            source_paths.push(path.to_owned());
            let task_doc = format!("# Objective\n{objective}\n\n# Active milestone\n{}\n\n# Active work item\n{}\n\n## Investigated sources\n- {path}\n\n## Runtime observations\n- read_file inspected `{path}`\n\n## Semantic findings\n\n## Open gaps\n", milestone.unwrap_or("not planned"), task.unwrap_or("not planned"));
            updates.push(json!({"path":format!("tasks/{}.md", safe_name(run_id)),"content":task_doc,"mode":"merge"}));
            let overview = format!("# Observed project\n\n## Sources inspected\n- {path}\n\n## Runtime-derived metadata\n- `{path}` was inspected through the project source tool.\n");
            updates.push(json!({"path":"project/overview.md","content":overview,"mode":"merge"}));
        }
        "list_directory" => {
            let entries = result
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if entries.is_empty() {
                return Ok(json!({"observation":"skipped_empty"}));
            }
            let list = entries
                .iter()
                .filter_map(Value::as_str)
                .filter(|entry| !entry.starts_with(DIRECTORY))
                .take(80)
                .map(|entry| format!("- {entry}"))
                .collect::<Vec<_>>()
                .join("\n");
            updates.push(json!({"path":"project/overview.md","content":format!("# Observed project\n\n## Known structure\n{list}\n"),"mode":"merge"}));
        }
        _ => return Ok(json!({"observation":"not_applicable"})),
    }
    if updates.is_empty() {
        return Ok(json!({"observation":"skipped"}));
    }
    let before = revision(&root);
    let result = update(
        &root,
        &json!({"updates":updates,"source_paths":source_paths}),
    )?;
    Ok(
        json!({"observation":"persisted","revisionBefore":before,"revisionAfter":revision(&root),"result":result}),
    )
}

fn bounded_projection(content: &str, max: usize) -> String {
    if content.chars().count() <= max {
        return redact(content);
    }
    let chars = content.chars().collect::<Vec<_>>();
    let head = max * 2 / 3;
    let tail = max - head;
    redact(&format!(
        "{}\n[... source observation truncated ...]\n{}",
        chars[..head].iter().collect::<String>(),
        chars[chars.len() - tail..].iter().collect::<String>()
    ))
}
fn merge_source_observation(
    existing: &str,
    path: &str,
    fingerprint: &str,
    coverage: &str,
    content: &str,
) -> String {
    let observation = format!(
        "### Observation — {coverage}\n\n{}\n",
        bounded_projection(content, 24_000)
    );
    if existing.is_empty() {
        return format!("# Source\n\nPath: {path}\n\nFingerprint: {fingerprint}\n\n## Coverage\n- {coverage}\n\n## Observed source content\n\n{observation}\n## Semantic findings\n\n## Relationships\n");
    }
    if existing.contains(&observation) {
        return existing.to_owned();
    }
    let mut next = existing.to_owned();
    if !next.contains(&format!("- {coverage}")) {
        if let Some(index) = next.find("## Observed source content") {
            next.insert_str(index, &format!("- {coverage}\n"));
        }
    }
    let insert = next.find("## Semantic findings").unwrap_or(next.len());
    next.insert_str(insert, &format!("{observation}\n"));
    next
}
fn is_sensitive_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.contains(".env")
        || lower.contains("credential")
        || lower.contains("secret")
        || lower.contains("private")
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(root).map_err(|error| error.to_string())
}

fn framework(root: &Path) -> PathBuf {
    root.join(DIRECTORY)
}

fn cache_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    validate_cache_document(relative)?;
    let target = framework(root).join(relative);
    let parent = target
        .parent()
        .ok_or_else(|| "invalid cache path".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let framework_real = fs::canonicalize(framework(root)).map_err(|error| error.to_string())?;
    let parent_real = fs::canonicalize(parent).map_err(|error| error.to_string())?;
    if !parent_real.starts_with(&framework_real) {
        return Err("knowledge path escapes .ai-framework".into());
    }
    if target.exists() {
        let target_real = fs::canonicalize(&target).map_err(|error| error.to_string())?;
        if !target_real.starts_with(&framework_real) {
            return Err("knowledge file symlink escapes .ai-framework".into());
        }
    }
    Ok(target)
}

fn validate_relative(path: &str) -> Result<(), String> {
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || path.is_empty()
        || candidate.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("path must stay inside .ai-framework".into());
    }
    Ok(())
}

fn validate_cache_document(path: &str) -> Result<(), String> {
    validate_relative(path)?;
    let allowed = path == "project/overview.md"
        || path == "project/architecture.md"
        || path == "project/product.md"
        || path == "project/conventions.md"
        || path.starts_with("modules/")
        || path.starts_with("sources/")
        || path.starts_with("tasks/");
    if !allowed || !path.ends_with(".md") {
        return Err("knowledge path must be an allowed .md document".into());
    }
    Ok(())
}

fn validate_source_path(path: &str) -> Result<(), String> {
    validate_relative(path)?;
    if path == DIRECTORY || path.starts_with(".ai-framework/") {
        return Err(".ai-framework is not project source".into());
    }
    Ok(())
}

fn source_cache_path(source: &str) -> String {
    format!("sources/{}.md", safe_name(source))
}

fn manifest_revision(root: &Path) -> u64 {
    load_manifest(root, true)
        .map(|manifest| manifest.revision)
        .unwrap_or(0)
}

pub fn revision(root: &Path) -> u64 {
    canonical_root(root)
        .ok()
        .map_or(0, |root| manifest_revision(&root))
}

fn materialized_project_knowledge(root: &Path, knowledge: &ProjectKnowledge) -> Value {
    let mut map = serde_json::Map::new();
    for (slot, path) in [
        ("overview", &knowledge.overview),
        ("architecture", &knowledge.architecture),
        ("product", &knowledge.product),
        ("conventions", &knowledge.conventions),
    ] {
        if let Some(path) = path
            .as_ref()
            .filter(|path| root.join(DIRECTORY).join(path).is_file())
        {
            map.insert(slot.into(), json!(path));
        }
    }
    Value::Object(map)
}

fn safe_name(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn load_manifest(root: &Path, recover: bool) -> Result<Manifest, String> {
    let path = framework(root).join(MANIFEST);
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    if bytes.len() <= MAX_MANIFEST_BYTES {
        if let Ok(manifest) = serde_json::from_slice::<Manifest>(&bytes) {
            return Ok(manifest);
        }
    }
    if !recover {
        return Err("invalid .ai-framework manifest".into());
    }
    let backup = framework(root).join(format!("manifest.corrupt-{}.json", now_compact()));
    let _ = fs::rename(&path, backup);
    let manifest = Manifest::fresh(root);
    write_manifest(&framework(root), &manifest)?;
    Ok(manifest)
}

fn write_manifest(framework: &Path, manifest: &Manifest) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?;
    if text.len() > MAX_MANIFEST_BYTES {
        return Err("knowledge manifest exceeded its bounded size".into());
    }
    atomic_write(&framework.join(MANIFEST), &String::from_utf8_lossy(&text))
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid write path".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("knowledge"),
        now_compact()
    ));
    fs::write(&temp, content).map_err(|error| error.to_string())?;
    fs::rename(&temp, path).map_err(|error| error.to_string())
}

fn source_status(root: &Path, source: &str, entry: &SourceEntry) -> &'static str {
    let path = root.join(source);
    if !path.is_file() {
        return "missing";
    }
    match fs::read(path) {
        Ok(bytes) if digest(&bytes) == entry.fingerprint => "fresh",
        Ok(_) => "stale",
        Err(_) => "unknown",
    }
}

fn directory_stats(path: &Path) -> (usize, u64) {
    let mut files = 0;
    let mut bytes = 0;
    let Ok(entries) = fs::read_dir(path) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_file() {
            files += 1;
            bytes += meta.len();
        } else if meta.is_dir() {
            let (child_files, child_bytes) = directory_stats(&entry.path());
            files += child_files;
            bytes += child_bytes;
        }
    }
    (files, bytes)
}

fn merge_markdown(existing: &str, incoming: &str) -> String {
    let mut seen = std::collections::BTreeSet::new();
    let mut lines = Vec::new();
    for line in existing.lines().chain(incoming.lines()) {
        let key = line.trim();
        if key.is_empty() || seen.insert(key.to_owned()) {
            lines.push(line);
        }
    }
    lines.join("\n")
}

fn redact(input: &str) -> String {
    input
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if (lower.contains("api_key")
                || lower.contains("token")
                || lower.contains("password")
                || lower.contains("secret"))
                && (line.contains('=') || line.contains(':'))
            {
                "[sensitive value omitted from project knowledge]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn limit_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_owned()
    } else {
        format!(
            "{}\n[knowledge content truncated]\n",
            value.chars().take(max).collect::<String>()
        )
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or_else(|_| "0".into(), |time| time.as_secs().to_string())
}
fn now_compact() -> String {
    now()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("local-ai-knowledge-{name}-{nonce}"))
    }

    #[test]
    fn read_observation_materializes_source_task_overview_and_manifest() {
        let root = unique_temp_root("read-observation");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("src.rs"), "pub fn answer() -> u8 { 42 }\n").unwrap();

        let observed = observe_tool(
            &root,
            "run-42",
            "Inspect the runtime",
            Some("Research"),
            Some("Read source"),
            "read_file",
            &json!({"path":"src.rs"}),
            &json!({"path":"src.rs", "content":"pub fn answer() -> u8 { 42 }\n"}),
        )
        .unwrap();

        assert_eq!(observed["observation"], "persisted");
        assert!(observed["revisionAfter"].as_u64() > observed["revisionBefore"].as_u64());
        let source =
            fs::read_to_string(root.join(DIRECTORY).join(source_cache_path("src.rs"))).unwrap();
        assert!(source.contains("pub fn answer() -> u8 { 42 }"));
        assert!(source.contains("Fingerprint: sha256:"));
        let task = fs::read_to_string(root.join(DIRECTORY).join("tasks/run-42.md")).unwrap();
        assert!(task.contains("Inspect the runtime"));
        let overview =
            fs::read_to_string(root.join(DIRECTORY).join("project/overview.md")).unwrap();
        assert!(overview.contains("src.rs"));
        let index = index(&root).unwrap();
        assert_eq!(index["sources"][0]["path"], "src.rs");
        assert_eq!(index["sources"][0]["freshness"], "fresh");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sensitive_source_path_never_materializes_an_observation() {
        let root = unique_temp_root("sensitive-observation");
        fs::create_dir_all(&root).unwrap();
        let observed = observe_tool(
            &root,
            "run",
            "Inspect configuration",
            None,
            None,
            "read_file",
            &json!({"path":".env"}),
            &json!({"path":".env", "content":"TOKEN=private"}),
        )
        .unwrap();
        assert_eq!(observed["observation"], "skipped_sensitive_or_internal");
        assert!(!root
            .join(DIRECTORY)
            .join(source_cache_path(".env"))
            .exists());
        assert!(!root.join(DIRECTORY).join("project/overview.md").exists());

        fs::remove_dir_all(root).unwrap();
    }
}
