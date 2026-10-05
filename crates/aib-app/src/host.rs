//! CEF host: top-level window, tab management, and browser callbacks.
//!
//! All state lives on the CEF UI thread (thread_local). Never hold a `STATE` borrow while
//! calling into CEF: many CEF calls can re-enter our handlers synchronously.

use aib_ipc::{Command, DownloadInfo, DownloadState, Event, TabId, TabInfo};
use cef::*;
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Height (DIP) of the chrome strip: tab row + toolbar row.
const CHROME_HEIGHT: i32 = 84;
const APP_NAME: &str = "Rovuka";
const SEARCH_TEMPLATE: &str = "https://www.google.com/search?q={q}";
const DARK_BG: u32 = 0xFF1E1F22;
const MAX_PAGE_TEXT_CHARS: usize = 80_000;

static UI_URL: OnceLock<String> = OnceLock::new();
static START_URL: OnceLock<Option<String>> = OnceLock::new();

pub fn configure(ui_url: String, start_url: Option<String>) {
    let _ = UI_URL.set(ui_url);
    let _ = START_URL.set(start_url);
}

struct Tab {
    id: TabId,
    view: BrowserView,
    browser: Option<Browser>,
    info: TabInfo,
}

struct AgentGuard {
    tab_id: TabId,
    lease_id: String,
    allowed_url: String,
    blocked: Option<String>,
    /// Page-initiated hops since the last agent navigation (bounded).
    redirects: u8,
    /// Cross-site destination the page tried to open; paused for task authorization.
    redirect_proposal: Option<String>,
    /// Same-site redirects followed during this lease (cumulative, for the activity trail).
    followed: Vec<String>,
}

const MAX_PAGE_REDIRECTS: u8 = 8;

#[derive(Default)]
struct HostState {
    window: Option<Window>,
    content: Option<Panel>,
    content_layout: Option<BoxLayout>,
    chrome_view: Option<BrowserView>,
    chrome_browser: Option<Browser>,
    assistant_view: Option<BrowserView>,
    assistant_browser: Option<Browser>,
    assistant_open: bool,
    assistant_expanded: bool,
    tabs: Vec<Tab>,
    active: Option<TabId>,
    next_id: TabId,
    closing: bool,
    /// Browsers (tabs, chrome UI, popups) that are still alive.
    live_browsers: Vec<Browser>,
    /// Browser ids of tabs whose view `close_tab` detached and which are now closing.
    detached_tabs: Vec<i32>,
    agent_guard: Option<AgentGuard>,
}

thread_local! {
    static STATE: RefCell<HostState> = RefCell::new(HostState { next_id: 1, ..Default::default() });
}

