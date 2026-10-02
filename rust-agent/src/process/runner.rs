use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

#[derive(Default)]
struct CapturedPipeline {
    exit_code: Option<i32>,
    statuses: Vec<i32>,
    pending_empty_stdout: usize,
}

fn flush_empty_stdout(count: usize, stdout: &mut String, output: &mut impl FnMut(&str, &str)) {
    for _ in 0..count {
        output("stdout", "");
        stdout.push('\n');
    }
}

fn capture_line(
    stream: &str,
    line: String,
    marker: &str,
    stdout: &mut String,
    stderr: &mut String,
    pipeline: &mut CapturedPipeline,
    output: &mut impl FnMut(&str, &str),
) {
    if stream == "stdout" {
        if let Some(metadata) = line.strip_prefix(marker) {
            if let Some((exit_code, statuses)) = metadata.split_once('|') {
                let parsed_exit = exit_code.parse::<i32>();
                let parsed_statuses = statuses
                    .split_whitespace()
                    .map(str::parse::<i32>)
                    .collect::<Result<Vec<_>, _>>();
                if let (Ok(exit_code), Ok(statuses)) = (parsed_exit, parsed_statuses) {
                    pipeline.exit_code = Some(exit_code);
                    pipeline.statuses = statuses;
                    flush_empty_stdout(
                        pipeline.pending_empty_stdout.saturating_sub(1),
                        stdout,
                        output,
                    );
                    pipeline.pending_empty_stdout = 0;
                    return;
                }
            }
        }
        if stream == "stdout" && line.is_empty() {
            pipeline.pending_empty_stdout += 1;
            return;
        }
        if stream == "stdout" && pipeline.pending_empty_stdout > 0 {
            flush_empty_stdout(pipeline.pending_empty_stdout, stdout, output);
            pipeline.pending_empty_stdout = 0;
        }
    }
    output(stream, &line);
    let target = if stream == "stdout" { stdout } else { stderr };
    target.push_str(&line);
    target.push('\n');
}

fn is_truncated_search_pipeline(
    command: &str,
    exit_code: i32,
    statuses: &[i32],
    stdout: &str,
) -> bool {
    if exit_code != 141 || statuses != [141, 0] || stdout.trim().is_empty() {
        return false;
    }
    let mut stages = command.split('|');
    let (Some(producer), Some(consumer), None) = (stages.next(), stages.next(), stages.next())
    else {
        return false;
    };
    fn executable(stage: &str) -> &str {
        stage
            .split_whitespace()
            .next()
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("")
    }
    matches!(executable(producer), "grep" | "egrep" | "fgrep" | "rg")
        && executable(consumer) == "head"
        && !producer.trim_end().ends_with('&')
        && !consumer.trim_start().starts_with('&')
}

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
    let marker = format!(
        "__LOCAL_AI_PIPE_STATUS_{}_{}__",
        std::process::id(),
        now_ms()
    );
    // Capture PIPESTATUS before any other shell command can overwrite it. The
    // wrapper exits with the user's original pipeline status, so diagnostics
    // and shell failure semantics remain intact.
    let wrapped_command = format!(
        "{command}\n__local_ai_runner_exit=$? __local_ai_runner_pipeline=(\"${{PIPESTATUS[@]}}\"); printf '\\n{marker}%s|%s\\n' \"$__local_ai_runner_exit\" \"${{__local_ai_runner_pipeline[*]}}\"; exit \"$__local_ai_runner_exit\""
    );
    let mut child = match Command::new("setsid")
        .arg("bash")
        // Preserve the actual failure status for common diagnostic pipelines
        // such as `npm test | tail`; otherwise the model sees a false success.
        .arg("-o")
        .arg("pipefail")
        .arg("-lc")
        .arg(&wrapped_command)
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
    let mut pipeline = CapturedPipeline::default();
    loop {
        while let Ok((stream, line)) = receiver.try_recv() {
            capture_line(
                stream,
                line,
                &marker,
                &mut stdout,
                &mut stderr,
                &mut pipeline,
                &mut output,
            );
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                while let Ok((stream, line)) = receiver.try_recv() {
                    capture_line(
                        stream,
                        line,
                        &marker,
                        &mut stdout,
                        &mut stderr,
                        &mut pipeline,
                        &mut output,
                    );
                }
                if pipeline.exit_code.is_none() && pipeline.pending_empty_stdout > 0 {
                    flush_empty_stdout(pipeline.pending_empty_stdout, &mut stdout, &mut output);
                    pipeline.pending_empty_stdout = 0;
                }
                let cancelled_status = was_cancelled;
                let exit_code = status.code();
                let pipeline_captured = pipeline.exit_code == exit_code;
                let partial_success = !cancelled_status
                    && !timed_out
                    && pipeline_captured
                    && exit_code.is_some_and(|code| {
                        is_truncated_search_pipeline(command, code, &pipeline.statuses, &stdout)
                    });
                let mut result = serde_json::json!({
                    "command":command,
                    "cwd":cwd,
                    "pid":pid,
                    "pgid":pid,
                    "session_id":pid,
                    "started_at":started_at,
                    "finished_at":now_ms(),
                    "stdout":stdout,
                    "stderr":stderr,
                    "exit_code":exit_code,
                    "timed_out":timed_out,
                    "cancelled":cancelled_status,
                    "status":if cancelled_status {"cancelled"} else if timed_out {"timed_out"} else if partial_success {"partial_success"} else if status.success() {"completed"} else {"error"}
                });
                if pipeline_captured {
                    result["pipeline_statuses"] = serde_json::json!(pipeline.statuses);
                }
                return result;
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

    #[test]
    fn truncated_search_preserves_output_and_reports_partial_success() {
        let value = run_streaming(
            "grep -n . src/agent/loop_runtime.rs | head -n 1",
            ".",
            5_000,
            || false,
            |_, _, _, _| {},
            |_, _| {},
        );
        assert_eq!(value["exit_code"], 141);
        assert_eq!(value["status"], "partial_success");
        assert_eq!(value["pipeline_statuses"], serde_json::json!([141, 0]));
        assert!(value["stdout"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty()));
    }

    #[test]
    fn ordinary_nonzero_search_and_other_sigpipe_remain_errors() {
        let no_match = run_streaming(
            "grep 'no-such-test-pattern' src/agent/loop_runtime.rs",
            ".",
            5_000,
            || false,
            |_, _, _, _| {},
            |_, _| {},
        );
        assert_eq!(no_match["exit_code"], 1);
        assert_eq!(no_match["status"], "error");
        assert_eq!(no_match["stdout"], "");

        let unrelated_sigpipe = run_streaming(
            "seq 1000000 | head -n 1",
            ".",
            5_000,
            || false,
            |_, _, _, _| {},
            |_, _| {},
        );
        assert_eq!(unrelated_sigpipe["exit_code"], 141);
        assert_eq!(unrelated_sigpipe["status"], "error");
        assert_eq!(unrelated_sigpipe["stdout"], "1\n");
    }

    #[test]
    fn nonzero_command_keeps_useful_stdout_and_is_not_partial_success() {
        let value = run_streaming(
            "printf 'useful diagnostic\\n'; exit 7",
            ".",
            5_000,
            || false,
            |_, _, _, _| {},
            |_, _| {},
        );
        assert_eq!(value["exit_code"], 7);
        assert_eq!(value["status"], "error");
        assert_eq!(value["stdout"], "useful diagnostic\n");
    }
}
