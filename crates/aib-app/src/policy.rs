use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ResearchPermission {
    #[default]
    AskEach,
    AllResearch,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskPermission {
    #[default]
    AskEach,
    AllSupported,
}

impl TaskPermission {
    pub fn allows(self, kind: &str) -> bool {
        self == Self::AllSupported
            && matches!(
                kind,
                "search" | "link" | "redirect" | "operation" | "readTab"
            )
    }
}

impl ResearchPermission {
    pub fn allows(self, kind: &str) -> bool {
        self == Self::AllResearch && matches!(kind, "search" | "link" | "redirect")
    }
}

/// How a page-initiated main-frame GET navigation (server or script redirect) is handled.
#[derive(Debug, PartialEq)]
pub enum Redirect {
    /// Stays on the approved site; followed within the approved navigation.
    SameSite,
    /// Leaves the approved site; paused until the task authorizes it.
    CrossSite,
    /// Never followed by the reader agent.
    Forbidden(&'static str),
}

pub fn classify_redirect(current: &str, target: &str) -> Redirect {
    let Ok(target) = crate::agent::validate_navigation(target) else {
        return Redirect::Forbidden(
            "its destination contains sensitive credentials/private codes or is not a safe HTTP(S) URL",
        );
    };
    if requires_manual_handoff(&target) {
        return Redirect::Forbidden(
            "its destination appears to start checkout or change account state",
        );
    }
    match url::Url::parse(current) {
        Ok(current) if same_site(&current, &target) => Redirect::SameSite,
        _ => Redirect::CrossSite,
    }
}

/// Same host (ignoring one leading `www.`), same port, and same scheme or an HTTP→HTTPS upgrade.
fn same_site(from: &url::Url, to: &url::Url) -> bool {
    let host = |url: &url::Url| {
        url.host_str()
            .map(|host| host.strip_prefix("www.").unwrap_or(host).to_owned())
    };
    let compatible = match (from.scheme(), to.scheme()) {
        (a, b) if a == b => from.port_or_known_default() == to.port_or_known_default(),
        ("http", "https") => from.port().is_none() && to.port().is_none(),
        _ => false,
    };
    compatible && host(from).is_some() && host(from) == host(to)
}

pub fn requires_manual_handoff(url: &url::Url) -> bool {
    const ACTIONS: &[&str] = &[
        "checkout",
        "purchase",
        "buy",
        "pay",
        "payment",
        "delete",
        "remove",
        "logout",
        "signout",
        "sign-out",
        "log-out",
        "unsubscribe",
        "cancel",
    ];
    url.path_segments().is_some_and(|mut segments| {
        segments.any(|segment| ACTIONS.contains(&segment.to_ascii_lowercase().as_str()))
    }) || url.query_pairs().any(|(key, value)| {
        matches!(
            key.to_ascii_lowercase().as_str(),
            "action" | "do" | "op" | "operation"
        ) && ACTIONS.contains(&value.to_ascii_lowercase().as_str())
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionEvent {
    pub at: String,
    pub decision: String,
    pub scope: String,
    pub url: Option<String>,
}

impl PermissionEvent {
    pub fn selected_read(decision: &str, url: Option<String>) -> Self {
        let mut event = Self::new(decision, url);
        event.scope = "This comparison task: read only explicitly selected, unchanged page snapshots; no navigation, page changes or access to other tabs".into();
        event
    }

    pub fn task(decision: &str, url: Option<String>) -> Self {
        let mut event = Self::new(decision, url);
        event.scope = "This task and tab: validated public research, search fields, filters, widgets and GET searches only; no transactions, messages, uploads or account changes".into();
        event
    }

    pub fn operation(decision: &str, url: Option<String>) -> Self {
        let mut event = Self::new(decision, url);
        event.scope =
            "One exact public page action only; no transaction or submission authority".into();
        event
    }

    pub fn new(decision: &str, url: Option<String>) -> Self {
        let at = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            Ok(duration) => duration.as_millis().to_string(),
            Err(error) => format!("-{}", error.duration().as_millis()),
        };
        Self {
            at,
            decision: decision.into(),
            scope: "This task: search, observed-link and redirect GET navigation only".into(),
            url,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn research_grant_never_authorizes_write_actions() {
        for kind in [
            "purchase", "submit", "upload", "download", "click", "delete",
        ] {
            assert!(!ResearchPermission::AllResearch.allows(kind));
            assert!(!ResearchPermission::AskEach.allows(kind));
        }

        for kind in ["search", "link", "redirect"] {
            assert!(ResearchPermission::AllResearch.allows(kind));
            assert!(!ResearchPermission::AskEach.allows(kind));
        }
    }

    #[test]
    fn task_grant_covers_only_native_validated_capabilities() {
        for kind in ["search", "link", "redirect", "operation"] {
            assert!(TaskPermission::AllSupported.allows(kind));
            assert!(!TaskPermission::AskEach.allows(kind));
        }
        for kind in [
            "purchase", "booking", "submit", "upload", "download", "delete", "send",
        ] {
            assert!(!TaskPermission::AllSupported.allows(kind));
        }
    }

    #[test]
    fn redirects_follow_same_site_pause_cross_site_and_refuse_transactions() {
        for (from, to) in [
            (
                "https://southwest.com/flights",
                "https://www.southwest.com/en/flights",
            ),
            ("https://www.site.test/a?x=1", "https://site.test/b"),
            ("http://site.test/a", "https://site.test/a"),
            (
                "http://127.0.0.1:4000/redirect",
                "http://127.0.0.1:4000/landing",
            ),
        ] {
            assert_eq!(
                classify_redirect(from, to),
                Redirect::SameSite,
                "{from} -> {to}"
            );
        }
        for (from, to) in [
            (
                "https://www.google.com/goto?url=opaque",
                "https://www.southwest.com/en/flights/flights-from-austin-to-los-angeles",
            ),
            ("https://site.test/", "https://book.site.test/"),
            ("https://site.test/", "http://site.test/"),
            ("http://127.0.0.1:4000/a", "http://127.0.0.1:5000/a"),
            ("https://site.test:8443/", "https://site.test/"),
            ("not a url", "https://site.test/"),
        ] {
            assert_eq!(
                classify_redirect(from, to),
                Redirect::CrossSite,
                "{from} -> {to}"
            );
        }
        for to in [
            "https://site.test/checkout",
            "https://other.test/account/delete",
            "javascript:alert(1)",
            "file:///C:/Windows",
            "https://user:secret@site.test/",
        ] {
            assert!(
                matches!(
                    classify_redirect("https://site.test/", to),
                    Redirect::Forbidden(_)
                ),
                "{to}"
            );
        }
    }

    #[test]
    fn sensitive_navigation_requires_manual_handoff_not_research_permission() {
        for target in [
            "https://site.test/checkout",
            "https://site.test/account/delete",
            "https://site.test/?action=logout",
            "https://site.test/path?op=BUY",
        ] {
            assert!(requires_manual_handoff(&url::Url::parse(target).unwrap()));
        }
        for target in [
            "https://site.test/product/42",
            "https://site.test/cancellation-policy",
            "https://www.google.com/search?q=buy+a+desk",
            "https://site.test/hotel/details",
        ] {
            assert!(!requires_manual_handoff(&url::Url::parse(target).unwrap()));
        }
    }
}
