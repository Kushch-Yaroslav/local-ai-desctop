use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_READ_RESULT_BYTES: usize = 64 * 1024;

/// Largest read result this call may return: the tool maximum, optionally
/// lowered by the runtime through the internal `_result_limit_bytes` argument
/// (never part of the model-facing schema) so one turn's results fit the window.
fn read_limit(object: &serde_json::Map<String, Value>) -> usize {
    object
        .get("_result_limit_bytes")
        .and_then(Value::as_u64)
        .map_or(MAX_READ_RESULT_BYTES, |limit| {
            (limit as usize).clamp(1, MAX_READ_RESULT_BYTES)
        })
}

fn bounded_read_content(
    content: &str,
    offset_chars: usize,
    limit_bytes: usize,
) -> (String, bool, usize) {
    let start = content
        .char_indices()
        .nth(offset_chars)
        .map_or(content.len(), |(index, _)| index);
    let remainder = &content[start..];
    if remainder.len() <= limit_bytes {
        return (
            remainder.to_owned(),
            false,
            offset_chars + remainder.chars().count(),
        );
    }
    let end = remainder
        .char_indices()
        .take_while(|(index, _)| *index < limit_bytes)
        .last()
        .map_or(0, |(index, character)| index + character.len_utf8());
    (
        remainder[..end].to_owned(),
        true,
        offset_chars + remainder[..end].chars().count(),
    )
}

fn returned_line_range(
    source: &str,
    offset_chars: usize,
    returned: &str,
    first_source_line: usize,
) -> Option<(usize, usize, bool)> {
    if returned.is_empty() {
        return None;
    }
    let prefix_end = source
        .char_indices()
        .nth(offset_chars)
        .map_or(source.len(), |(index, _)| index);
    let prefix = &source[..prefix_end];
    let start_line = first_source_line + prefix.bytes().filter(|byte| *byte == b'\n').count();
    let newlines = returned.bytes().filter(|byte| *byte == b'\n').count();
    let end_line = start_line + newlines.saturating_sub(usize::from(returned.ends_with('\n')));
    let starts_mid_line = !prefix.is_empty() && !prefix.ends_with('\n');
    Some((start_line, end_line, starts_mid_line))
}

/// Where file tools may act: the primary root plus directories the user named
/// explicitly. Relative paths resolve against the primary root.
#[derive(Clone, Copy)]
pub struct Scope<'a> {
    pub root: &'a Path,
    pub grants: &'a [PathBuf],
}

/// Canonicalize the deepest existing ancestor and re-append the components that
/// do not exist yet, so a file can be created below directories that are about
/// to be created. A missing tail can never contain `..` or a symlink.
fn resolve_with_missing_tail(candidate: &Path) -> Result<PathBuf, String> {
    let mut missing = Vec::new();
    let mut current = candidate.to_path_buf();
    loop {
        match fs::canonicalize(&current) {
            Ok(mut base) => {
                base.extend(missing.iter().rev());
                return Ok(base);
            }
            Err(error) => {
                let Some(name) = current.file_name().map(|name| name.to_owned()) else {
                    return Err(format!("invalid path: {error}"));
                };
                missing.push(name);
                if !current.pop() {
                    return Err("invalid path".to_owned());
                }
            }
        }
    }
}

fn scoped(scope: &Scope, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(scope.root).unwrap_or_else(|_| scope.root.to_path_buf());
    let normalized = resolve_with_missing_tail(&root.join(path))?;
    let allowed = std::iter::once(root.clone()).chain(
        scope
            .grants
            .iter()
            .map(|grant| fs::canonicalize(grant).unwrap_or_else(|_| grant.clone())),
    );
    if !allowed
        .into_iter()
        .any(|allowed| normalized.starts_with(allowed))
    {
        return Err("path escapes project scope".to_owned());
    }
    Ok(normalized)
}

/// Acceptance output is runtime-internal diagnostic data, not project source.
/// Hide only the repository's `runtime/.tmp` subtree; an unrelated user
/// project's `.tmp` directory remains visible.
fn is_runtime_temporary(root: &Path, target: &Path) -> bool {
    let relative = match target.strip_prefix(root) {
        Ok(relative) => relative,
        Err(_) => return false,
    };
    let components = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    components.starts_with(&["runtime", ".tmp"])
        || (root.file_name().and_then(|name| name.to_str()) == Some("runtime")
            && components.first() == Some(&".tmp"))
}

/// `.ai-framework` is accessed only through the dedicated knowledge tools.
/// Treating it as application source would make broad repository traversal
/// recursively audit the cache itself.
fn is_knowledge_cache(root: &Path, target: &Path) -> bool {
    target
        .strip_prefix(root)
        .ok()
        .and_then(|relative| relative.components().next())
        .is_some_and(|component| component.as_os_str() == ".ai-framework")
}
/// SHA-256 of a file's current bytes, with its resolved path, or `None` when it
/// is not a readable file inside the scope. Used to notice that a file changed
/// between a read and a later write.
pub fn file_revision(scope: &Scope, path: &str) -> Option<(PathBuf, String)> {
    use sha2::{Digest, Sha256};
    let target = scoped(scope, path).ok()?;
    let bytes = fs::read(&target).ok()?;
    Some((target, format!("{:x}", Sha256::digest(bytes))))
}

