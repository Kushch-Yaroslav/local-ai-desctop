//! End-to-end regressions for the agent loop against a scripted OpenAI-style
//! provider. They assert runtime-owned behavior only: what the model is offered
//! and told, when a tool-free reply completes the run, and that the run can
//! never be blocked from answering. They contain no project- or model-specific
//! knowledge.

use local_ai_agent_runtime::agent::loop_runtime::{
    run, Config, MAX_INVESTIGATION_TURNS, MAX_SYNTHESIS_TURNS,
};
use local_ai_agent_runtime::agent::policy::RunPolicy;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

static NEXT: AtomicUsize = AtomicUsize::new(0);

#[test]
fn two_project_reads_have_distinct_evidence_and_model_visible_scope() {
    let fixture = Workspace::new(&[("first-only.txt", "primary identity")]);
    let secondary = fixture.base.join("secondary");
    std::fs::create_dir_all(&secondary).unwrap();
    std::fs::write(secondary.join("second-only.txt"), "secondary identity").unwrap();
    let secondary_name = secondary.to_string_lossy().into_owned();
    let expected = secondary_name.clone();
    let provider = Provider::start(move |request, turn| {
        assert!(request["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains(&expected));
        if turn == 0 {
            assert!(request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["function"]["name"] == "read_file"
                    && tool["function"]["parameters"]["properties"]["project"]["enum"]
                        == json!([1, 2])));
            Reply::Tools(vec![
                ("read_file", json!({"path":"first-only.txt","project":1})),
                ("read_file", json!({"path":"second-only.txt","project":2})),
            ])
        } else {
            let tools = request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["role"] == "tool")
                .map(|entry| entry["content"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert!(tools.iter().any(|body| body.contains("primary identity")));
            assert!(tools.iter().any(|body| body.contains("secondary identity")));
            Reply::Text("Project 1: obs-00000001. Project 2: obs-00000002.".into())
        }
    });
    let mut config = fixture.config(&provider.endpoint, "read-only compare two projects");
    config.secondary_root = Some(secondary_name.clone());
    run(config);
    let evidence = fixture.base.join("evidence");
    let active: Value =
        serde_json::from_slice(&std::fs::read(evidence.join("active.json")).unwrap()).unwrap();
    let journal = std::fs::read_to_string(
        evidence
            .join(active["run_dir"].as_str().unwrap())
            .join("events.jsonl"),
    )
    .unwrap();
    let observations = journal
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter_map(|entry| {
            entry
                .get("observation")
                .filter(|observation| !observation.is_null())
                .cloned()
        })
        .collect::<Vec<_>>();
    assert_eq!(observations.len(), 2);
    assert_eq!(observations[0]["source"], "first-only.txt");
    assert_eq!(
        observations[1]["source"],
        format!("{secondary_name}/second-only.txt")
    );
    assert!(observations
        .iter()
        .all(|observation| observation["source_revision"].as_str().is_some()));
}

#[test]
fn steering_at_completion_is_applied_before_final_and_replays() {
    let fixture = Workspace::new(&[("identity.txt", "steering evidence")]);
    let queue = Arc::new(Mutex::new(Vec::new()));
    let incoming = queue.clone();
    let provider = Provider::start(move |request, turn| {
        if turn == 0 {
            incoming
                .lock()
                .unwrap()
                .push("Read identity.txt before answering; include STEER_OK.".into());
            Reply::Text("Premature answer".into())
        } else if turn == 1 {
            assert!(request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["role"] == "user"
                    && entry["content"]
                        .as_str()
                        .is_some_and(|text| text.contains("STEER_OK"))));
            Reply::Tools(vec![("read_file", json!({"path":"identity.txt"}))])
        } else {
            Reply::Text("STEER_OK".into())
        }
    });
    let mut config = fixture.config(&provider.endpoint, "inspect");
    config.steering = queue;
    run(config);
    let history = vec![
        json!({"role":"user","content":"inspect"}),
        json!({"role":"user","content":"Read identity.txt before answering; include STEER_OK."}),
        json!({"role":"assistant","content":"STEER_OK"}),
    ];
    let restored = local_ai_agent_runtime::agent::transcript::Transcript::durable(
        &fixture.base.join("evidence"),
        "next-run",
        &history,
        fixture.root.to_str(),
    )
    .unwrap();
    assert!(restored.entries().iter().any(|entry| matches!(entry, local_ai_agent_runtime::agent::transcript::Entry::Steering(content) if content.contains("STEER_OK"))));
    assert_eq!(restored.observations().len(), 1);
}

enum Reply {
    Text(String),
    /// Only reasoning, no content and no structured call.
    Reasoning(String),
    Tools(Vec<(&'static str, Value)>),
    /// Reasoning streamed first, then structured calls.
    ReasonedTools(String, Vec<(&'static str, Value)>),
    /// Reasoning streamed first, then visible content.
    ReasonedText(String, String),
}

struct Provider {
    endpoint: String,
    requests: Arc<Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
}

impl Provider {
    fn start(mut script: impl FnMut(&Value, usize) -> Reply + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (log, halt) = (requests.clone(), stop.clone());
        listener.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            let mut served = 0_usize;
            while !halt.load(Ordering::Relaxed) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                let mut raw = Vec::new();
                let mut chunk = [0_u8; 8192];
                let (body_start, length) = loop {
                    let read = stream.read(&mut chunk).unwrap();
                    raw.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        break (end + 4, length);
                    }
                };
                while raw.len() < body_start + length {
                    let read = stream.read(&mut chunk).unwrap();
                    raw.extend_from_slice(&chunk[..read]);
                }
                let request: Value =
                    serde_json::from_slice(&raw[body_start..body_start + length]).unwrap();
                let reply = script(&request, served);
                log.lock().unwrap().push(request);
                served += 1;
                let mut out = String::from("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
                let frame = |delta: Value, finish: Option<&str>| {
                    format!(
                        "data: {}\n\n",
                        json!({"choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
                    )
                };
                match reply {
                    Reply::Text(text) => {
                        out.push_str(&frame(json!({"content": text}), None));
                        out.push_str(&frame(json!({}), Some("stop")));
                    }
                    Reply::Reasoning(text) => {
                        out.push_str(&frame(json!({"reasoning_content": text}), None));
                        out.push_str(&frame(json!({}), Some("stop")));
                    }
                    Reply::ReasonedText(reasoning, text) => {
                        out.push_str(&frame(json!({"reasoning_content": reasoning}), None));
                        out.push_str(&frame(json!({"content": text}), None));
                        out.push_str(&frame(json!({}), Some("stop")));
                    }
                    Reply::ReasonedTools(reasoning, calls) => {
                        out.push_str(&frame(json!({"reasoning_content": reasoning}), None));
                        let calls = calls
                            .into_iter()
                            .enumerate()
                            .map(|(index, (name, arguments))| json!({"index":index,"id":format!("call_{served}_{index}"),"type":"function","function":{"name":name,"arguments":arguments.to_string()}}))
                            .collect::<Vec<_>>();
                        out.push_str(&frame(json!({"tool_calls": calls}), None));
                        out.push_str(&frame(json!({}), Some("tool_calls")));
                    }
                    Reply::Tools(calls) => {
                        let calls = calls
                            .into_iter()
                            .enumerate()
                            .map(|(index, (name, arguments))| json!({"index":index,"id":format!("call_{served}_{index}"),"type":"function","function":{"name":name,"arguments":arguments.to_string()}}))
                            .collect::<Vec<_>>();
                        out.push_str(&frame(json!({"tool_calls": calls}), None));
                        out.push_str(&frame(json!({}), Some("tool_calls")));
                    }
                }
                out.push_str("data: [DONE]\n\n");
                let _ = stream.write_all(out.as_bytes());
            }
        });
        Self {
            endpoint,
            requests,
            stop,
        }
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

struct Workspace {
    base: PathBuf,
    root: PathBuf,
}

impl Workspace {
    fn new(files: &[(&str, &str)]) -> Self {
        let base = std::env::temp_dir().join(format!(
            "agent-loop-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let root = base.join("project");
        for (path, content) in files {
            let full = root.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, content).unwrap();
        }
        Self {
            root: root.canonicalize().unwrap(),
            base,
        }
    }

    fn config(&self, endpoint: &str, user: &str) -> Config {
        Config {
            run_id: format!("run-{}", NEXT.fetch_add(1, Ordering::Relaxed)),
            endpoint: endpoint.into(),
            model: "scripted".into(),
            system: "system".into(),
            user: user.into(),
            root: Some(self.root.to_string_lossy().into_owned()),
            secondary_root: None,
            context_limit: 65_536,
            reasoning_mode: "fast".into(),
            supports_reasoning: true,
            policy: RunPolicy::Auto,
            history: Vec::new(),
            evidence_dir: Some(self.base.join("evidence").to_string_lossy().into_owned()),
            task_memory: None,
            provider_max_output: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            steering: Arc::new(Mutex::new(Vec::new())),
            steering_closed: Arc::new(AtomicBool::new(false)),
        }
    }

    fn journal(&self) -> Vec<Value> {
        let evidence = self.base.join("evidence");
        let active: Value =
            serde_json::from_slice(&std::fs::read(evidence.join("active.json")).unwrap()).unwrap();
        let path = evidence
            .join(active["run_dir"].as_str().unwrap())
            .join("events.jsonl");
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["entry"].clone())
            .collect()
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

const READ_ONLY: &str =
    "Audit the product, architecture, backend, history and quality. Do not modify files.";

fn withheld_drafts(journal: &[Value]) -> usize {
    journal
        .iter()
        .filter(|entry| entry.pointer("/Message/_runtime_draft_status").is_some())
        .count()
}

fn completed(journal: &[Value]) -> bool {
    journal.iter().any(|entry| entry == &json!("RunComplete"))
}

fn last_user_text(request: &Value) -> String {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .filter(|m| m["role"] == "user")
        .map(|m| m["content"].as_str().unwrap_or("").to_owned())
        .collect::<Vec<_>>()
        .join("\n---\n")
}

fn tool_names(request: &Value) -> Vec<String> {
    request["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|t| {
                    t.pointer("/function/name")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

const SHOP: &[(&str, &str)] = &[
    ("package.json", "{\"name\":\"shop\"}"),
    (
        "src/Form.tsx",
        "export const send = () => fetch('api.php', { method: 'POST' });",
    ),
    ("src/Home.tsx", "export const home = 1;"),
    ("public/api.php", "<?php echo 'ok';"),
];

/// Failure shape: prose naming requested areas (a plan note, narration) used to
/// be graded as coverage, which drove closeout/finalization transitions and
/// blocked or forced final answers. A tool-free reply must simply complete.
#[test]
fn a_tool_free_answer_completes_regardless_of_plan_notes_and_area_words() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            ("read_file", json!({"path":"src/Home.tsx"})),
            ("read_file", json!({"path":"package.json"})),
        ]),
        1 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"record","finding":"Plan: audit product, architecture, backend order flow, history and quality","evidence":"obs-00000001, obs-00000002","next":"read backend"}),
        )]),
        _ => Reply::Text("Final audit: product, architecture, backend, history, quality.".into()),
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 0, "no draft may be withheld");
    let requests = provider.requests();
    assert_eq!(requests.len(), 3, "answer on the first tool-free reply");
    for request in &requests {
        let text = request.to_string();
        for removed in [
            "closeout_gap",
            "closeout_reason",
            "evidence_record",
            "evidence_frontier",
            "begin_finalization",
            "verification_of",
        ] {
            assert!(!text.contains(removed), "{removed}");
        }
        assert!(tool_names(request).contains(&"read_file".to_owned()));
    }
}

/// Failure shape: a final answer must never be blocked by a condition the
/// model cannot see or satisfy. The only deviation from "tool-free completes"
/// is one bounded reminder, and it names concrete files.
#[test]
fn unopened_requested_files_get_exactly_one_reminder_and_never_block_the_answer() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"src/Form.tsx"}))]),
        1 => Reply::Text("Draft A: there is no backend.".into()),
        _ => Reply::Text("Draft B: the form posts to api.php, which I did not inspect.".into()),
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(
        withheld_drafts(&journal),
        1,
        "only the first draft is held back"
    );
    let requests = provider.requests();
    assert_eq!(requests.len(), 3);
    let reminded = last_user_text(&requests[2]);
    assert!(reminded.contains("Before finishing"), "{reminded}");
    assert!(reminded.contains("public/api.php"), "{reminded}");
    assert!(
        !last_user_text(&requests[1]).contains("Before finishing"),
        "no reminder before a draft exists"
    );
    // the state the model sees names the unopened target on every turn
    assert!(
        last_user_text(&requests[1]).contains("public/api.php <- request/submit target 'api.php'")
    );
    let accepted = journal
        .iter()
        .rev()
        .find_map(|e| {
            e.pointer("/Message/content")
                .and_then(Value::as_str)
                .filter(|c| c.starts_with("Draft"))
        })
        .unwrap();
    assert!(accepted.starts_with("Draft B"));
}