fn with_state<R>(f: impl FnOnce(&mut HostState) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

fn client() -> Client {
    AibClient::new()
}

fn browser_id(browser: Option<&mut Browser>) -> Option<i32> {
    browser.map(|b| b.identifier())
}

fn tab_id_for_browser(id: i32) -> Option<TabId> {
    with_state(|s| {
        s.tabs
            .iter()
            .find(|t| t.browser.as_ref().is_some_and(|b| b.identifier() == id))
            .map(|t| t.id)
    })
}

fn is_chrome_browser(id: i32) -> bool {
    with_state(|s| {
        s.chrome_browser
            .as_ref()
            .is_some_and(|b| b.identifier() == id)
            || s.assistant_browser
                .as_ref()
                .is_some_and(|b| b.identifier() == id)
    })
}

fn emit_tabs() {
    let ev = with_state(|s| Event::Tabs {
        tabs: s.tabs.iter().map(|t| t.info.clone()).collect(),
        active: s.active,
    });
    crate::bus::emit(ev);
}

fn update_tab(id: TabId, f: impl FnOnce(&mut TabInfo)) {
    let changed = with_state(|s| {
        let tab = s.tabs.iter_mut().find(|t| t.id == id)?;
        let before = tab.info.clone();
        f(&mut tab.info);
        (before != tab.info).then_some(())
    });
    if changed.is_some() {
        emit_tabs();
        update_window_title();
    }
}

fn update_window_title() {
    let (window, title) = with_state(|s| {
        let title = s
            .active
            .and_then(|a| s.tabs.iter().find(|t| t.id == a))
            .map(|t| t.info.title.clone())
            .filter(|t| !t.is_empty());
        (s.window.clone(), title)
    });
    if let Some(window) = window {
        let title = match title {
            Some(t) => format!("{t} - {APP_NAME}"),
            None => APP_NAME.to_string(),
        };
        window.set_title(Some(&CefString::from(title.as_str())));
    }
}

fn active_or(tab_id: Option<TabId>) -> Option<TabId> {
    tab_id.or_else(|| with_state(|s| s.active))
}

fn tab_browser(tab_id: Option<TabId>) -> Option<Browser> {
    let id = active_or(tab_id)?;
    with_state(|s| {
        s.tabs
            .iter()
            .find(|t| t.id == id)
            .and_then(|t| t.browser.clone())
    })
}

fn tab_view(id: TabId) -> Option<BrowserView> {
    with_state(|s| s.tabs.iter().find(|t| t.id == id).map(|t| t.view.clone()))
}

pub fn handle_agent(request: crate::cdp::HostRequest) {
    use crate::cdp::HostRequest;
    if let HostRequest::Cancel { id } = request {
        crate::cdp::cancel(id);
        return;
    }
    if let HostRequest::End { tab_id, lease_id } = request {
        with_state(|s| {
            if s.agent_guard
                .as_ref()
                .is_some_and(|g| g.tab_id == tab_id && g.lease_id == lease_id)
            {
                s.agent_guard = None;
            }
        });
        return;
    }
    let (tab_id, expected) = match &request {
        HostRequest::Inspect { tab_id, .. } => (*tab_id, None),
        HostRequest::Lease { tab_id, .. } => (Some(*tab_id), None),
        HostRequest::Call {
            tab_id,
            expected_url,
            ..
        }
        | HostRequest::Ready {
            tab_id,
            expected_url,
            ..
        }
        | HostRequest::Navigate {
            tab_id,
            expected_url,
            ..
        }
        | HostRequest::Begin {
            tab_id,
            expected_url,
            ..
        } => (Some(*tab_id), Some(expected_url.as_str())),
        HostRequest::Cancel { .. } | HostRequest::End { .. } => unreachable!(),
    };
    let target = with_state(|s| {
        if s.closing {
            return None;
        }
        let id = tab_id.or(s.active)?;
        if s.active != Some(id) {
            return None;
        }
        s.tabs
            .iter()
            .find(|t| t.id == id)
            .and_then(|t| t.browser.clone().map(|b| (t.info.clone(), b)))
    });
    let result = target
        .ok_or_else(|| anyhow::anyhow!("Task stopped: its tab was closed or you switched tabs."))
        .and_then(|(info, browser)| {
            if let Some(blocked) = with_state(|s| {
                s.agent_guard
                    .as_ref()
                    .filter(|g| g.tab_id == info.id)
                    .and_then(|g| g.blocked.clone())
            }) {
                anyhow::bail!("{blocked}");
            }
            if let Some(expected) = expected {
                if info.url != expected {
                    // Same-site redirects and same-document URL updates move the guard's approved
                    // URL; report them as a typed move so the agent revalidates instead of failing.
                    let approved_move = with_state(|s| {
                        s.agent_guard
                            .as_ref()
                            .is_some_and(|g| g.tab_id == info.id && g.allowed_url == info.url)
                    });
                    if approved_move {
                        return Err(crate::cdp::PageMoved(info.url.clone()).into());
                    }
                    tracing::warn!(
                        expected = %expected,
                        actual = %info.url,
                        "Task tab URL changed outside the approved navigation"
                    );
                    anyhow::bail!(
                        "The task page URL changed outside the approved navigation (expected {}, now {}). No further action was accepted.",
                        crate::diagnostics::short_url(expected),
                        crate::diagnostics::short_url(&info.url)
                    );
                }
                if info.loading {
                    return Err(crate::cdp::PageLoading.into());
                }
            }
            if let Some(ui) = UI_URL.get()
                && url::Url::parse(&info.url).ok().is_some_and(|page| {
                    url::Url::parse(ui)
                        .ok()
                        .is_some_and(|trusted| page.origin() == trusted.origin())
                })
            {
                anyhow::bail!("The agent cannot read or navigate the trusted browser UI");
            }
            Ok((info, browser))
        });
    match request {
        HostRequest::Begin {
            tab_id,
            expected_url,
            lease_id,
            reply,
        } => {
            if reply.is_closed() {
                return;
            }
            let _ = reply.send(result.map(|_| {
                with_state(|s| {
                    s.agent_guard = Some(AgentGuard {
                        tab_id,
                        lease_id,
                        allowed_url: expected_url,
                        blocked: None,
                        redirects: 0,
                        redirect_proposal: None,
                        followed: Vec::new(),
                    })
                });
                serde_json::Value::Null
            }));
        }
        HostRequest::Inspect { reply, .. } => {
            let _ = reply
                .send(result.and_then(|(info, _)| serde_json::to_value(info).map_err(Into::into)));
        }
        HostRequest::Ready { reply, .. } => {
            let _ = reply.send(result.map(|_| serde_json::Value::Null));
        }
        HostRequest::Lease {
            tab_id,
            lease_id,
            reply,
        } => {
            let _ = reply.send(result.and_then(|_| {
                with_state(|s| {
                    let guard = s
                        .agent_guard
                        .as_ref()
                        .filter(|g| g.tab_id == tab_id && g.lease_id == lease_id)
                        .ok_or_else(|| {
                            anyhow::anyhow!("Task navigation guard is no longer active")
                        })?;
                    Ok(serde_json::json!({
                        "allowedUrl": guard.allowed_url,
                        "redirect": guard.redirect_proposal,
                        "followed": guard.followed,
                    }))
                })
            }));
        }
        HostRequest::Call {
            id,
            method,
            params,
            reply,
            ..
        } => match result {
            Ok((_, browser)) => crate::cdp::dispatch(browser, id, method, params, reply),
            Err(error) => {
                let _ = reply.send(Err(error));
            }
        },
        HostRequest::Navigate {
            tab_id,
            url,
            lease_id,
            reply,
            ..
        } => {
            if reply.is_closed() {
                return;
            }
            let result = result.and_then(|(_, browser)| {
                crate::agent::validate_navigation(&url)?;
                if let Some(ui) = UI_URL.get()
                    && url::Url::parse(&url)?.origin() == url::Url::parse(ui)?.origin()
                {
                    anyhow::bail!("Navigation to the trusted browser UI is forbidden");
                }
                let frame = browser
                    .main_frame()
                    .ok_or_else(|| anyhow::anyhow!("Task frame is unavailable"))?;
                with_state(|s| {
                    let guard = s
                        .agent_guard
                        .as_mut()
                        .filter(|g| g.tab_id == tab_id && g.lease_id == lease_id)
                        .ok_or_else(|| {
                            anyhow::anyhow!("Task navigation guard is no longer active")
                        })?;
                    guard.allowed_url = url.clone();
                    guard.redirects = 0;
                    guard.redirect_proposal = None;
                    Ok::<_, anyhow::Error>(())
                })?;
                frame.load_url(Some(&CefString::from(url.as_str())));
                Ok(serde_json::Value::Null)
            });
            let _ = reply.send(result);
        }
        HostRequest::Cancel { .. } | HostRequest::End { .. } => unreachable!(),
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

pub fn handle_command(cmd: Command) {
    debug_assert_ne!(currently_on(ThreadId::UI), 0);
    if with_state(|s| s.closing) {
        return;
    }
    if cmd.interrupts_agent() {
        with_state(|s| s.agent_guard = None);
        set_assistant_expanded(false);
    }
    match cmd {
        Command::NewTab { url } => {
            new_tab(url.as_deref(), true);
        }
        Command::CloseTab { tab_id } => close_tab(tab_id),
        Command::ActivateTab { tab_id } => activate_tab(tab_id),
        Command::Navigate { tab_id, input } => {
            let url = aib_ipc::resolve_omnibox_input(&input, SEARCH_TEMPLATE);
            match active_or(tab_id) {
                Some(id) => {
                    if let Some(frame) = tab_browser(Some(id)).and_then(|b| b.main_frame()) {
                        frame.load_url(Some(&CefString::from(url.as_str())));
                    }
                    if let Some(view) = tab_view(id) {
                        view.request_focus();
                    }
                }
                None => {
                    new_tab(Some(&url), true);
                }
            }
        }
        Command::Back { tab_id } => {
            if let Some(b) = tab_browser(tab_id) {
                b.go_back();
            }
        }
        Command::Forward { tab_id } => {
            if let Some(b) = tab_browser(tab_id) {
                b.go_forward();
            }
        }
        Command::Reload { tab_id } => {
            if let Some(b) = tab_browser(tab_id) {
                b.reload();
            }
        }
        Command::Stop { tab_id } => {
            if let Some(b) = tab_browser(tab_id) {
                b.stop_load();
            }
        }
        Command::FocusContent => {
            let view = with_state(|s| {
                if s.assistant_expanded {
                    s.assistant_view.clone()
                } else {
                    s.active.and_then(|id| {
                        s.tabs
                            .iter()
                            .find(|tab| tab.id == id)
                            .map(|tab| tab.view.clone())
                    })
                }
            });
            if let Some(view) = view {
                view.request_focus();
            }
        }
        Command::ShowDevTools { tab_id } => {
            if let Some(host) = tab_browser(tab_id).and_then(|b| b.host()) {
                let window_info = WindowInfo {
                    runtime_style: RuntimeStyle::ALLOY,
                    ..Default::default()
                };
                let mut client = DevToolsClient::new();
                host.show_dev_tools(
                    Some(&window_info),
                    Some(&mut client),
                    Some(&BrowserSettings::default()),
                    None,
                );
            }
        }
        Command::ToggleAssistant => toggle_assistant(),
        Command::SetAssistantExpanded { expanded } => set_assistant_expanded(expanded),
        Command::GetPageText { request_id } => get_page_text(request_id),
    }
}

fn set_assistant_expanded(expanded: bool) {
    let (assistant, content, layout, active, open) = with_state(|s| {
        s.assistant_expanded = expanded && s.assistant_open;
        (
            s.assistant_view.clone(),
            s.content.clone(),
            s.content_layout.clone(),
            s.active.and_then(|id| {
                s.tabs
                    .iter()
                    .find(|tab| tab.id == id)
                    .map(|tab| tab.view.clone())
            }),
            s.assistant_expanded,
        )
    });
    if let (Some(assistant), Some(content), Some(layout)) = (assistant, content, layout) {
        if let Some(active) = active {
            let mut child = View::from(&active);
            child.set_visible((!open) as i32);
            layout.set_flex_for_view(Some(&mut child), if open { 0 } else { 1 });
            if let Some(host) = active.browser().and_then(|browser| browser.host()) {
                host.was_hidden(open as i32);
            }
        }
        layout.set_flex_for_view(Some(&mut View::from(&assistant)), if open { 1 } else { 0 });
        content.layout();
        if open {
            assistant.request_focus();
        }
    }
    crate::bus::emit(Event::AssistantLayout { expanded: open });
}

fn new_tab(url: Option<&str>, activate: bool) -> Option<TabId> {
    let content = with_state(|s| s.content.clone())?;
    let id = with_state(|s| {
        let id = s.next_id;
        s.next_id += 1;
        id
    });
    let url = url
        .filter(|u| !u.is_empty())
        .unwrap_or("about:blank")
        .to_string();

    let mut client = client();
    let mut delegate = TabViewDelegate::new(id);
    let settings = BrowserSettings::default();
    let view = browser_view_create(
        Some(&mut client),
        Some(&CefString::from(url.as_str())),
        Some(&settings),
        None,
        None,
        Some(&mut delegate),
    )?;

    with_state(|s| {
        s.tabs.push(Tab {
            id,
            view: view.clone(),
            browser: None,
            info: TabInfo {
                id,
                url: if url == "about:blank" {
                    String::new()
                } else {
                    url.clone()
                },
                title: "New Tab".into(),
                loading: true,
                ..Default::default()
            },
        })
    });

    let mut v = View::from(&view);
    v.set_visible(0);
    content.add_child_view(Some(&mut v));

    if activate {
        activate_tab(id);
        if url == "about:blank" {
            focus_omnibox();
        }
    } else {
        emit_tabs();
    }
    Some(id)
}

fn activate_tab(id: TabId) {
    let (views, content, layout, assistant_open, assistant_view) = with_state(|s| {
        if !s.tabs.iter().any(|t| t.id == id) {
            return (Vec::new(), None, None, false, None);
        }
        s.active = Some(id);
        (
            s.tabs
                .iter()
                .map(|t| (t.id, t.view.clone()))
                .collect::<Vec<_>>(),
            s.content.clone(),
            s.content_layout.clone(),
            s.assistant_open,
            s.assistant_view.clone(),
        )
    });
    let Some(content) = content else { return };
    for (tid, view) in &views {
        let visible = *tid == id;
        let mut child = View::from(view);
        child.set_visible(visible as i32);
        if let Some(layout) = &layout {
            layout.set_flex_for_view(Some(&mut child), if visible { 1 } else { 0 });
        }
        if let Some(host) = view.browser().and_then(|b| b.host()) {
            host.was_hidden((!visible) as i32);
        }
    }
    if assistant_open {
        if let (Some(layout), Some(sidebar)) = (&layout, &assistant_view) {
            let mut child = View::from(sidebar);
            child.set_visible(1);
            layout.set_flex_for_view(Some(&mut child), 0);
        }
        if let Some(sidebar) = assistant_view {
            if let Some(host) = sidebar.browser().and_then(|browser| browser.host()) {
                host.was_hidden(0);
            }
        }
    }
    content.layout();
    if let Some((_, view)) = views.iter().find(|(tid, _)| *tid == id) {
        view.request_focus();
    }
    emit_tabs();
    update_window_title();
}

fn toggle_assistant() {
    let (open, active_view, assistant_view, content, layout) = with_state(|s| {
        s.assistant_open = !s.assistant_open;
        (
            s.assistant_open,
            s.active.and_then(|id| {
                s.tabs
                    .iter()
                    .find(|tab| tab.id == id)
                    .map(|tab| tab.view.clone())
            }),
            s.assistant_view.clone(),
            s.content.clone(),
            s.content_layout.clone(),
        )
    });
    let (Some(assistant), Some(content), Some(layout)) = (assistant_view, content, layout) else {
        return;
    };

    if open {
        let mut assistant_child = View::from(&assistant);
        assistant_child.set_visible(1);
        content.add_child_view(Some(&mut assistant_child));
        layout.set_flex_for_view(Some(&mut assistant_child), 0);
        if let Some(host) = assistant.browser().and_then(|browser| browser.host()) {
            host.was_hidden(0);
        }
        if let Some(active) = active_view.as_ref() {
            let mut active_child = View::from(active);
            layout.set_flex_for_view(Some(&mut active_child), 1);
        }
        content.layout();
        assistant.request_focus();
    } else {
        if let Some(host) = assistant.browser().and_then(|browser| browser.host()) {
            host.was_hidden(1);
        }
        content.remove_child_view(Some(&mut View::from(&assistant)));
        if let Some(active) = active_view.as_ref() {
            let mut active_child = View::from(active);
            layout.set_flex_for_view(Some(&mut active_child), 1);
            active.request_focus();
        }
        content.layout();
    }
}

fn get_page_text(request_id: String) {
    let current = with_state(|s| {
        let tab = s.tabs.iter().find(|tab| Some(tab.id) == s.active)?;
        Some((tab.id, tab.info.clone(), tab.browser.clone()))
    });
    let Some((tab_id, info, Some(browser))) = current else {
        crate::bus::emit(Event::PageText {
            request_id,
            tab_id: None,
            url: String::new(),
            title: String::new(),
            text: String::new(),
            truncated: false,
            error: Some("There is no active webpage to read.".into()),
        });
        return;
    };
    let Some(frame) = browser.main_frame() else {
        crate::bus::emit(Event::PageText {
            request_id,
            tab_id: Some(tab_id),
            url: info.url,
            title: info.title,
            text: String::new(),
            truncated: false,
            error: Some("The active page is not ready yet.".into()),
        });
        return;
    };
    let mut visitor = PageTextVisitor::new(request_id, tab_id, info.url, info.title);
    frame.text(Some(&mut visitor));
}

fn close_tab(id: TabId) {
    let removed = with_state(|s| {
        let idx = s.tabs.iter().position(|t| t.id == id)?;
        let tab = s.tabs.remove(idx);
        let next = if s.active == Some(id) {
            s.active = None;
            s.tabs
                .get(idx)
                .or_else(|| s.tabs.get(idx.wrapping_sub(1)))
                .map(|t| t.id)
        } else {
            s.active
        };
        Some((tab, next, s.content.clone()))
    });
    let Some((tab, next, content)) = removed else {
        return;
    };

    if let Some(content) = content {
        content.remove_child_view(Some(&mut View::from(&tab.view)));
    }
    if let Some(browser) = tab.browser.as_ref() {
        with_state(|s| s.detached_tabs.push(browser.identifier()));
    }
    if let Some(host) = tab.browser.as_ref().and_then(|b| b.host()) {
        host.close_browser(1);
    }
    drop(tab);

    match next {
        Some(next) => activate_tab(next),
        None => {
            new_tab(None, true);
        }
    }
}

fn focus_omnibox() {
    if let Some(chrome) = with_state(|s| s.chrome_view.clone()) {
        chrome.request_focus();
    }
    crate::bus::emit(Event::FocusOmnibox);
}

/// Global shortcuts. Returns true if handled.
fn handle_shortcut(event: &KeyEvent) -> bool {
    const CTRL: u32 = 1 << 2;
    const SHIFT: u32 = 1 << 1;
    const ALT: u32 = 1 << 3;
    if event.type_ != KeyEventType::RAWKEYDOWN {
        return false;
    }
    let m = event.modifiers;
    let ctrl = m & CTRL != 0;
    let shift = m & SHIFT != 0;
    let alt = m & ALT != 0;
    let key = event.windows_key_code;
    let active = with_state(|s| s.active);

    let cmd = match (ctrl, shift, alt, key) {
        (true, false, false, 0x54) => Some(Command::NewTab { url: None }), // Ctrl+T
        (true, false, false, 0x57) => active.map(|tab_id| Command::CloseTab { tab_id }), // Ctrl+W
        (true, false, false, 0x4C) | (false, false, true, 0x44) => {
            // Ctrl+L / Alt+D
            focus_omnibox();
            return true;
        }
        (true, _, false, 0x09) => {
            // Ctrl+Tab / Ctrl+Shift+Tab
            let next = with_state(|s| {
                let n = s.tabs.len();
                let i = s.tabs.iter().position(|t| Some(t.id) == s.active)?;
                let j = if shift { (i + n - 1) % n } else { (i + 1) % n };
                Some(s.tabs[j].id)
            });
            next.map(|tab_id| Command::ActivateTab { tab_id })
        }
        (false, false, false, 0x74) | (true, false, false, 0x52) => {
            Some(Command::Reload { tab_id: None })
        } // F5 / Ctrl+R
        (false, false, true, 0x25) => Some(Command::Back { tab_id: None }), // Alt+Left
        (false, false, true, 0x27) => Some(Command::Forward { tab_id: None }), // Alt+Right
        (false, false, false, 0x7B) | (true, true, false, 0x49) => {
            Some(Command::ShowDevTools { tab_id: None })
        } // F12 / Ctrl+Shift+I
        _ => None,
    };
    match cmd {
        Some(cmd) => {
            // Defer: we're inside a CEF input callback.
            crate::bus::send_command(cmd);
            true
        }
        None => false,
    }
}

fn unique_download_path(name: &str) -> PathBuf {
    let dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
    let name = if name.trim().is_empty() {
        "download"
    } else {
        name
    };
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let p = PathBuf::from(name);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download")
        .to_string();
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    (1..)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|c| !c.exists())
        .unwrap()
}

// ---------------------------------------------------------------------------------------------
// App / process handler
// ---------------------------------------------------------------------------------------------

wrap_app! {
    pub struct AibApp;

    impl App {
        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            if process_type.is_some_and(|value| !value.to_string().is_empty()) {
                return;
            }
            let Some(command_line) = command_line else { return };
            let value = CefString::from(
                &command_line.switch_value(Some(&CefString::from("graphics")))
            ).to_string();
            if crate::graphics::resolve(&value).ok() == Some(crate::graphics::GraphicsMode::Software) {
                command_line.append_switch(Some(&CefString::from("disable-gpu")));
                command_line.append_switch(Some(&CefString::from("disable-gpu-compositing")));
            }
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(AibBrowserProcessHandler::new())
        }
    }
}

wrap_browser_process_handler! {
    struct AibBrowserProcessHandler;

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            let mut delegate = MainWindowDelegate::new();
            window_create_top_level(Some(&mut delegate));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Window and views
// ---------------------------------------------------------------------------------------------

wrap_window_delegate! {
    struct MainWindowDelegate {}

    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 1280, height: 860 }
        }

        fn minimum_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 480, height: 320 }
        }
    }

    impl PanelDelegate {}

    impl WindowDelegate {
        fn window_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }

        fn can_resize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_maximize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_minimize(&self, _window: Option<&mut Window>) -> i32 { 1 }

        fn on_window_created(&self, window: Option<&mut Window>) {
            let Some(window) = window else { return };
            window.set_title(Some(&CefString::from(APP_NAME)));

            let layout_settings = BoxLayoutSettings {
                horizontal: 0,
                cross_axis_alignment: AxisAlignment::STRETCH,
                ..Default::default()
            };
            let Some(layout) = window.set_to_box_layout(Some(&layout_settings)) else { return };

            // Trusted chrome UI (tab strip + omnibox).
            let ui_url = UI_URL.get().cloned().unwrap_or_default();
            let mut chrome_client = client();
            let mut chrome_delegate = ChromeViewDelegate::new();
            let settings = BrowserSettings { background_color: DARK_BG, ..Default::default() };
            let Some(chrome_view) = browser_view_create(
                Some(&mut chrome_client),
                Some(&CefString::from(ui_url.as_str())),
                Some(&settings),
                None,
                None,
                Some(&mut chrome_delegate),
            ) else {
                return;
            };
            let mut chrome_v = View::from(&chrome_view);
            window.add_child_view(Some(&mut chrome_v));
            layout.set_flex_for_view(Some(&mut chrome_v), 0);

            // Content area: one BrowserView per tab, only the active one visible.
            let Some(content) = panel_create(None) else { return };
            let content_layout = content.set_to_box_layout(Some(&BoxLayoutSettings {
                horizontal: 1,
                cross_axis_alignment: AxisAlignment::STRETCH,
                default_flex: 0,
                ..Default::default()
            }));
            let Some(content_layout) = content_layout else { return };
            let mut content_v = View::from(&content);
            content_v.set_background_color(0xFFFFFFFF);
            window.add_child_view(Some(&mut content_v));
            layout.set_flex_for_view(Some(&mut content_v), 1);

            let assistant_url = format!("{ui_url}&surface=assistant");
            let mut assistant_client = client();
            let mut assistant_delegate = AssistantViewDelegate::new();
            let assistant_settings = BrowserSettings { background_color: DARK_BG, ..Default::default() };
            let Some(assistant_view) = browser_view_create(
                Some(&mut assistant_client),
                Some(&CefString::from(assistant_url.as_str())),
                Some(&assistant_settings),
                None,
                None,
                Some(&mut assistant_delegate),
            ) else {
                return;
            };
            with_state(|s| {
                s.window = Some(window.clone());
                s.content = Some(content.clone());
                s.content_layout = Some(content_layout);
                s.chrome_view = Some(chrome_view.clone());
                s.assistant_view = Some(assistant_view);
            });

            let start = START_URL.get().cloned().flatten();
            new_tab(start.as_deref(), true);

            window.show();
        }

        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            let browsers = with_state(|s| {
                s.closing = true;
                s.live_browsers.clone()
            });
            let mut all_closed = true;
            for b in browsers {
                if let Some(host) = b.host() {
                    if host.try_close_browser() == 0 {
                        all_closed = false;
                    }
                }
            }
            all_closed as i32
        }

        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            with_state(|s| {
                s.tabs.clear();
                s.window = None;
                s.content = None;
                s.content_layout = None;
                s.chrome_view = None;
                s.chrome_browser = None;
                s.assistant_view = None;
                s.assistant_browser = None;
            });
            quit_message_loop();
        }
    }
}