/// A literal, single-occurrence edit. The expected revision comes from runtime
/// read tracking, never from model arguments. Staging and rename preserve the
/// original on every validation/write failure and preserve its permissions.
pub fn replace_text_in(
    scope: &Scope,
    args: &Value,
    expected_revision: &str,
) -> Result<(Value, Option<String>), String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let text = |key: &str| args.get(key).and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"));
    let path = text("path")?;
    let old = text("old_text")?;
    let new = text("new_text")?;
    if old.is_empty() || old == new {
        return Err("old_text must be nonempty and new_text must differ".into());
    }
    let target = scoped(scope, path)?;
    let original = fs::read(&target).map_err(|error| error.to_string())?;
    if format!("{:x}", Sha256::digest(&original)) != expected_revision {
        return Err("File changed since your last read. Read the latest version before replacing text.".into());
    }
    let content = std::str::from_utf8(&original).map_err(|error| error.to_string())?;
    let start = content.find(old).ok_or_else(|| "old_text does not exactly match current content; no file was written".to_owned())?;
    let next_character = start + old.chars().next().expect("nonempty").len_utf8();
    if content[next_character..].contains(old) {
        return Err("old_text matches more than one place; include a larger exact snippet; no file was written".into());
    }
    let updated = format!("{}{}{}", &content[..start], new, &content[start + old.len()..]);
    let permissions = fs::metadata(&target).map_err(|error| error.to_string())?.permissions();
    let temporary = target.parent().ok_or("file has no parent")?.join(format!(
        ".local-ai-replace-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut staged = fs::OpenOptions::new().write(true).create_new(true)
        .open(&temporary).map_err(|error| error.to_string())?;
    let result = (|| {
        staged.set_permissions(permissions).map_err(|error| error.to_string())?;
        staged.write_all(updated.as_bytes()).map_err(|error| error.to_string())?;
        staged.sync_all().map_err(|error| error.to_string())?;
        drop(staged);
        if scoped(scope, path)? != target || fs::read(&target).map_err(|error| error.to_string())? != original {
            return Err("File changed while staging the edit; no file was written. Read the latest version.".into());
        }
        fs::rename(&temporary, &target).map_err(|error| error.to_string())
    })();
    let _ = fs::remove_file(&temporary);
    result?;
    Ok((json!({"path":path,"bytes":updated.len(),"replacements":1}),
        Some(format!("--- {path}\n+++ {path}\n-{old}\n+{new}"))))
}

pub fn execute(root: &Path, name: &str, args: &Value) -> Result<(Value, Option<String>), String> {
    execute_in(&Scope { root, grants: &[] }, name, args)
}

pub fn execute_in(
    scope: &Scope,
    name: &str,
    args: &Value,
) -> Result<(Value, Option<String>), String> {
    let root = scope.root;
    let object = args
        .as_object()
        .ok_or_else(|| "arguments must be an object".to_owned())?;
    let path = object.get("path").and_then(Value::as_str).unwrap_or(".");
    match name {
        "list_directory" => {
            let target = scoped(scope, path)?;
            if is_runtime_temporary(root, &target) || is_knowledge_cache(root, &target) {
                return Err(
                    "internal runtime/cache files are excluded from project discovery".to_owned(),
                );
            }
            let mut items = Vec::new();
            let mut complete = true;
            for entry in fs::read_dir(target).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if is_runtime_temporary(root, &entry.path())
                    || is_knowledge_cache(root, &entry.path())
                {
                    complete = false;
                    continue;
                }
                items.push(entry.file_name().to_string_lossy().to_string());
            }
            items.sort();
            Ok((json!({"entries":items,"complete":complete}), None))
        }
        "read_file" => {
            let target = scoped(scope, path)?;
            if is_runtime_temporary(root, &target) || is_knowledge_cache(root, &target) {
                return Err(
                    "internal runtime/cache files are excluded from project discovery".to_owned(),
                );
            }
            let content = fs::read_to_string(target).map_err(|e| e.to_string())?;
            let limit = read_limit(object);
            let lines = content.lines().collect::<Vec<_>>();
            let start_line = object
                .get("start_line")
                .and_then(Value::as_u64)
                .map(|line| line.max(1) as usize);
            let end_line = object
                .get("end_line")
                .and_then(Value::as_u64)
                .map(|line| line.max(1) as usize);
            let offset_chars = object
                .get("offset_chars")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            if start_line.is_some() || end_line.is_some() {
                let start = start_line.unwrap_or(1);
                let end = end_line.unwrap_or(lines.len());
                if start > lines.len() {
                    return Err(format!(
                        "start_line {start} is outside {path}, which has {} lines",
                        lines.len()
                    ));
                }
                if end < start {
                    return Err(format!(
                        "end_line {end} precedes start_line {start} for {path}"
                    ));
                }
                if end > lines.len() {
                    return Err(format!(
                        "end_line {end} is outside {path}, which has {} lines",
                        lines.len()
                    ));
                }
                let selected_source = lines
                    .iter()
                    .skip(start.saturating_sub(1))
                    .take(end.saturating_sub(start).saturating_add(1))
                    .copied()
                    .collect::<Vec<_>>()
                    .join("\n");
                let (selected, truncated, next_offset_chars) =
                    bounded_read_content(&selected_source, offset_chars, limit);
                let range = returned_line_range(&selected_source, offset_chars, &selected, start);
                let (returned_start, returned_end, starts_mid_line) = range
                    .map(|(start, end, partial)| (json!(start), json!(end), partial))
                    .unwrap_or((Value::Null, Value::Null, false));
                Ok((
                    json!({"path":path,"content":selected,"start_line":returned_start,"end_line":returned_end,"requested_start_line":start,"requested_end_line":end,"starts_mid_line":starts_mid_line,"ends_mid_line":truncated && !selected.ends_with('\n'),"total_lines":lines.len(),"targeted":true,"truncated":truncated,"offset_chars":offset_chars,"next_offset_chars":next_offset_chars,"read_result_limit_bytes":limit}),
                    None,
                ))
            } else {
                let (chunk, truncated, next_offset_chars) =
                    bounded_read_content(&content, offset_chars, limit);
                let range = returned_line_range(&content, offset_chars, &chunk, 1);
                let (start, end, starts_mid_line) = range
                    .map(|(start, end, partial)| (json!(start), json!(end), partial))
                    .unwrap_or((Value::Null, Value::Null, false));
                Ok((
                    json!({"path":path,"content":chunk,"start_line":start,"end_line":end,"starts_mid_line":starts_mid_line,"ends_mid_line":truncated && !chunk.ends_with('\n'),"total_lines":lines.len(),"targeted":false,"truncated":truncated,"offset_chars":offset_chars,"next_offset_chars":next_offset_chars,"read_result_limit_bytes":limit}),
                    None,
                ))
            }
        }
        "write_file" | "create_file" => {
            let content = object
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| "content is required".to_owned())?;
            let target = scoped(scope, path)?;
            let before = fs::read_to_string(&target).unwrap_or_default();
            if name == "create_file" && target.exists() {
                return Err("file already exists; use write_file".to_owned());
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?
            }
            fs::write(&target, content).map_err(|e| e.to_string())?;
            Ok((
                json!({"path":path,"bytes":content.len()}),
                Some(format!("--- {path}\n+++ {path}\n-{}\n+{}", before, content)),
            ))
        }
        "apply_patch" => apply_patch(scope, object),
        "delete_file" => {
            let content = object
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "path is required".to_owned())?;
            let target = scoped(scope, content)?;
            if !target.is_file() {
                return Err("only regular files can be deleted".to_owned());
            }
            fs::remove_file(&target).map_err(|e| e.to_string())?;
            Ok((json!({"path":content,"deleted":true}), None))
        }
        _ => Err(format!("unsupported filesystem tool: {name}")),
    }
}

