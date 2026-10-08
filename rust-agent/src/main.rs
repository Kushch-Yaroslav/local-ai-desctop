use local_ai_agent_runtime::{
    agent::{
        loop_runtime::{self, Config},
        policy::RunPolicy,
    },
    protocol::{read, Request},
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
};

#[derive(Clone)]
struct Control {
    external: Arc<local_ai_agent_runtime::tools::web::HostTools>,
    cancelled: Arc<AtomicBool>,
    steering: Arc<Mutex<Vec<String>>>,
    pause_requested: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    steering_closed: Arc<AtomicBool>,
}

fn main() {
    // Keep stdin live for the duration of a run. Jan's loop consumes steering at
    // turn boundaries and cancellation is observed by both upstream and tools.
    let (requests, incoming) = mpsc::channel();
    std::thread::spawn(move || {
        while let Some(request) = read() {
            if requests.send(request).is_err() {
                break;
            }
        }
    });
    let mut controls: HashMap<String, Control> = HashMap::new();
    // A one-shot CLI client may close stdin immediately after `run`; completed
    // work is still owned by its worker. Electron keeps stdin open for control
    // messages, while this loop remains alive after EOF until shutdown.
    loop {
        controls.retain(|_, control| !control.finished.load(Ordering::Relaxed));
        let request = match incoming.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(request) => request,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) if controls.is_empty() => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
        };
        match request {
            Request::Run {
                run_id,
                endpoint,
                model,
                system,
                ui_language,
                user,
                user_images,
                user_image_refs,
                web_tools,
                project_root,
                secondary_project_root,
                context_limit,
                reasoning_mode,
                supports_reasoning,
                reasoning_options,
                web_mode,
                policy,
                history,
                evidence_dir,
                task_memory,
                provider_max_output,
                workspace_roots,
            } => {
                if !controls.is_empty() {
                    local_ai_agent_runtime::protocol::emit(
                        &run_id,
                        local_ai_agent_runtime::agent::events::Event::AgentError {
                            code: "generation_busy".into(),
                            message: "Only one Agent generation may run at a time".into(),
                        },
                    );
                    continue;
                }
                let control = Control {
                    external: Arc::new(Default::default()),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    steering: Arc::new(Mutex::new(Vec::new())),
                    pause_requested: Arc::new(AtomicBool::new(false)),
                    finished: Arc::new(AtomicBool::new(false)),
                    steering_closed: Arc::new(AtomicBool::new(false)),
                };
                controls.insert(run_id.clone(), control.clone());
                std::thread::spawn(move || {
                    loop_runtime::run(Config {
                        run_id,
                        endpoint,
                        model,
                        system,
                        ui_language,
                        user,
                        user_images,
                        user_image_refs,
                        web_tools: if web_mode == "auto" { web_tools } else { Vec::new() },
                        host_tools: Some(control.external),
                        root: project_root,
                        secondary_root: secondary_project_root,
                        workspace_roots,
                        context_limit,
                        reasoning_mode,
                        supports_reasoning,
                        reasoning_options,
                        policy: if policy == "safe" {
                            RunPolicy::Safe
                        } else {
                            RunPolicy::Auto
                        },
                        history,
                        evidence_dir,
                        task_memory,
                        provider_max_output,
                        browser_capability: None,
                        cancelled: control.cancelled,
                        steering: control.steering,
                        pause_requested: control.pause_requested,
                        steering_closed: control.steering_closed,
                    });
                    control.finished.store(true, Ordering::Relaxed);
                });
            }
            Request::HostToolResult { run_id, id, result } => {
                if let Some(control) = controls.get(&run_id) { control.external.reply(&id, result); }
            }
            Request::Cancel { run_id } => {
                if let Some(control) = controls.get(&run_id) {
                    control.cancelled.store(true, Ordering::Relaxed);
                }
            }
            Request::Steer {
                run_id,
                content,
                intent,
            } => {
                if let Some(control) = controls.get(&run_id) {
                    let mut queue = control.steering.lock().expect("steering lock");
                    if control.steering_closed.load(Ordering::Relaxed)
                        || control.finished.load(Ordering::Relaxed)
                        || control.cancelled.load(Ordering::Relaxed)
                        || content.trim().is_empty()
                        || content.len() > 64_000
                        || queue.len() >= 4
                    {
                        local_ai_agent_runtime::protocol::emit(
                            &run_id,
                            local_ai_agent_runtime::agent::events::Event::SteeringRejected {
                                message: "Agent is closed or steering queue/input limit exceeded"
                                    .into(),
                            },
                        );
                    } else {
                        queue.push(content.clone());
                        if intent.as_deref() == Some("pause") {
                            control.pause_requested.store(true, Ordering::Relaxed);
                        }
                        local_ai_agent_runtime::protocol::emit(
                            &run_id,
                            local_ai_agent_runtime::agent::events::Event::SteeringAccepted {
                                content,
                            },
                        );
                    }
                } else {
                    local_ai_agent_runtime::protocol::emit(
                        &run_id,
                        local_ai_agent_runtime::agent::events::Event::SteeringRejected {
                            message: "Agent run has ended".into(),
                        },
                    );
                }
            }
            Request::Shutdown => {
                for control in controls.values() {
                    control.cancelled.store(true, Ordering::Relaxed);
                }
                break;
            }
        }
    }
}
