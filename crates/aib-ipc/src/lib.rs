//! Wire protocol between the browser host (Rust) and the trusted chrome UI (React).
//!
//! Messages are JSON over a token-authenticated WebSocket on 127.0.0.1.
//! Keep `ui/src/ipc.ts` in sync with this file.

use serde::{Deserialize, Serialize};

pub type TabId = u32;

/// UI -> host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
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
    ShowDevTools {
        #[serde(default)]
        tab_id: Option<TabId>,
    },
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
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
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
}

/// Turn omnibox input into a URL: keep explicit URLs, add a scheme to
/// host-like input, otherwise run a search.
pub fn resolve_omnibox_input(input: &str, search_template: &str) -> String {
    let input = input.trim();
    if input.is_empty() {
        return "about:blank".into();
    }
    let lower = input.to_ascii_lowercase();
    let has_scheme = ["http://", "https://", "file://", "about:", "data:", "chrome://", "view-source:"]
        .iter()
        .any(|s| lower.starts_with(s));
    if has_scheme {
        return input.to_string();
    }
    if !input.contains(char::is_whitespace) {
        let host = lower.split(['/', '?', '#']).next().unwrap_or_default();
        let host_no_port = host.split(':').next().unwrap_or_default();
        let is_local = host_no_port == "localhost" || host_no_port.parse::<std::net::Ipv4Addr>().is_ok();
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
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
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
        assert_eq!(resolve_omnibox_input("https://a.com/x", T), "https://a.com/x");
        assert_eq!(resolve_omnibox_input("example.com", T), "https://example.com");
        assert_eq!(resolve_omnibox_input("example.com/path?q=1", T), "https://example.com/path?q=1");
        assert_eq!(resolve_omnibox_input("localhost:3000", T), "http://localhost:3000");
        assert_eq!(resolve_omnibox_input("127.0.0.1:8080/a", T), "http://127.0.0.1:8080/a");
        assert_eq!(resolve_omnibox_input("rust traits", T), "https://search.example/?q=rust+traits");
        assert_eq!(resolve_omnibox_input("v1.2", T), "https://search.example/?q=v1.2");
        assert_eq!(resolve_omnibox_input("c++", T), "https://search.example/?q=c%2B%2B");
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
}
