//! Native data minimization. Recognizable secrets are masked before model calls and diagnostics.

use anyhow::bail;
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    sync::{LazyLock, RwLock},
};

pub const MASK: &str = "[redacted]";

static KNOWN_SECRETS: RwLock<Vec<String>> = RwLock::new(Vec::new());
static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?s)-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----.*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----",
        r"(?i)\b(?:sk-(?:ant-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|AIza[a-z0-9_-]{30,}|eyJ[a-z0-9_-]{12,}\.[a-z0-9_-]{12,}\.[a-z0-9_-]{8,})\b",
        r"(?i)\bBearer\s+[a-z0-9_.~+/-]{8,}=*",
        r"\b\d{3}-\d{2}-\d{4}\b",
    ]
    .into_iter()
    .map(|pattern| Regex::new(pattern).expect("constant privacy regex"))
    .collect()
});
static LABELLED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(\b(?:password|passwd|passcode|api[-_ ]?key|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|authorization|session[-_ ]?id|token|secret)\b["']?\s*[:=]\s*)("[^"\r\n]{1,256}"|'[^'\r\n]{1,256}'|[^\s,;<>&"'\\}{]{4,})"#,
    )
    .expect("constant labelled-secret regex")
});
static OTP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(\b(?:otp|one[- ]time (?:password|code)|verification code|security code)\s*[:=]?\s*)\b\d{4,8}\b",
    )
    .expect("constant one-time-code regex")
});
static CARDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:\d[ -]?){12,18}\d\b").expect("constant card-number regex"));
static URLS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)https?://[^\s"'<>\\]+"#).expect("constant URL regex"));
static ISO_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b\d{4}-\d{2}-\d{2}\b").expect("constant ISO date regex"));

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Summary {
    pub redactions: usize,
    pub blocked_links: usize,
}

impl Summary {
    pub fn add(&mut self, other: &Self) {
        self.redactions += other.redactions;
        self.blocked_links += other.blocked_links;
    }
}

pub struct Redacted {
    pub text: String,
    pub count: usize,
}

pub fn remember_secret(secret: &str) {
    if secret.is_empty() {
        return;
    }
    let mut secrets = KNOWN_SECRETS.write().expect("privacy lock poisoned");
    if !secrets.iter().any(|known| known == secret) {
        secrets.push(secret.to_owned());
    }
}

pub fn redact(text: &str) -> Redacted {
    let mut urls = 0;
    let clean = URLS.replace_all(text, |captures: &Captures<'_>| {
        let result = redact_url(&captures[0]);
        urls += result.count;
        result.text
    });
    let mut result = redact_literals(&clean);
    result.count += urls;
    result
}

fn redact_literals(text: &str) -> Redacted {
    let mut result = Redacted {
        text: text.to_owned(),
        count: 0,
    };
    for secret in KNOWN_SECRETS.read().expect("privacy lock poisoned").iter() {
        let count = result.text.matches(secret).count();
        if count > 0 {
            result.text = result.text.replace(secret, MASK);
            result.count += count;
        }
    }
    for pattern in PATTERNS.iter() {
        result.text = pattern
            .replace_all(&result.text, |_: &Captures<'_>| {
                result.count += 1;
                MASK
            })
            .into_owned();
    }
    result.text = LABELLED
        .replace_all(&result.text, |captures: &Captures<'_>| {
            let value = &captures[2];
            if value.contains(MASK) {
                return captures[0].to_owned();
            }
            result.count += 1;
            let quote = value.chars().next().filter(|c| matches!(c, '"' | '\''));
            match quote {
                Some(quote) => format!("{}{quote}{MASK}{quote}", &captures[1]),
                None => format!("{}{MASK}", &captures[1]),
            }
        })
        .into_owned();
    result.text = OTP
        .replace_all(&result.text, |captures: &Captures<'_>| {
            result.count += 1;
            format!("{}{MASK}", &captures[1])
        })
        .into_owned();
    result.text = CARDS
        .replace_all(&result.text, |captures: &Captures<'_>| {
            if !is_card(&captures[0]) {
                return captures[0].to_owned();
            }
            result.count += 1;
            MASK.to_owned()
        })
        .into_owned();
    result
}

