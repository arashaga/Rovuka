//! Bridges the tokio world (IPC server) and the CEF UI thread.
//!
//! Commands are queued and drained on the CEF UI thread via `post_task`.
//! Events are fanned out to every connected UI over a broadcast channel.

use aib_ipc::{Command, Event};
use cef::*;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::broadcast;

enum QueuedCommand {
    Ui(Command),
    Agent(crate::cdp::HostRequest),
}

static COMMANDS: Mutex<VecDeque<QueuedCommand>> = Mutex::new(VecDeque::new());
static EVENTS: OnceLock<broadcast::Sender<Event>> = OnceLock::new();
/// Last tab snapshot, replayed to newly connected UIs.
static LAST_TABS: Mutex<Option<Event>> = Mutex::new(None);
static LAST_LAYOUT: Mutex<Option<Event>> = Mutex::new(None);
static AGENT: OnceLock<Arc<crate::agent::Service>> = OnceLock::new();

pub fn set_agent(service: Arc<crate::agent::Service>) {
    let _ = AGENT.set(service);
}

pub fn take_over() {
    if let Some(service) = AGENT.get() {
        service.take_over();
    }
}

pub fn task_active(id: &str) -> bool {
    AGENT.get().is_some_and(|service| service.task_active(id))
}

fn events() -> &'static broadcast::Sender<Event> {
    EVENTS.get_or_init(|| broadcast::channel(256).0)
}

pub fn subscribe() -> (Vec<Event>, broadcast::Receiver<Event>) {
    let rx = events().subscribe();
    (
        [
            LAST_TABS.lock().unwrap().clone(),
            LAST_LAYOUT.lock().unwrap().clone(),
        ]
        .into_iter()
        .flatten()
        .collect(),
        rx,
    )
}

pub fn emit(event: Event) {
    if matches!(event, Event::Tabs { .. }) {
        *LAST_TABS.lock().unwrap() = Some(event.clone());
    }
    if matches!(event, Event::AssistantLayout { .. }) {
        *LAST_LAYOUT.lock().unwrap() = Some(event.clone());
    }
    let _ = events().send(event);
}

/// Queue a command for the UI thread. Safe to call from any thread.
pub fn send_command(cmd: Command) {
    if cmd.interrupts_agent() {
        take_over();
    }
    COMMANDS.lock().unwrap().push_back(QueuedCommand::Ui(cmd));
    let mut task = DrainCommands::new();
    post_task(ThreadId::UI, Some(&mut task));
}

pub fn send_agent(cmd: crate::cdp::HostRequest) {
    COMMANDS
        .lock()
        .unwrap()
        .push_back(QueuedCommand::Agent(cmd));
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
                match cmd {
                    QueuedCommand::Ui(cmd) => crate::host::handle_command(cmd),
                    QueuedCommand::Agent(cmd) => crate::host::handle_agent(cmd),
                }
            }
        }
    }
}
