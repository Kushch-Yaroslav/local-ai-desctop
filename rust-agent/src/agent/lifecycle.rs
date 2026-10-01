//! Finalization is a durable transcript state. This module classifies whether
//! a proposed tool operation is a bounded verification or renewed discovery.
//! It does not own a plan, evidence, or model-specific policy.
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

/// Keep the ordinary read and history tools available, but give each evidence
/// acquisition a concrete unresolved purpose during Closeout. The runtime
/// checks the same contract when a provider ignores its advertised schema.
pub fn closeout_schemas(schemas: &[Value], targets: &[String]) -> Vec<Value> {
    let mut result = schemas.to_vec();
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
    result
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
        "read_file" => unchanged_file_read(call, transcript, project_root),
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
            return Err(format!("Closeout already has unchanged evidence {id} for this exact operation. Use evidence_record or observation_read for the named gap; to verify a specific contradiction, supply verification_of={id} and verification_reason."));
        }
    }
    Ok(())
}

fn unchanged_file_read(
    call: &ValidatedCall,
    transcript: &Transcript,
    root: Option<&Path>,
) -> Option<String> {
    let path = call.arguments.get("path")?.as_str()?;
    let file = root?.join(path).canonicalize().ok()?;
    let revision = format!("{:x}", Sha256::digest(std::fs::read(&file).ok()?));
    let lines = call
        .arguments
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
        });
    let range = format!(
        "{} offset_chars={}",
        lines.unwrap_or("all".into()),
        call.arguments
            .get("offset_chars")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    );
    transcript
        .observations()
        .iter()
        .rev()
        .find(|observation| {
            observation.tool == "read_file"
                && !observation.error
                && observation
                    .source
                    .as_deref()
                    .and_then(|source| Path::new(source).canonicalize().ok())
                    .as_deref()
                    == Some(file.as_path())
                && observation.source_revision.as_deref() == Some(revision.as_str())
                && observation.requested_range.as_deref() == Some(range.as_str())
        })
        .map(|observation| observation.id.clone())
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
