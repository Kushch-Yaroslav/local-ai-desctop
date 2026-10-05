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
fn unsupported_saved_confirmed_memory_never_reaches_provider() {
    let fixture = Workspace::new(&[("source.txt", "observed source")]);
    let provider = Provider::start(|_, _| panic!("invalid saved memory reached provider"));
    let mut config = fixture.config(&provider.endpoint, "Continue investigation");
    config.task_memory = Some(json!({"entries":[{
        "id":"saved","finding":"unsupported","status":"confirmed","evidence":"obs-99999999"
    }],"revision":1}));
    run(config);
    assert!(provider.requests().is_empty());
}

#[test]
fn confirmed_memory_rejection_is_visible_and_retry_preserves_state() {
    let fixture = Workspace::new(&[("source.txt", "observed source")]);
    let provider = Provider::start(move |request, turn| {
        let parameters = &request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["name"] == "task_memory")
            .unwrap()["function"]["parameters"];
        assert_eq!(parameters["type"], "object");
        assert_eq!(parameters["properties"]["finding"]["type"], "string");
        assert_eq!(parameters["required"], json!(["action"]));
        assert!(parameters.get("oneOf").is_none());
        match turn {
            0 => Reply::Tools(vec![("read_file", json!({"path":"source.txt"}))]),
            1 => Reply::Tools(vec![("task_memory", json!({"action":"unsupported"}))]),
            2 => Reply::Tools(vec![("task_memory", json!({"action":"record"}))]),
            3 => Reply::Tools(vec![("task_memory", json!({}))]),
            4 => Reply::Tools(vec![(
                "task_memory",
                json!({
                    "action":"record","id":"fact","finding":"invalid candidate","status":"confirmed","evidence":"obs-99999999"
                }),
            )]),
            5 => {
                let messages = request["messages"].as_array().unwrap();
                assert!(messages.iter().any(|message| message["role"] == "tool"
                    && message["content"]
                        .as_str()
                        .is_some_and(|body| body.contains("unknown observation")
                            && body.contains("no memory was changed"))));
                assert!(!messages.iter().any(|message| message["role"] == "user"
                    && message["content"]
                        .as_str()
                        .is_some_and(|body| body.contains("fact [confirmed]"))));
                Reply::Tools(vec![(
                    "task_memory",
                    json!({
                        "action":"record","id":"fact","finding":"observed source","status":"confirmed","evidence":"obs-00000001"
                    }),
                )])
            }
            _ => {
                let result = request["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|message| message["role"] == "tool")
                    .unwrap();
                let body = result["content"].as_str().unwrap();
                let end = body.find("\n[observation").unwrap_or(body.len());
                let memory: Value = serde_json::from_str(&body[..end]).unwrap();
                assert_eq!(memory["task_memory"]["revision"], 1);
                assert_eq!(
                    memory["task_memory"]["entries"].as_array().unwrap().len(),
                    1
                );
                assert_eq!(
                    memory["task_memory"]["entries"][0]["finding"],
                    "observed source"
                );
                Reply::Text("Completed after a recoverable invalid evidence write.".into())
            }
        }
    });
    run(fixture.config(
        &provider.endpoint,
        "Read-only source inspection with memory",
    ));
    assert_eq!(provider.requests().len(), 7);
}

fn last_tool_result(request: &Value) -> String {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .and_then(|m| m["content"].as_str())
        .unwrap_or("")
        .to_owned()
}

fn memory_json(body: &str) -> Value {
    let end = body.find("\n[observation").unwrap_or(body.len());
    serde_json::from_str(&body[..end]).unwrap()
}

