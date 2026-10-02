//! Finalization is a durable transcript state. This module classifies whether
//! a proposed tool operation is a bounded verification or renewed discovery.
//! It does not own a plan, evidence, or model-specific policy.
use crate::agent::evidence::Observation;
use crate::agent::frontiers::{matches_target_source, EvidenceFrontier};
use crate::agent::research::ResearchController;
use crate::agent::transcript::{Transcript, ValidatedCall};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

fn closeout_acquisition(name: &str) -> bool {
    matches!(
        name,
        "read_file"
            | "list_directory"
            | "run_terminal"
            | "observation_index"
            | "observation_read"
            | "project_knowledge_index"
            | "project_knowledge_read"
    )
}

fn closeout_tool_available(name: &str) -> bool {
    closeout_acquisition(name)
        || matches!(
            name,
            "task_memory" | "evidence_record" | "evidence_frontier" | "begin_finalization"
        )
}

pub fn blocked_frontier_targets(
    frontiers: &[EvidenceFrontier],
    observations: &[Observation],
    closeout_targets: &[String],
) -> Vec<String> {
    frontiers
        .iter()
        .filter(|frontier| closeout_targets.iter().any(|target| target == &frontier.id))
        .filter(|frontier| {
            observations.iter().any(|observation| {
                observation.error
                    && observation
                        .source
                        .as_deref()
                        .is_some_and(|source| matches_target_source(frontier, source))
            })
        })
        .map(|frontier| frontier.id.clone())
        .collect()
}

/// Closeout permits targeted reads and evidence-state updates, not project
/// mutations. The runtime enforces the same set when a provider ignores its
/// advertised schema.
pub fn closeout_schemas(
    schemas: &[Value],
    targets: &[String],
    blocked_frontiers: &[String],
) -> Vec<Value> {
    let mut result = schemas
        .iter()
        .filter(|schema| {
            let name = schema
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            closeout_tool_available(name) && name != "evidence_frontier"
        })
        .cloned()
        .collect::<Vec<_>>();
    append_blocked_frontier_schema(schemas, &mut result, blocked_frontiers);
    for schema in &mut result {
        let name = schema
            .pointer("/function/name")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !closeout_acquisition(name) {
            continue;
        }
        if let Some(properties) = schema
            .pointer_mut("/function/parameters/properties")
            .and_then(Value::as_object_mut)
        {
            properties.insert("closeout_gap".into(), json!({"type":"string","enum":targets,"description":"Exact unresolved requested area or frontier ID this call will address."}));
            properties.insert("closeout_reason".into(), json!({"type":"string","description":"The specific fact, contradiction, or blocker this operation will establish for that gap. For an unchanged repeat, supply verification_of and verification_reason."}));
        }
        if let Some(required) = schema
            .pointer_mut("/function/parameters/required")
            .and_then(Value::as_array_mut)
        {
            required.push(json!("closeout_gap"));
            required.push(json!("closeout_reason"));
        } else {
            schema["function"]["parameters"]["required"] =
                json!(["closeout_gap", "closeout_reason"]);
        }
    }
    restrict_frontier_dispositions(&mut result, blocked_frontiers);
    result
}

pub fn research_schemas(schemas: &[Value], blocked_frontiers: &[String]) -> Vec<Value> {
    let mut result = schemas
        .iter()
        .filter(|schema| {
            schema.pointer("/function/name").and_then(Value::as_str) != Some("evidence_frontier")
        })
        .cloned()
        .collect::<Vec<_>>();
    append_blocked_frontier_schema(schemas, &mut result, blocked_frontiers);
    restrict_frontier_dispositions(&mut result, blocked_frontiers);
    result
}

pub fn finalizing_schemas(schemas: &[Value], blocked_frontiers: &[String]) -> Vec<Value> {
    let mut result = schemas
        .iter()
        .filter(|schema| {
            let name = schema
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            advertise_in_finalizing(name) && name != "evidence_frontier"
        })
        .cloned()
        .collect::<Vec<_>>();
    append_blocked_frontier_schema(schemas, &mut result, blocked_frontiers);
    restrict_frontier_dispositions(&mut result, blocked_frontiers);
    result
}

fn append_blocked_frontier_schema(
    schemas: &[Value],
    result: &mut Vec<Value>,
    blocked_frontiers: &[String],
) {
    if blocked_frontiers.is_empty() {
        return;
    }
    if let Some(schema) = schemas.iter().find(|schema| {
        schema.pointer("/function/name").and_then(Value::as_str) == Some("evidence_frontier")
    }) {
        result.push(schema.clone());
    }
}