const PATCH_FORMAT: &str = "Format: *** Begin Patch, then per file `*** Update File: path` (hunks of ` context`, `-old`, `+new` lines, hunks separated by `@@`), `*** Add File: path` (every line prefixed `+`) or `*** Delete File: path`, then *** End Patch.";

/// One file change inside a patch, computed fully in memory before anything
/// is written.
enum PatchOp {
    Add {
        rel: String,
        lines: Vec<String>,
    },
    Delete {
        rel: String,
    },
    Update {
        rel: String,
        hunks: Vec<Vec<String>>,
    },
}

/// Parse a patch tolerantly: surrounding blank lines and a markdown fence are
/// ignored, CRLF is normalized, and a missing `*** End Patch` is accepted.
fn parse_patch(patch: &str) -> Result<Vec<PatchOp>, String> {
    let normalized = patch.replace("\r\n", "\n");
    let mut lines = normalized.split('\n').collect::<Vec<_>>();
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    if lines
        .first()
        .is_some_and(|line| line.trim().starts_with("```"))
    {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| {
        let line = line.trim();
        line.is_empty() || line.starts_with("```")
    }) {
        lines.pop();
    }
    let lines = lines.into_iter().map(str::to_owned).collect::<Vec<_>>();
    if lines.first().map(|line| line.trim()) != Some("*** Begin Patch") {
        return Err(format!(
            "patch must start with *** Begin Patch. {PATCH_FORMAT}"
        ));
    }
    let mut cursor = 1;
    let mut operations = Vec::new();
    while cursor < lines.len() {
        let header = lines[cursor].trim().to_owned();
        cursor += 1;
        if header == "*** End Patch" {
            break;
        }
        if header.is_empty() {
            continue;
        }
        if let Some(rel) = header.strip_prefix("*** Add File:") {
            let body = collect_body(&lines, &mut cursor);
            let mut content = body
                .iter()
                .map(|line| line.strip_prefix('+').unwrap_or(line).to_owned())
                .collect::<Vec<_>>();
            while content.last().is_some_and(String::is_empty) {
                content.pop();
            }
            operations.push(PatchOp::Add {
                rel: rel.trim().to_owned(),
                lines: content,
            });
        } else if let Some(rel) = header.strip_prefix("*** Delete File:") {
            operations.push(PatchOp::Delete {
                rel: rel.trim().to_owned(),
            });
        } else if let Some(rel) = header.strip_prefix("*** Update File:") {
            let body = collect_body(&lines, &mut cursor);
            operations.push(PatchOp::Update {
                rel: rel.trim().to_owned(),
                hunks: hunk_blocks(&body),
            });
        } else {
            return Err(format!("unknown patch section: {header}. {PATCH_FORMAT}"));
        }
    }
    if operations.is_empty() {
        return Err(format!("patch contains no file sections. {PATCH_FORMAT}"));
    }
    Ok(operations)
}