#[test]
fn task_memory_supports_create_observe_revise_cite_revise() {
    let fixture = Workspace::new(&[("source.txt", "observed source")]);
    let provider = Provider::start(|_, turn| match turn {
        // create: no id, an alias action, status still open
        0 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"add","finding":"how checkout works is not known","status":"open","next":"read source.txt"}),
        )]),
        1 => Reply::Tools(vec![("read_file", json!({"path":"source.txt"}))]),
        // a status-only update of an unknown id is explained, not silently created
        2 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"update","id":"tm-077","status":"confirmed"}),
        )]),
        // revise with an unpadded reference and a compact evidence run
        3 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"revise","id":"tm-001","finding":"checkout reads source.txt","status":"verified","evidence":"obs-1"}),
        )]),
        // revise only one field: everything else must survive
        4 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"update","id":"tm-001","next":"","implication":"nothing else to read"}),
        )]),
        // a fabricated reference is rejected with valid ones named
        5 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"record","id":"fake","finding":"made up","status":"confirmed","observations":["obs-00000099"]}),
        )]),
        // cite through the array form and revise the confirmed finding
        6 => Reply::Tools(vec![(
            "task_memory",
            json!({"action":"update","id":"tm-001","finding":"checkout reads source.txt only","observations":["obs-00000001"]}),
        )]),
        _ => Reply::Text("Checkout reads source.txt.".into()),
    });
    run(fixture.config(&provider.endpoint, "Investigate checkout and keep notes"));
    let requests = provider.requests();
    assert_eq!(requests.len(), 8);

    let created = memory_json(&last_tool_result(&requests[1]));
    assert_eq!(created["id"], "tm-001");
    assert_eq!(created["task_memory"]["entries"][0]["status"], "unknown");

    let unknown = last_tool_result(&requests[3]);
    assert!(
        unknown.contains("no entry 'tm-077'") || unknown.contains("There is no entry 'tm-077'"),
        "{unknown}"
    );
    assert!(
        unknown.contains("tm-001"),
        "the error must list existing ids: {unknown}"
    );

    let cited = memory_json(&last_tool_result(&requests[4]));
    let entry = &cited["task_memory"]["entries"][0];
    assert_eq!(entry["status"], "confirmed");
    assert_eq!(
        entry["evidence"], "obs-00000001",
        "an unpadded reference must be normalized"
    );
    assert_eq!(entry["next"], "read source.txt");

    let partial = memory_json(&last_tool_result(&requests[5]));
    let entry = &partial["task_memory"]["entries"][0];
    assert_eq!(
        entry["finding"], "checkout reads source.txt",
        "an update without finding must keep it"
    );
    assert_eq!(entry["evidence"], "obs-00000001");
    assert_eq!(entry["status"], "confirmed");
    assert_eq!(entry["next"], "", "an empty string clears a field");
    assert_eq!(entry["implication"], "nothing else to read");

    let rejected = last_tool_result(&requests[6]);
    assert!(
        rejected.contains("obs-00000099") && rejected.contains("obs-00000001"),
        "{rejected}"
    );
    assert!(rejected.contains("no memory was changed"));

    let revised = memory_json(&last_tool_result(&requests[7]));
    assert_eq!(
        revised["task_memory"]["entries"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        revised["task_memory"]["entries"][0]["finding"],
        "checkout reads source.txt only"
    );
    assert_eq!(
        revised["task_memory"]["entries"][0]["evidence"],
        "obs-00000001"
    );
}

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

/// Graceful pause: the user control (structured, not parsed from text) arrives
/// while a run has unfinished deliverables and an unvalidated mutation. The run
/// keeps only its checkpoint tools, none of the completion guidance can resume
/// work, the checkpoint is written, and the run ends paused with the unfinished
/// deliverable still pending.
#[test]
fn a_structured_pause_checkpoints_and_ends_without_resuming_guidance() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let queue = Arc::new(Mutex::new(Vec::new()));
    let pause = Arc::new(AtomicBool::new(false));
    let (incoming, flag) = (queue.clone(), pause.clone());
    let provider = Provider::start(move |request, n| match n {
        0 => add_both(),
        1 => Reply::Tools(vec![(
            "write_file",
            json!({"path":"a.txt","content":"changed"}),
        )]),
        2 => {
            incoming.lock().unwrap().push("Пауза".into());
            flag.store(true, Ordering::Relaxed);
            Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))])
        }
        3 => {
            let names = tool_names(request);
            assert_eq!(names.len(), 2, "{names:?}");
            assert!(names.contains(&"task_memory".to_owned()));
            assert!(names.contains(&"deliverables".to_owned()));
            let text = request.to_string();
            assert!(text.contains("<run_paused>"));
            assert!(!text.contains("<run_budget>") && !text.contains("deliverables_hint"));
            Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))])
        }
        4 => {
            let blocked = request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|m| m["role"] == "tool")
                .unwrap();
            assert!(blocked["content"]
                .as_str()
                .unwrap()
                .contains("run is paused"));
            Reply::Tools(vec![
                (
                    "task_memory",
                    json!({"action":"record","id":"state","finding":"bot mode is not started; a.txt was changed","status":"inferred","next":"add the bot mode, then validate"}),
                ),
                deliverable("done", json!({"id":"d-001","evidence":"saw it work"})),
            ])
        }
        _ => Reply::Text("Paused: the theme switch is not done yet.".into()),
    });
    let mut config = workspace.config(&provider.endpoint, TWO_PART_REQUEST);
    config.steering = queue;
    config.pause_requested = pause;
    run(config);
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(
        withheld_drafts(&journal),
        0,
        "no completion guidance may hold the pause summary back"
    );
    let requests = provider.requests();
    assert_eq!(requests.len(), 6);
    let last = requests[5].to_string();
    assert!(
        last.contains("state [inferred]") || last.contains("bot mode is not started"),
        "{last}"
    );
    assert!(
        last.contains("d-002 theme switch changes the theme"),
        "pending deliverable survives the pause"
    );
}

