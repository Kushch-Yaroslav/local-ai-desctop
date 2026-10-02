//! Exact unchanged-read detection. A read of the same path, range and file
//! revision already stored as an observation creates no new information; the
//! model is pointed at the stored observation instead. This is mechanical:
//! it compares recorded observation metadata and the current file revision and
//! makes no judgement about what is relevant.
use crate::agent::transcript::{Transcript, ValidatedCall};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

pub fn repeated_file_read_decision(
    call: &ValidatedCall,
    transcript: &Transcript,
    project_root: Option<&Path>,
) -> Result<(), String> {
    let Some(id) = repeated_file_read_observation(call, transcript, project_root) else {
        return Ok(());
    };
    let detail = if transcript
        .observation(&id)
        .is_some_and(|observation| observation.error)
    {
        "the previous read failed and the path is still missing"
    } else {
        "the file contents and requested range are unchanged"
    };
    Err(format!(
        "This exact read is already stored as observation {id}; {detail}. No new observation was created. Use observation_read(id=\"{id}\") to recover the stored result, or inspect a different file or range; do not repeat this unchanged read."
    ))
}

fn repeated_file_read_observation(
    call: &ValidatedCall,
    transcript: &Transcript,
    root: Option<&Path>,
) -> Option<String> {
    let path = call.arguments.get("path")?.as_str()?;
    let root = root?;
    let canonical_root = root.canonicalize().ok()?;
    let range = format!(
        "{} offset_chars={}",
        call.arguments
            .get("start_line")
            .and_then(Value::as_u64)
            .map(|start| {
                format!(
                    "lines {}-{}",
                    start,
                    call.arguments
                        .get("end_line")
                        .and_then(Value::as_u64)
                        .map_or("end".into(), |end| end.to_string())
                )
            })
            .unwrap_or_else(|| "all".into()),
        call.arguments
            .get("offset_chars")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    );
    if let Ok(file) = canonical_root.join(path).canonicalize() {
        if !file.starts_with(&canonical_root) {
            return None;
        }
        if let Ok(contents) = std::fs::read(&file) {
            let revision = format!("{:x}", Sha256::digest(contents));
            if let Some(observation) = transcript.observations().iter().rev().find(|observation| {
                observation.tool == "read_file"
                    && !observation.error
                    && observation
                        .source
                        .as_deref()
                        .and_then(|source| canonical_source_path(source, &canonical_root))
                        .as_deref()
                        == Some(file.as_path())
                    && observation.source_revision.as_deref() == Some(revision.as_str())
                    && observation.requested_range.as_deref() == Some(range.as_str())
            }) {
                return Some(observation.id.clone());
            }
        }
    }

    let requested_file = canonical_root.join(path);
    if requested_file.exists() {
        return None;
    }
    let project_path = requested_file.to_string_lossy().into_owned();
    transcript
        .observations()
        .iter()
        .rev()
        .find(|observation| {
            observation.tool == "read_file"
                && observation.error
                && observation.requested_range.as_deref() == Some(range.as_str())
                && observation
                    .source
                    .as_deref()
                    .is_some_and(|source| source == path || source == project_path)
        })
        .map(|observation| observation.id.clone())
}

fn canonical_source_path(source: &str, root: &Path) -> Option<std::path::PathBuf> {
    let path = Path::new(source);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let canonical = candidate.canonicalize().ok()?;
    canonical.starts_with(root).then_some(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn call(name: &str, args: Value) -> ValidatedCall {
        ValidatedCall {
            id: "call".into(),
            name: name.into(),
            arguments: args,
        }
    }
    #[test]
    fn research_rejects_repeated_unchanged_and_missing_file_reads() {
        let base = std::env::temp_dir().join(format!(
            "research-repeated-read-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let root = base.join("project");
        std::fs::create_dir_all(root.join("src/Shared/Interfaces")).unwrap();
        for name in ["item.ts", "Product.ts", "Category.ts"] {
            std::fs::write(root.join("src/Shared/Interfaces").join(name), name).unwrap();
        }
        let paths = [
            "item.ts",
            "Product.ts",
            "Category.ts",
            "Items.ts",
            "Products.ts",
        ]
        .map(|name| format!("src/Shared/Interfaces/{name}"));
        let mut transcript =
            Transcript::durable(&base.join("store"), "run", &[], root.to_str()).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit project implementation"}));
        let first_batch = paths
            .iter()
            .enumerate()
            .map(|(index, path)| ValidatedCall {
                id: format!("first-{index}"),
                name: "read_file".into(),
                arguments: json!({"path":path}),
            })
            .collect::<Vec<_>>();
        transcript.assistant_tool_turn(String::new(), &first_batch);
        for (index, path) in paths.iter().enumerate() {
            let file = root.join(path);
            let result = if file.exists() {
                json!({"path":path,"content":std::fs::read_to_string(file).unwrap()})
            } else {
                json!({"path":path,"error":"file not found"})
            };
            transcript.tool_result(&format!("first-{index}"), "read_file", result.to_string());
        }

        assert_eq!(transcript.observations().len(), 5);
        for (index, path) in paths.iter().enumerate() {
            let observation_id = transcript
                .observation_for_call(&format!("first-{index}"))
                .unwrap()
                .id
                .clone();
            let duplicate = ValidatedCall {
                id: format!("repeat-{index}"),
                name: "read_file".into(),
                arguments: json!({"path":path}),
            };
            let error =
                repeated_file_read_decision(&duplicate, &transcript, Some(&root)).unwrap_err();
            assert!(error.contains(&observation_id), "{error}");
            assert!(error.contains("observation_read"), "{error}");
        }
        assert_eq!(transcript.observations().len(), 5);

        std::fs::write(root.join(&paths[3]), "now present").unwrap();
        assert!(repeated_file_read_decision(
            &call("new-version", json!({"path":paths[3]})),
            &transcript,
            Some(&root)
        )
        .is_ok());
        std::fs::write(root.join(&paths[0]), "changed").unwrap();
        assert!(repeated_file_read_decision(
            &call("changed-version", json!({"path":paths[0]})),
            &transcript,
            Some(&root)
        )
        .is_ok());
        assert!(repeated_file_read_decision(
            &call("new-range", json!({"path":paths[1],"start_line":1})),
            &transcript,
            Some(&root)
        )
        .is_ok());
        std::fs::remove_dir_all(base).unwrap();
    }
}