fn restrict_frontier_dispositions(result: &mut [Value], blocked_frontiers: &[String]) {
    for schema in result {
        if schema.pointer("/function/name").and_then(Value::as_str) != Some("evidence_frontier") {
            continue;
        }
        let properties = schema
            .pointer_mut("/function/parameters/properties")
            .and_then(Value::as_object_mut);
        if let Some(properties) = properties {
            properties.insert(
                "id".into(),
                json!({"type":"string","enum":blocked_frontiers}),
            );
            properties.insert(
                "outcome".into(),
                json!({"type":"string","enum":["blocked"]}),
            );
        }
    }
}

/// A duplicate unchanged read cannot establish a new closeout finding by
/// itself. Exact reinspection remains possible when tied to the prior
/// observation and a specific verification question.
pub fn closeout_decision(
    call: &ValidatedCall,
    transcript: &Transcript,
    research: &ResearchController,
    project_root: Option<&Path>,
) -> Result<(), String> {
    if !closeout_tool_available(&call.name) {
        return Err(format!(
            "Tool '{}' is unavailable during targeted closeout; use source reads and evidence-state updates until the requested gaps are grounded",
            call.name
        ));
    }
    if !closeout_acquisition(&call.name) {
        return Ok(());
    }
    let targets = research.closeout_targets();
    let gap = call
        .arguments
        .get("closeout_gap")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !targets.iter().any(|target| target == gap) {
        return Err(format!(
            "Closeout requires one current unresolved closeout_gap: {}",
            targets.join(", ")
        ));
    }
    if !call
        .arguments
        .get("closeout_reason")
        .and_then(Value::as_str)
        .is_some_and(|reason| !reason.trim().is_empty())
    {
        return Err(format!(
            "Closeout call for {gap} needs a specific closeout_reason"
        ));
    }
    let previous = match call.name.as_str() {
        "read_file" => repeated_file_read_observation(call, transcript, project_root),
        "run_terminal" => repeated_terminal_command(call, transcript),
        _ => None,
    };
    if let Some(id) = previous {
        let anchored = call
            .arguments
            .get("verification_of")
            .and_then(Value::as_str)
            == Some(id.as_str())
            && call
                .arguments
                .get("verification_reason")
                .and_then(Value::as_str)
                .is_some_and(|reason| !reason.trim().is_empty());
        if !anchored {
            return Err(format!("Closeout already has observation {id} for this exact unchanged operation. Use evidence_record or observation_read for the named gap; to verify a specific contradiction, supply verification_of={id} and verification_reason."));
        }
    }
    Ok(())
}

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

fn repeated_terminal_command(call: &ValidatedCall, transcript: &Transcript) -> Option<String> {
    let command = call.arguments.get("command")?.as_str()?;
    transcript
        .observations()
        .iter()
        .rev()
        .filter(|observation| observation.tool == "run_terminal" && !observation.error)
        .find_map(|observation| {
            transcript
                .entries()
                .iter()
                .any(|entry| match entry {
                    crate::agent::transcript::Entry::Message(message) => message
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .is_some_and(|calls| {
                            calls.iter().any(|prior| {
                                prior.get("id").and_then(Value::as_str)
                                    == Some(observation.call_id.as_str())
                                    && prior
                                        .pointer("/function/arguments")
                                        .and_then(Value::as_str)
                                        .and_then(|args| serde_json::from_str::<Value>(args).ok())
                                        .and_then(|args| {
                                            args.get("command")
                                                .and_then(Value::as_str)
                                                .map(str::to_owned)
                                        })
                                        .as_deref()
                                        == Some(command)
                            })
                        }),
                    _ => false,
                })
                .then(|| observation.id.clone())
        })
}

pub fn advertise_in_finalizing(name: &str) -> bool {
    matches!(
        name,
        "task_memory"
            | "evidence_record"
            | "evidence_frontier"
            | "begin_finalization"
            | "observation_read"
            | "read_file"
            | "project_knowledge_read"
            | "run_terminal"
    )
}

