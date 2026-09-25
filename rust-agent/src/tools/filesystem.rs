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
        _ => Err(format!("unsupported filesystem tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