wrap_browser_view_delegate! {
    struct ChromeViewDelegate {}

    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 800, height: CHROME_HEIGHT }
        }

        fn minimum_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 200, height: CHROME_HEIGHT }
        }
    }

    impl BrowserViewDelegate {
        fn browser_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }

        fn on_browser_created(&self, _browser_view: Option<&mut BrowserView>, browser: Option<&mut Browser>) {
            let browser = browser.cloned();
            with_state(|s| s.chrome_browser = browser);
        }
    }
}

wrap_browser_view_delegate! {
    struct AssistantViewDelegate {}

    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            // A zero-height Size is empty to CEF; the layout stretches this height.
            Size { width: 360, height: 1 }
        }

        fn minimum_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 280, height: 1 }
        }
    }

    impl BrowserViewDelegate {
        fn browser_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }

        fn on_browser_created(&self, _browser_view: Option<&mut BrowserView>, browser: Option<&mut Browser>) {
            let browser = browser.cloned();
            with_state(|s| s.assistant_browser = browser);
        }
    }
}

wrap_browser_view_delegate! {
    struct TabViewDelegate {
        tab_id: TabId,
    }

    impl ViewDelegate {}

    impl BrowserViewDelegate {
        fn browser_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }

        fn on_browser_created(&self, _browser_view: Option<&mut BrowserView>, browser: Option<&mut Browser>) {
            let browser = browser.cloned();
            let id = self.tab_id;
            with_state(|s| {
                if let Some(tab) = s.tabs.iter_mut().find(|t| t.id == id) {
                    tab.browser = browser;
                }
            });
        }

        fn on_popup_browser_view_created(
            &self,
            _browser_view: Option<&mut BrowserView>,
            popup_browser_view: Option<&mut BrowserView>,
            is_devtools: i32,
        ) -> i32 {
            // Let CEF host DevTools in its default window; our popup window delegate crashes it.
            if is_devtools != 0 {
                return 0;
            }
            let Some(popup) = popup_browser_view.cloned() else { return 0 };
            let mut delegate = PopupWindowDelegate::new(RefCell::new(Some(popup)));
            window_create_top_level(Some(&mut delegate));
            1
        }
    }
}

