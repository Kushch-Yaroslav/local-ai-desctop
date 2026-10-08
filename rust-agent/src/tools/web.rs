use crate::{agent::events::Event, protocol::emit};
use serde_json::Value;
use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex, Condvar};
use std::time::{Duration, Instant};

pub fn is_web_tool(name: &str) -> bool {
    matches!(name, "web_search" | "web_open" | "web_read" | "web_follow_link" | "web_back")
}

/// Only the trusted host can answer a pending call. Results still flow through
/// the ordinary observation ledger; they are never accepted as verification.
#[derive(Default)]
pub struct HostTools {
    pending: Mutex<Option<(String, Option<Value>)>>,
    changed: Condvar,
    next_id: AtomicU64,
}
impl HostTools {
    pub fn reply(&self, id: &str, result: Value) {
        let mut pending = self.pending.lock().unwrap();
        if let Some((expected, value)) = pending.as_mut() {
            if expected == id && value.is_none() { *value = Some(result); self.changed.notify_all(); }
        }
    }
    pub fn execute(&self, run_id: &str, name: &str, arguments: &Value, cancelled: &AtomicBool) -> Result<Value, String> {
        if !is_web_tool(name) { return Err("Unknown web tool".into()); }
        if cancelled.load(Ordering::Relaxed) { return Err("Web request cancelled".into()); }
        let id = format!("host-{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let mut pending = self.pending.lock().unwrap();
        *pending = Some((id.clone(), None));
        emit(run_id, Event::HostToolCall { id: id.clone(), name: name.into(), arguments: arguments.clone() });
        let started = Instant::now();
        loop {
            if cancelled.load(Ordering::Relaxed) { *pending = None; return Err("Web request cancelled".into()); }
            if let Some((_, Some(value))) = pending.take() { return Ok(value); }
            *pending = Some((id.clone(), None));
            if started.elapsed() > Duration::from_secs(30) { *pending = None; return Err("Web host response timed out".into()); }
            pending = self.changed.wait_timeout(pending, Duration::from_millis(100)).unwrap().0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn replies_are_bound_to_pending_id_and_cancellation_remains_available() {
        let host = Arc::new(HostTools::default());
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_host = host.clone(); let worker_cancel = cancelled.clone();
        let worker = std::thread::spawn(move || worker_host.execute("test", "web_open", &serde_json::json!({"url":"https://example.com"}), &worker_cancel));
        while host.pending.lock().unwrap().is_none() { std::thread::yield_now(); }
        host.reply("wrong-id", serde_json::json!({"content":"invalid"}));
        assert!(host.pending.lock().unwrap().as_ref().unwrap().1.is_none());
        host.reply("host-1", serde_json::json!({"content":"page"}));
        assert_eq!(worker.join().unwrap().unwrap()["content"], "page");
        let worker_host = host.clone(); let worker_cancel = cancelled.clone();
        let worker = std::thread::spawn(move || worker_host.execute("test", "web_read", &serde_json::json!({}), &worker_cancel));
        while host.pending.lock().unwrap().is_none() { std::thread::yield_now(); }
        cancelled.store(true, Ordering::Relaxed);
        assert!(worker.join().unwrap().unwrap_err().contains("cancelled"));
        assert!(host.pending.lock().unwrap().is_none());
        assert!(host.execute("test", "run_terminal", &Value::Null, &cancelled).is_err());
    }
}