#[test]
fn opening_the_requested_file_removes_the_reminder_and_answer_is_accepted_immediately() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"src/Form.tsx"}))]),
        1 => Reply::Tools(vec![("read_file", json!({"path":"public/api.php"}))]),
        _ => Reply::Text("The form posts to api.php, which echoes ok.".into()),
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 0);
    assert_eq!(provider.requests().len(), 3);
}

#[test]
fn no_reminder_without_a_concrete_unopened_request() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"src/Home.tsx"}))]),
        _ => Reply::Text("Home exports a constant.".into()),
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    assert_eq!(withheld_drafts(&workspace.journal()), 0);
    assert_eq!(provider.requests().len(), 2);
}

/// Failure shape: exhausting the turn budget used to end the run with an error
/// and no answer. Tools are now withdrawn and the run still produces one.
#[test]
fn exhausting_the_turn_budget_withdraws_tools_and_still_answers() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|request, _| {
        if request.get("tools").is_some() {
            Reply::Tools(vec![("list_directory", json!({"path":"."}))])
        } else {
            Reply::Text("Answer from what was inspected; the rest was not examined.".into())
        }
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    let journal = workspace.journal();
    assert!(completed(&journal), "run must end with an accepted answer");
    let requests = provider.requests();
    assert_eq!(requests.len(), MAX_INVESTIGATION_TURNS + 1);
    assert!(MAX_SYNTHESIS_TURNS >= 1);
    let last = requests.last().unwrap();
    assert!(last.get("tools").is_none() && last.get("tool_choice").is_none());
    assert!(last_user_text(last).contains("MODE: FINALIZING"));
    assert!(tool_names(&requests[MAX_INVESTIGATION_TURNS - 1]).contains(&"read_file".to_owned()));
}

