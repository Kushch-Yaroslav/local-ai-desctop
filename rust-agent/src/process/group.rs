//! Strictly owned process groups: the only place in the runtime that signals
//! a process.
//!
//! A terminal command runs in a brand-new session and process group created by
//! this module. Cancellation may signal exactly that group, and only while the
//! group leader is still running and unreaped (so its PID cannot have been
//! reused). There is deliberately no constructor from a bare PID/PGID: process
//! identifiers read back from persisted events, a previous run or another
//! process can never become a signal target, and after a restart an earlier
//! command is simply no longer controllable.
//!
//! Never shell out to `kill`. procps-ng `kill -TERM -<pgid>` does not issue
//! `kill(-<pgid>)`: it reduces the number to its first digit, so any group
//! starting with `1` becomes `kill(-1, SIGTERM)`, which signals every process
//! the user owns (the whole desktop session).

use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};

extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
    fn getpgid(pid: i32) -> i32;
    fn getsid(pid: i32) -> i32;
    fn getpgrp() -> i32;
    fn setsid() -> i32;
}

const SIGKILL: i32 = 9;
const SIGTERM: i32 = 15;
const ESRCH: i32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
}

impl Signal {
    fn number(self) -> i32 {
        match self {
            Signal::Term => SIGTERM,
            Signal::Kill => SIGKILL,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Zero, negative, 1 (init), or outside the PID range.
    InvalidId(i64),
    /// The group is one this process (or its parent) belongs to.
    ProtectedGroup(i32),
    /// The process is not the leader of its own session and group, so this
    /// runtime did not create it as an isolated group.
    NotOwned(i32),
    /// The signal syscall itself failed.
    Os(i32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    Delivered,
    /// The leader had already exited; nothing was signalled.
    NotRunning,
}

/// Pure check shared by adoption and signalling. `protected` lists the groups
/// that must never be targeted.
pub fn validate_target(pgid: i64, protected: &[i32]) -> Result<i32, Refusal> {
    let id = i32::try_from(pgid).map_err(|_| Refusal::InvalidId(pgid))?;
    if id <= 1 {
        return Err(Refusal::InvalidId(pgid));
    }
    if protected.contains(&id) {
        return Err(Refusal::ProtectedGroup(id));
    }
    Ok(id)
}

/// Groups and sessions of this process and of its parent (typically Electron,
/// a shell or the desktop session), plus our own PID.
fn protected_groups() -> Vec<i32> {
    // SAFETY: these calls only read process attributes.
    unsafe {
        let parent = i32::try_from(std::os::unix::process::parent_id()).unwrap_or(1);
        let mut groups = vec![
            getpgrp(),
            getsid(0),
            i32::try_from(std::process::id()).unwrap_or(1),
            parent,
        ];
        for id in [getpgid(parent), getsid(parent)] {
            if id > 0 {
                groups.push(id);
            }
        }
        groups
    }
}

/// Token proving that a child was started by `spawn_owned` and leads its own
/// session and process group. It carries no public constructor from numbers.
#[derive(Debug)]
pub struct OwnedGroup {
    pgid: i32,
}

/// Starts `command` as leader of a new session/process group. The child is
/// signalled through the returned token only.
pub fn spawn_owned(mut command: Command) -> io::Result<(Child, OwnedGroup)> {
    // SAFETY: the closure runs between fork and exec and only calls the
    // async-signal-safe `setsid`.
    unsafe {
        command.pre_exec(|| {
            if setsid() == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = command.spawn()?;
    match OwnedGroup::adopt(&child) {
        Ok(group) => Ok((child, group)),
        Err(refusal) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(io::Error::other(format!(
                "terminal process is not an isolated group: {refusal:?}"
            )))
        }
    }
}

impl OwnedGroup {
    pub fn pgid(&self) -> u32 {
        self.pgid.unsigned_abs()
    }

    /// Only a live child that is the leader of its own session and group is
    /// accepted. An unrelated, exited or reaped process is refused.
    pub fn adopt(child: &Child) -> Result<Self, Refusal> {
        let pid = validate_target(i64::from(child.id()), &protected_groups())?;
        // SAFETY: read-only queries on a PID we hold an unreaped handle for.
        let (group, session) = unsafe { (getpgid(pid), getsid(pid)) };
        if group != pid || session != pid {
            return Err(Refusal::NotOwned(pid));
        }
        Ok(Self { pgid: pid })
    }

    /// Signals the group, but only while the leader is still running and has
    /// not been reaped, and only if every ownership check still holds.
    pub fn signal(&self, child: &mut Child, signal: Signal) -> Result<Delivery, Refusal> {
        if i64::from(child.id()) != i64::from(self.pgid) {
            return Err(Refusal::NotOwned(self.pgid));
        }
        // `try_wait` reaps an exited leader; an unreaped leader keeps its PID
        // reserved, so the group id below cannot belong to anyone else.
        if !matches!(child.try_wait(), Ok(None)) {
            return Ok(Delivery::NotRunning);
        }
        let pgid = validate_target(i64::from(self.pgid), &protected_groups())?;
        // SAFETY: read-only queries.
        let (group, session) = unsafe { (getpgid(pgid), getsid(pgid)) };
        if group != pgid || session != pgid {
            return Err(Refusal::NotOwned(pgid));
        }
        // SAFETY: `pgid` is a validated, positive, isolated group we created.
        // The negated value addresses that process group only.
        let result = unsafe { kill(-pgid, signal.number()) };
        if result == 0 {
            return Ok(Delivery::Delivered);
        }
        let errno = io::Error::last_os_error().raw_os_error().unwrap_or(0);
        if errno == ESRCH {
            Ok(Delivery::NotRunning)
        } else {
            Err(Refusal::Os(errno))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    /// Disposable child that is always cleaned up, even if an assertion fails.
    struct Sibling(Child);

    impl Sibling {
        fn start(tag: &str) -> Self {
            Self(
                Command::new("sleep")
                    .arg(format!("120.{tag}"))
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            )
        }
        fn alive(&mut self) -> bool {
            matches!(self.0.try_wait(), Ok(None))
        }
    }

    impl Drop for Sibling {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// A shell that starts a background descendant and reports its PID.
    fn spawn_group(tag: &str) -> (Child, OwnedGroup, i32) {
        let mut command = Command::new("bash");
        command
            .arg("-c")
            .arg(format!("sleep 120.{tag} & echo $!; wait"))
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let (mut child, group) = spawn_owned(command).unwrap();
        let mut line = String::new();
        let mut out = std::io::BufReader::new(child.stdout.take().unwrap());
        std::io::BufRead::read_line(&mut out, &mut line).unwrap();
        (child, group, line.trim().parse().unwrap())
    }

    fn gone(pid: i32) -> bool {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => true,
            Ok(stat) => stat
                .rsplit_once(") ")
                .is_some_and(|(_, rest)| rest.starts_with('Z')),
        }
    }

    fn wait_gone(pid: i32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if gone(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        gone(pid)
    }

    fn cleanup(mut child: Child, descendant: i32) {
        let _ = child.kill();
        let _ = child.wait();
        // Only our own disposable `sleep`, addressed by its exact positive PID.
        if validate_target(i64::from(descendant), &protected_groups()).is_ok() && !gone(descendant)
        {
            // SAFETY: a single, validated, positive PID.
            unsafe { kill(descendant, SIGKILL) };
        }
    }

    #[test]
    fn invalid_zero_negative_and_out_of_range_ids_are_refused() {
        for bad in [
            0_i64,
            1,
            -1,
            -2,
            -12345,
            i64::from(i32::MAX) + 1,
            i64::MAX,
            i64::MIN,
        ] {
            assert_eq!(
                validate_target(bad, &[]),
                Err(Refusal::InvalidId(bad)),
                "{bad}"
            );
        }
        assert_eq!(validate_target(2, &[]), Ok(2));
        assert_eq!(validate_target(4_194_304, &[]), Ok(4_194_304));
    }

    #[test]
    fn this_process_its_parent_and_their_groups_are_protected() {
        let protected = protected_groups();
        assert!(protected.len() >= 3);
        for id in &protected {
            if *id > 1 {
                assert_eq!(
                    validate_target(i64::from(*id), &protected),
                    Err(Refusal::ProtectedGroup(*id))
                );
            }
        }
        // Our own group and session are among them.
        assert!(protected.contains(&unsafe { getpgrp() }));
        assert!(protected.contains(&unsafe { getsid(0) }));
    }

    #[test]
    fn a_child_is_isolated_in_its_own_session_and_group() {
        let (child, group, descendant) = spawn_group("01");
        let pid = i32::try_from(child.id()).unwrap();
        assert_eq!(group.pgid(), child.id());
        assert_ne!(pid, unsafe { getpgrp() });
        assert_ne!(unsafe { getsid(pid) }, unsafe { getsid(0) });
        assert_eq!(unsafe { getpgid(pid) }, pid);
        assert_eq!(
            unsafe { getpgid(descendant) },
            pid,
            "descendant is in the group"
        );
        cleanup(child, descendant);
    }

    #[test]
    fn terminating_a_group_stops_its_descendants_and_spares_unrelated_siblings() {
        let mut sibling = Sibling::start("02");
        let (mut child, group, descendant) = spawn_group("03");
        assert_eq!(
            group.signal(&mut child, Signal::Term),
            Ok(Delivery::Delivered)
        );
        assert!(
            wait_gone(descendant),
            "the descendant survived group termination"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            child.try_wait().unwrap().is_some(),
            "the group leader survived"
        );
        assert!(sibling.alive(), "an unrelated sibling was signalled");
    }

    #[test]
    fn simultaneous_groups_are_independent() {
        let mut sibling = Sibling::start("04");
        let (mut first, first_group, first_descendant) = spawn_group("05");
        let (second, second_group, second_descendant) = spawn_group("06");
        let mut second = second;
        assert_eq!(
            first_group.signal(&mut first, Signal::Kill),
            Ok(Delivery::Delivered)
        );
        assert!(wait_gone(first_descendant));
        assert!(
            !gone(second_descendant),
            "another tool's process was signalled"
        );
        assert!(
            matches!(second.try_wait(), Ok(None)),
            "another tool's shell was signalled"
        );
        assert!(sibling.alive());
        // A token is bound to its own child.
        assert_eq!(
            second_group.signal(&mut first, Signal::Term),
            Err(Refusal::NotOwned(
                i32::try_from(second_group.pgid()).unwrap()
            ))
        );
        assert!(!gone(second_descendant));
        cleanup(second, second_descendant);
        let _ = first.wait();
    }

    #[test]
    fn an_exited_child_is_never_signalled() {
        let mut sibling = Sibling::start("07");
        let mut command = Command::new("true");
        command.stdout(Stdio::null());
        let (mut child, group) = spawn_owned(command).unwrap();
        child.wait().unwrap();
        for signal in [Signal::Term, Signal::Kill] {
            assert_eq!(group.signal(&mut child, signal), Ok(Delivery::NotRunning));
        }
        assert!(sibling.alive());
    }

    #[test]
    fn a_stale_or_unowned_process_cannot_be_adopted_or_signalled() {
        let mut sibling = Sibling::start("08");
        // Never created through spawn_owned (as after an application restart):
        // it shares our group, so it is not an owned, isolated group.
        let mut unowned = Sibling::start("09");
        assert!(matches!(
            OwnedGroup::adopt(&unowned.0),
            Err(Refusal::NotOwned(_))
        ));
        assert!(unowned.alive() && sibling.alive());
        // Exited and reaped: the PID no longer names a live group.
        let mut command = Command::new("true");
        command.stdout(Stdio::null());
        let (mut child, _group) = spawn_owned(command).unwrap();
        child.wait().unwrap();
        assert!(OwnedGroup::adopt(&child).is_err());
        assert!(unowned.alive() && sibling.alive());
    }

    #[test]
    fn nothing_outside_this_module_can_signal_or_shell_out_to_a_kill_utility() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let in_group_module = path.file_name().and_then(|n| n.to_str()) == Some("group.rs");
                let text = std::fs::read_to_string(&path).unwrap();
                for (number, line) in text.lines().enumerate() {
                    if line.trim_start().starts_with("//") {
                        continue;
                    }
                    let kill_tool = ["kill", "pkill", "killall", "killpg", "pgrep"]
                        .iter()
                        .any(|name| line.contains(&format!("Command::new(\"{name}\")")));
                    let libc_kill = ["libc", "kill"].join("::");
                    let raw_signal = line.contains(&libc_kill)
                        || (!in_group_module
                            && (line.contains("fn kill(") || line.contains("fn killpg(")));
                    if kill_tool || raw_signal {
                        offenders.push(format!("{}:{}", path.display(), number + 1));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "signalling outside process::group: {offenders:?}"
        );
    }
}