// Real popup windows (OAuth sign-in, window.open with features, DevTools).
wrap_window_delegate! {
    struct PopupWindowDelegate {
        view: RefCell<Option<BrowserView>>,
    }

    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 900, height: 700 }
        }
    }

    impl PanelDelegate {}

    impl WindowDelegate {
        fn window_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }

        fn can_resize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_maximize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_minimize(&self, _window: Option<&mut Window>) -> i32 { 1 }

        fn on_window_created(&self, window: Option<&mut Window>) {
            let Some(window) = window else { return };
            if let Some(view) = self.view.borrow().as_ref() {
                window.add_child_view(Some(&mut View::from(view)));
            }
            window.show();
        }

        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            *self.view.borrow_mut() = None;
        }

        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            let browser = self.view.borrow().as_ref().and_then(|v| v.browser());
            match browser.and_then(|b| b.host()) {
                Some(host) => host.try_close_browser(),
                None => 1,
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Client + handlers (shared by chrome UI, tabs, and popups)
// ---------------------------------------------------------------------------------------------

wrap_client! {
    struct DevToolsClient;

    impl Client {}
}

wrap_client! {
    struct AibClient;

    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(AibDisplayHandler::new())
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(AibLifeSpanHandler::new())
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(AibLoadHandler::new())
        }

        fn request_handler(&self) -> Option<RequestHandler> {
            Some(AibRequestHandler::new())
        }

        fn download_handler(&self) -> Option<DownloadHandler> {
            Some(AibDownloadHandler::new())
        }

        fn keyboard_handler(&self) -> Option<KeyboardHandler> {
            Some(AibKeyboardHandler::new())
        }
    }
}

