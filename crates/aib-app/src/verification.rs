use anyhow::{Context, bail};
use serde::Serialize;
use url::Url;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub checks: usize,
    pub verified: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub category: String,
    pub recovery: String,
    pub retryable: bool,
}

impl Issue {
    pub fn manual_takeover() -> Self {
        Self {
            category: "manualTakeover".into(),
            recovery: "Review the current page, then use Retry with my details for a fresh task and approval. Page clicks, typing and scrolling take over from preparation; assistant controls do not. Already applied changes remain.".into(),
            retryable: true,
        }
    }

    pub fn from_error(error: &anyhow::Error) -> Self {
        let message = format!("{error:#}").to_lowercase();
        let (category, recovery, retryable) = if message.contains("audit") {
            (
                "auditStorage",
                "Fix the local audit storage problem before retrying. No new action can proceed without its audit.",
                false,
            )
        } else if message.contains("site may require verification")
            || message.contains("website challenge")
        {
            (
                "websiteChallenge",
                "Complete the website's verification yourself, then retry from the current page. Rovuka does not bypass CAPTCHA or sign-in.",
                false,
            )
        } else if message.contains("quarantined reader") {
            (
                "untrustedEvidence",
                "The page could not supply safe, source-grounded evidence. Try another public page or model.",
                true,
            )
        } else if message.contains("retain")
            || message.contains("postcondition")
            || message.contains("verification")
        {
            (
                "outcomeMismatch",
                "The website did not retain the verified result. Review the page and retry from its current state; executed changes are not undone.",
                true,
            )
        } else if message.contains("changed")
            || message.contains("stale")
            || message.contains("reload")
        {
            (
                "pageChanged",
                "The page or control changed. A fresh task can re-inspect the current page; old approvals cannot be reused.",
                true,
            )
        } else if message.contains("timeout")
            || message.contains("timed out")
            || message.contains("seconds")
        {
            (
                "timeout",
                "Let the website finish loading or choose another model, then retry from the current page.",
                true,
            )
        } else if message.contains("unsupported")
            || message.contains("manual")
            || message.contains("adults only")
            || message.contains("one room")
        {
            (
                "unsupportedCapability",
                "This task exceeds the supported public-search capabilities. Narrow the request or continue manually; transaction permissions are not available.",
                false,
            )
        } else if message.contains("model")
            || message.contains("json")
            || message.contains("protocol")
            || message.contains("structured resolver")
            || message.contains("structured hotel requirements")
            || message.contains("resolved destination")
        {
            (
                "modelProtocol",
                "Try a model with stronger structured-output support. The rejected response was not executed.",
                true,
            )
        } else {
            (
                "executionFailed",
                "Review the error and current page before retrying. Retried tasks start with fresh permissions; prior changes remain on the page.",
                true,
            )
        };
        Self {
            category: category.into(),
            recovery: recovery.into(),
            retryable,
        }
    }
}

pub fn search_matches(expected: &str, actual: &str) -> anyhow::Result<()> {
    let expected = Url::parse(expected).context("Invalid expected search URL")?;
    let actual = Url::parse(actual).context("Invalid observed search result URL")?;
    if expected.origin() != actual.origin()
        || expected.path() != actual.path()
        || expected.query_pairs().any(|(key, value)| {
            let wanted = expected
                .query_pairs()
                .filter(|(name, _)| name == &key)
                .map(|(_, value)| value.into_owned())
                .collect::<Vec<_>>();
            let observed = actual
                .query_pairs()
                .filter(|(name, _)| name == &key)
                .map(|(_, value)| value.into_owned())
                .collect::<Vec<_>>();
            wanted != observed || !observed.contains(&value.into_owned())
        })
    {
        bail!(
            "Independent search verification failed: the result did not retain the exact reviewed route and parameters"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omitted_known_requirements_have_a_model_recovery_category() {
        let error = anyhow::anyhow!(
            "The structured resolver omitted the already supplied adult requirement"
        );
        assert_eq!(Issue::from_error(&error).category, "modelProtocol");
    }

    #[test]
    fn search_outcomes_cannot_be_claimed_from_changed_routes_counts_or_duplicate_parameters() {
        let expected = "https://site.test/search?destination=Cancun&adults=2";
        assert!(search_matches(expected, &format!("{expected}&notice=1")).is_ok());
        for actual in [
            "https://site.test/search?destination=Cancun&adults=3",
            "https://site.test/search?destination=Cancun&adults=2&adults=2",
            "https://site.test/other?destination=Cancun&adults=2",
            "https://other.test/search?destination=Cancun&adults=2",
        ] {
            assert!(search_matches(expected, actual).is_err());
        }
    }
}
