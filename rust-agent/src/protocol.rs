use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead, Write};
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Run {
        run_id: String,
        endpoint: String,
        model: String,
        system: String,
        user: String,
        project_root: Option<String>,
        secondary_project_root: Option<String>,
        context_limit: usize,
        reasoning_mode: String,
        web_mode: String,
        policy: String,
        #[serde(default)]
        history: Vec<Value>,
    },
    Cancel {
        run_id: String,
    },
    Steer {
        run_id: String,
        content: String,
    },
    Shutdown,
}
#[derive(Debug, Serialize)]
pub struct Envelope<T: Serialize> {
    pub run_id: String,
    #[serde(flatten)]
    pub event: T,
}
pub fn read() -> Option<Request> {
    let mut line = String::new();
    if io::stdin().lock().read_line(&mut line).ok()? == 0 {
        return None;
    }
    serde_json::from_str(&line).ok()
}
pub fn emit<T: Serialize>(run_id: &str, event: T) {
    if let Ok(line) = serde_json::to_string(&Envelope {
        run_id: run_id.to_owned(),
        event,
    }) {
        let mut out = io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}
