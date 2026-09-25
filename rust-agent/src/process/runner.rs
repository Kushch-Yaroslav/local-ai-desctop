use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

/// Runs each shell turn in a dedicated session. `setsid` makes the bash PID a
/// process-group leader, allowing cancellation to terminate npm/vite/test
/// descendants instead of leaving background workers behind.
pub fn run_streaming(
    command: &str,
    cwd: &str,
    timeout_ms: u64,
    cancelled: impl Fn() -> bool,
    mut started_event: impl FnMut(u32, u32, u32, u128),
    mut output: impl FnMut(&str, &str),
) -> serde_json::Value {
    let mut child = match Command::new("setsid")
        .arg("bash")
        // Preserve the actual failure status for common diagnostic pipelines
        // such as `npm test | tail`; otherwise the model sees a false success.
        .arg("-o")
        .arg("pipefail")
        .arg("-lc")
        .arg(command)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return serde_json::json!({"command":command,"cwd":cwd,"error":error.to_string(),"timed_out":false,"cancelled":false,"status":"error","started_at":now_ms(),"finished_at":now_ms()})
        }
    };
    let pid = child.id();
    // `setsid bash` makes bash both session and process-group leader. The
    // runner only ever signals this known child group on cancellation.
    let started_at = now_ms();
    started_event(pid, pid, pid, started_at);
    let stdout_handle = child.stdout.take().expect("piped stdout");
    let stderr_handle = child.stderr.take().expect("piped stderr");
    let (sender, receiver) = mpsc::channel();
    let stderr_sender = sender.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout_handle).lines().map_while(Result::ok) {
            let _ = sender.send(("stdout", line));
        }
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr_handle).lines().map_while(Result::ok) {
            let _ = stderr_sender.send(("stderr", line));
        }
    });
    let started = std::time::Instant::now();
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut timed_out = false;
    let mut was_cancelled = false;
    let mut terminated = false;
    loop {
        while let Ok((stream, line)) = receiver.try_recv() {
            output(stream, &line);
            let target = if stream == "stdout" {
                &mut stdout
            } else {
                &mut stderr
            };
            target.push_str(&line);
            target.push('\n');
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                while let Ok((stream, line)) = receiver.try_recv() {
                    output(stream, &line);
                    let target = if stream == "stdout" {
                        &mut stdout
                    } else {
                        &mut stderr
                    };
                    target.push_str(&line);
                    target.push('\n');
                }
                let cancelled_status = was_cancelled;
                return serde_json::json!({"command":command,"cwd":cwd,"pid":pid,"pgid":pid,"session_id":pid,"started_at":started_at,"finished_at":now_ms(),"stdout":stdout,"stderr":stderr,"exit_code":status.code(),"timed_out":timed_out,"cancelled":cancelled_status,"status":if cancelled_status {"cancelled"} else if timed_out {"timed_out"} else if status.success() {"completed"} else {"error"}});
            }
            Ok(None) => {}
            Err(error) => {
                return serde_json::json!({"command":command,"cwd":cwd,"pid":pid,"pgid":pid,"session_id":pid,"started_at":started_at,"finished_at":now_ms(),"stdout":stdout,"stderr":stderr,"error":error.to_string(),"timed_out":timed_out,"cancelled":was_cancelled,"status":"error"})
            }
        }
        if !terminated && (cancelled() || started.elapsed().as_millis() as u64 > timeout_ms) {
            was_cancelled = cancelled();
            timed_out = !was_cancelled;
            terminated = true;
            // Signal the whole session first; kill is retained as a final local fallback.
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(format!("-{pid}"))
                .status();
            std::thread::sleep(Duration::from_millis(120));
            let _ = child.kill();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |value| value.as_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_durable_process_identity_before_streamed_output() {
        let mut identity = None;
        let value = run_streaming(
            "printf 'first\\nsecond\\n'",
            ".",
            5_000,
            || false,
            |pid, pgid, session_id, started_at| {
                identity = Some((pid, pgid, session_id, started_at))
            },
            |_, _| {},
        );
        let identity = identity.expect("spawn event");
        assert!(identity.0 > 0);
        assert_eq!(identity.0, identity.1);
        assert_eq!(identity.1, identity.2);
        assert_eq!(value["pid"].as_u64(), Some(u64::from(identity.0)));
        assert_eq!(value["pgid"].as_u64(), Some(u64::from(identity.1)));
        assert_eq!(value["session_id"].as_u64(), Some(u64::from(identity.2)));
        assert_eq!(value["started_at"].as_u64(), Some(identity.3 as u64));
        assert!(value["finished_at"].as_u64().is_some());
        assert_eq!(value["stdout"].as_str(), Some("first\nsecond\n"));
    }
}
