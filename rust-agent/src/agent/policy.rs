#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunPolicy {
    Auto,
    Safe,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reasoning {
    Off,
    Low,
    Deep,
}
pub fn reasoning(mode: &str, phase: &str) -> Reasoning {
    // The selected Agent mode is an upstream contract, not merely a UI label.
    // llama.cpp's Qwen template understands `low` and `xhigh`; preserving it
    // across tool, note, compaction and final turns avoids silently degrading
    // a Deep run after its first request.
    let _ = phase;
    if mode == "deep" {
        Reasoning::Deep
    } else {
        Reasoning::Low
    }
}
pub fn requires_approval(policy: RunPolicy, tool: &str, arguments: &serde_json::Value) -> bool {
    if tool == "run_terminal" && terminal_requires_explicit_approval(arguments) {
        return true;
    }
    policy == RunPolicy::Safe && (tool == "delete_file" || tool == "run_terminal")
}

/// Model-issued commands which can end or reconfigure the desktop/user/system
/// session never run silently, including in AUTO. This is deliberately parsed
/// as command words rather than matched as a free-form substring. The runner's
/// own `kill -TERM -<known child pgid>` bypasses this policy entirely: it is
/// internal cancellation machinery, not a model shell command.
pub fn terminal_requires_explicit_approval(arguments: &serde_json::Value) -> bool {
    let Some(command) = arguments.get("command").and_then(serde_json::Value::as_str) else {
        return true;
    };
    let command = command.trim();
    if command.is_empty() {
        return true;
    }
    // Compound shell forms obscure which program ultimately receives control.
    if command.contains('\n')
        || [";", "&&", "||", "`", "$(", "<", ">", "&"]
            .iter()
            .any(|part| command.contains(part))
    {
        return true;
    }
    command.split('|').any(stage_requires_explicit_approval)
}

fn stage_requires_explicit_approval(stage: &str) -> bool {
    let words = shell_words(stage);
    let Some((program, args)) = words.split_first() else {
        return true;
    };
    let program = program.rsplit('/').next().unwrap_or(program);
    // Shell interpreters and process wrappers can conceal a lifecycle command
    // in their child program/script. AUTO only permits directly classifiable
    // project commands; these forms need an explicit decision.
    if matches!(
        program,
        "sh" | "bash"
            | "dash"
            | "zsh"
            | "fish"
            | "sudo"
            | "doas"
            | "nohup"
            | "setsid"
            | "xargs"
            | "env"
            | "timeout"
            | "nice"
            | "ionice"
            | "exec"
            | "eval"
            | "source"
            | "."
    ) {
        return true;
    }
    if program == "command" {
        return wrapped_command_requires_approval(args);
    }
    match program {
        "loginctl" => args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "terminate-session"
                    | "terminate-user"
                    | "kill-session"
                    | "kill-user"
                    | "activate"
                    | "lock-session"
            )
        }),
        "systemctl" => args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "exit"
                    | "poweroff"
                    | "reboot"
                    | "halt"
                    | "suspend"
                    | "hibernate"
                    | "isolate"
                    | "stop"
                    | "restart"
                    | "kill"
            )
        }),
        "gnome-session-quit" | "shutdown" | "reboot" | "poweroff" | "halt" => true,
        // A model cannot prove that a numeric/name target belongs to its own
        // transient shell tree. Require approval; the runtime's own child-PGID
        // cancellation path remains automatic and is not represented here.
        "kill" | "pkill" | "killall" => true,
        "dbus-send" | "gdbus" => args.iter().any(|arg| {
            let lower = arg.to_ascii_lowercase();
            lower.contains("session")
                || lower.contains("logout")
                || lower.contains("power")
                || lower.contains("reboot")
                || lower.contains("org.gnome.shell")
                || lower.contains("login1")
        }),
        _ => false,
    }
}

fn wrapped_command_requires_approval(args: &[String]) -> bool {
    let Some(index) = args
        .iter()
        .position(|word| !word.starts_with('-') && !word.contains('='))
    else {
        return true;
    };
    stage_requires_explicit_approval(&args[index..].join(" "))
}

fn shell_words(stage: &str) -> Vec<String> {
    // The policy only needs a conservative lexical view. Any unbalanced quote
    // leaves a token that cannot equal a safe session command and the compound
    // command gate above already requests approval for shell syntax.
    stage
        .split_whitespace()
        .map(|word| word.trim_matches(['\'', '"']))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_commands_need_approval_even_in_auto() {
        for command in ["loginctl terminate-session 9", "loginctl --no-ask-password terminate-user yaroslav", "systemctl --user exit", "systemctl --user --no-block reboot", "gnome-session-quit --logout", "shutdown now", "pkill gnome-shell", "gdbus call --session --dest org.gnome.SessionManager --method org.gnome.SessionManager.Logout 0", "bash -c 'gnome-session-quit --logout'", "sudo reboot", "env FOO=1 gnome-session-quit --logout", "timeout 10 reboot", "exec reboot", "eval 'reboot'"] {
            assert!(terminal_requires_explicit_approval(&json!({"command":command})), "{command}");
        }
        assert!(!terminal_requires_explicit_approval(
            &json!({"command":"npm run build"})
        ));
        assert!(requires_approval(
            RunPolicy::Auto,
            "run_terminal",
            &json!({"command":"reboot"})
        ));
    }

    #[test]
    fn selected_reasoning_mode_survives_every_agent_phase() {
        for phase in [
            "plan",
            "investigate",
            "execute",
            "verify",
            "final",
            "final_continuation",
        ] {
            assert_eq!(reasoning("fast", phase), Reasoning::Low, "{phase}");
            assert_eq!(reasoning("deep", phase), Reasoning::Deep, "{phase}");
        }
    }

    #[test]
    fn investigation_keeps_reasoning_enabled_after_the_first_turn() {
        assert_eq!(reasoning("fast", "investigate"), Reasoning::Low);
        assert_eq!(reasoning("deep", "investigate"), Reasoning::Deep);
        assert_eq!(reasoning("fast", "execute"), Reasoning::Low);
        assert_eq!(reasoning("deep", "execute"), Reasoning::Deep);
        assert_eq!(reasoning("deep", "verify"), Reasoning::Deep);
    }
}