/// The checkpoint is bounded: a model that keeps writing checkpoints loses its tools, and a model that never
/// answers still ends with a visible paused summary.
#[test]
fn a_pause_is_bounded_even_if_the_model_keeps_calling_tools_or_stays_silent() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let queue = Arc::new(Mutex::new(vec!["Пауза".to_owned()]));
    let pause = Arc::new(AtomicBool::new(true));
    let provider = Provider::start(|request, n| {
        if n < 3 {
            assert!(!tool_names(request).is_empty());
            Reply::Tools(vec![("task_memory", json!({"action":"view"}))])
        } else {
            assert!(
                tool_names(request).is_empty(),
                "tools are withdrawn after the checkpoint turns"
            );
            Reply::Reasoning("thinking without an answer".into())
        }
    });
    let mut config = workspace.config(&provider.endpoint, "Do a long task");
    config.steering = queue;
    config.pause_requested = pause;
    run(config);
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(provider.requests().len(), 5);
}

/// Natural-language classification belongs to the model: the pause tool is offered only right after a steering
/// message, an ordinary clarification keeps the run going, and a call outside that window is refused.
#[test]
fn the_pause_tool_is_offered_only_after_steering_and_a_clarification_does_not_pause() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let queue = Arc::new(Mutex::new(Vec::new()));
    let incoming = queue.clone();
    let provider = Provider::start(move |request, n| match n {
        0 => {
            assert!(!tool_names(request).contains(&"pause_run".to_owned()));
            incoming
                .lock()
                .unwrap()
                .push("Не останавливайся, проверь ещё b.txt".into());
            Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))])
        }
        1 => {
            assert!(tool_names(request).contains(&"pause_run".to_owned()));
            assert!(last_user_text(request).contains("pause_run"));
            Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))])
        }
        2 => {
            assert!(!tool_names(request).contains(&"pause_run".to_owned()));
            Reply::Tools(vec![("pause_run", json!({}))])
        }
        3 => {
            let refused = request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|m| m["role"] == "tool")
                .unwrap();
            assert!(refused["content"].as_str().unwrap().contains("unavailable"));
            assert!(
                tool_names(request).contains(&"read_file".to_owned()),
                "a refused pause_run must not restrict the run"
            );
            Reply::Text("Checked, continuing normally.".into())
        }
        _ => unreachable!(),
    });
    let mut config = workspace.config(&provider.endpoint, "Inspect a.txt");
    config.steering = queue;
    run(config);
    assert!(completed(&workspace.journal()));
    assert_eq!(provider.requests().len(), 4);
}

#[test]
fn a_model_classified_pause_restricts_tools_and_ends_the_run() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let queue = Arc::new(Mutex::new(Vec::new()));
    let incoming = queue.clone();
    let provider = Provider::start(move |request, n| match n {
        0 => {
            incoming
                .lock()
                .unwrap()
                .push("Хватит, остановись на этом месте".into());
            Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))])
        }
        1 => Reply::Tools(vec![("pause_run", json!({}))]),
        2 => {
            assert!(!tool_names(request).contains(&"read_file".to_owned()));
            assert!(request.to_string().contains("<run_paused>"));
            Reply::Text("Paused after reading a.txt.".into())
        }
        _ => unreachable!(),
    });
    let mut config = workspace.config(&provider.endpoint, "Inspect a.txt thoroughly");
    config.steering = queue;
    run(config);
    assert!(completed(&workspace.journal()));
    assert_eq!(provider.requests().len(), 3);
}