pub fn verification_decision(
    call: &ValidatedCall,
    transcript: &Transcript,
) -> Result<&'static str, &'static str> {
    match call.name.as_str() {
        "task_memory" | "evidence_record" | "evidence_frontier" | "begin_finalization" => {
            Ok("durable_state")
        }
        "observation_read" => {
            require_reason(&call.arguments)?;
            let id = call
                .arguments
                .get("id")
                .and_then(Value::as_str)
                .ok_or("missing_observation_id")?;
            if transcript.observation(id).is_some() {
                Ok("exact_historical_verification")
            } else {
                Err("unknown_observation_id")
            }
        }
        "read_file" | "project_knowledge_read" | "run_terminal" => {
            require_reason(&call.arguments)?;
            let id = call
                .arguments
                .get("verification_of")
                .and_then(Value::as_str)
                .ok_or("missing_evidence_anchor")?;
            if transcript.observation(id).is_none() {
                return Err("unknown_evidence_anchor");
            }
            let specific = match call.name.as_str() {
                "read_file" => call
                    .arguments
                    .get("path")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty()),
                "project_knowledge_read" => call
                    .arguments
                    .get("paths")
                    .and_then(Value::as_array)
                    .is_some_and(|a| !a.is_empty()),
                "run_terminal" => call
                    .arguments
                    .get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty()),
                _ => false,
            };
            if specific {
                Ok("source_anchored_verification")
            } else {
                Err("missing_specific_target")
            }
        }
        _ => Err("broad_discovery_after_finalization"),
    }
}