fn find_block(
    haystack: &[String],
    needle: &[&str],
    same: impl Fn(&str, &str) -> bool,
) -> Vec<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return Vec::new();
    }
    (0..=haystack.len() - needle.len())
        .filter(|start| {
            needle
                .iter()
                .enumerate()
                .all(|(offset, line)| same(&haystack[start + offset], line))
        })
        .collect()
}

/// Apply the hunks of one Update section to `content`. Matching is by whole
/// lines: exact first, then ignoring trailing whitespace. A hunk that matches
/// several places is refused rather than applied to an arbitrary one.
fn apply_hunks(rel: &str, content: &str, hunks: &[Vec<String>]) -> Result<String, String> {
    let crlf = content.contains("\r\n");
    let mut lines = content
        .replace("\r\n", "\n")
        .split('\n')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for (index, hunk) in hunks.iter().enumerate() {
        if !hunk.iter().any(|line| line.starts_with('+') || line.starts_with('-')) {
            return Err(format!(
                "hunk {} for {rel} contains no change lines. Prefix the removed line with `-` and its replacement with `+`; prefix each unchanged context line with one EXTRA space before its original indentation. Context-only hunks cannot edit a file.",
                index + 1
            ));
        }
        let (old, new) = interpret_hunk(hunk);
        if old.iter().all(|line| line.trim().is_empty()) {
            return Err(format!(
                "hunk {} for {rel} has no existing line to anchor on: include at least one unchanged ` context` line or a `-` line from the file",
                index + 1
            ));
        }
        let old_refs = old.iter().map(String::as_str).collect::<Vec<_>>();
        let mut matches = find_block(&lines, &old_refs, |left, right| left == right);
        if matches.is_empty() {
            matches = find_block(&lines, &old_refs, |left, right| {
                left.trim_end() == right.trim_end()
            });
        }
        match matches.as_slice() {
            [] => {
                let first = old
                    .iter()
                    .find(|line| !line.trim().is_empty())
                    .map_or("", String::as_str);
                let hint = if lines.iter().any(|line| line.trim() == first.trim()) {
                    "its first line exists, but the surrounding lines differ"
                } else {
                    "its first line is not in the file"
                };
                let candidate = lines.iter().position(|line| line.trim() == first.trim());
                let detail = candidate.and_then(|start| {
                    let anchor_offset = old.iter().position(|line| !line.trim().is_empty())?;
                    let start = start.checked_sub(anchor_offset)?;
                    old.iter().enumerate().find_map(|(offset, expected)| {
                        let actual = lines.get(start + offset)?;
                        (actual.trim_end() != expected.trim_end()).then(|| format!(
                            " First mismatch at file line {}: expected {:?}, current {:?}.",
                            start + offset + 1,
                            expected.chars().take(160).collect::<String>(),
                            actual.chars().take(160).collect::<String>()
                        ))
                    })
                }).unwrap_or_default();
                return Err(format!(
                    "patch does not match current content: {rel} (hunk {}: {hint}).{detail} Context lines need one EXTRA leading space as the patch marker, followed by the exact original indentation. Prefer a small `-old` / `+new` replacement for a one-line edit. If the source actually changed, read the latest range; no file was written.",
                    index + 1
                ));
            }
            [position] => {
                lines.splice(*position..*position + old.len(), new);
            }
            several => {
                return Err(format!(
                    "hunk {} for {rel} matches {} places: add unchanged ` context` lines around it so it matches exactly one",
                    index + 1,
                    several.len()
                ));
            }
        }
    }
    let joined = lines.join("\n");
    Ok(if crlf {
        joined.replace('\n', "\r\n")
    } else {
        joined
    })
}