/// A hard cancel keeps priority over the graceful lifecycle.
#[test]
fn hard_cancel_still_stops_a_pausing_run_without_another_request() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, _| Reply::Text("never requested".into()));
    let mut config = workspace.config(&provider.endpoint, "task");
    config.steering = Arc::new(Mutex::new(vec!["Пауза".to_owned()]));
    config.pause_requested = Arc::new(AtomicBool::new(true));
    config.cancelled = Arc::new(AtomicBool::new(true));
    run(config);
    assert!(provider.requests().is_empty());
    assert!(!completed(&workspace.journal_or_empty()));
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
            workspace_roots: Vec::new(),
            context_limit: 65_536,
            reasoning_mode: "fast".into(),
            supports_reasoning: true,
            reasoning_options: None,
            policy: RunPolicy::Auto,
            history: Vec::new(),
            evidence_dir: Some(self.base.join("evidence").to_string_lossy().into_owned()),
            task_memory: None,
            provider_max_output: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            steering: Arc::new(Mutex::new(Vec::new())),
            steering_closed: Arc::new(AtomicBool::new(false)),
            pause_requested: Arc::new(AtomicBool::new(false)),
        }
    }

    fn journal_or_empty(&self) -> Vec<Value> {
        if self.base.join("evidence").join("active.json").exists() {
            self.journal()
        } else {
            Vec::new()
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

fn tool_result_text(request: &Value) -> String {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .map(|m| m["content"].as_str().unwrap_or("").to_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

const EXECUTION_TOOLS: &[&str] = &[
    "apply_patch",
    "create_file",
    "delete_file",
    "list_directory",
    "read_file",
    "run_terminal",
    "write_file",
];

/// No selected project, but the user named a directory: the model must receive
/// execution tools scoped to it, actually run them, and see the real result.
#[test]
fn explicit_directory_without_a_project_exposes_execution_tools_and_really_executes() {
    let workspace = Workspace::new(&[("granted/keep.txt", "keep")]);
    let granted = workspace.root.join("granted");
    let target = granted.join("Шашки");
    let outside = workspace.root.join("outside.txt");
    let (target_arg, outside_arg) = (
        target.to_string_lossy().into_owned(),
        outside.to_string_lossy().into_owned(),
    );
    let provider = Provider::start(move |_, n| match n {
        0 => Reply::Tools(vec![(
            "run_terminal",
            json!({"command": format!("mkdir '{target_arg}'")}),
        )]),
        1 => Reply::Tools(vec![(
            "create_file",
            json!({"path": outside_arg, "content": "must not exist"}),
        )]),
        2 => Reply::Tools(vec![("list_directory", json!({"path": "."}))]),
        _ => Reply::Text("done".into()),
    });
    let mut config = workspace.config(&provider.endpoint, "create the folder");
    config.root = None;
    config.workspace_roots = vec![granted.to_string_lossy().into_owned()];
    run(config);
    assert!(target.is_dir(), "the terminal command did not run");
    assert!(
        !outside.exists(),
        "a file tool escaped the granted directory"
    );
    let requests = provider.requests();
    let names = tool_names(&requests[0]);
    for tool in EXECUTION_TOOLS {
        assert!(
            names.contains(&(*tool).to_owned()),
            "{tool} missing: {names:?}"
        );
    }
    assert!(!names
        .iter()
        .any(|name| name.starts_with("project_knowledge_")));
    assert!(requests[0]
        .to_string()
        .contains(&granted.to_string_lossy().into_owned()));
    assert!(
        tool_result_text(&requests[2]).contains("escapes"),
        "the refusal was not reported"
    );
    assert!(
        tool_result_text(&requests[3]).contains("Шашки"),
        "the real listing was not returned"
    );
    assert!(completed(&workspace.journal()));
    assert!(
        !granted.join(".ai-framework").exists() && !workspace.root.join(".ai-framework").exists(),
        "a workspace run must not create a project knowledge cache"
    );
}

/// Neither a project nor a named directory: no execution tools, and the model
/// is told so rather than being left to guess.
#[test]
fn without_any_scope_no_execution_tools_are_exposed_and_the_model_is_told() {
    let workspace = Workspace::new(&[("unused.txt", "")]);
    let provider = Provider::start(|_, _| Reply::Text("I need a directory.".into()));
    let mut config = workspace.config(&provider.endpoint, "create a folder");
    config.root = None;
    run(config);
    let requests = provider.requests();
    let names = tool_names(&requests[0]);
    for tool in EXECUTION_TOOLS {
        assert!(
            !names.contains(&(*tool).to_owned()),
            "{tool} leaked into an unscoped run"
        );
    }
    assert!(names.contains(&"task_memory".to_owned()));
    assert!(requests[0]
        .to_string()
        .contains("not available in this run"));
}

/// A selected project keeps its full toolset, and named directories only add
/// scope: absolute paths inside them work, others are refused.
#[test]
fn project_scope_keeps_all_tools_and_named_directories_extend_file_scope() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let extra = workspace.base.join("extra");
    std::fs::create_dir_all(&extra).unwrap();
    let extra = extra.canonicalize().unwrap();
    let written = extra.join("out.txt");
    let written_arg = written.to_string_lossy().into_owned();
    let provider = Provider::start(move |_, n| match n {
        0 => Reply::Tools(vec![(
            "write_file",
            json!({"path": written_arg, "content": "hello"}),
        )]),
        _ => Reply::Text("done".into()),
    });
    let mut config = workspace.config(&provider.endpoint, "write a file");
    config.workspace_roots = vec![extra.to_string_lossy().into_owned()];
    run(config);
    assert_eq!(std::fs::read_to_string(written).unwrap(), "hello");
    let names = tool_names(&provider.requests()[0]);
    assert!(names.contains(&"project_knowledge_index".to_owned()));
    for tool in EXECUTION_TOOLS {
        assert!(names.contains(&(*tool).to_owned()), "{tool}");
    }
}

/// Reasoning mode is a model setting; it must never change which tools the
/// model is given.
#[test]
fn tool_exposure_does_not_depend_on_the_reasoning_mode() {
    let mut exposed = Vec::new();
    for mode in ["fast", "deep"] {
        let workspace = Workspace::new(&[("a.txt", "a")]);
        let provider = Provider::start(|_, _| Reply::Text("done".into()));
        let mut config = workspace.config(&provider.endpoint, "do the task");
        config.reasoning_mode = mode.into();
        run(config);
        let mut names = tool_names(&provider.requests()[0]);
        names.sort();
        exposed.push(names);
    }
    assert_eq!(exposed[0], exposed[1]);
    assert!(exposed[0].contains(&"run_terminal".to_owned()));
}

/// A failing command, an invalid path, a path outside the scope, a disallowed
/// command shape and an unavailable tool must each reach the model as an
/// honest error (never as a success), and the run must continue to an answer.
#[test]
fn failures_and_refusals_are_reported_honestly_and_the_run_still_completes() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let outside = workspace.base.join("outside.txt");
    std::fs::write(&outside, "keep").unwrap();
    let outside_arg = outside.to_string_lossy().into_owned();
    let provider = Provider::start(move |_, n| match n {
        0 => Reply::Tools(vec![("run_terminal", json!({"command":"exit 3"}))]),
        1 => Reply::Tools(vec![("read_file", json!({"path":"missing/none.txt"}))]),
        2 => Reply::Tools(vec![("delete_file", json!({"path": outside_arg}))]),
        3 => Reply::Tools(vec![(
            "run_terminal",
            json!({"command":"echo a && echo b"}),
        )]),
        4 => Reply::Tools(vec![("format_disk", json!({}))]),
        _ => Reply::Text("reported".into()),
    });
    run(workspace.config(&provider.endpoint, "exercise failures"));
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
    assert!(completed(&workspace.journal()));
    let requests = provider.requests();
    assert_eq!(requests.len(), 6);
    let failed_command = tool_result_text(&requests[1]);
    assert!(
        failed_command.contains("\"exit_code\":3") || failed_command.contains("exit_code"),
        "{failed_command}"
    );
    assert!(
        !failed_command.contains("\"status\":\"completed\""),
        "{failed_command}"
    );
    assert!(
        tool_result_text(&requests[2])
            .to_lowercase()
            .contains("no such file")
            || tool_result_text(&requests[2]).contains("error")
    );
    assert!(tool_result_text(&requests[3]).contains("escapes"));
    assert!(tool_result_text(&requests[4]).contains("approval required"));
    assert!(
        tool_result_text(&requests[5])
            .to_lowercase()
            .contains("format_disk"),
        "{}",
        tool_result_text(&requests[5])
    );
}

/// Cancelling while a terminal command runs ends the run promptly and does
/// not leave the command running.
#[test]
fn cancelling_during_a_running_terminal_command_stops_the_run_and_the_process() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![("run_terminal", json!({"command":"sleep 47.31"}))]),
        _ => Reply::Text("unreachable".into()),
    });
    let config = workspace.config(&provider.endpoint, "run something slow");
    let cancelled = config.cancelled.clone();
    let started = std::time::Instant::now();
    let worker = std::thread::spawn(move || run(config));
    std::thread::sleep(std::time::Duration::from_millis(700));
    cancelled.store(true, Ordering::Relaxed);
    worker.join().unwrap();
    assert!(
        started.elapsed().as_secs() < 20,
        "cancellation was not prompt"
    );
    std::thread::sleep(std::time::Duration::from_millis(300));
    let leftover = std::process::Command::new("pgrep")
        .args(["-f", "sleep 47.31"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&leftover.stdout).trim().is_empty(),
        "the cancelled command is still running"
    );
}