fn guarded_tab(browser: Option<&Browser>) -> bool {
    let tab = browser
        .map(|browser| browser.identifier())
        .and_then(tab_id_for_browser);
    with_state(|s| {
        s.agent_guard
            .as_ref()
            .is_some_and(|guard| Some(guard.tab_id) == tab)
    })
}

wrap_request_handler! {
    struct AibRequestHandler;

    impl RequestHandler {
        fn on_before_browse(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>,
            request: Option<&mut Request>, user_gesture: i32, is_redirect: i32) -> i32 {
            if frame.is_none_or(|frame| frame.is_main() == 0) { return 0; }
            let tab = browser_id(browser).and_then(tab_id_for_browser);
            let url = request.as_ref().map(|request| CefString::from(&request.url()).to_string()).unwrap_or_default();
            let method = request.as_ref().map(|request| CefString::from(&request.method()).to_string()).unwrap_or_default();
            with_state(|s| {
                let committed = s.tabs.iter().find(|t| Some(t.id) == tab).map(|t| t.info.url.clone());
                let Some(guard) = s.agent_guard.as_mut().filter(|guard| Some(guard.tab_id) == tab) else { return 0 };
                if url == guard.allowed_url && method == "GET" { return 0; }
                let destination = url::Url::parse(&url).map(|url| {
                    format!("{}{}", url.origin().ascii_serialization(), url.path())
                }).unwrap_or_else(|_| "an invalid destination".into());
                let kind = if method != "GET" { "non-GET request" } else if is_redirect != 0 { "redirect" } else { "page navigation" };
                // Server redirects and script/meta navigations without user activation are the
                // site's decision, like a normal browser following a link; apply the redirect policy.
                if method == "GET" && (is_redirect != 0 || user_gesture == 0) {
                    use crate::policy::Redirect;
                    // While an approved navigation is still pending, a script navigation comes from
                    // the previous page: cancel it so it cannot replace the approved destination.
                    if is_redirect == 0 && committed.as_deref() != Some(guard.allowed_url.as_str()) {
                        tracing::info!(target_url = %url, approved = %guard.allowed_url, "Guard: cancelled a script navigation while an approved navigation was pending");
                        return 1;
                    }
                    let trusted_ui = UI_URL.get().and_then(|ui| url::Url::parse(ui).ok())
                        .zip(url::Url::parse(&url).ok())
                        .is_some_and(|(ui, target)| ui.origin() == target.origin());
                    let decision = if trusted_ui {
                        Redirect::Forbidden("its destination is the trusted browser UI")
                    } else if guard.redirects >= MAX_PAGE_REDIRECTS {
                        Redirect::Forbidden("the site redirected too many times")
                    } else {
                        crate::policy::classify_redirect(&guard.allowed_url, &url)
                    };
                    match decision {
                        Redirect::SameSite => {
                            tracing::info!(from = %guard.allowed_url, to = %url, kind, "Guard: followed same-site redirect");
                            guard.redirects += 1;
                            guard.allowed_url = url.clone();
                            guard.followed.push(url);
                            return 0;
                        }
                        Redirect::CrossSite => {
                            if guard.redirect_proposal.is_none() {
                                tracing::info!(from = %guard.allowed_url, to = %url, kind, "Guard: paused cross-site redirect for task authorization");
                                guard.redirects += 1;
                                guard.redirect_proposal = Some(url);
                            }
                            return 1;
                        }
                        Redirect::Forbidden(reason) => {
                            tracing::warn!(from = %guard.allowed_url, to = %url, kind, reason, "Guard: blocked forbidden redirect");
                            guard.blocked = Some(format!(
                                "A {kind} was blocked because {reason} ({destination}). Query/fragment details are omitted. Open the site manually or retry the task; no further agent action was accepted."
                            ));
                            return 1;
                        }
                    }
                }
                tracing::warn!(approved = %guard.allowed_url, to = %url, kind, method = %method, user_gesture, "Guard: blocked unapproved navigation");
                guard.blocked = Some(format!(
                    "An unapproved {kind} was blocked ({destination}). Query/fragment details are omitted. Open the site manually or retry the task; no further agent action was accepted."
                ));
                1
            })
        }
    }
}

