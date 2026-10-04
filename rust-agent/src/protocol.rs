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
        #[serde(default = "default_supports_reasoning")]
        supports_reasoning: bool,
        #[serde(default)]
        reasoning_options: Option<Value>,
        web_mode: String,
        policy: String,
        #[serde(default)]
        history: Vec<Value>,
        #[serde(default)]
        evidence_dir: Option<String>,
        /// Durable semantic findings from an earlier turn of this user task.
        /// This carries Task Memory only; it is never interpreted as a plan.
        #[serde(default)]
        task_memory: Option<Value>,
        /// Optional backend/model output ceiling. The runtime intersects this
        /// with selected context capacity and its application ceiling.
        #[serde(default)]
        provider_max_output: Option<usize>,
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

fn default_supports_reasoning() -> bool {
    true
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

#[cfg(test)]
mod tests {
    use super::Request;
    use serde_json::json;

    #[test]
    fn run_request_preserves_model_reasoning_capabilities() {
        let options = json!({
            "fast":{"reasoning_effort":"low"},
            "deep":{"reasoning_effort":"high"},
            "final":{"reasoning_effort":"low"}
        });
        let request = json!({
            "type":"run",
            "run_id":"test",
            "endpoint":"http://127.0.0.1:8081/v1/chat/completions",
            "model":"local-model",
            "system":"system",
            "user":"inspect",
            "context_limit":32768,
            "reasoning_mode":"deep",
            "supports_reasoning":true,
            "reasoning_options":options,
            "web_mode":"off",
            "policy":"safe"
        });
        match serde_json::from_value::<Request>(request).unwrap() {
            Request::Run {
                reasoning_options, ..
            } => assert_eq!(reasoning_options, Some(options)),
            _ => panic!("run request was parsed as another protocol variant"),
        }
    }
}