/// Tool calls and results of an execution run are journaled as a matched pair,
/// so a restart or Continue replays the same state.
#[test]
fn execution_tool_calls_and_results_are_persisted_as_matched_pairs() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![(
            "create_file",
            json!({"path":"new/dir/b.txt","content":"b"}),
        )]),
        _ => Reply::Text("created".into()),
    });
    run(workspace.config(&provider.endpoint, "create a file"));
    assert_eq!(
        std::fs::read_to_string(workspace.root.join("new/dir/b.txt")).unwrap(),
        "b"
    );
    let journal = workspace.journal();
    assert!(completed(&journal));
    let calls: Vec<String> = journal
        .iter()
        .filter_map(|entry| entry.pointer("/Message/tool_calls"))
        .flat_map(|calls| calls.as_array().cloned().unwrap_or_default())
        .filter_map(|call| call["id"].as_str().map(str::to_owned))
        .collect();
    let results: Vec<String> = journal
        .iter()
        .filter(|entry| entry.pointer("/Message/role").and_then(Value::as_str) == Some("tool"))
        .filter_map(|entry| {
            entry
                .pointer("/Message/tool_call_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    assert_eq!(calls.len(), 1, "{journal:?}");
    assert_eq!(calls, results, "a tool call has no persisted result");
}

fn tree(root: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                files.push((
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    std::fs::read(&path).unwrap(),
                ));
            }
        }
    }
    files.sort();
    files
}