/// Apply a `*** Begin Patch` style patch (Add/Update/Delete sections). Every
/// section is computed in memory first, so a failure anywhere leaves the
/// project untouched; the files are written only once the whole patch is
/// known to apply, and restored if a write itself fails.
fn apply_patch(
    scope: &Scope,
    object: &serde_json::Map<String, Value>,
) -> Result<(Value, Option<String>), String> {
    let patch = object
        .get("patch")
        .and_then(Value::as_str)
        .ok_or_else(|| "patch is required".to_owned())?;
    let operations = parse_patch(patch)?;
    // Latest in-memory state per path: Some(content) or None when deleted.
    let mut staged: Vec<(String, PathBuf, Option<String>)> = Vec::new();
    let mut original: Vec<(PathBuf, Option<Vec<u8>>)> = Vec::new();
    let mut changed: Vec<String> = Vec::new();
    for operation in operations {
        let rel = match &operation {
            PatchOp::Add { rel, .. } | PatchOp::Delete { rel } | PatchOp::Update { rel, .. } => {
                rel.clone()
            }
        };
        let target = scoped(scope, &rel)?;
        let position = staged.iter().position(|(_, known, _)| *known == target);
        let current = match position {
            Some(index) => staged[index].2.clone(),
            None => target
                .is_file()
                .then(|| fs::read_to_string(&target))
                .transpose()
                .map_err(|e| format!("cannot read {rel}: {e}"))?,
        };
        let next = match operation {
            PatchOp::Add { lines, .. } => {
                if current.is_some() || target.exists() && position.is_none() {
                    return Err(format!(
                        "file already exists: {rel}. Use *** Update File to change it."
                    ));
                }
                let mut content = lines.join("\n");
                if !content.is_empty() {
                    content.push('\n');
                }
                Some(content)
            }
            PatchOp::Delete { .. } => {
                if current.is_none() {
                    return Err(format!("only regular files can be deleted: {rel}"));
                }
                None
            }
            PatchOp::Update { hunks, .. } => {
                let before = current.ok_or_else(|| {
                    format!("cannot update {rel}: the file does not exist (use *** Add File)")
                })?;
                if hunks.is_empty() {
                    return Err(format!("patch for {rel} has no changes. {PATCH_FORMAT}"));
                }
                Some(apply_hunks(&rel, &before, &hunks)?)
            }
        };
        if position.is_none() {
            original.push((
                target.clone(),
                target
                    .is_file()
                    .then(|| fs::read(&target).unwrap_or_default()),
            ));
        }
        match position {
            Some(index) => staged[index].2 = next,
            None => staged.push((rel.clone(), target, next)),
        }
        if !changed.contains(&rel) {
            changed.push(rel);
        }
    }
    let mut failure = None;
    for (_, target, content) in &staged {
        let outcome = match content {
            Some(content) => target
                .parent()
                .map_or(Ok(()), fs::create_dir_all)
                .and_then(|()| fs::write(target, content)),
            None => fs::remove_file(target),
        };
        if let Err(error) = outcome {
            failure = Some(format!("cannot write {}: {error}", target.display()));
            break;
        }
    }
    if let Some(message) = failure {
        for (target, bytes) in original {
            let _ = match bytes {
                Some(bytes) => fs::write(&target, bytes),
                None => fs::remove_file(&target).or(Ok(())),
            };
        }
        return Err(format!("{message}; no file was changed"));
    }
    Ok((
        json!({"applied":true,"files":changed}),
        Some(changed.join(", ")),
    ))
}

/// Body lines run up to (and excluding) the next `*** ` header or `*** End
/// Patch`; the cursor is left on that header so the outer loop re-reads it.
fn collect_body(lines: &[String], cursor: &mut usize) -> Vec<String> {
    let mut body = Vec::new();
    while *cursor < lines.len() {
        let trimmed = lines[*cursor].trim();
        if trimmed == "*** End Patch" || trimmed.starts_with("*** ") {
            break;
        }
        body.push(lines[*cursor].clone());
        *cursor += 1;
    }
    body
}

/// Hunks are separated by `@@` lines; a header such as `@@ fn main() @@` or
/// `@@ -1,3 +1,3 @@` is accepted and ignored. Blank lines at the edges of a
/// hunk are formatting, not content.
fn hunk_blocks(body: &[String]) -> Vec<Vec<String>> {
    let mut blocks: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for line in body {
        if line.trim_start().starts_with("@@") {
            blocks.push(std::mem::take(&mut current));
        } else {
            current.push(line.to_owned());
        }
    }
    blocks.push(current);
    blocks
        .into_iter()
        .map(|mut block| {
            while block.last().is_some_and(String::is_empty) {
                block.pop();
            }
            while block.first().is_some_and(String::is_empty) {
                block.remove(0);
            }
            block
        })
        .filter(|block| !block.is_empty())
        .collect()
}

