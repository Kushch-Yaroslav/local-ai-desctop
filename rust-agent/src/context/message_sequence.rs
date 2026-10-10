use serde_json::{json, Value};

fn role(message: &Value) -> &str {
    message.get("role").and_then(Value::as_str).unwrap_or("")
}

fn tool_call(message: &Value) -> bool {
    role(message) == "assistant"
        && message
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| !calls.is_empty())
}

fn append_content(target: &mut Value, addition: &Value) {
    if let (Some(left), Some(right)) = (
        target.get("content").and_then(Value::as_str),
        addition.get("content").and_then(Value::as_str),
    ) {
        target["content"] = json!(format!("{left}\n\n{right}"));
    } else {
        let parts = |message: &Value| match message.get("content") {
            Some(Value::Array(parts)) => parts.clone(),
            Some(Value::String(text)) => vec![json!({"type":"text","text":text})],
            _ => Vec::new(),
        };
        let mut combined = parts(target);
        combined.extend(parts(addition));
        target["content"] = json!(combined);
    }
}

/// Wire projection only: the transcript retains each user/guidance/tool event.
/// Tool calls and results are substeps of an assistant turn, not completed
/// replies. Guidance/steering during those substeps must not open a second
/// user turn while the first still awaits its reply. Keep it at the latest
/// result boundary with its explicit origin, preserving call IDs and results.
/// No fabricated assistant acknowledgement or template override is required.
pub fn normalize(messages: &[Value]) -> Vec<Value> {
    let mut normalized: Vec<Value> = Vec::new();
    let mut last_turn = "";
    let mut last_user = None;
    for message in messages {
        if role(message) == "runtime" {
            // State belongs to this assistant/tool substep, not to a new
            // human turn. Initial state shares the original request envelope.
            // A runtime review after a completed draft needs a continuation
            // envelope for strict alternating templates; its origin stays
            // explicit and it is never persisted as a human message.
            if let Some(target) = normalized.last_mut().filter(|m| {
                role(m) == "tool" || role(m) == "user"
            }) {
                append_content(target, message);
            } else {
                let mut continuation = message.clone();
                continuation["role"] = json!("user");
                continuation["metadata"] = json!({"runtime":true});
                normalized.push(continuation);
                last_turn = "user";
                last_user = Some(normalized.len() - 1);
            }
        } else if role(message) == "user" && last_turn == "user" {
            let index = if normalized
                .last()
                .is_some_and(|m| role(m) == "tool" || role(m) == "user")
            {
                normalized.len() - 1
            } else {
                last_user.expect("an open user turn has its user message")
            };
            let mut addition = message.clone();
            if role(&normalized[index]) == "tool" {
                // Runtime tails already identify themselves; real steering/user
                // input must also be distinguishable from untrusted tool output.
                if let Some(content) = message.get("content").and_then(Value::as_str) {
                    addition["content"] = json!(format!(
                        "[CONTINUED USER TURN — NOT TOOL OUTPUT]\n{content}"
                    ));
                }
            }
            append_content(&mut normalized[index], &addition);
        } else if tool_call(message)
            && normalized
                .last()
                .is_some_and(|m| role(m) == "assistant" && !tool_call(m))
        {
            // A withheld draft/status followed by tools continues the same
            // assistant turn. Carry its text into the native call envelope,
            // rather than falsely recording a completed ordinary reply.
            let target = normalized.last_mut().expect("assistant continuation");
            let mut combined = target.clone();
            append_content(&mut combined, message);
            combined["tool_calls"] = message["tool_calls"].clone();
            if let Some(reasoning) = message.get("reasoning_content").and_then(Value::as_str) {
                let prior = combined
                    .get("reasoning_content")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                combined["reasoning_content"] = json!(format!("{prior}{reasoning}"));
            }
            *target = combined;
            last_turn = normalized
                .iter()
                .rev()
                .find(|m| role(m) == "user" || (role(m) == "assistant" && !tool_call(m)))
                .map(|m| {
                    if role(m) == "user" {
                        "user"
                    } else {
                        "assistant"
                    }
                })
                .unwrap_or("");
        } else if role(message) == "assistant"
            && !tool_call(message)
            && normalized
                .last()
                .is_some_and(|m| role(m) == "assistant" && !tool_call(m))
        {
            let target = normalized.last_mut().expect("adjacent assistant");
            append_content(target, message);
            if let Some(reasoning) = message.get("reasoning_content").and_then(Value::as_str) {
                let prior = target
                    .get("reasoning_content")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                target["reasoning_content"] = json!(format!("{prior}{reasoning}"));
            }
            last_turn = "assistant";
        } else {
            normalized.push(message.clone());
            if role(message) == "user" {
                last_turn = "user";
                last_user = Some(normalized.len() - 1);
            } else if role(message) == "assistant" && !tool_call(message) {
                last_turn = "assistant";
            }
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    fn valid(messages: &[Value]) {
        let mut ordinary_user = true;
        for message in messages.iter().skip(1) {
            if role(message) == "user" || (role(message) == "assistant" && !tool_call(message)) {
                assert_eq!(
                    role(message) == "user",
                    ordinary_user,
                    "actual Devstral template alternation: {messages:?}"
                );
                ordinary_user = !ordinary_user;
            }
        }
    }
    #[test]
    fn initial_runtime_guidance_is_same_user_turn() {
        let input = vec![
            json!({"role":"system","content":"stable"}),
            json!({"role":"user","content":"inspect both projects"}),
            json!({"role":"user","content":"[RUNTIME GUIDANCE — NOT USER CONTENT]\nplan and memory"}),
        ];
        let output = normalize(&input);
        valid(&output);
        assert_eq!(output.len(), 2);
        assert!(output[1]["content"]
            .as_str()
            .unwrap()
            .starts_with("inspect both projects\n\n"));
        assert!(output[1]["content"]
            .as_str()
            .unwrap()
            .contains("plan and memory"));
        assert_eq!(input.len(), 3, "canonical ledger not changed");
    }
    #[test]
    fn multiple_tool_cycles_and_steering_preserve_matching_results() {
        let mut input = vec![
            json!({"role":"system","content":"stable"}),
            json!({"role":"user","content":"task"}),
        ];
        for i in 0..3 {
            input.push(json!({"role":"assistant","tool_calls":[{"id":format!("call-{i}"),"type":"function","function":{"name":"read_file","arguments":"{}"}}]}));
            input.push(json!({"role":"tool","tool_call_id":format!("call-{i}"),"content":format!("result-{i}")}));
            input.push(json!({"role":"user","content":format!("[RUNTIME GUIDANCE — NOT USER CONTENT]\nupdated evidence {i}")}));
        }
        input.push(
            json!({"role":"user","content":"Also inspect Project 2","metadata":{"steering":true}}),
        );
        input.push(json!({"role":"assistant","content":"verified answer"}));
        input.push(json!({"role":"user","content":"Continue"}));
        input.push(json!({"role":"user","content":"[RUNTIME GUIDANCE — NOT USER CONTENT]\nrestored task memory"}));
        let output = normalize(&input);
        valid(&output);
        assert_eq!(output.len(), 10);
        for i in 0..3 {
            assert_eq!(output[3 + 2 * i]["tool_call_id"], format!("call-{i}"));
            let result = output[3 + 2 * i]["content"].as_str().unwrap();
            assert!(result.starts_with(&format!("result-{i}")));
            assert!(result.contains(&format!("updated evidence {i}")));
        }
        assert!(output[7]["content"]
            .as_str()
            .unwrap()
            .contains("Also inspect Project 2"));
        assert!(output[9]["content"]
            .as_str()
            .unwrap()
            .starts_with("Continue\n\n"));
    }
    #[test]
    fn withheld_draft_followed_by_tools_is_an_assistant_continuation() {
        let input = vec![
            json!({"role":"system","content":"stable"}),
            json!({"role":"user","content":"fix and verify"}),
            json!({"role":"assistant","content":"premature draft","reasoning_content":"reason"}),
            json!({"role":"assistant","content":"","tool_calls":[{"id":"check","function":{"name":"run_terminal","arguments":"{}"}}]}),
            json!({"role":"tool","tool_call_id":"check","content":"test failed"}),
            json!({"role":"assistant","content":"honest final"}),
            json!({"role":"user","content":"Continue"}),
        ];
        let output = normalize(&input);
        valid(&output);
        assert_eq!(output.len(), 6);
        assert!(output[2]["content"]
            .as_str()
            .unwrap()
            .contains("premature draft"));
        assert_eq!(output[2]["reasoning_content"], "reason");
        assert_eq!(output[2]["tool_calls"][0]["id"], "check");
        assert_eq!(input.len(), 7);
    }
    #[test]
    fn adjacent_assistant_fragments_and_multimodal_user_parts_are_retained() {
        let input = vec![
            json!({"role":"system","content":"stable"}),
            json!({"role":"user","content":[{"type":"text","text":"inspect"},{"type":"image_url","image_url":{"url":"data:image/png;base64,fixture"}}]}),
            json!({"role":"user","content":"guidance"}),
            json!({"role":"assistant","content":"first","reasoning_content":"thought 1"}),
            json!({"role":"assistant","content":"second","reasoning_content":"thought 2"}),
        ];
        let output = normalize(&input);
        valid(&output);
        assert_eq!(output[1]["content"].as_array().unwrap().len(), 3);
        assert_eq!(output[2]["content"], "first\n\nsecond");
        assert_eq!(output[2]["reasoning_content"], "thought 1thought 2");
    }
}