/// Reading a reference project (Project 2) must leave it byte-identical:
/// passive knowledge caching is limited to the primary project.
#[test]
fn reading_the_secondary_project_never_modifies_it_while_writes_land_in_the_primary() {
    let fixture = Workspace::new(&[("a.txt", "primary")]);
    let secondary = fixture.base.join("reference");
    std::fs::create_dir_all(secondary.join("src")).unwrap();
    std::fs::write(secondary.join("src/theme.css"), ":root{--c:#0a0}").unwrap();
    std::fs::write(secondary.join("index.html"), "<html></html>").unwrap();
    let before = tree(&secondary);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            ("list_directory", json!({"path":".","project":2})),
            ("read_file", json!({"path":"src/theme.css","project":2})),
            ("project_knowledge_index", json!({"project":2})),
        ]),
        1 => Reply::Tools(vec![(
            "create_file",
            json!({"path":"theme.css","content":":root{--c:#0a0}","project":1}),
        )]),
        _ => Reply::Text("done".into()),
    });
    let mut config = fixture.config(&provider.endpoint, "adapt the reference theme");
    config.secondary_root = Some(secondary.to_string_lossy().into_owned());
    run(config);
    assert_eq!(
        tree(&secondary),
        before,
        "the reference project was modified"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("theme.css")).unwrap(),
        ":root{--c:#0a0}"
    );
    assert!(completed(&fixture.journal()));
}

