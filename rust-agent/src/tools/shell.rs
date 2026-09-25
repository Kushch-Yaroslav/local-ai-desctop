use serde_json::Value;
use std::path::Path;
pub fn execute(
    root: &Path,
    args: &Value,
    cancelled: impl Fn() -> bool,
    started_event: impl FnMut(u32, u32, u32, u128),
    output: impl FnMut(&str, &str),
) -> Result<Value, String> {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "command is required".to_owned())?;
    let timeout = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(120_000);
    Ok(crate::process::runner::run_streaming(
        command,
        &root.display().to_string(),
        timeout,
        cancelled,
        started_event,
        output,
    ))
}
