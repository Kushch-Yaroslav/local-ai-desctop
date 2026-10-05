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
    requires_approval_in_root(policy, tool, arguments, None)
}

pub fn requires_approval_in_root(
    policy: RunPolicy,
    tool: &str,
    arguments: &serde_json::Value,
    root: Option<&std::path::Path>,
) -> bool {
    if tool == "run_terminal" && terminal_requires_explicit_approval_in_root(arguments, root) {
        return true;
    }
    policy == RunPolicy::Safe && (tool == "delete_file" || tool == "run_terminal")
}

/// Model-issued commands which can end or reconfigure the desktop/user/system
/// session never run silently, including in AUTO. This is deliberately parsed
/// as command words rather than matched as a free-form substring. The runner's
/// own cancellation (`process::group`, a direct signal to the isolated group it
/// created) bypasses this policy entirely: it is internal machinery, not a model
/// shell command.
pub fn terminal_requires_explicit_approval(arguments: &serde_json::Value) -> bool {
    terminal_requires_explicit_approval_in_root(arguments, None)
}

fn terminal_requires_explicit_approval_in_root(
    arguments: &serde_json::Value,
    root: Option<&std::path::Path>,
) -> bool {
    let Some(command) = arguments.get("command").and_then(serde_json::Value::as_str) else {
        return true;
    };
    if let Some(allowed) = scoped_read_only_git_chain(command, root) {
        return !allowed;
    }
    if let Some(allowed) = read_only_git_and_chain(command) {
        return !allowed;
    }
    let Ok(stages) = shell_stages(command) else {
        return true;
    };
    stages.iter().enumerate().any(|(index, words)| {
        stage_requires_explicit_approval(words) || (index > 0 && !safe_pipe_filter(words))
    })
}

/// `cd <selected project> && git log ...` is the normal command shape seen in
/// real audits. Only an existing directory inside the selected project and a
/// fully read-only Git inspection suffix are eligible for automatic approval.
fn scoped_read_only_git_chain(command: &str, root: Option<&std::path::Path>) -> Option<bool> {
    let root = root?;
    let marker = "&&";
    let (prefix, suffix) = command.split_once(marker)?;
    let words = shell_stages(prefix).ok()?;
    if words.len() != 1 || words[0].len() != 2 || words[0][0] != "cd" {
        return None;
    }
    let selected = std::fs::canonicalize(root).ok()?;
    let entered = std::fs::canonicalize(if std::path::Path::new(&words[0][1]).is_absolute() {
        std::path::PathBuf::from(&words[0][1])
    } else {
        selected.join(&words[0][1])
    })
    .ok()?;
    if !entered.starts_with(selected) {
        return Some(false);
    }
    let suffix = suffix.trim();
    let parts = if suffix.contains("&&") {
        return read_only_git_and_chain(suffix);
    } else {
        vec![suffix]
    };
    Some(parts.into_iter().all(|part| {
        let Ok(stages) = shell_stages(part) else {
            return false;
        };
        stages.iter().enumerate().all(|(index, words)| {
            if index == 0 {
                words.first().is_some_and(|program| {
                    matches!(program.as_str(), "git" | "/usr/bin/git" | "/bin/git")
                }) && !stage_requires_explicit_approval(words)
            } else {
                safe_pipe_filter(words) && !stage_requires_explicit_approval(words)
            }
        })
    }))
}

/// Permit a quoted, explicit `git inspection && git inspection` chain while
/// refusing any segment that is not independently read-only Git. Other shell
/// list forms remain approval-gated.
fn read_only_git_and_chain(command: &str) -> Option<bool> {
    let mut parts = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut start = 0;
    let chars = command.char_indices().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        let (byte, ch) = chars[index];
        if escaped {
            escaped = false;
            index += 1;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            index += 1;
            continue;
        }
        if let Some(active) = quote {
            if ch == active {
                quote = None;
            }
            index += 1;
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            index += 1;
            continue;
        }
        if ch == '&' && chars.get(index + 1).is_some_and(|(_, next)| *next == '&') {
            parts.push(&command[start..byte]);
            start = chars[index + 1].0 + 1;
            index += 2;
            continue;
        }
        index += 1;
    }
    if parts.is_empty() {
        return None;
    }
    parts.push(&command[start..]);
    Some(parts.into_iter().all(|part| {
        let Ok(stages) = shell_stages(part) else {
            return false;
        };
        stages.iter().enumerate().all(|(i, words)| {
            if i == 0 {
                words.first().is_some_and(|program| {
                    matches!(program.as_str(), "git" | "/usr/bin/git" | "/bin/git")
                }) && !stage_requires_explicit_approval(words)
            } else {
                safe_pipe_filter(words) && !stage_requires_explicit_approval(words)
            }
        })
    }))
}