/// A provider that keeps calling tools during synthesis gets an explicit
/// instruction instead of silently looping, and the run stays bounded.
#[test]
fn tool_calls_during_synthesis_are_answered_with_an_instruction_to_write_the_answer() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|request, _| {
        let finalizing = request.get("tools").is_none();
        let already_told = request["messages"].as_array().unwrap().iter().any(|m| {
            m["role"] == "tool"
                && m["content"]
                    .as_str()
                    .is_some_and(|c| c.contains("Write the final answer now"))
        });
        if finalizing && already_told {
            Reply::Text("Final answer.".into())
        } else {
            Reply::Tools(vec![("list_directory", json!({"path":"."}))])
        }
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    assert!(completed(&workspace.journal()));
    assert_eq!(provider.requests().len(), MAX_INVESTIGATION_TURNS + 2);
}

/// Failure shape: protocol misfires during synthesis (markup instead of an
/// answer, repeated tool calls) consumed a three-turn allowance and ended the
/// run in `turn_limit` without an answer. Misfires get an instruction that
/// matches the mode, and the allowance covers many of them.
#[test]
fn repeated_synthesis_misfires_still_end_in_an_answer() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|request, _| {
        if request.get("tools").is_some() {
            return Reply::Tools(vec![("list_directory", json!({"path":"."}))]);
        }
        let misfires = request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| {
                m["role"] == "tool"
                    && m["content"]
                        .as_str()
                        .is_some_and(|c| c.contains("Write the final answer now"))
            })
            .count();
        match misfires {
            0..=4 => Reply::Tools(vec![("list_directory", json!({"path":"."}))]),
            _ => Reply::Text("Answer after several misfires.".into()),
        }
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    assert!(completed(&workspace.journal()));
    assert_eq!(provider.requests().len(), MAX_INVESTIGATION_TURNS + 6);
    let reminded = last_user_text(provider.requests().last().unwrap());
    assert!(!reminded.contains("Emit a complete structured tool call"));
}

