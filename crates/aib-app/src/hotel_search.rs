use super::{Message, literal_user_value};
use anyhow::{Context, bail};
use chrono::{Duration, NaiveDate};
use regex::Regex;
use serde::{Deserialize, Serialize};
use url::{Host, Url};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HotelContext {
    pub action: String,
    pub input_id: Option<u32>,
    #[serde(default)]
    pub open_id: Option<u32>,
    pub search_id: u32,
    pub query: String,
    pub destination: String,
    pub region_id: String,
    pub selected: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HotelQuery {
    pub check_in: String,
    pub check_out: String,
    pub adults: u8,
    pub rooms: u8,
}

#[derive(Clone)]
pub(super) struct HotelIntent {
    pub place: String,
    pub query: HotelQuery,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HotelResult {
    pub dates: String,
    pub party: String,
}

impl HotelResult {
    pub fn matches(&self, query: &HotelQuery) -> bool {
        let date_pattern = |value: &str| {
            let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("validated query date");
            let month = date.format("%b").to_string();
            let day = date.format("%-d").to_string();
            Regex::new(&format!(
                r"(?i)(?:\b{}\b|\b{}\w*\s+{}\b|\b{}\s+{}\w*\b)",
                regex::escape(value),
                month,
                day,
                day,
                month
            ))
            .expect("fixed display date pattern")
        };
        let start = date_pattern(&query.check_in);
        let end = date_pattern(&query.check_out);
        let dates = start
            .find(&self.dates)
            .is_some_and(|first| end.find_at(&self.dates, first.end()).is_some());
        let party =
            Regex::new(r"(?i)\b(\d+)\s+(?:travel(?:er|ler)s?|adults?)\b.*?\b(\d+)\s+rooms?\b")
                .expect("fixed party display pattern")
                .captures(&self.party);
        dates
            && party.is_some_and(|party| {
                party[1].parse::<u8>().ok() == Some(query.adults)
                    && party[2].parse::<u8>().ok() == Some(query.rooms)
            })
    }
}

pub(super) fn is_public_site(input: &str) -> bool {
    let Ok(page) = Url::parse(input) else {
        return false;
    };
    if page.scheme() == "https"
        && matches!(page.host_str(), Some("www.hotels.com" | "hotels.com"))
        && page.port().is_none()
        && page.username().is_empty()
        && page.password().is_none()
    {
        return true;
    }
    false
}

pub(super) fn is_site(input: &str) -> bool {
    if is_public_site(input) {
        return true;
    }
    let Ok(page) = Url::parse(input) else {
        return false;
    };
    std::env::var("AIB_OPERATOR_TEST_HOTEL_ORIGIN")
        .ok()
        .and_then(|origin| Url::parse(&origin).ok())
        .is_some_and(|origin| {
            matches!(origin.scheme(), "http" | "https")
                && matches!(origin.host(), Some(Host::Ipv4(ip)) if ip.is_loopback())
                && origin.username().is_empty()
                && origin.password().is_none()
                && origin.path() == "/"
                && origin.query().is_none()
                && origin.fragment().is_none()
                && origin.origin() == page.origin()
        })
}

pub(super) fn normalized(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| match ch {
            '\u{00e0}' | '\u{00e1}' | '\u{00e2}' | '\u{00e3}' | '\u{00e4}' => 'a',
            '\u{00e8}' | '\u{00e9}' | '\u{00ea}' | '\u{00eb}' => 'e',
            '\u{00ec}' | '\u{00ed}' | '\u{00ee}' | '\u{00ef}' => 'i',
            '\u{00f2}' | '\u{00f3}' | '\u{00f4}' | '\u{00f6}' => 'o',
            '\u{00f9}' | '\u{00fa}' | '\u{00fb}' | '\u{00fc}' => 'u',
            '\u{00f1}' => 'n',
            ch => ch,
        })
        .collect()
}

pub(super) fn matches_place(label: &str, place: &str) -> bool {
    let label = normalized(label);
    let place = normalized(place);
    label == place
        || label
            .strip_prefix(&place)
            .is_some_and(|rest| rest.starts_with(','))
}

fn unique_capture(pattern: &str, input: &str) -> Option<String> {
    let regex = Regex::new(pattern).expect("fixed hotel requirement pattern");
    let mut matches = regex.captures_iter(input);
    let value = matches.next()?.get(1)?.as_str().trim().to_owned();
    matches.next().is_none().then_some(value)
}

pub(super) fn intent(conversation: &[Message]) -> Option<HotelIntent> {
    let mut messages = conversation.iter().filter(|message| message.role == "user");
    let goal = &messages.next()?.content;
    if messages.next().is_some()
        || Regex::new(r"(?i)\b(?:children|child|kids?|infants?)\b")
            .unwrap()
            .is_match(goal)
    {
        return None;
    }
    let scope = Regex::new(
        r"(?ix)^\s*(?:prepare|open)\s+(?:a\s+)?hotel\s+search(?:\s+on\s+this\s+page)?
        \s+(?:for|in)\s+[^,;\n.]+?(?:,\s*|\s+)(?:check(?:ing)?[-\s]?in|arrival)
        \s*(?:on|:|=)?\s*\d{4}-\d{2}-\d{2}\s+and\s+(?:check(?:ing)?[-\s]?out|departure)
        \s*(?:on|:|=)?\s*\d{4}-\d{2}-\d{2}\s*,?\s*(?:for\s+)?[1-9]\s+adults?\s+and\s+[1-9]\s+rooms?\b",
    )
    .expect("fixed basic hotel search scope")
    .find(goal)?;
    if goal[scope.end()..].split('.').any(|clause| {
        let clause = clause
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        !matches!(
            clause.as_str(),
            "" | "use these exact values"
                | "ask me before every change"
                | "open search results only if this is a supported public get search"
                | "stop before booking, payment, or signing in"
                | "stop before booking or payment"
                | "if a control is unsupported, explain what i must do manually"
        )
    }) {
        return None;
    }
    let place = unique_capture(
        r"(?i)\b(?:for|in)\s+([^,;\n.]+?)(?:,\s*|\s+)(?:check(?:ing)?[- ]?in|arrival)\b",
        goal,
    )?;
    if place.len() > 100 || !literal_user_value(&place, conversation) {
        return None;
    }
    let query = HotelQuery {
        check_in: unique_capture(
            r"(?i)\b(?:check(?:ing)?[- ]?in|arrival)\s*(?:on|:|=)?\s*(\d{4}-\d{2}-\d{2})\b",
            goal,
        )?,
        check_out: unique_capture(
            r"(?i)\b(?:check(?:ing)?[- ]?out|departure)\s*(?:on|:|=)?\s*(\d{4}-\d{2}-\d{2})\b",
            goal,
        )?,
        adults: unique_capture(r"(?i)\b([1-9])\s+adults?\b", goal)?
            .parse()
            .ok()?,
        rooms: unique_capture(r"(?i)\b([1-9])\s+rooms?\b", goal)?
            .parse()
            .ok()?,
    };
    Some(HotelIntent { place, query })
}

impl HotelQuery {
    pub fn validate(&self, conversation: &[Message], today: NaiveDate) -> anyhow::Result<()> {
        if conversation.iter().any(|message| {
            message.role == "user"
                && Regex::new(r"(?i)\b(?:children|child|kids?|infants?)\b")
                    .unwrap()
                    .is_match(&message.content)
        }) {
            bail!(
                "This reviewed Hotels.com shortcut supports adults only; child ages must not be silently omitted."
            );
        }
        let day = |value: &str| -> anyhow::Result<NaiveDate> {
            let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .context("Hotel search dates must be exact YYYY-MM-DD values")?;
            if date.format("%Y-%m-%d").to_string() != value
                || date < today
                || date > today + Duration::days(366)
                || !literal_user_value(value, conversation)
            {
                bail!("Hotel search dates must be supplied by you and within the next year");
            }
            Ok(date)
        };
        if day(&self.check_out)? <= day(&self.check_in)? {
            bail!("Hotel check-out must be after check-in");
        }
        if !(1..=9).contains(&self.adults) || self.rooms != 1 {
            bail!(
                "The verified Hotels.com shortcut supports 1-9 adults in one room. Multiple-room allocation and child ages need a different reviewed search."
            );
        }
        for (name, expected) in [
            ("check-in", self.check_in.clone()),
            ("check-out", self.check_out.clone()),
            ("adult", self.adults.to_string()),
            ("room", self.rooms.to_string()),
        ] {
            let values = super::requirements::labelled_values(conversation, name);
            if values.is_none_or(|values| values.iter().any(|value| value != &expected)) {
                bail!(
                    "The exact {name} requirement must match your latest labelled values, not another date, count or model guess"
                );
            }
        }
        Ok(())
    }

    pub fn url(&self, context: &HotelContext, page: &str) -> anyhow::Result<String> {
        let mut url = Url::parse(&context.action)?;
        if !is_site(page)
            || url.origin() != Url::parse(page)?.origin()
            || url.path() != "/Hotel-Search"
            || url.query().is_some()
            || url.fragment().is_some()
            || !context.selected
            || context.destination != context.query
            || context.destination.is_empty()
            || context.destination.len() > 180
            || context.region_id.is_empty()
            || context.region_id.len() > 12
            || !context.region_id.bytes().all(|byte| byte.is_ascii_digit())
            || crate::privacy::redact(&context.destination).count > 0
            || context.destination.contains("[redacted]")
        {
            bail!(
                "The current Hotels.com GET form and selected destination could not be revalidated. No search URL was invented."
            );
        }
        url.query_pairs_mut()
            .append_pair("destination", &context.destination)
            .append_pair("regionId", &context.region_id)
            .append_pair("flexibility", "0_DAY")
            .append_pair("d1", &self.check_in)
            .append_pair("startDate", &self.check_in)
            .append_pair("d2", &self.check_out)
            .append_pair("endDate", &self.check_out)
            .append_pair("adults", &self.adults.to_string())
            .append_pair("rooms", &self.rooms.to_string());
        Ok(url.into())
    }

    pub fn result_matches(&self, url: &str, context: &HotelContext) -> bool {
        let Ok(expected) = self.url(context, url).and_then(|url| Ok(Url::parse(&url)?)) else {
            return false;
        };
        Url::parse(url).is_ok_and(|url| {
            url.path() == expected.path()
                && expected.query_pairs().all(|(name, expected)| {
                    let values = url
                        .query_pairs()
                        .filter(|(key, _)| key == &name)
                        .map(|(_, value)| value.into_owned())
                        .collect::<Vec<_>>();
                    values == [expected.into_owned()]
                })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Vec<Message> {
        vec![Message { role: "user", content: "Prepare a hotel search on this page for Cancun, checking in 2026-11-20 and checking out 2026-11-25, for 2 adults and 1 room. Use these exact values. Ask me before every change. Open search results only if this is a supported public GET search. Stop before booking, payment, or signing in. If a control is unsupported, explain what I must do manually.".into() }]
    }

    fn context() -> HotelContext {
        HotelContext {
            action: "https://www.hotels.com/Hotel-Search".into(),
            input_id: Some(1),
            open_id: None,
            search_id: 2,
            query: "Cancun, Quintana Roo, Mexico".into(),
            destination: "Cancun, Quintana Roo, Mexico".into(),
            region_id: "179995".into(),
            selected: true,
        }
    }

    #[test]
    fn complete_hotel_prompt_produces_exact_reviewable_public_get_parameters() {
        let conversation = request();
        let intent = intent(&conversation).unwrap();
        assert_eq!(intent.place, "Cancun");
        intent
            .query
            .validate(&conversation, NaiveDate::from_ymd_opt(2026, 10, 5).unwrap())
            .unwrap();
        let url = intent
            .query
            .url(&context(), "https://www.hotels.com/")
            .unwrap();
        assert!(intent.query.result_matches(&url, &context()));
        assert!(!intent.query.result_matches(
            &url.replace("/Hotel-Search", "/unrelated-route"),
            &context()
        ));
        assert!(
            !intent
                .query
                .result_matches(&format!("{url}&rooms=2"), &context())
        );
        assert!(
            !intent
                .query
                .result_matches(&url.replace("179995", "100"), &context())
        );
        assert!(
            !intent
                .query
                .result_matches(&url.replace("0_DAY", "1_DAY"), &context())
        );
        let url = Url::parse(&url).unwrap();
        assert_eq!(url.query_pairs().count(), 9);
        assert!(
            url.query_pairs()
                .any(|(key, value)| key == "regionId" && value == "179995")
        );
    }

    #[test]
    fn exact_url_is_not_enough_when_the_site_displays_different_dates_or_travelers() {
        let intent = intent(&request()).unwrap();
        let summary = HotelResult {
            dates: "Dates, Fri, Nov 20 - Wed, Nov 25".into(),
            party: "Travelers, 2 travelers, 1 room".into(),
        };
        assert!(summary.matches(&intent.query));
        for summary in [
            HotelResult {
                dates: "Dates 2026-11-20 to 2026-11-24".into(),
                ..summary.clone()
            },
            HotelResult {
                dates: "Dates, Nov 25 - Nov 20".into(),
                ..summary.clone()
            },
            HotelResult {
                party: "Travelers, 3 travelers, 1 room".into(),
                ..summary.clone()
            },
            HotelResult {
                party: "Travelers, 2 travelers, 2 rooms".into(),
                ..summary.clone()
            },
        ] {
            assert!(!summary.matches(&intent.query));
        }
    }

    #[test]
    fn hotel_shortcut_never_uses_assistant_instructions_or_guesses_missing_details() {
        let mut conversation = request();
        conversation[0].role = "assistant";
        assert!(intent(&conversation).is_none());
        conversation = request();
        conversation[0].content = conversation[0].content.replace("2026-11-25", "next week");
        assert!(intent(&conversation).is_none());
        conversation = request();
        conversation.push(Message {
            role: "user",
            content: "Change it to Madrid".into(),
        });
        assert!(intent(&conversation).is_none());
        for extra in [
            " Only hotels with free parking under USD 300 a night.",
            " Only 5* properties.",
            " Only free cancellation.",
            " Then find a flight.",
        ] {
            conversation = request();
            conversation[0].content.push_str(extra);
            assert!(
                intent(&conversation).is_none(),
                "A basic GET shortcut must not claim it applied an extra requirement: {extra}"
            );
        }
        conversation[0].content = "Open a hotel search for Madrid, arrival 2026-11-20 and departure 2026-11-25, for 2 adults and 1 room.".into();
        assert_eq!(intent(&conversation).unwrap().place, "Madrid");
        assert!(matches_place(
            "Canc\u{00fa}n, Quintana Roo, Mexico",
            "Cancun"
        ));
        assert!(!matches_place("Cancun South, Mexico", "Cancun"));
    }

    #[test]
    fn hotel_get_search_rejects_unobserved_regions_wrong_sites_dates_and_party_counts() {
        let conversation = request();
        let intent = intent(&conversation).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 10, 5).unwrap();
        for bad in ["region", "query", "action", "selected"] {
            let mut context = context();
            match bad {
                "region" => context.region_id = "injected&token=secret".into(),
                "query" => context.query = "unselected text".into(),
                "action" => context.action = "https://www.hotels.com/booking".into(),
                _ => context.selected = false,
            }
            assert!(
                intent
                    .query
                    .url(&context, "https://www.hotels.com/")
                    .is_err(),
                "{bad}"
            );
        }
        assert!(
            intent
                .query
                .url(&context(), "https://www.hotels.com.attacker.test/")
                .is_err()
        );
        for bad in ["date", "order", "adults", "rooms"] {
            let mut query = intent.query.clone();
            match bad {
                "date" => query.check_in = "2026-11-21".into(),
                "order" => query.check_out = query.check_in.clone(),
                "adults" => query.adults = 1,
                _ => query.rooms = 2,
            }
            assert!(query.validate(&conversation, today).is_err(), "{bad}");
        }
    }

    #[test]
    fn model_hotel_parameters_cannot_silently_omit_children_or_room_allocations() {
        let mut conversation = request();
        let query = intent(&conversation).unwrap().query;
        let today = NaiveDate::from_ymd_opt(2026, 10, 5).unwrap();
        conversation[0]
            .content
            .push_str(" Also 2 children ages 8 and 15.");
        assert!(intent(&conversation).is_none());
        assert!(query.validate(&conversation, today).is_err());
        conversation = request();
        conversation[0].content = conversation[0].content.replace("1 room", "2 rooms");
        assert!(query.validate(&conversation, today).is_err());
        conversation = request();
        conversation[0].content = conversation[0]
            .content
            .replace("2 adults", "2 nights, adults not specified");
        assert!(query.validate(&conversation, today).is_err());
        conversation = request();
        conversation[0].content.push_str(" Actually use 2 rooms.");
        assert!(query.validate(&conversation, today).is_err());
        conversation = request();
        conversation[0].content.push_str(" Check-in 2026-11-21.");
        assert!(query.validate(&conversation, today).is_err());
    }
}