/// Lex only the shell forms the policy can prove safe. Pipes inside quotes are
/// data; substitutions, redirections, command lists and unbalanced quotes
/// require approval rather than being misclassified as a Git option.
fn shell_stages(command: &str) -> Result<Vec<Vec<String>>, ()> {
    let mut stages = Vec::new();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    for ch in command.chars() {
        if escaped {
            word.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if ch == '\n' || ch == '\r' || ch == '`' || ch == '$' {
            return Err(());
        }
        if let Some(active) = quote {
            if ch == active {
                quote = None;
            } else {
                word.push(ch);
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            ';' | '&' | '<' | '>' => return Err(()),
            '|' => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
                if words.is_empty() {
                    return Err(());
                }
                stages.push(std::mem::take(&mut words));
            }
            ch if ch.is_whitespace() => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
            _ => word.push(ch),
        }
    }
    if escaped || quote.is_some() {
        return Err(());
    }
    if !word.is_empty() {
        words.push(word);
    }
    if words.is_empty() {
        return Err(());
    }
    stages.push(words);
    Ok(stages)
}

fn safe_pipe_filter(words: &[String]) -> bool {
    let Some((program, _args)) = words.split_first() else {
        return false;
    };
    let basename = program.rsplit('/').next().unwrap_or(program);
    let trusted = program == basename
        || program == &format!("/usr/bin/{basename}")
        || program == &format!("/bin/{basename}");
    trusted && matches!(basename, "head" | "tail" | "wc" | "cut" | "grep")
}

fn stage_requires_explicit_approval(words: &[String]) -> bool {
    let Some((program, args)) = words.split_first() else {
        return true;
    };
    let unqualified = program.as_str();
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
    if program == "git" {
        if !matches!(unqualified, "git" | "/usr/bin/git" | "/bin/git") {
            return true;
        }
        return git_requires_approval(args);
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
    stage_requires_explicit_approval(&args[index..])
}

fn git_requires_approval(args: &[String]) -> bool {
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        if arg == "-C" || arg == "--git-dir" || arg == "--work-tree" {
            index += 2;
            if index > args.len() {
                return true;
            }
        } else if arg.starts_with("-C")
            || arg.starts_with("--git-dir=")
            || arg.starts_with("--work-tree=")
            || matches!(
                arg.as_str(),
                "--no-pager"
                    | "--literal-pathspecs"
                    | "--glob-pathspecs"
                    | "--noglob-pathspecs"
                    | "--icase-pathspecs"
            )
        {
            index += 1;
        } else if arg.starts_with('-') {
            return true;
        } else {
            break;
        }
    }
    let Some((verb, rest)) = args.get(index..).and_then(|slice| slice.split_first()) else {
        return true;
    };
    if rest.iter().any(|arg| {
        arg == "--output"
            || arg.starts_with("--output=")
            || matches!(
                arg.as_str(),
                "--ext-diff" | "--textconv" | "--open-files-in-pager" | "--exec" | "--paginate"
            )
    }) {
        return true;
    }
    match verb.as_str() {
        "status" | "log" | "show" | "diff" | "rev-parse" | "ls-files" | "grep" => false,
        "remote" => !rest
            .iter()
            .all(|arg| matches!(arg.as_str(), "-v" | "--verbose")),
        "branch" => {
            if rest.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "--delete"
                        | "--move"
                        | "--copy"
                        | "--edit-description"
                        | "--track"
                        | "--no-track"
                        | "--unset-upstream"
                ) || arg.starts_with("--set-upstream-to")
                    || matches!(
                        arg.as_str(),
                        "--force" | "--create-reflog" | "--no-create-reflog"
                    )
                    || (arg.starts_with('-')
                        && !arg.starts_with("--")
                        && arg.chars().skip(1).any(|ch| "dDmMcCuf".contains(ch)))
            }) {
                return true;
            }
            let listing = rest.iter().any(|arg| arg == "--list");
            let mut skip_value = false;
            for arg in rest {
                if skip_value {
                    skip_value = false;
                    continue;
                }
                if matches!(
                    arg.as_str(),
                    "--format"
                        | "--sort"
                        | "--contains"
                        | "--no-contains"
                        | "--merged"
                        | "--no-merged"
                        | "--points-at"
                ) {
                    skip_value = true;
                    continue;
                }
                if arg.starts_with('-') || listing {
                    continue;
                }
                return true;
            }
            skip_value
        }
        _ => true,
    }
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
    fn read_only_git_history_and_quoted_pipelines_are_auto_allowed() {
        for command in [
            "git status --short",
            "git -C src log --oneline -20 -- api.php",
            "git --no-pager log --format='%h | %s' --all | head -30",
            "git show HEAD:public/api.php",
            "git diff --stat HEAD~1 -- public/api.php",
            "git branch",
            "git branch -avv",
            "git branch --list 'feature/*'",
            "git branch --show-current",
            "git remote -v",
            "git rev-parse HEAD",
            "git ls-files 'src/**/*.ts'",
            "git grep -n 'checkout' -- public/api.php",
            "git log --oneline | grep Casino | head -5",
            "git status --short && git log --oneline -5",
            "git log --format='%h && %s' | head -5",
            "npm test | tail -20",
        ] {
            assert!(
                !terminal_requires_explicit_approval(&json!({"command":command})),
                "{command}"
            );
        }
        assert!(!requires_approval(
            RunPolicy::Auto,
            "run_terminal",
            &json!({"command":"git log --oneline -5"})
        ));
        assert!(requires_approval(
            RunPolicy::Safe,
            "run_terminal",
            &json!({"command":"git log --oneline -5"})
        ));
    }

    #[test]
    fn mutating_git_and_unsafe_shell_composition_need_approval() {
        for command in [
            "git commit -m fix",
            "git push",
            "git pull",
            "git checkout main",
            "git switch main",
            "git reset --hard",
            "git clean -fd",
            "git restore public/api.php",
            "git rebase main",
            "git merge main",
            "git cherry-pick HEAD~1",
            "git tag release",
            "git branch new-name",
            "git branch -D old",
            "git branch --set-upstream-to origin/main",
            "git config user.name X",
            "git add .",
            "git rm file",
            "git mv old new",
            "git -c alias.log='!touch changed' log",
            "git diff --output=changed",
            "git grep --open-files-in-pager pattern",
            "git log | sh",
            "git log | tee changed",
            "/tmp/git log --oneline",
            "git log | /tmp/head",
            "git branch --force main",
            "git log && git reset --hard",
            "git status && npm run build",
            "git log; git commit -m bad",
            "git log > history.txt",
            "git log --format='unterminated",
            "git log $(touch changed)",
        ] {
            assert!(
                terminal_requires_explicit_approval(&json!({"command":command})),
                "{command}"
            );
        }
    }

    #[test]
    fn actual_auto_terminal_gate_allows_scoped_git_inspection_only() {
        let root = std::env::temp_dir().join(format!(
            "git-policy-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let prefix = format!("cd {} && ", root.display());
        for suffix in [
            "git log",
            "git log --oneline",
            "git show HEAD:file",
            "git status --short",
            "git diff",
            "git branch --list",
            "git remote -v",
            "git log --format='%h | %s' | head -20",
        ] {
            assert!(
                !requires_approval_in_root(
                    RunPolicy::Auto,
                    "run_terminal",
                    &json!({"command":format!("{prefix}{suffix}")}),
                    Some(&root)
                ),
                "{suffix}"
            );
        }
        assert!(!requires_approval_in_root(
            RunPolicy::Auto,
            "run_terminal",
            &json!({"command":format!("git -C {} log --oneline", root.display())}),
            Some(&root)
        ));
        assert!(!requires_approval_in_root(
            RunPolicy::Auto,
            "run_terminal",
            &json!({"command":format!("git -C {} log --oneline -30 | head -40", root.display())}),
            Some(&root)
        ));
        assert!(requires_approval_in_root(
            RunPolicy::Auto,
            "run_terminal",
            &json!({"command":format!("ls -la {} && (cd {} && git log --oneline -30 2>&1 | head -40)",root.display(),root.display())}),
            Some(&root)
        ));
        for suffix in [
            "git commit -m x",
            "git push",
            "git checkout main",
            "git switch -c new",
            "git reset --hard",
            "git clean -fd",
            "git rebase main",
            "git branch -D old",
            "git log > log.txt",
            "git log | sh",
            "git log && rm -rf x",
        ] {
            assert!(
                requires_approval_in_root(
                    RunPolicy::Auto,
                    "run_terminal",
                    &json!({"command":format!("{prefix}{suffix}")}),
                    Some(&root)
                ),
                "{suffix}"
            );
        }
        assert!(requires_approval_in_root(
            RunPolicy::Auto,
            "run_terminal",
            &json!({"command":"cd / && git log"}),
            Some(&root)
        ));
        assert!(requires_approval_in_root(
            RunPolicy::Safe,
            "run_terminal",
            &json!({"command":format!("{prefix}git log")}),
            Some(&root)
        ));
        std::fs::remove_dir_all(root).unwrap();
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