/// Failure shape: a turn that produced neither content nor a structured call
/// (a tool call written inside the reasoning stream is never executed) used to
/// complete the run with an empty answer.
#[test]
fn an_empty_response_never_completes_the_run() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| {
        match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"src/Home.tsx"}))]),
        1 => Reply::Reasoning("Next I will read more.<tool_call>read_file<arg_key>path</arg_key><arg_value>src</arg_value></tool_call>".into()),
        _ => Reply::Text("The real answer.".into()),
    }
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    let journal = workspace.journal();
    assert!(completed(&journal));
    let requests = provider.requests();
    assert_eq!(requests.len(), 3);
    assert!(last_user_text(&requests[2]).contains("neither an answer nor a structured tool call"));
    assert!(tool_names(&requests[2]).contains(&"read_file".to_owned()));
    let answers = journal
        .iter()
        .filter_map(|e| e.pointer("/Message/content").and_then(Value::as_str))
        .filter(|c| c.contains("The real answer"))
        .count();
    assert_eq!(answers, 1);
}

#[test]
fn persistent_empty_responses_force_a_tool_free_answer_turn() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|request, _| {
        if request.get("tools").is_some() {
            Reply::Text(String::new())
        } else {
            Reply::Text("Answer once tools were withdrawn.".into())
        }
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    assert!(completed(&workspace.journal()));
    let requests = provider.requests();
    assert_eq!(requests.len(), 4);
    let last = requests.last().unwrap();
    assert!(last.get("tools").is_none());
    assert!(last_user_text(last).contains("MODE: FINALIZING"));
}