/// Interpret one hunk body. `-` and `+` lines form the old and new halves; a
/// ` ` line (or a bare empty line, or any other unprefixed line) is context in
/// both halves, so the anchor matches a wider window than the changed lines
/// alone. Context is verified against the file like everything else.
fn interpret_hunk(hunk: &[String]) -> (Vec<String>, Vec<String>) {
    let mut old = Vec::new();
    let mut new = Vec::new();
    for line in hunk {
        if let Some(rest) = line.strip_prefix('-') {
            old.push(rest.to_owned());
        } else if let Some(rest) = line.strip_prefix('+') {
            new.push(rest.to_owned());
        } else if line.starts_with('\\') {
            continue;
        } else {
            let rest = line.strip_prefix(' ').unwrap_or(line);
            old.push(rest.to_owned());
            new.push(rest.to_owned());
        }
    }
    (old, new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_result_limit_truncates_with_a_continuation_offset() {
        let root = std::env::temp_dir().join(format!("fs-limit-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("big.txt"), "abcdefghij".repeat(100)).unwrap();
        let (first, _) = execute(
            &root,
            "read_file",
            &json!({"path":"big.txt","_result_limit_bytes":100}),
        )
        .unwrap();
        assert_eq!(first["truncated"], true);
        assert_eq!(first["content"].as_str().unwrap().len(), 100);
        assert_eq!(first["next_offset_chars"], 100);
        assert_eq!(first["read_result_limit_bytes"], 100);
        let (second, _) = execute(
            &root,
            "read_file",
            &json!({"path":"big.txt","offset_chars":100,"_result_limit_bytes":100}),
        )
        .unwrap();
        assert!(second["content"]
            .as_str()
            .unwrap()
            .starts_with("abcdefghij"));
        // the internal limit can only lower the tool maximum
        let (all, _) = execute(
            &root,
            "read_file",
            &json!({"path":"big.txt","_result_limit_bytes":10_000_000}),
        )
        .unwrap();
        assert_eq!(all["truncated"], false);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn large_read_is_bounded_and_addressable_by_offset() {
        let root = std::env::temp_dir().join(format!(
            "local-ai-desktop-bounded-read-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let body = "é".repeat(70_000);
        fs::write(root.join("large.txt"), &body).unwrap();
        let first = execute(&root, "read_file", &json!({"path":"large.txt"}))
            .unwrap()
            .0;
        assert_eq!(first["truncated"], true);
        let first_text = first["content"].as_str().unwrap();
        assert!(first_text.len() <= MAX_READ_RESULT_BYTES);
        let offset = first["next_offset_chars"].as_u64().unwrap();
        let second = execute(
            &root,
            "read_file",
            &json!({"path":"large.txt","offset_chars":offset}),
        )
        .unwrap()
        .0;
        assert_eq!(second["offset_chars"], offset);
        assert!(second["content"].as_str().unwrap().len() <= MAX_READ_RESULT_BYTES);
        assert_eq!(
            format!("{}{}", first_text, second["content"].as_str().unwrap())
                .chars()
                .count(),
            second["next_offset_chars"].as_u64().unwrap() as usize
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn later_read_chunk_reports_actual_source_lines() {
        let root = std::env::temp_dir().join(format!(
            "local-ai-desktop-line-mapped-read-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("source.txt"),
            "one\nsecond-line\nthird line\nfourth\n",
        )
        .unwrap();

        let first = execute(
            &root,
            "read_file",
            &json!({"path":"source.txt","_result_limit_bytes":7}),
        )
        .unwrap()
        .0;
        assert_eq!(first["start_line"], 1);
        assert_eq!(first["end_line"], 2);
        assert_eq!(first["starts_mid_line"], false);
        assert_eq!(first["ends_mid_line"], true);

        let offset = first["next_offset_chars"].as_u64().unwrap();
        let second = execute(
            &root,
            "read_file",
            &json!({"path":"source.txt","offset_chars":offset,"_result_limit_bytes":13}),
        )
        .unwrap()
        .0;
        assert_eq!(second["content"], "ond-line\nthir");
        assert_eq!(second["start_line"], 2);
        assert_eq!(second["end_line"], 3);
        assert_eq!(second["starts_mid_line"], true);
        assert_eq!(second["ends_mid_line"], true);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn line_read_past_eof_is_an_explicit_error() {
        let root = std::env::temp_dir().join(format!(
            "local-ai-desktop-read-eof-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("short.txt"), "first\nsecond\n").unwrap();

        let error = execute(
            &root,
            "read_file",
            &json!({"path":"short.txt","start_line":3}),
        )
        .unwrap_err();
        assert_eq!(
            error,
            "start_line 3 is outside short.txt, which has 2 lines"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn apply_patch_update_add_delete_roundtrip() {
        let root = std::env::temp_dir().join(format!(
            "local-ai-desktop-patch-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("src")).expect("root");
        fs::write(root.join("src/a.txt"), "alpha\nbeta\ngamma\n").expect("write");
        fs::write(root.join("src/old.txt"), "gone\n").expect("write");

        let patch = [
            "*** Begin Patch",
            "*** Update File: src/a.txt",
            "-beta",
            "+BETA",
            "*** Add File: src/new.txt",
            "+hello",
            "*** Delete File: src/old.txt",
            "*** End Patch",
        ]
        .join("\n");
        let result = apply_patch(
            &Scope {
                root: &root,
                grants: &[],
            },
            &serde_json::json!({"patch": patch})
                .as_object()
                .cloned()
                .unwrap(),
        )
        .expect("patch applies");
        assert!(result.0["applied"] == true);

        assert_eq!(
            fs::read_to_string(root.join("src/a.txt")).unwrap(),
            "alpha\nBETA\ngamma\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("src/new.txt")).unwrap(),
            "hello\n"
        );
        assert!(!root.join("src/old.txt").exists());

        let bad = apply_patch(
            &Scope {
                root: &root,
                grants: &[],
            },
            &serde_json::json!({"patch":"*** Begin Patch\n*** Update File: src/a.txt\n-DOES-NOT-EXIST\n+X\n*** End Patch"})
                .as_object()
                .cloned()
                .unwrap(),
        )
        .expect_err("mismatch must fail");
        assert!(bad.contains("does not match"), "{bad}");
        // File must remain untouched after a failed patch.
        assert_eq!(
            fs::read_to_string(root.join("src/a.txt")).unwrap(),
            "alpha\nBETA\ngamma\n"
        );

        fs::remove_dir_all(root).expect("cleanup");
    }

    fn patch_fixture(files: &[(&str, &str)]) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "fs-patch-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        for (name, content) in files {
            fs::write(root.join(name), content).unwrap();
        }
        root
    }

    fn patch(root: &Path, text: &str) -> Result<(Value, Option<String>), String> {
        apply_patch(
            &Scope { root, grants: &[] },
            json!({ "patch": text }).as_object().unwrap(),
        )
    }

    #[test]
    fn incident_context_marker_error_reports_indentation_without_fuzzy_editing() {
        let root = patch_fixture(&[("a.js", "    function count() {\n      return 1;\n    }\n")]);
        let error = patch(&root, "*** Begin Patch\n*** Update File: a.js\n@@\n    function count() {\n      return 1;\n    }\n+    const added = true;\n*** End Patch").unwrap_err();
        assert!(error.contains("hunk 1"), "{error}");
        assert!(error.contains("file line 1"), "{error}");
        assert!(error.contains("expected \"   function"), "{error}");
        assert!(error.contains("current \"    function"), "{error}");
        assert!(error.contains("EXTRA leading space"), "{error}");
        assert_eq!(fs::read_to_string(root.join("a.js")).unwrap(), "    function count() {\n      return 1;\n    }\n");
        patch(&root, "*** Begin Patch\n*** Update File: a.js\n@@\n     function count() {\n-      return 1;\n+      return 2;\n     }\n*** End Patch").unwrap();
        let stale = patch(&root, "*** Begin Patch\n*** Update File: a.js\n@@\n-      return 1;\n+      return 3;\n*** End Patch").unwrap_err();
        assert!(stale.contains("does not match"));
        assert!(fs::read_to_string(root.join("a.js")).unwrap().contains("return 2"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn context_only_hunks_are_rejected_before_matching_or_writing() {
        let root = patch_fixture(&[("a.js", "    old();\n")]);
        let error = patch(&root, "*** Begin Patch\n*** Update File: a.js\n@@\n     old();\n*** End Patch").unwrap_err();
        assert!(error.contains("contains no change lines"), "{error}");
        assert!(error.contains("replacement with `+`"), "{error}");
        assert_eq!(fs::read_to_string(root.join("a.js")).unwrap(), "    old();\n");
        assert!(patch(&root, "not a patch").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn literal_replacement_is_unique_fresh_atomic_and_preserves_line_endings() {
        let root = patch_fixture(&[("a.txt", "alpha\r\nbeta\r\n"), ("overlap.txt", "aaa")]);
        let scope = Scope { root: &root, grants: &[] };
        let (_, revision) = file_revision(&scope, "a.txt").unwrap();
        let result = replace_text_in(&scope, &json!({"path":"a.txt","old_text":"beta","new_text":"BETA"}), &revision).unwrap();
        assert_eq!(result.0["replacements"], 1);
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"alpha\r\nBETA\r\n");
        let stale = replace_text_in(&scope, &json!({"path":"a.txt","old_text":"BETA","new_text":"new"}), &revision).unwrap_err();
        assert!(stale.contains("changed since your last read"));
        let (_, current) = file_revision(&scope, "a.txt").unwrap();
        for args in [
            json!({"path":"a.txt","old_text":"","new_text":"new"}),
            json!({"path":"a.txt","old_text":"BETA","new_text":"BETA"}),
            json!({"path":"a.txt","old_text":"missing","new_text":"new"}),
            json!({"path":"../escape.txt","old_text":"x","new_text":"y"}),
        ] {
            assert!(replace_text_in(&scope, &args, &current).is_err());
        }
        let (_, overlap) = file_revision(&scope, "overlap.txt").unwrap();
        assert!(replace_text_in(&scope, &json!({"path":"overlap.txt","old_text":"aa","new_text":"b"}), &overlap).unwrap_err().contains("more than one place"));
        assert_eq!(fs::read_to_string(root.join("overlap.txt")).unwrap(), "aaa");
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"alpha\r\nBETA\r\n");
        assert!(!fs::read_dir(&root).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".local-ai-replace")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn patch_tolerates_fences_blank_edges_hunk_headers_and_blank_context() {
        let root = patch_fixture(&[("a.js", "one\ntwo\n\nthree\nfour\nfive\n")]);
        let text = "\n```diff\n*** Begin Patch\n*** Update File: a.js\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n\n three\n@@ function four() @@\n-four\n+FOUR\n*** End Patch\n```\n";
        patch(&root, text).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("a.js")).unwrap(),
            "one\nTWO\n\nthree\nFOUR\nfive\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn patch_preserves_crlf_files_and_accepts_a_missing_end_marker() {
        let root = patch_fixture(&[("a.txt", "alpha\r\nbeta\r\ngamma\r\n")]);
        patch(
            &root,
            "*** Begin Patch\n*** Update File: a.txt\n-beta\n+BETA",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "alpha\r\nBETA\r\ngamma\r\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_ambiguous_hunk_is_refused_and_context_disambiguates_it() {
        let root = patch_fixture(&[("a.txt", "x\nsame\ny\nsame\nz\n")]);
        let error = patch(
            &root,
            "*** Begin Patch\n*** Update File: a.txt\n-same\n+SAME\n*** End Patch",
        )
        .unwrap_err();
        assert!(error.contains("matches 2 places"), "{error}");
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "x\nsame\ny\nsame\nz\n"
        );
        patch(
            &root,
            "*** Begin Patch\n*** Update File: a.txt\n y\n-same\n+SAME\n*** End Patch",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "x\nsame\ny\nSAME\nz\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_multi_file_patch_is_all_or_nothing() {
        let root = patch_fixture(&[("a.txt", "a\n"), ("b.txt", "b\n")]);
        let error = patch(
            &root,
            "*** Begin Patch\n*** Update File: a.txt\n-a\n+A\n*** Add File: c.txt\n+c\n*** Update File: b.txt\n-missing\n+B\n*** End Patch",
        )
        .unwrap_err();
        assert!(error.contains("does not match"), "{error}");
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "a\n");
        assert!(
            !root.join("c.txt").exists(),
            "an earlier Add must not survive a later failure"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn later_sections_see_earlier_sections_of_the_same_patch() {
        let root = patch_fixture(&[("a.txt", "a\nb\n")]);
        patch(
            &root,
            "*** Begin Patch\n*** Update File: a.txt\n-a\n+A\n*** Update File: a.txt\n-b\n+B\n*** End Patch",
        )
        .unwrap();
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "A\nB\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn patch_errors_say_how_to_fix_the_call() {
        let root = patch_fixture(&[("a.txt", "a\n")]);
        let error = patch(&root, "diff --git a/a.txt b/a.txt").unwrap_err();
        assert!(
            error.contains("*** Begin Patch") && error.contains("Format:"),
            "{error}"
        );
        let error = patch(
            &root,
            "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch",
        )
        .unwrap_err();
        assert!(error.contains("Update File"), "{error}");
        let error = patch(
            &root,
            "*** Begin Patch\n*** Update File: a.txt\n+only added\n*** End Patch",
        )
        .unwrap_err();
        assert!(error.contains("context"), "{error}");
        let error = patch(
            &root,
            "*** Begin Patch\n*** Update File: a.txt\n-nope\n+x\n*** End Patch",
        )
        .unwrap_err();
        assert!(error.contains("not in the file"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn hides_runtime_tmp_acceptance_artifacts_without_hiding_other_project_tmp() {
        let root = std::env::temp_dir().join(format!(
            "local-ai-desktop-filesystem-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("runtime/.tmp/acceptance")).expect("runtime tmp");
        fs::create_dir_all(root.join(".tmp")).expect("project tmp");
        fs::write(root.join("runtime/.tmp/acceptance/run.ndjson"), "{}\n").expect("artifact");
        fs::write(root.join(".tmp/keep.txt"), "keep\n").expect("project file");

        let root_listing = execute(&root, "list_directory", &json!({}))
            .expect("root listing")
            .0;
        let runtime_listing = execute(&root, "list_directory", &json!({"path":"runtime"}))
            .expect("runtime listing")
            .0;
        assert!(root_listing["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|item| item == ".tmp"));
        assert_eq!(root_listing["complete"], true);
        assert!(!runtime_listing["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|item| item == ".tmp"));
        assert_eq!(runtime_listing["complete"], false);
        assert!(execute(
            &root,
            "read_file",
            &json!({"path":"runtime/.tmp/acceptance/run.ndjson"})
        )
        .is_err());

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn files_can_be_created_below_directories_that_do_not_exist_yet() {
        let root = std::env::temp_dir().join(format!("fs-nested-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        execute(
            &root,
            "create_file",
            &json!({"path":"src/components/ui/Board.tsx","content":"x"}),
        )
        .unwrap();
        assert!(root.join("src/components/ui/Board.tsx").is_file());
        for escape in [
            "new/../../escape.txt",
            "../escape.txt",
            "a/b/../../../escape.txt",
        ] {
            assert!(
                execute(&root, "write_file", &json!({"path":escape,"content":"x"})).is_err(),
                "{escape}"
            );
        }
        assert!(!root.parent().unwrap().join("escape.txt").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn granted_directories_extend_scope_and_symlinks_cannot_escape_them() {
        let base = std::env::temp_dir().join(format!("fs-grants-{}", std::process::id()));
        let (root, granted, other) = (base.join("root"), base.join("granted"), base.join("other"));
        for dir in [&root, &granted, &other] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let (root, granted, other) = (
            root.canonicalize().unwrap(),
            granted.canonicalize().unwrap(),
            other.canonicalize().unwrap(),
        );
        std::os::unix::fs::symlink(&other, granted.join("link")).unwrap();
        let grants = [granted.clone()];
        let scope = Scope {
            root: &root,
            grants: &grants,
        };
        let inside = granted.join("new/ok.txt");
        execute_in(
            &scope,
            "create_file",
            &json!({"path":inside,"content":"ok"}),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&inside).unwrap(), "ok");
        for denied in [other.join("x.txt"), granted.join("link/x.txt")] {
            let error = execute_in(&scope, "write_file", &json!({"path":denied,"content":"no"}))
                .unwrap_err();
            assert!(error.contains("escapes"), "{error}");
        }
        assert!(!other.join("x.txt").exists());
        assert!(execute_in(
            &Scope {
                root: &root,
                grants: &[]
            },
            "write_file",
            &json!({"path":inside,"content":"no"})
        )
        .is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
}
