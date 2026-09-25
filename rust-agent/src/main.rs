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
    cancelled: Arc<AtomicBool>,
    steering: Arc<Mutex<Vec<String>>>,
    finished: Arc<AtomicBool>,
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
                user,
                project_root,
                secondary_project_root: _,
                context_limit,
                reasoning_mode,
                web_mode: _,
                policy,
                history,
            } => {
                if controls.contains_key(&run_id) {
                    continue;
                }
                let control = Control {
                    cancelled: Arc::new(AtomicBool::new(false)),
                    steering: Arc::new(Mutex::new(Vec::new())),
                    finished: Arc::new(AtomicBool::new(false)),
                };
                controls.insert(run_id.clone(), control.clone());
                std::thread::spawn(move || {
                    loop_runtime::run(Config {
                        run_id,
                        endpoint,
                        model,
                        system,
                        user,
                        root: project_root,
                        context_limit,
                        reasoning_mode,
                        policy: if policy == "safe" {
                            RunPolicy::Safe
                        } else {
                            RunPolicy::Auto
                        },
                        history,
                        cancelled: control.cancelled,
                        steering: control.steering,
                    });
                    control.finished.store(true, Ordering::Relaxed);
                });
            }
            Request::Cancel { run_id } => {
                if let Some(control) = controls.get(&run_id) {
                    control.cancelled.store(true, Ordering::Relaxed);
                }
            }
            Request::Steer { run_id, content } => {
                if let Some(control) = controls.get(&run_id) {
                    control
                        .steering
                        .lock()
                        .expect("steering lock")
                        .push(content);
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