const TWO_PART_REQUEST: &str =
    "Do two things: add a bot mode to the game, and add a theme switch to the game.";

fn deliverable(action: &str, fields: Value) -> (&'static str, Value) {
    let mut arguments = fields;
    arguments["action"] = json!(action);
    ("deliverables", arguments)
}

fn add_both() -> Reply {
    Reply::Tools(vec![
        deliverable(
            "add",
            json!({"task":"bot","text":"bot opponent is selectable in the UI"}),
        ),
        deliverable(
            "add",
            json!({"task":"theme","text":"theme switch changes the theme"}),
        ),
    ])
}

/// The failure this guards against: the run recorded two requested deliverables,
/// finished one, and tried to end. It must be sent back once (Fast) naming
/// exactly what is unfinished, and the second answer is accepted so the review
/// can never deadlock a run.
#[test]
fn fast_sends_a_run_with_unfinished_deliverables_back_once_then_accepts() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => add_both(),
        1 => Reply::Tools(vec![deliverable(
            "done",
            json!({"id":"d-001","evidence":"saw it work"}),
        )]),
        2 => Reply::Text("Everything is finished.".into()),
        _ => Reply::Text("The theme switch is not done: out of time.".into()),
    });
    run(workspace.config(&provider.endpoint, TWO_PART_REQUEST));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(
        withheld_drafts(&journal),
        1,
        "the premature answer must be withheld exactly once"
    );
    let requests = provider.requests();
    assert_eq!(requests.len(), 4);
    let reminder = last_user_text(&requests[3]);
    assert!(reminder.contains("not all complete"), "{reminder}");
    assert!(
        reminder.contains("d-002 theme switch changes the theme (theme)"),
        "{reminder}"
    );
    let review = reminder
        .split("Before finishing:")
        .nth(1)
        .and_then(|rest| rest.split("Continue with").next())
        .unwrap_or_default();
    assert!(
        !review.contains("d-001"),
        "finished work must not be listed as pending: {review}"
    );
    assert!(requests[3].to_string().contains("<deliverables>"));
}

/// Marking an item blocked with a concrete reason is an honest way to end: no review is needed.
#[test]
fn blocked_with_a_reason_ends_without_a_review() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => add_both(),
        1 => Reply::Tools(vec![
            deliverable("done", json!({"id":"d-001","evidence":"verified"})),
            deliverable(
                "block",
                json!({"id":"d-002","reason":"the theme assets cannot be reached from this environment"}),
            ),
        ]),
        _ => Reply::Text("Bot done; theme blocked, see the reason.".into()),
    });
    run(workspace.config(&provider.endpoint, TWO_PART_REQUEST));
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(withheld_drafts(&journal), 0);
    assert_eq!(provider.requests().len(), 3);
}

/// Deep checks completion harder: it may be sent back twice, and `done` needs evidence that cites something observed.
#[test]
fn deep_requires_cited_evidence_for_done_and_reviews_twice() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => add_both(),
        1 => Reply::Tools(vec![deliverable(
            "done",
            json!({"id":"d-001","evidence":"I believe it works"}),
        )]),
        2 => Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))]),
        3 => Reply::Tools(vec![deliverable(
            "done",
            json!({"id":"d-001","evidence":"obs-00000001 shows it"}),
        )]),
        4 | 5 => Reply::Text("Finished everything.".into()),
        _ => Reply::Text("Theme switch remains unfinished.".into()),
    });
    let mut config = workspace.config(&provider.endpoint, TWO_PART_REQUEST);
    config.reasoning_mode = "deep".into();
    run(config);
    let requests = provider.requests();
    assert!(
        tool_result_text(&requests[2]).contains("In Deep mode"),
        "uncited evidence was accepted: {}",
        tool_result_text(&requests[2])
    );
    let journal = workspace.journal();
    assert!(completed(&journal));
    assert_eq!(
        withheld_drafts(&journal),
        2,
        "Deep reviews an unfinished list twice"
    );
    assert_eq!(requests.len(), 7);
    assert!(last_user_text(&requests[6]).contains("cite the observation"));
}