wrap_display_handler! {
    struct AibDisplayHandler;

    impl DisplayHandler {
        fn on_address_change(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, url: Option<&CefString>) {
            if frame.is_some_and(|f| f.is_main() == 0) {
                return;
            }
            let Some(tab) = browser_id(browser).and_then(tab_id_for_browser) else { return };
            let url = url.map(|u| u.to_string()).unwrap_or_default();
            let url = if url == "about:blank" { String::new() } else { url };
            // A committed page changing its own URL (pushState/replaceState/fragment) stays on the
            // same origin and loads no new document; keep the task lease on that page.
            with_state(|s| {
                let previous = s.tabs.iter().find(|t| t.id == tab).map(|t| t.info.url.clone());
                let Some(guard) = s.agent_guard.as_mut().filter(|g| g.tab_id == tab) else { return };
                if url == guard.allowed_url || previous.as_deref() == Some(url.as_str()) { return; }
                let same_origin = url::Url::parse(&guard.allowed_url).ok().zip(url::Url::parse(&url).ok())
                    .is_some_and(|(from, to)| from.origin() == to.origin());
                if previous.as_deref() == Some(guard.allowed_url.as_str()) && same_origin {
                    tracing::info!(from = %guard.allowed_url, to = %url, "Guard: adopted same-document URL update");
                    guard.allowed_url = url.clone();
                } else {
                    tracing::warn!(approved = %guard.allowed_url, previous = ?previous, now = %url, "Guard: task tab address changed without approval");
                }
            });
            update_tab(tab, |t| t.url = url);
        }

        fn on_title_change(&self, browser: Option<&mut Browser>, title: Option<&CefString>) {
            let Some(tab) = browser_id(browser).and_then(tab_id_for_browser) else { return };
            let title = title.map(|t| t.to_string()).unwrap_or_default();
            update_tab(tab, |t| {
                t.title = if title.is_empty() || title == "about:blank" { "New Tab".into() } else { title };
            });
        }

        fn on_favicon_urlchange(&self, browser: Option<&mut Browser>, icon_urls: Option<&mut CefStringList>) {
            let Some(tab) = browser_id(browser).and_then(tab_id_for_browser) else { return };
            let icon = icon_urls.and_then(|l| l.clone().into_iter().next());
            update_tab(tab, |t| t.favicon = icon);
        }

        fn on_loading_progress_change(&self, browser: Option<&mut Browser>, progress: f64) {
            let Some(tab) = browser_id(browser).and_then(tab_id_for_browser) else { return };
            update_tab(tab, |t| t.progress = progress);
        }
    }
}

