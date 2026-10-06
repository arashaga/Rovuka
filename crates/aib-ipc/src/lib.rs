//! Wire protocol between the browser host (Rust) and the trusted chrome UI (React).
//!
//! Messages are JSON over a token-authenticated WebSocket on 127.0.0.1.
//! Keep `ui/src/ipc.ts` in sync with this file.

use serde::{Deserialize, Serialize};

pub type TabId = u32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantPanel {
    Chat,
    Task,
    Local,
    Safety,
    Settings,
    Memory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskDraftStart {
    WebSearch,
    SelectedTabs,
}

/// UI -> host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    NewTab {
        #[serde(default)]
        url: Option<String>,
    },
    CloseTab {
        tab_id: TabId,
    },
    ActivateTab {
        tab_id: TabId,
        #[serde(default, skip_serializing_if = "is_false")]
        keep_chrome_focus: bool,
    },
    /// Omnibox input: either a URL or a search query.
    Navigate {
        #[serde(default)]
        tab_id: Option<TabId>,
        input: String,
    },
    Back {
        #[serde(default)]
        tab_id: Option<TabId>,
    },
    Forward {
        #[serde(default)]
        tab_id: Option<TabId>,
    },
    Reload {
        #[serde(default)]
        tab_id: Option<TabId>,
    },
    Stop {
        #[serde(default)]
        tab_id: Option<TabId>,
    },
    /// Move keyboard focus from the chrome UI into the active page.
    FocusContent,
    FocusOmnibox,
    ShowDevTools {
        #[serde(default)]
        tab_id: Option<TabId>,
    },
    ToggleAssistant,
    OpenAssistant {
        panel: AssistantPanel,
        #[serde(default)]
        goal: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        prepare: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_start_mode: Option<TaskDraftStart>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        compare_options: Option<bool>,
    },
    SetAssistantExpanded {
        expanded: bool,
    },
    GetPageText {
        request_id: String,
    },
}