#[test]
fn reasoning_only_finalizing_turn_retries_without_reasoning_and_accepts_visible_answer() {
    let workspace = Workspace::new(SHOP);
    let mut config = workspace.config("unused", READ_ONLY);
    config.reasoning_mode = "deep".into();
    let provider = Provider::start(|request, _| {
        if request.pointer("/chat_template_kwargs/enable_thinking") == Some(&json!(false)) {
            Reply::Text("Visible final answer.".into())
        } else {
            Reply::Reasoning("I will synthesize the answer now.".into())
        }
    });
    config.endpoint = provider.endpoint.clone();
    run(config);
    assert!(completed(&workspace.journal()));
    let requests = provider.requests();
    assert!(requests.len() >= 2);
    assert_eq!(
        requests.last().unwrap()["chat_template_kwargs"]["enable_thinking"],
        false,
        "finalizing request must explicitly disable supported reasoning"
    );
    assert!(requests.last().unwrap().get("tools").is_none());
    assert!(workspace.journal().iter().any(|entry| {
        entry
            .pointer("/Message/content")
            .and_then(Value::as_str)
            .is_some_and(|content| content.contains("Visible final answer"))
    }));
}

/// Failure shape: a single turn of parallel reads larger than the whole window
/// (here 8 files of 60 KB against a 16K window). Results are now bounded by the
/// window at creation and carry a continuation offset, instead of being
/// replaced by receipts later and recovered with `observation_read` bursts
/// that, being exact, could not be fitted (a `context_budget` run failure).
#[test]
fn a_burst_of_large_reads_cannot_exceed_a_small_window() {
    let big = "x".repeat(60_000);
    let files = (0..8)
        .map(|i| (format!("data/file{i}.json"), big.clone()))
        .collect::<Vec<_>>();
    let refs = files
        .iter()
        .map(|(p, c)| (p.as_str(), c.as_str()))
        .collect::<Vec<_>>();
    let workspace = Workspace::new(&refs);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(
            (0..8)
                .map(|i| ("read_file", json!({"path": format!("data/file{i}.json")})))
                .collect(),
        ),
        _ => Reply::Text("Summary of the data files.".into()),
    });
    let mut config = workspace.config(
        &provider.endpoint,
        "Summarize the data files. Do not modify files.",
    );
    config.context_limit = 16_384;
    run(config);
    let journal = workspace.journal();
    assert!(completed(&journal), "the run must survive the burst");
    let second = &provider.requests()[1];
    let tool_chars = second["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .map(|m| m["content"].as_str().unwrap_or("").chars().count())
        .sum::<usize>();
    assert!(
        tool_chars < 16_384 * 3 / 2,
        "results must fit the window: {tool_chars} chars"
    );
    let first_result = second["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    assert!(first_result.contains("\"truncated\":true"));
    assert!(first_result.contains("next_offset_chars"));
}