wrap_load_handler! {
    struct AibLoadHandler;

    impl LoadHandler {
        fn on_loading_state_change(
            &self,
            browser: Option<&mut Browser>,
            is_loading: i32,
            can_go_back: i32,
            can_go_forward: i32,
        ) {
            let Some(tab) = browser_id(browser).and_then(tab_id_for_browser) else { return };
            update_tab(tab, |t| {
                t.loading = is_loading != 0;
                t.can_go_back = can_go_back != 0;
                t.can_go_forward = can_go_forward != 0;
                if is_loading == 0 {
                    t.progress = 1.0;
                }
            });
        }
    }
}

wrap_life_span_handler! {
    struct AibLifeSpanHandler;

    impl LifeSpanHandler {
        fn on_before_popup(
            &self,
            browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: i32,
            target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>,
            _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            if guarded_tab(browser.as_deref()) { return 1; }
            // The chrome UI never opens popups.
            if browser_id(browser).is_some_and(is_chrome_browser) {
                return 1;
            }
            // Real popups (e.g. OAuth) keep their opener; everything else becomes a tab.
            if target_disposition == WindowOpenDisposition::NEW_POPUP {
                return 0;
            }
            let url = target_url.map(|u| u.to_string()).unwrap_or_default();
            crate::bus::send_command(Command::NewTab { url: Some(url) });
            1
        }

        fn on_after_created(&self, browser: Option<&mut Browser>) {
            if let Some(b) = browser.cloned() {
                with_state(|s| s.live_browsers.push(b));
            }
        }

        fn do_close(&self, browser: Option<&mut Browser>) -> i32 {
            // A closed tab's view is already detached from the window: returning 1 stops CEF from
            // closing the main window; the browser is destroyed once the detached view is released.
            // Everything else (popups, DevTools, main window) returns 0 so its window closes.
            let Some(id) = browser_id(browser) else { return 0 };
            with_state(|s| s.detached_tabs.contains(&id)) as i32
        }

        fn on_before_close(&self, browser: Option<&mut Browser>) {
            if guarded_tab(browser.as_deref()) { crate::bus::take_over(); }
            let Some(id) = browser_id(browser) else { return };
            crate::cdp::close(id);
            let reopen = with_state(|s| {
                s.live_browsers.retain(|b| b.identifier() != id);
                s.detached_tabs.retain(|&d| d != id);
                s.closing && s.live_browsers.is_empty()
            });
            // All browsers are gone after a window close request: finish closing the window.
            if reopen {
                if let Some(window) = with_state(|s| s.window.clone()) {
                    window.close();
                }
            }
        }
    }
}