fn require_reason(args: &Value) -> Result<(), &'static str> {
    if args
        .get("verification_reason")
        .and_then(Value::as_str)
        .is_some_and(|s| s.trim().chars().count() >= 12)
    {
        Ok(())
    } else {
        Err("missing_specific_verification_reason")
    }
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
    fn closeout_requires_an_actual_gap_and_preserves_targeted_source_work() {
        let base = std::env::temp_dir().join(format!(
            "closeout-source-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let root = base.join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/SEO.tsx"), "export const title = 'shop';").unwrap();
        std::fs::write(root.join("src/order.ts"), "submitOrder();").unwrap();
        let mut transcript =
            Transcript::durable(&base.join("store"), "run", &[], root.to_str()).unwrap();
        transcript.push_run_user(
            json!({"role":"user","content":"audit product backend history quality"}),
        );
        let source = root.join("src/SEO.tsx").to_string_lossy().into_owned();
        let prior = call("read_file", json!({"path":source}));
        transcript.assistant_tool_turn(String::new(), &[prior]);
        transcript.tool_result(
            "call",
            "read_file",
            json!({"path":source,"content":"export const title = 'shop';"}).to_string(),
        );
        let id = transcript.observations()[0].id.clone();
        let research =
            ResearchController::with_depth("audit product backend history quality", true);
        let schemas = closeout_schemas(
            &[
                json!({"type":"function","function":{"name":"read_file","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}),
            ],
            &research.closeout_targets(),
            &[],
        );
        assert!(schemas[0]["function"]["parameters"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("closeout_gap")));
        assert!(schemas[0]["function"]["parameters"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("closeout_reason")));
        assert!(closeout_decision(
            &call("read_file", json!({"path":source})),
            &transcript,
            &research,
            Some(&root)
        )
        .is_err());
        let repeated = call(
            "read_file",
            json!({"path":source,"closeout_gap":"backend/order flow","closeout_reason":"check checkout flow"}),
        );
        let error = closeout_decision(&repeated, &transcript, &research, Some(&root)).unwrap_err();
        assert!(error.contains(&id));
        let verified = call(
            "read_file",
            json!({"path":source,"closeout_gap":"backend/order flow","closeout_reason":"check a concrete contradiction","verification_of":id,"verification_reason":"the prior source conflicts with checkout evidence"}),
        );
        assert!(closeout_decision(&verified, &transcript, &research, Some(&root)).is_ok());
        let new_target = call(
            "read_file",
            json!({"path":root.join("src/order.ts"),"closeout_gap":"backend/order flow","closeout_reason":"inspect the order submission target"}),
        );
        assert!(closeout_decision(&new_target, &transcript, &research, Some(&root)).is_ok());
        assert_eq!(transcript.observations().len(), 1);
        std::fs::remove_dir_all(base).unwrap();
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

    #[test]
    fn closeout_hides_project_mutations_and_rejects_them_at_execution() {
        let names = [
            "read_file",
            "run_terminal",
            "task_memory",
            "evidence_record",
            "evidence_frontier",
            "begin_finalization",
            "write_file",
            "project_knowledge_update",
        ];
        let schemas = names
            .iter()
            .map(|name| {
                json!({"type":"function","function":{"name":name,"parameters":{"type":"object","properties":{},"required":[]}}})
            })
            .collect::<Vec<_>>();
        let research = ResearchController::with_depth("audit backend order flow", true);
        let closeout = closeout_schemas(&schemas, &research.closeout_targets(), &[]);
        let available = closeout
            .iter()
            .filter_map(|schema| schema.pointer("/function/name").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert!(available.contains(&"read_file"));
        assert!(available.contains(&"run_terminal"));
        assert!(available.contains(&"task_memory"));
        assert!(available.contains(&"evidence_record"));
        assert!(!available.contains(&"evidence_frontier"));
        assert!(available.contains(&"begin_finalization"));
        assert!(!available.contains(&"write_file"));
        assert!(!available.contains(&"project_knowledge_update"));

        for name in ["write_file", "project_knowledge_update"] {
            assert!(closeout_decision(
                &call(name, json!({})),
                &Transcript::default(),
                &research,
                None
            )
            .unwrap_err()
            .contains("unavailable during targeted closeout"));
        }
    }

    #[test]
    fn closeout_frontier_disposition_requires_target_specific_error_observation() {
        let frontier = EvidenceFrontier {
            id: "frontier-source-00".into(),
            from_observation: "source".into(),
            source: "/project/src/Form.tsx".into(),
            target: "api.php".into(),
            resolved_path: Some("/project/public/api.php".into()),
            project_relative_path: Some("public/api.php".into()),
            resolution: Some("configured public root".into()),
        };
        let observation = |id: &str, source: &str, error| Observation {
            id: id.into(),
            event_id: format!("event-{id}"),
            call_id: format!("call-{id}"),
            tool: "read_file".into(),
            source: Some(source.into()),
            source_revision: None,
            requested_range: None,
            returned_range: None,
            error,
            body_sha256: String::new(),
            body_bytes: 0,
        };
        let targets = vec![frontier.id.clone()];
        let schemas = vec![
            json!({"type":"function","function":{"name":"evidence_frontier","parameters":{"type":"object","properties":{"id":{"type":"string"},"outcome":{"type":"string","enum":["blocked","irrelevant"]},"reason":{"type":"string"},"observation_id":{"type":"string"}},"required":["id","outcome","reason","observation_id"]}}}),
            json!({"type":"function","function":{"name":"evidence_record","parameters":{"type":"object","properties":{},"required":[]}}}),
        ];

        let successful_target_read = observation("success", "/project/public/api.php", false);
        let unrelated_error = observation("other-error", "/project/src/Form.tsx", true);
        let no_disposition = blocked_frontier_targets(
            std::slice::from_ref(&frontier),
            &[successful_target_read, unrelated_error],
            &targets,
        );
        assert!(no_disposition.is_empty());
        let research_hidden = research_schemas(&schemas, &no_disposition);
        assert!(!research_hidden.iter().any(|schema| schema
            .pointer("/function/name")
            .and_then(Value::as_str)
            == Some("evidence_frontier")));
        let hidden = closeout_schemas(&schemas, &targets, &no_disposition);
        assert!(!hidden.iter().any(|schema| schema
            .pointer("/function/name")
            .and_then(Value::as_str)
            == Some("evidence_frontier")));
        assert!(hidden.iter().any(|schema| schema
            .pointer("/function/name")
            .and_then(Value::as_str)
            == Some("evidence_record")));

        let target_error = observation("target-error", "/project/public/api.php", true);
        let available =
            blocked_frontier_targets(std::slice::from_ref(&frontier), &[target_error], &targets);
        assert_eq!(available, vec![frontier.id]);
        let research_enabled = research_schemas(&schemas, &available);
        let research_frontiers = research_enabled
            .iter()
            .filter(|schema| {
                schema.pointer("/function/name").and_then(Value::as_str)
                    == Some("evidence_frontier")
            })
            .collect::<Vec<_>>();
        assert_eq!(research_frontiers.len(), 1);
        assert_eq!(
            research_frontiers[0].pointer("/function/parameters/properties/outcome/enum"),
            Some(&json!(["blocked"]))
        );
        let enabled = closeout_schemas(&schemas, &targets, &available);
        let frontier_schema = enabled
            .iter()
            .find(|schema| {
                schema.pointer("/function/name").and_then(Value::as_str)
                    == Some("evidence_frontier")
            })
            .unwrap();
        assert_eq!(
            frontier_schema.pointer("/function/parameters/properties/id/enum"),
            Some(&json!(["frontier-source-00"]))
        );
        assert_eq!(
            frontier_schema.pointer("/function/parameters/properties/outcome/enum"),
            Some(&json!(["blocked"]))
        );
        assert!(closeout_decision(
            &call(
                "evidence_frontier",
                json!({"id":"frontier-source-00","outcome":"blocked","reason":"target read is unavailable","observation_id":"target-error"}),
            ),
            &Transcript::default(),
            &ResearchController::with_depth("audit backend order flow", true),
            None,
        )
        .is_ok());

        let finalizing_hidden = finalizing_schemas(&schemas, &[]);
        assert!(!finalizing_hidden.iter().any(|schema| schema
            .pointer("/function/name")
            .and_then(Value::as_str)
            == Some("evidence_frontier")));
        let finalizing_enabled = finalizing_schemas(&schemas, &available);
        assert!(finalizing_enabled.iter().any(|schema| schema
            .pointer("/function/name")
            .and_then(Value::as_str)
            == Some("evidence_frontier")));
    }

    #[test]
    fn closeout_reuses_terminal_history_only_for_anchored_verification() {
        let base = std::env::temp_dir().join(format!(
            "closeout-terminal-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let mut transcript = Transcript::durable(&base, "run", &[], None).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit history"}));
        transcript.assistant_tool_turn(
            String::new(),
            &[call(
                "run_terminal",
                json!({"command":"git log --oneline -20"}),
            )],
        );
        transcript.tool_result(
            "call",
            "run_terminal",
            json!({"command":"git log --oneline -20","stdout":"history"}).to_string(),
        );
        let id = transcript.observations()[0].id.clone();
        let research = ResearchController::with_depth("audit history", true);
        let repeated = call(
            "run_terminal",
            json!({"command":"git log --oneline -20","closeout_gap":"history/evolution","closeout_reason":"inspect project evolution"}),
        );
        assert!(closeout_decision(&repeated, &transcript, &research, None)
            .unwrap_err()
            .contains(&id));
        let targeted = call(
            "run_terminal",
            json!({"command":"git log --oneline -20","closeout_gap":"history/evolution","closeout_reason":"check a concrete contradiction","verification_of":id,"verification_reason":"confirm whether HEAD changed since the observation"}),
        );
        assert!(closeout_decision(&targeted, &transcript, &research, None).is_ok());
        let new_command = call(
            "run_terminal",
            json!({"command":"git log --stat -5","closeout_gap":"history/evolution","closeout_reason":"inspect the scope of recent changes"}),
        );
        assert!(closeout_decision(&new_command, &transcript, &research, None).is_ok());
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn generic_discovery_is_redirected_but_exact_verification_remains_possible() {
        let transcript = Transcript::default();
        assert_eq!(
            verification_decision(&call("list_directory", json!({"path":"."})), &transcript),
            Err("broad_discovery_after_finalization")
        );
        assert_eq!(
            verification_decision(&call("observation_index", json!({})), &transcript),
            Err("broad_discovery_after_finalization")
        );
        assert_eq!(
            verification_decision(
                &call("read_file", json!({"path":"src/lib.ts"})),
                &transcript
            ),
            Err("missing_specific_verification_reason")
        );
        assert!(
            verification_decision(&call("task_memory", json!({"action":"view"})), &transcript)
                .is_ok()
        );
    }

    #[test]
    fn anchored_verification_recovers_exact_evidence_without_reopening_research() {
        let base = std::env::temp_dir().join(format!(
            "targeted-verification-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let mut transcript = Transcript::durable(&base, "run", &[], None).unwrap();
        transcript.push_run_user(json!({"role":"user","content":"audit"}));
        transcript.assistant_tool_turn(
            String::new(),
            &[call("read_file", json!({"path":"src/endpoint.ts"}))],
        );
        transcript.tool_result(
            "call",
            "read_file",
            json!({"content":"EXACT_BACKEND_VALUE"}).to_string(),
        );
        let id = transcript.observations()[0].id.clone();
        transcript.mark_finalizing();
        let exact = call(
            "observation_read",
            json!({"id":id,"verification_reason":"Resolve the exact backend value"}),
        );
        assert_eq!(
            verification_decision(&exact, &transcript),
            Ok("exact_historical_verification")
        );
        assert!(transcript
            .read_observation(&id, 0, 200)
            .unwrap()
            .to_string()
            .contains("EXACT_BACKEND_VALUE"));
        let live = call(
            "read_file",
            json!({"path":"src/endpoint.ts","verification_of":id,"verification_reason":"Check a specific source contradiction"}),
        );
        assert_eq!(
            verification_decision(&live, &transcript),
            Ok("source_anchored_verification")
        );
        let broad = call(
            "read_file",
            json!({"path":"src/other.ts","verification_reason":"Look around the repository"}),
        );
        assert_eq!(
            verification_decision(&broad, &transcript),
            Err("missing_evidence_anchor")
        );
        assert!(transcript.is_finalizing());
        drop(transcript);
        std::fs::remove_dir_all(base).unwrap();
    }
}