fn is_card(text: &str) -> bool {
    if ISO_DATE.is_match(text) {
        return false;
    }
    let digits: Vec<_> = text
        .bytes()
        .filter(u8::is_ascii_digit)
        .map(|b| b - b'0')
        .collect();
    if !(13..=19).contains(&digits.len())
        || digits[0] == 0
        || digits.iter().all(|n| *n == digits[0])
    {
        return false;
    }
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(index, digit)| {
            let value = u32::from(*digit) * if index % 2 == 1 { 2 } else { 1 };
            if value > 9 { value - 9 } else { value }
        })
        .sum();
    sum % 10 == 0
}

fn sensitive_parameter(name: &str, value: &str) -> bool {
    let name = name.to_ascii_lowercase().replace(['-', '_'], "");
    matches!(
        name.as_str(),
        "password"
            | "passwd"
            | "passcode"
            | "apikey"
            | "key"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "clientsecret"
            | "authorization"
            | "sessionid"
            | "sid"
            | "otp"
            | "sig"
            | "signature"
            | "xamzsignature"
            | "xamzcredential"
    ) || (name == "code" && value.len() >= 6)
}

fn decoded(text: &str) -> String {
    let once = percent_encoding::percent_decode_str(text).decode_utf8_lossy();
    percent_encoding::percent_decode_str(&once)
        .decode_utf8_lossy()
        .into_owned()
}

pub fn validate_outbound(url: &url::Url) -> anyhow::Result<()> {
    let raw = decoded(url.as_str());
    if raw.contains(MASK)
        || redact(&raw).count > 0
        || url
            .query_pairs()
            .any(|(key, value)| sensitive_parameter(&key, &value))
    {
        bail!(
            "Sensitive credentials or private codes cannot be sent in a research URL. Open the website manually instead."
        );
    }
    Ok(())
}

pub fn redact_url(input: &str) -> Redacted {
    let Ok(mut url) = url::Url::parse(input) else {
        return redact_literals(input);
    };
    let mut count = 0;
    let pairs: Vec<_> = url
        .query_pairs()
        .map(|(name, value)| {
            let clean = redact_literals(&decoded(&value));
            count += clean.count;
            let value = if sensitive_parameter(&name, &value) && !value.contains(MASK) {
                count += usize::from(clean.count == 0);
                MASK.to_owned()
            } else {
                clean.text
            };
            (name.into_owned(), value)
        })
        .collect();
    if !pairs.is_empty() {
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    let clean = redact_literals(&decoded(url.as_str()));
    let count = count + clean.count;
    Redacted {
        text: if count == 0 {
            input.to_owned()
        } else {
            clean.text
        },
        count,
    }
}

pub fn protect_observation(page: &mut crate::cdp::Observation) -> Summary {
    let mut summary = Summary::default();
    for text in std::iter::once(&mut page.text)
        .chain(std::iter::once(&mut page.title))
        .chain(page.headings.iter_mut())
    {
        let clean = redact(text);
        *text = clean.text;
        summary.redactions += clean.count;
    }
    page.links.retain_mut(|link| {
        if url::Url::parse(&link.url).is_ok_and(|url| validate_outbound(&url).is_err()) {
            summary.blocked_links += 1;
            return false;
        }
        let clean = redact(&link.name);
        link.name = clean.text;
        summary.redactions += clean.count;
        true
    });
    summary
}

/// Buffer one formatted tracing record, so a secret split across writes is still masked.
pub struct RedactingWriter<W: Write> {
    target: W,
    buffer: Vec<u8>,
}

impl<W: Write> RedactingWriter<W> {
    pub fn new(target: W) -> Self {
        Self {
            target,
            buffer: Vec::new(),
        }
    }
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if !self.buffer.is_empty() {
            let clean = redact(&String::from_utf8_lossy(&self.buffer));
            self.target.write_all(clean.text.as_bytes())?;
            self.buffer.clear();
        }
        self.target.flush()
    }
}