wrap_keyboard_handler! {
    struct AibKeyboardHandler;

    impl KeyboardHandler {
        fn on_pre_key_event(
            &self,
            _browser: Option<&mut Browser>,
            event: Option<&KeyEvent>,
            _os_event: Option<&mut sys::MSG>,
            _is_keyboard_shortcut: Option<&mut i32>,
        ) -> i32 {
            event.is_some_and(handle_shortcut) as i32
        }
    }
}

wrap_download_handler! {
    struct AibDownloadHandler;

    impl DownloadHandler {
        // cef-rs defaults this to 0 (deny), unlike CEF's own default of allow.
        fn can_download(
            &self,
            _browser: Option<&mut Browser>,
            _url: Option<&CefString>,
            _request_method: Option<&CefString>,
        ) -> i32 {
            1
        }

        fn on_before_download(
            &self,
            browser: Option<&mut Browser>,
            _download_item: Option<&mut DownloadItem>,
            suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> i32 {
            if guarded_tab(browser.as_deref()) {
                with_state(|s| {
                    if let Some(guard) = s.agent_guard.as_mut() {
                        guard.blocked = Some("A download was blocked. Reader tasks cannot download files.".into());
                    }
                });
                tracing::warn!("Blocked a download from the task tab");
                return 0;
            }
            let name = suggested_name.map(|n| n.to_string()).unwrap_or_default();
            let path = unique_download_path(&name);
            if let Some(cb) = callback {
                cb.cont(Some(&CefString::from(path.to_string_lossy().as_ref())), 0);
            }
            1
        }

        fn on_download_updated(
            &self,
            _browser: Option<&mut Browser>,
            download_item: Option<&mut DownloadItem>,
            _callback: Option<&mut DownloadItemCallback>,
        ) {
            let Some(item) = download_item else { return };
            let state = if item.is_complete() != 0 {
                DownloadState::Complete
            } else if item.is_canceled() != 0 {
                DownloadState::Canceled
            } else if item.is_interrupted() != 0 {
                DownloadState::Interrupted
            } else {
                DownloadState::InProgress
            };
            let full_path = CefString::from(&item.full_path()).to_string();
            let file_name = std::path::Path::new(&full_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| CefString::from(&item.suggested_file_name()).to_string());
            crate::bus::emit(Event::Download {
                download: DownloadInfo {
                    id: item.id(),
                    url: CefString::from(&item.url()).to_string(),
                    file_name,
                    full_path,
                    received_bytes: item.received_bytes(),
                    total_bytes: item.total_bytes(),
                    percent: item.percent_complete(),
                    state,
                },
            });
        }
    }

}

wrap_string_visitor! {
    struct PageTextVisitor {
        request_id: String,
        tab_id: TabId,
        url: String,
        title: String,
    }

    impl CefStringVisitor {
        fn visit(&self, string: Option<&CefString>) {
            let source = string.map(ToString::to_string).unwrap_or_default();
            let mut chars = source.chars();
            let text: String = chars.by_ref().take(MAX_PAGE_TEXT_CHARS).collect();
            let truncated = chars.next().is_some();
            crate::bus::emit(Event::PageText {
                request_id: self.request_id.clone(),
                tab_id: Some(self.tab_id),
                url: self.url.clone(),
                title: self.title.clone(),
                text,
                truncated,
                error: None,
            });
        }
    }
}