/// Trivial and analysis-only prompts must stay lean: the runtime never creates a list on its own, so nothing is reviewed.
#[test]
fn a_run_that_never_records_deliverables_is_never_reviewed() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![("read_file", json!({"path":"a.txt"}))]),
        _ => Reply::Text("It says a.".into()),
    });
    run(workspace.config(&provider.endpoint, "what does a.txt say?"));
    assert_eq!(withheld_drafts(&workspace.journal()), 0);
    assert_eq!(provider.requests().len(), 2);
    assert!(!provider.requests()[1]
        .to_string()
        .contains("<deliverables>"));
}

/// The list is persisted with Task Memory: a later run (Continue after an interruption) sees it, and a fresh run
/// (Regenerate starts without saved memory) does not.
#[test]
fn saved_deliverables_return_on_continue_and_a_fresh_run_starts_empty() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, _| Reply::Text("ok".into()));
    let mut resumed = workspace.config(&provider.endpoint, "continue");
    resumed.task_memory = Some(json!({"entries":[],"revision":0,"deliverables":{"items":[
        {"id":"d-001","task":"bot","text":"bot opponent is selectable in the UI","status":"pending","evidence":"","reason":""}
    ],"revision":1}}));
    run(resumed);
    assert!(provider.requests()[0]
        .to_string()
        .contains("bot opponent is selectable in the UI"));

    let fresh_workspace = Workspace::new(&[("a.txt", "a")]);
    let fresh_provider = Provider::start(|_, _| Reply::Text("ok".into()));
    run(fresh_workspace.config(&fresh_provider.endpoint, "start over"));
    assert!(!fresh_provider.requests()[0]
        .to_string()
        .contains("<deliverables>"));
}

/// A read-only request produces nothing to deliver, so the tool is not offered; other runs offer it.
#[test]
fn the_deliverables_tool_is_offered_except_for_read_only_requests() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, _| Reply::Text("ok".into()));
    run(workspace.config(&provider.endpoint, "do the work"));
    assert!(tool_names(&provider.requests()[0]).contains(&"deliverables".to_owned()));
    let read_only_provider = Provider::start(|_, _| Reply::Text("ok".into()));
    let read_only_workspace = Workspace::new(&[("a.txt", "a")]);
    run(read_only_workspace.config(&read_only_provider.endpoint, READ_ONLY));
    assert!(!tool_names(&read_only_provider.requests()[0]).contains(&"deliverables".to_owned()));
}

/// Files the run created stay visible, and a pending review points at them so scratch files are not forgotten.
#[test]
fn files_created_in_the_run_are_listed_and_named_in_the_review() {
    let workspace = Workspace::new(&[("a.txt", "a")]);
    let provider = Provider::start(|_, n| match n {
        0 => Reply::Tools(vec![
            deliverable("add", json!({"text":"the feature works end to end"})),
            (
                "create_file",
                json!({"path":"scratch-check.js","content":"1"}),
            ),
            ("write_file", json!({"path":"a.txt","content":"changed"})),
        ]),
        1 => Reply::Tools(vec![(
            "run_terminal",
            json!({"command":"echo run test ok"}),
        )]),
        2 => Reply::Text("done".into()),
        3 => Reply::Tools(vec![("delete_file", json!({"path":"scratch-check.js"}))]),
        _ => Reply::Text("done again".into()),
    });
    run(workspace.config(&provider.endpoint, "build the feature"));
    let requests = provider.requests();
    assert!(requests[1]
        .to_string()
        .contains("<files_created_this_run>scratch-check.js</files_created_this_run>"));
    assert!(
        !requests[1]
            .to_string()
            .contains("a.txt</files_created_this_run>"),
        "an existing file is not a created file"
    );
    let review = last_user_text(&requests[3]);
    assert!(
        review.contains("Files you created in this run: scratch-check.js"),
        "{review}"
    );
    assert!(
        !requests[4].to_string().contains("<files_created_this_run>"),
        "a deleted file must leave the list"
    );
}