impl Command {
    /// Navigation and workspace changes return control to the user.
    pub fn interrupts_agent(&self) -> bool {
        matches!(
            self,
            Self::Navigate { .. }
                | Self::Back { .. }
                | Self::Forward { .. }
                | Self::Reload { .. }
                | Self::Stop { .. }
                | Self::NewTab { .. }
                | Self::CloseTab { .. }
                | Self::ActivateTab { .. }
                | Self::ToggleAssistant
                | Self::OpenAssistant { .. }
        )
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub id: TabId,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub loading: bool,
    pub progress: f64,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_error: Option<PageLoadError>,
}

impl TabInfo {
    pub fn needs_trusted_page(&self) -> bool {
        self.load_error.is_some() || (self.url.is_empty() && self.pending_url.is_none())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageLoadError {
    pub url: String,
    pub code: i32,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadState {
    InProgress,
    Complete,
    Canceled,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInfo {
    pub id: u32,
    pub url: String,
    pub file_name: String,
    pub full_path: String,
    pub received_bytes: i64,
    pub total_bytes: i64,
    pub percent: i32,
    pub state: DownloadState,
}

/// Host -> UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    /// Full tab-strip snapshot. Sent on connect and after every tab change.
    Tabs {
        tabs: Vec<TabInfo>,
        active: Option<TabId>,
    },
    Download {
        download: DownloadInfo,
    },
    FocusOmnibox,
    AssistantLayout {
        expanded: bool,
    },
    AssistantWorkspace {
        request_id: String,
        panel: AssistantPanel,
        goal: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        prepare: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_start_mode: Option<TaskDraftStart>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        compare_options: Option<bool>,
    },
    PageText {
        request_id: String,
        tab_id: Option<TabId>,
        url: String,
        title: String,
        text: String,
        truncated: bool,
        error: Option<String>,
    },
}

fn is_false(value: &bool) -> bool {
    !value
}

/// Turn omnibox input into a URL: keep explicit URLs, add a scheme to
/// host-like input, otherwise run a search.
pub fn resolve_omnibox_input(input: &str, search_template: &str) -> String {
    let input = input.trim();
    if input.is_empty() {
        return "about:blank".into();
    }

    let lower = input.to_ascii_lowercase();
    let has_scheme = [
        "http://",
        "https://",
        "file://",
        "about:",
        "data:",
        "chrome://",
        "view-source:",
    ]
    .iter()
    .any(|s| lower.starts_with(s));
    if has_scheme {
        return input.to_string();
    }
    if !input.contains(char::is_whitespace) {
        let host = lower.split(['/', '?', '#']).next().unwrap_or_default();
        let host_no_port = host.split(':').next().unwrap_or_default();
        let is_local =
            host_no_port == "localhost" || host_no_port.parse::<std::net::Ipv4Addr>().is_ok();
        if is_local {
            return format!("http://{input}");
        }
        let looks_like_domain = host_no_port.contains('.')
            && !host_no_port.starts_with('.')
            && !host_no_port.ends_with('.')
            && host_no_port
                .rsplit('.')
                .next()
                .is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()));
        if looks_like_domain {
            return format!("https://{input}");
        }
    }
    search_template.replace("{q}", &percent_encode(input))
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "https://search.example/?q={q}";

    #[test]
    fn omnibox() {
        assert_eq!(
            resolve_omnibox_input("https://a.com/x", T),
            "https://a.com/x"
        );
        assert_eq!(
            resolve_omnibox_input("example.com", T),
            "https://example.com"
        );
        assert_eq!(
            resolve_omnibox_input("example.com/path?q=1", T),
            "https://example.com/path?q=1"
        );
        assert_eq!(
            resolve_omnibox_input("localhost:3000", T),
            "http://localhost:3000"
        );
        assert_eq!(
            resolve_omnibox_input("127.0.0.1:8080/a", T),
            "http://127.0.0.1:8080/a"
        );
        assert_eq!(
            resolve_omnibox_input("rust traits", T),
            "https://search.example/?q=rust+traits"
        );
        assert_eq!(
            resolve_omnibox_input("v1.2", T),
            "https://search.example/?q=v1.2"
        );
        assert_eq!(
            resolve_omnibox_input("c++", T),
            "https://search.example/?q=c%2B%2B"
        );
    }

    #[test]
    fn command_wire_format() {
        let c: Command = serde_json::from_str(r#"{"type":"closeTab","tabId":3}"#).unwrap();
        assert!(matches!(c, Command::CloseTab { tab_id: 3 }));
        let c: Command = serde_json::from_str(r#"{"type":"navigate","input":"x"}"#).unwrap();
        assert!(matches!(c, Command::Navigate { tab_id: None, .. }));
        let e = serde_json::to_string(&Event::FocusOmnibox).unwrap();
        assert_eq!(e, r#"{"type":"focusOmnibox"}"#);
    }

    #[test]
    fn keyboard_tab_activation_keeps_focus_and_interrupts_tasks() {
        let pointer: Command = serde_json::from_str(r#"{"type":"activateTab","tabId":2}"#).unwrap();
        assert!(matches!(
            pointer,
            Command::ActivateTab {
                keep_chrome_focus: false,
                ..
            }
        ));
        assert_eq!(
            serde_json::to_string(&pointer).unwrap(),
            r#"{"type":"activateTab","tabId":2}"#
        );
        let keyboard: Command =
            serde_json::from_str(r#"{"type":"activateTab","tabId":3,"keepChromeFocus":true}"#)
                .unwrap();
        assert!(matches!(
            keyboard,
            Command::ActivateTab {
                keep_chrome_focus: true,
                ..
            }
        ));
        assert!(keyboard.interrupts_agent());
    }

    #[test]
    fn native_and_ui_navigation_commands_interrupt_tasks() {
        for command in [
            Command::Reload { tab_id: None },
            Command::Stop { tab_id: None },
            Command::NewTab { url: None },
            Command::CloseTab { tab_id: 1 },
            Command::ActivateTab {
                tab_id: 2,
                keep_chrome_focus: false,
            },
            Command::ToggleAssistant,
            Command::OpenAssistant {
                panel: AssistantPanel::Task,
                goal: Some("Compare headphones".into()),
                prepare: false,
                task_start_mode: None,
                compare_options: None,
            },
            Command::Navigate {
                tab_id: None,
                input: "example.com".into(),
            },
            Command::Back { tab_id: None },
            Command::Forward { tab_id: None },
        ] {
            assert!(command.interrupts_agent());
        }
        assert!(
            !Command::GetPageText {
                request_id: "read".into()
            }
            .interrupts_agent()
        );
        assert!(!Command::FocusContent.interrupts_agent());
        assert!(!Command::FocusOmnibox.interrupts_agent());
        assert!(!Command::SetAssistantExpanded { expanded: true }.interrupts_agent());
    }

    #[test]
    fn findings_layout_wire_format() {
        let command: Command =
            serde_json::from_str(r#"{"type":"setAssistantExpanded","expanded":true}"#).unwrap();
        assert!(matches!(
            command,
            Command::SetAssistantExpanded { expanded: true }
        ));
        assert_eq!(
            serde_json::to_string(&Event::AssistantLayout { expanded: false }).unwrap(),
            r#"{"type":"assistantLayout","expanded":false}"#
        );
    }

    #[test]
    fn assistant_shortcut_wire_format() {
        let command: Command = serde_json::from_str(
            r#"{"type":"openAssistant","panel":"task","goal":"Compare headphones"}"#,
        )
        .unwrap();
        assert!(matches!(
            command,
            Command::OpenAssistant {
                panel: AssistantPanel::Task,
                goal: Some(goal),
                prepare: false,
                task_start_mode: None,
                compare_options: None,
            } if goal == "Compare headphones"
        ));
        assert!(
            serde_json::from_str::<Command>(r#"{"type":"openAssistant","panel":"buy"}"#).is_err()
        );
        assert_eq!(
            serde_json::to_string(&Event::AssistantWorkspace {
                request_id: "draft-1".into(),
                panel: AssistantPanel::Safety,
                goal: None,
                prepare: false,
                task_start_mode: None,
                compare_options: None,
            })
            .unwrap(),
            r#"{"type":"assistantWorkspace","requestId":"draft-1","panel":"safety","goal":null}"#
        );
    }

    #[test]
    fn preparation_shortcut_is_explicit_and_does_not_change_research_defaults() {
        let command: Command = serde_json::from_str(
            r#"{"type":"openAssistant","panel":"task","goal":"Prepare dates","prepare":true}"#,
        )
        .unwrap();
        assert!(matches!(
            command,
            Command::OpenAssistant { prepare: true, .. }
        ));
        let command: Command =
            serde_json::from_str(r#"{"type":"openAssistant","panel":"task"}"#).unwrap();
        assert!(matches!(
            command,
            Command::OpenAssistant { prepare: false, .. }
        ));
    }

    #[test]
    fn task_draft_shortcuts_are_typed_and_do_not_change_legacy_defaults() {
        let command: Command = serde_json::from_str(
            r#"{"type":"openAssistant","panel":"task","taskStartMode":"selectedTabs","compareOptions":false}"#,
        )
        .unwrap();
        assert!(matches!(
            command,
            Command::OpenAssistant {
                task_start_mode: Some(TaskDraftStart::SelectedTabs),
                compare_options: Some(false),
                prepare: false,
                ..
            }
        ));
        assert!(
            serde_json::from_str::<Command>(
                r#"{"type":"openAssistant","panel":"task","taskStartMode":"purchase"}"#
            )
            .is_err()
        );
        assert_eq!(
            serde_json::to_string(&Event::AssistantWorkspace {
                request_id: "draft-2".into(),
                panel: AssistantPanel::Task,
                goal: None,
                prepare: false,
                task_start_mode: Some(TaskDraftStart::WebSearch),
                compare_options: Some(false),
            })
            .unwrap(),
            r#"{"type":"assistantWorkspace","requestId":"draft-2","panel":"task","goal":null,"taskStartMode":"webSearch","compareOptions":false}"#
        );
    }

    #[test]
    fn page_text_wire_format() {
        let e = Event::PageText {
            request_id: "req-1".into(),
            tab_id: Some(4),
            url: "https://example.com".into(),
            title: "Example".into(),
            text: "hello".into(),
            truncated: false,
            error: None,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains(r#""type":"pageText""#));
        assert!(json.contains(r#""requestId":"req-1""#));
        assert!(json.contains(r#""tabId":4"#));
    }

    #[test]
    fn navigation_status_is_optional_for_existing_tab_snapshots() {
        let mut tab: TabInfo = serde_json::from_str(
            r#"{"id":1,"url":"","title":"New Tab","favicon":null,"loading":false,"progress":1,"canGoBack":false,"canGoForward":false}"#,
        )
        .unwrap();
        assert!(tab.needs_trusted_page());
        let original = serde_json::to_value(&tab).unwrap();
        assert!(original.get("pendingUrl").is_none());
        assert!(original.get("loadError").is_none());
        tab.pending_url = Some("https://site.test".into());
        assert!(!tab.needs_trusted_page());
        tab.load_error = Some(PageLoadError {
            url: "https://site.test".into(),
            code: -102,
            name: "ERR_CONNECTION_REFUSED".into(),
        });
        assert!(tab.needs_trusted_page());
        let value = serde_json::to_value(&tab).unwrap();
        assert_eq!(value["pendingUrl"], "https://site.test");
        assert_eq!(value["loadError"]["code"], -102);
        assert_eq!(serde_json::from_value::<TabInfo>(value).unwrap(), tab);
    }
}
