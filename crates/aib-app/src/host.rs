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
const APP_NAME: &str = "AI Browser";
const SEARCH_TEMPLATE: &str = "https://www.google.com/search?q={q}";
const DARK_BG: u32 = 0xFF1E1F22;

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

#[derive(Default)]
struct HostState {
    window: Option<Window>,
    content: Option<Panel>,
    chrome_view: Option<BrowserView>,
    chrome_browser: Option<Browser>,
    tabs: Vec<Tab>,
    active: Option<TabId>,
    next_id: TabId,
    closing: bool,
    /// Browsers (tabs, chrome UI, popups) that are still alive.
    live_browsers: Vec<Browser>,
    /// Browser ids of tabs whose view `close_tab` detached and which are now closing.
    detached_tabs: Vec<i32>,
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
    with_state(|s| s.chrome_browser.as_ref().is_some_and(|b| b.identifier() == id))
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
    with_state(|s| s.tabs.iter().find(|t| t.id == id).and_then(|t| t.browser.clone()))
}

fn tab_view(id: TabId) -> Option<BrowserView> {
    with_state(|s| s.tabs.iter().find(|t| t.id == id).map(|t| t.view.clone()))
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

pub fn handle_command(cmd: Command) {
    debug_assert_ne!(currently_on(ThreadId::UI), 0);
    if with_state(|s| s.closing) {
        return;
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
            if let Some(view) = with_state(|s| s.active).and_then(tab_view) {
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
    }
}

fn new_tab(url: Option<&str>, activate: bool) -> Option<TabId> {
    let content = with_state(|s| s.content.clone())?;
    let id = with_state(|s| {
        let id = s.next_id;
        s.next_id += 1;
        id
    });
    let url = url.filter(|u| !u.is_empty()).unwrap_or("about:blank").to_string();

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
                url: if url == "about:blank" { String::new() } else { url.clone() },
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
    let (views, content) = with_state(|s| {
        if !s.tabs.iter().any(|t| t.id == id) {
            return (Vec::new(), None);
        }
        s.active = Some(id);
        (
            s.tabs.iter().map(|t| (t.id, t.view.clone())).collect::<Vec<_>>(),
            s.content.clone(),
        )
    });
    let Some(content) = content else { return };
    for (tid, view) in &views {
        let visible = *tid == id;
        View::from(view).set_visible(visible as i32);
        if let Some(host) = view.browser().and_then(|b| b.host()) {
            host.was_hidden((!visible) as i32);
        }
    }
    content.layout();
    if let Some((_, view)) = views.iter().find(|(tid, _)| *tid == id) {
        view.request_focus();
    }
    emit_tabs();
    update_window_title();
}

fn close_tab(id: TabId) {
    let removed = with_state(|s| {
        let idx = s.tabs.iter().position(|t| t.id == id)?;
        let tab = s.tabs.remove(idx);
        let next = if s.active == Some(id) {
            s.active = None;
            s.tabs.get(idx).or_else(|| s.tabs.get(idx.wrapping_sub(1))).map(|t| t.id)
        } else {
            s.active
        };
        Some((tab, next, s.content.clone()))
    });
    let Some((tab, next, content)) = removed else { return };

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
        (false, false, false, 0x74) | (true, false, false, 0x52) => Some(Command::Reload { tab_id: None }), // F5 / Ctrl+R
        (false, false, true, 0x25) => Some(Command::Back { tab_id: None }),    // Alt+Left
        (false, false, true, 0x27) => Some(Command::Forward { tab_id: None }), // Alt+Right
        (false, false, false, 0x7B) | (true, true, false, 0x49) => Some(Command::ShowDevTools { tab_id: None }), // F12 / Ctrl+Shift+I
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
    let name = if name.trim().is_empty() { "download" } else { name };
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let p = PathBuf::from(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("download").to_string();
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
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
            let mut client = client();
            let mut chrome_delegate = ChromeViewDelegate::new();
            let settings = BrowserSettings { background_color: DARK_BG, ..Default::default() };
            let Some(chrome_view) = browser_view_create(
                Some(&mut client),
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
            content.set_to_fill_layout();
            let mut content_v = View::from(&content);
            content_v.set_background_color(0xFFFFFFFF);
            window.add_child_view(Some(&mut content_v));
            layout.set_flex_for_view(Some(&mut content_v), 1);

            with_state(|s| {
                s.window = Some(window.clone());
                s.content = Some(content.clone());
                s.chrome_view = Some(chrome_view.clone());
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
                s.chrome_view = None;
                s.chrome_browser = None;
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

        fn download_handler(&self) -> Option<DownloadHandler> {
            Some(AibDownloadHandler::new())
        }

        fn keyboard_handler(&self) -> Option<KeyboardHandler> {
            Some(AibKeyboardHandler::new())
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
            let Some(id) = browser_id(browser) else { return };
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
            _browser: Option<&mut Browser>,
            _download_item: Option<&mut DownloadItem>,
            suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> i32 {
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