impl<W: Write> Drop for RedactingWriter<W> {
    fn drop(&mut self) {
        if let Err(error) = self.flush() {
            eprintln!("Could not write redacted diagnostics: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_recognizable_secrets_without_changing_travel_prices_or_dates() {
        let token = format!("sk-{}", "simulatedfixture".repeat(3));
        let card = ["4111", "1111", "1111", "1111"].join(" ");
        let text = format!(
            "password: hotelGuest123\napi_key=\"{token}\"\nVerification code: 123456\nCard {card}\n\
             Nov 23-28 2026, 2 adults, USD 1,842.00. USD 238.00 per night. Hilton 4.6 stars."
        );
        let clean = redact(&text);
        assert_eq!(clean.count, 4);
        for secret in [&token, &card, &"hotelGuest123".into(), &"123456".into()] {
            assert!(!clean.text.contains(secret));
        }
        assert!(clean.text.contains("USD 1,842.00"));
        assert!(clean.text.contains("Nov 23-28 2026"));
        assert_eq!(
            redact("2026-11-23 2026-11-28").text,
            "2026-11-23 2026-11-28"
        );
        assert_eq!(redact(&clean.text).count, 0, "Redaction must be idempotent");
    }

    #[test]
    fn exact_saved_credentials_are_masked_even_without_a_known_format() {
        let secret = "fixture-saved-credential-with-no-provider-prefix";
        remember_secret(secret);
        assert_eq!(redact(&format!("An unrelated label: {secret}")).count, 1);
        let url = url::Url::parse(&format!("https://site.test/?q={secret}")).unwrap();
        assert!(validate_outbound(&url).is_err());
        remember_secret("Q~z");
        assert_eq!(redact("Credential Q~z").text, "Credential [redacted]");
    }

    #[test]
    fn encoded_secret_urls_are_blocked_but_travel_search_parameters_are_not() {
        for target in [
            "https://site.test/?access_token=opaque",
            "https://site.test/?next=https%3A%2F%2Fother.test%2F%3Fpassword%3DhiddenValue",
            "https://site.test/?next=password%253DhiddenValue",
            "https://site.test/path?code=123456",
            "https://site.test/?q=%5Bredacted%5D",
        ] {
            assert!(
                validate_outbound(&url::Url::parse(target).unwrap()).is_err(),
                "{target}"
            );
        }
        for target in [
            "https://www.google.com/search?q=password+reset+documentation",
            "https://www.google.com/travel/flights/search?tfs=CBwQAhopEgoyMDI2LTExLTIz",
            "https://www.google.com/travel/search?q=Hotels+near+Universal&ts=CAEaJRI",
            "https://site.test/?code=LA&price=2458&guests=4",
        ] {
            assert!(
                validate_outbound(&url::Url::parse(target).unwrap()).is_ok(),
                "{target}"
            );
        }
        assert!(
            !redact_url("https://site.test/?token=opaque")
                .text
                .contains("opaque")
        );
        assert!(
            !redact("Page text https://site.test/?next=password%253DfixtureNestedSecret")
                .text
                .contains("fixtureNestedSecret")
        );
    }

    #[test]
    fn private_keys_and_split_diagnostic_writes_are_masked() {
        let pem = "-----BEGIN PRIVATE KEY-----\nfixture contents\n-----END PRIVATE KEY-----";
        assert_eq!(redact(pem).text, MASK);
        let mut output = Vec::new();
        {
            let mut writer = RedactingWriter::new(&mut output);
            writer.write_all(b"password: ").unwrap();
            writer.write_all(b"simulatedSecret\n").unwrap();
        }
        assert_eq!(
            String::from_utf8(output).unwrap(),
            format!("password: {MASK}\n")
        );
    }
}
