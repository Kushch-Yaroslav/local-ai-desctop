use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn scoped(root: &Path, path: &str) -> Result<PathBuf, String> {
    let candidate = root.join(path);
    let normalized = match fs::canonicalize(&candidate) {
        Ok(path) => path,
        Err(_) => {
            let parent = candidate
                .parent()
                .ok_or_else(|| "invalid path".to_owned())?;
            fs::canonicalize(parent)
                .map_err(|error| error.to_string())?
                .join(
                    candidate
                        .file_name()
                        .ok_or_else(|| "invalid path".to_owned())?,
                )
        }
    };
    if !normalized.starts_with(root) {
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
pub fn execute(root: &Path, name: &str, args: &Value) -> Result<(Value, Option<String>), String> {
    let object = args
        .as_object()
        .ok_or_else(|| "arguments must be an object".to_owned())?;
    let path = object.get("path").and_then(Value::as_str).unwrap_or(".");
    match name {
        "list_directory" => {
            let target = scoped(root, path)?;
            if is_runtime_temporary(root, &target) {
                return Err(
                    "runtime acceptance artifacts are excluded from project discovery".to_owned(),
                );
            }
            let mut items = fs::read_dir(target)
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .filter(|entry| !is_runtime_temporary(root, &entry.path()))
                .map(|x| x.file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>();
            items.sort();
            Ok((json!({"entries":items}), None))
        }
        "read_file" => {
            let target = scoped(root, path)?;
            if is_runtime_temporary(root, &target) {
                return Err(
                    "runtime acceptance artifacts are excluded from project discovery".to_owned(),
                );
            }
            let content = fs::read_to_string(target).map_err(|e| e.to_string())?;
            let lines = content.lines().collect::<Vec<_>>();
            let start_line = object
                .get("start_line")
                .and_then(Value::as_u64)
                .map(|line| line.max(1) as usize);
            let end_line = object
                .get("end_line")
                .and_then(Value::as_u64)
                .map(|line| line.max(1) as usize);
            if start_line.is_some() || end_line.is_some() {
                let start = start_line.unwrap_or(1);
                let end = end_line.unwrap_or(lines.len()).max(start);
                let selected = lines
                    .iter()
                    .skip(start.saturating_sub(1))
                    .take(end.saturating_sub(start).saturating_add(1))
                    .copied()
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok((
                    json!({"path":path,"content":selected,"start_line":start,"end_line":end,"total_lines":lines.len(),"targeted":true}),
                    None,
                ))
            } else {
                Ok((
                    json!({"path":path,"content":content,"total_lines":lines.len(),"targeted":false}),
                    None,
                ))
            }
        }
        "write_file" | "create_file" => {
            let content = object
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| "content is required".to_owned())?;
            let target = scoped(root, path)?;
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
        "apply_patch" => apply_patch(root, object),
        "delete_file" => {
            let content = object
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "path is required".to_owned())?;
            let target = scoped(root, content)?;
            if !target.is_file() {
                return Err("only regular files can be deleted".to_owned());
            }
            fs::remove_file(&target).map_err(|e| e.to_string())?;
            Ok((json!({"path":content,"deleted":true}), None))
        }
        _ => Err(format!("unsupported filesystem tool: {name}")),
    }
}

/// Apply a `*** Begin Patch` style patch (Add/Update/Delete sections). The
/// body of an Update section is either a classic unified diff (context `/ -/ +`
/// lines) or a literal old/new block when context is absent; both forms
/// round-trip against the same file content. A section failure leaves the file
/// untouched because the rewrite happens in memory until the last byte is
/// validated.
fn apply_patch(
    root: &Path,
    object: &serde_json::Map<String, Value>,
) -> Result<(Value, Option<String>), String> {
    let patch = object
        .get("patch")
        .and_then(Value::as_str)
        .ok_or_else(|| "patch is required".to_owned())?;
    let lines: Vec<String> = patch
        .replace("\r\n", "\n")
        .split('\n')
        .map(str::to_owned)
        .collect();
    if lines
        .first()
        .map(|l| l.trim())
        .is_some_and(|h| h != "*** Begin Patch")
    {
        return Err("patch must start with *** Begin Patch".to_owned());
    }
    let mut cursor = 1;
    let mut changed: Vec<String> = Vec::new();
    while cursor < lines.len() {
        let header = lines[cursor].trim();
        cursor += 1;
        if header == "*** End Patch" {
            break;
        }
        if let Some(rel) = header.strip_prefix("*** Add File: ") {
            let rel = rel.trim();
            let target = scoped(root, rel)?;
            if target.exists() {
                return Err(format!("file already exists: {rel}"));
            }
            let body = collect_body(&lines, &mut cursor);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut content = body
                .iter()
                .filter(|line| line.starts_with('+'))
                .map(|line| line[1..].to_owned())
                .collect::<Vec<_>>()
                .join("\n");
            if !content.is_empty() && !content.ends_with('\n') {
                content.push('\n');
            }
            fs::write(&target, &content).map_err(|e| e.to_string())?;
            changed.push(rel.to_owned());
            continue;
        }
        if let Some(rel) = header.strip_prefix("*** Delete File: ") {
            let rel = rel.trim();
            let target = scoped(root, rel)?;
            if !target.is_file() {
                return Err(format!("only regular files can be deleted: {rel}"));
            }
            fs::remove_file(&target).map_err(|e| e.to_string())?;
            changed.push(rel.to_owned());
            continue;
        }
        if let Some(rel) = header.strip_prefix("*** Update File: ") {
            let rel = rel.trim();
            let target = scoped(root, rel)?;
            let before =
                fs::read_to_string(&target).map_err(|e| format!("cannot read {rel}: {e}"))?;
            let body = collect_body(&lines, &mut cursor);
            let mut content = before.clone();
            for hunk in hunk_blocks(&body) {
                let (old, new) = interpret_hunk(&hunk);
                if old.trim().is_empty() {
                    return Err(format!(
                        "patch for {rel} must remove or replace existing content"
                    ));
                }
                // Apply each hunk against the latest in-memory content so a
                // multi-hunk section edits the same file consistently.
                let position = content
                    .find(&old)
                    .ok_or_else(|| format!("patch does not match current content: {rel}"))?;
                content = format!(
                    "{}{}{}",
                    &content[..position],
                    new,
                    &content[position + old.len()..]
                );
            }
            fs::write(&target, &content).map_err(|e| e.to_string())?;
            changed.push(rel.to_owned());
            continue;
        }
        return Err(format!("unknown patch section: {header}"));
    }
    if changed.is_empty() {
        return Err("patch contains no file sections".to_owned());
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

fn hunk_blocks(body: &[String]) -> Vec<Vec<String>> {
    let mut blocks: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for line in body {
        if line.trim() == "@@" {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
        } else {
            current.push(line.to_owned());
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    blocks
}

/// Interpret one hunk body. Classic unified form keeps ` ` context lines and
/// uses `-`/`+` for the old/new halves; a compact literal form pairs trailing
/// `-` lines with trailing `+` lines and has no context. Both must produce a
/// non-empty old half; the outer caller rejects otherwise.
fn interpret_hunk(hunk: &[String]) -> (String, String) {
    let mut old: Vec<&str> = Vec::new();
    let mut new: Vec<&str> = Vec::new();
    for line in hunk {
        if line.starts_with("-") {
            old.push(&line[1..]);
        } else if line.starts_with("+") {
            new.push(&line[1..]);
        } else if let Some(rest) = line.strip_prefix(' ') {
            // Context lines belong to both halves and let the anchor match a
            // wider window than a bare old-content search.
            old.push(rest);
            new.push(rest);
        }
    }
    (old.join("\n"), new.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
            &root,
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
            &root,
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
        assert!(!runtime_listing["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|item| item == ".tmp"));
        assert!(execute(
            &root,
            "read_file",
            &json!({"path":"runtime/.tmp/acceptance/run.ndjson"})
        )
        .is_err());

        fs::remove_dir_all(root).expect("cleanup");
    }
}