/// Failure shape: reasoning was dropped from the record, so a thinking model's
/// template rendered every earlier assistant turn with empty thinking and the
/// model re-derived its plan on each step.
#[test]
fn reasoning_is_recorded_and_replayed_with_the_assistant_turn_that_produced_it() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::ReasonedTools(
            "PLAN-ALPHA: read the form first".into(),
            vec![("read_file", json!({"path":"src/Form.tsx"}))],
        ),
        1 => Reply::ReasonedTools(
            "PLAN-BETA: then the endpoint".into(),
            vec![("read_file", json!({"path":"public/api.php"}))],
        ),
        _ => Reply::ReasonedText("ALL-DONE".into(), "The form posts to api.php.".into()),
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    assert!(completed(&workspace.journal()));
    let requests = provider.requests();
    assert_eq!(requests.len(), 3);
    let assistants = |request: &Value| {
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "assistant")
            .map(|m| {
                m.get("reasoning_content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            })
            .collect::<Vec<_>>()
    };
    assert!(assistants(&requests[0]).is_empty());
    assert_eq!(
        assistants(&requests[1]),
        vec!["PLAN-ALPHA: read the form first"]
    );
    assert_eq!(
        assistants(&requests[2]),
        vec![
            "PLAN-ALPHA: read the form first",
            "PLAN-BETA: then the endpoint"
        ]
    );
    // The durable record keeps it too, so a restart replays the same bytes.
    let journal = workspace.journal();
    assert!(journal.iter().any(|entry| entry
        .pointer("/Message/reasoning_content")
        .and_then(Value::as_str)
        == Some("PLAN-BETA: then the endpoint")));
}

/// Failure shape: a turn with only reasoning left no trace, so the retry
/// regenerated the same reasoning from nothing, indefinitely.
#[test]
fn a_reasoning_only_turn_is_visible_to_the_retry() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Reasoning("DRAFT-IN-THINKING: the report is: form posts to api.php".into()),
        _ => Reply::Text("The form posts to api.php.".into()),
    });
    run(workspace.config(&provider.endpoint, READ_ONLY));
    assert!(completed(&workspace.journal()));
    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    let retry = requests[1]["messages"].as_array().unwrap();
    assert!(
        retry.iter().any(|m| m["role"] == "assistant"
            && m["reasoning_content"] == "DRAFT-IN-THINKING: the report is: form posts to api.php"),
        "the retry did not carry the reasoning-only turn"
    );
    assert!(last_user_text(&requests[1]).contains("neither an answer nor a structured tool call"));
}

#[test]
fn a_provider_without_reasoning_never_receives_replayed_reasoning() {
    let workspace = Workspace::new(SHOP);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::ReasonedTools(
            "hidden".into(),
            vec![("read_file", json!({"path":"src/Form.tsx"}))],
        ),
        _ => Reply::Text("done".into()),
    });
    let mut config = workspace.config(&provider.endpoint, READ_ONLY);
    config.supports_reasoning = false;
    run(config);
    assert!(!provider.requests()[1]
        .to_string()
        .contains("reasoning_content"));
}
