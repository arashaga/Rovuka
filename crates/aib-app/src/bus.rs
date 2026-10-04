//! Bridges the tokio world (IPC server) and the CEF UI thread.
//!
//! Commands are queued and drained on the CEF UI thread via `post_task`.
//! Events are fanned out to every connected UI over a broadcast channel.

use aib_ipc::{Command, Event};
use cef::*;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use tokio::sync::broadcast;

static COMMANDS: Mutex<VecDeque<Command>> = Mutex::new(VecDeque::new());
static EVENTS: OnceLock<broadcast::Sender<Event>> = OnceLock::new();
/// Last tab snapshot, replayed to newly connected UIs.
static LAST_TABS: Mutex<Option<Event>> = Mutex::new(None);

fn events() -> &'static broadcast::Sender<Event> {
    EVENTS.get_or_init(|| broadcast::channel(256).0)
}

pub fn subscribe() -> (Option<Event>, broadcast::Receiver<Event>) {
    let rx = events().subscribe();
    (LAST_TABS.lock().unwrap().clone(), rx)
}

pub fn emit(event: Event) {
    if matches!(event, Event::Tabs { .. }) {
        *LAST_TABS.lock().unwrap() = Some(event.clone());
    }
    let _ = events().send(event);
}

/// Queue a command for the UI thread. Safe to call from any thread.
pub fn send_command(cmd: Command) {
    COMMANDS.lock().unwrap().push_back(cmd);
    let mut task = DrainCommands::new();
    post_task(ThreadId::UI, Some(&mut task));
}

wrap_task! {
    struct DrainCommands;

    impl Task {
        fn execute(&self) {
            loop {
                // Never hold the queue lock while running a command.
                let next = COMMANDS.lock().unwrap().pop_front();
                let Some(cmd) = next else { break };
                crate::host::handle_command(cmd);
            }
        }
    }
}
