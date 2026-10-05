//! Model decision wire format, its strict JSON schema (provider structured output), and the
//! native travel-search tools. The model only fills typed fields; native code builds every URL.

use crate::agent::{Decision, Report};
use anyhow::{Context, bail};
use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

/// One flat decision object. Fields an action does not use are null (or omitted when a
/// provider cannot enforce the schema). Unknown fields are rejected.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WireDecision {
    action: Action,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    link_id: Option<u32>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    answer: Option<String>,
    #[serde(default)]
    sources: Option<Vec<usize>>,
    #[serde(default)]
    report: Option<Report>,
    #[serde(default)]
    flight: Option<FlightQuery>,
    #[serde(default)]
    stay: Option<StayQuery>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Action {
    Search,
    FlightSearch,
    HotelSearch,
    FollowLink,
    NeedsInput,
    Unable,
    Finish,
}

impl WireDecision {
    pub fn into_decision(self, missing_reason: &str) -> anyhow::Result<Decision> {
        let reason = || {
            self.reason
                .clone()
                .filter(|reason| !reason.trim().is_empty())
                .unwrap_or_else(|| missing_reason.into())
        };
        Ok(match self.action {
            Action::Search => Decision::Search {
                query: self.query.clone().context("search requires query")?,
                reason: reason(),
            },
            Action::FlightSearch => Decision::FlightSearch {
                trip: self
                    .flight
                    .clone()
                    .context("flightSearch requires flight")?,
                reason: reason(),
            },
            Action::HotelSearch => Decision::HotelSearch {
                stay: self.stay.clone().context("hotelSearch requires stay")?,
                reason: reason(),
            },
            Action::FollowLink => Decision::FollowLink {
                link_id: self.link_id.context("followLink requires linkId")?,
                reason: reason(),
            },
            Action::NeedsInput => Decision::NeedsInput {
                message: self.message.context("needsInput requires message")?,
            },
            Action::Unable => Decision::Unable {
                message: self.message.context("unable requires message")?,
            },
            Action::Finish => Decision::Finish {
                answer: self.answer.context("finish requires answer")?,
                sources: self.sources.context("finish requires sources")?,
                report: self.report,
            },
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Cabin {
    Economy,
    PremiumEconomy,
    Business,
    First,
}

/// Structured Google Flights search; native code encodes the URL.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlightQuery {
    pub origin: String,
    pub destination: String,
    pub depart_date: String,
    pub return_date: Option<String>,
    pub adults: u8,
    pub children: u8,
    pub infants: u8,
    pub cabin: Cabin,
}

/// Structured Google Hotels search for a place, exact stay dates and ONE room's guests.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StayQuery {
    pub place: String,
    pub check_in: String,
    pub check_out: String,
    pub adults: u8,
    pub child_ages: Vec<u8>,
}

fn travel_base(path: &str) -> anyhow::Result<Url> {
    if let Ok(base) = std::env::var("AIB_AGENT_TEST_TRAVEL_URL") {
        let mut url = crate::agent::validate_navigation(&base)?;
        let loopback = match url.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        if !loopback || url.query().is_some() || url.fragment().is_some() {
            bail!(
                "The test travel endpoint must be a numeric loopback URL without query or fragment"
            );
        }
        url.set_path(path);
        return Ok(url);
    }
    Ok(Url::parse("https://www.google.com")
        .expect("fixed travel host")
        .join(path)?)
}

fn date(value: &str, today: NaiveDate) -> anyhow::Result<NaiveDate> {
    let parsed = NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d")
        .with_context(|| format!("Travel dates must be YYYY-MM-DD, got {value:?}"))?;
    if parsed < today || parsed > today + Duration::days(366) {
        bail!("Travel date {value} must be between today and one year ahead");
    }
    Ok(parsed)
}

fn airport(code: &str) -> anyhow::Result<String> {
    let code = code.trim().to_ascii_uppercase();
    if code.len() != 3 || !code.bytes().all(|byte| byte.is_ascii_uppercase()) {
        bail!("Airports must be 3-letter IATA codes, got {code:?}");
    }
    Ok(code)
}

fn travelers(adults: u8, children: u8, infants: u8) -> anyhow::Result<()> {
    if !(1..=9).contains(&adults) || u16::from(adults) + u16::from(children) > 9 || infants > adults
    {
        bail!(
            "Travelers must be 1-9 adults, at most 9 seated passengers, and no more lap infants than adults"
        );
    }
    Ok(())
}

fn varint(mut value: u64, out: &mut Vec<u8>) {
    while value > 0x7f {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn field(number: u64, data: &[u8], out: &mut Vec<u8>) {
    varint(number << 3 | 2, out);
    varint(data.len() as u64, out);
    out.extend_from_slice(data);
}

fn number(field: u64, value: u64, out: &mut Vec<u8>) {
    varint(field << 3, out);
    varint(value, out);
}

fn calendar_day(day: NaiveDate) -> Vec<u8> {
    let mut out = Vec::new();
    number(1, day.year() as u64, &mut out);
    number(2, u64::from(day.month()), &mut out);
    number(3, u64::from(day.day()), &mut out);
    out
}

fn leg(day: NaiveDate, from: &str, to: &str) -> Vec<u8> {
    let mut leg = Vec::new();
    field(2, day.format("%Y-%m-%d").to_string().as_bytes(), &mut leg);
    for (number, code) in [(13, from), (14, to)] {
        let mut airport = Vec::new();
        field(2, code.as_bytes(), &mut airport);
        field(number, &airport, &mut leg);
    }
    leg
}

impl FlightQuery {
    /// Google Flights search URL: the `tfs` protobuf (legs, passengers, cabin, trip type).
    pub fn url(&self, today: NaiveDate) -> anyhow::Result<String> {
        let (origin, destination) = (airport(&self.origin)?, airport(&self.destination)?);
        if origin == destination {
            bail!("Origin and destination airports must differ");
        }
        travelers(self.adults, self.children, self.infants)?;
        let depart = date(&self.depart_date, today)?;
        let back = self
            .return_date
            .as_deref()
            .map(|value| date(value, today))
            .transpose()?;
        if back.is_some_and(|back| back < depart) {
            bail!("The return date must not be before the departure date");
        }
        let mut info = Vec::new();
        field(3, &leg(depart, &origin, &destination), &mut info);
        if let Some(back) = back {
            field(3, &leg(back, &destination, &origin), &mut info);
        }
        let mut passengers = Vec::new();
        for (kind, count) in [(1, self.adults), (2, self.children), (4, self.infants)] {
            for _ in 0..count {
                varint(kind, &mut passengers);
            }
        }
        field(8, &passengers, &mut info);
        varint(9 << 3, &mut info);
        varint(
            match self.cabin {
                Cabin::Economy => 1,
                Cabin::PremiumEconomy => 2,
                Cabin::Business => 3,
                Cabin::First => 4,
            },
            &mut info,
        );
        varint(19 << 3, &mut info);
        varint(if back.is_some() { 1 } else { 2 }, &mut info);
        let mut url = travel_base("/travel/flights/search")?;
        url.query_pairs_mut()
            .append_pair("tfs", &base64url(&info))
            .append_pair("hl", "en-US")
            .append_pair("gl", "us")
            .append_pair("curr", "USD");
        Ok(url.to_string())
    }

    pub fn describe(&self) -> String {
        format!(
            "Google Flights: {} → {}, {}{}, {} adult(s), {} child(ren), {} lap infant(s), {:?}",
            self.origin.trim().to_ascii_uppercase(),
            self.destination.trim().to_ascii_uppercase(),
            self.depart_date.trim(),
            self.return_date
                .as_deref()
                .map(|back| format!(" to {}", back.trim()))
                .unwrap_or_else(|| " one way".into()),
            self.adults,
            self.children,
            self.infants,
            self.cabin
        )
    }
}

impl StayQuery {
    /// Google Hotels results near the place. Dates and guests travel in the `ts` protobuf
    /// (Google's own link format); its natural-language parser drops dates when the place
    /// contains a comma, silently showing default one-night prices.
    pub fn url(&self, today: NaiveDate) -> anyhow::Result<String> {
        let place = self.place.split_whitespace().collect::<Vec<_>>().join(" ");
        if place.chars().count() < 2 || place.len() > 120 || place.chars().any(char::is_control) {
            bail!("Hotel place must contain 2-120 characters");
        }
        if !(1..=9).contains(&self.adults)
            || usize::from(self.adults) + self.child_ages.len() > 9
            || self.child_ages.iter().any(|age| *age > 17)
        {
            bail!("A room needs 1-9 adults, at most 9 guests, and child ages 0-17");
        }
        let (check_in, check_out) = (date(&self.check_in, today)?, date(&self.check_out, today)?);
        let nights = (check_out - check_in).num_days();
        if !(1..=30).contains(&nights) {
            bail!("Check-out must be 1-30 nights after check-in");
        }
        let mut guests = Vec::new();
        for _ in 0..self.adults {
            let mut adult = Vec::new();
            number(1, 3, &mut adult);
            field(1, &adult, &mut guests);
        }
        for age in &self.child_ages {
            let mut child = Vec::new();
            number(1, 2, &mut child);
            number(2, u64::from(*age), &mut child);
            field(1, &child, &mut guests);
        }
        number(2, 1, &mut guests);
        let mut stay = Vec::new();
        field(1, &calendar_day(check_in), &mut stay);
        field(2, &calendar_day(check_out), &mut stay);
        number(3, nights as u64, &mut stay);
        let (mut dates, mut search) = (Vec::new(), Vec::new());
        field(2, &stay, &mut dates);
        field(2, &dates, &mut search);
        let (mut code, mut currency) = (Vec::new(), Vec::new());
        field(7, b"USD", &mut code);
        field(1, &code, &mut currency);
        let mut ts = Vec::new();
        number(1, 1, &mut ts);
        field(2, &guests, &mut ts);
        field(3, &search, &mut ts);
        field(5, &currency, &mut ts);
        let mut url = travel_base("/travel/search")?;
        url.query_pairs_mut()
            .append_pair("q", &format!("Hotels near {place}"))
            .append_pair("ts", &base64url(&ts))
            .append_pair("hl", "en-US")
            .append_pair("gl", "us")
            .append_pair("curr", "USD");
        Ok(url.to_string())
    }

    pub fn describe(&self) -> String {
        let nights = NaiveDate::parse_from_str(self.check_out.trim(), "%Y-%m-%d")
            .ok()
            .zip(NaiveDate::parse_from_str(self.check_in.trim(), "%Y-%m-%d").ok())
            .map(|(out, check_in)| format!(" ({} nights)", (out - check_in).num_days()))
            .unwrap_or_default();
        let children = if self.child_ages.is_empty() {
            "no children".into()
        } else {
            format!(
                "children aged {}",
                self.child_ages
                    .iter()
                    .map(u8::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        format!(
            "Google Hotels: near {}, {} to {}{nights}, one room for {} adult(s), {children}",
            self.place.split_whitespace().collect::<Vec<_>>().join(" "),
            self.check_in.trim(),
            self.check_out.trim(),
            self.adults,
        )
    }
}

fn base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let value = chunk.iter().enumerate().fold(0u32, |acc, (index, byte)| {
            acc | u32::from(*byte) << (16 - 8 * index)
        });
        for index in 0..=chunk.len() {
            out.push(TABLE[(value >> (18 - 6 * index) & 63) as usize] as char);
        }
    }
    out
}

fn nullable(schema: Value) -> Value {
    json!({ "anyOf": [{ "type": "null" }, schema] })
}

fn object(properties: Value) -> Value {
    let required: Vec<_> = properties
        .as_object()
        .expect("schema properties object")
        .keys()
        .cloned()
        .collect();
    json!({ "type": "object", "additionalProperties": false, "required": required, "properties": properties })
}

/// Strict JSON schema for one decision (OpenAI strict mode compatible: every property is
/// required, unused ones are null, no additional properties).
pub fn decision_schema() -> Value {
    let string = || json!({ "type": "string" });
    let integer = || json!({ "type": "integer" });
    let ids = || json!({ "type": "array", "items": { "type": "integer" } });
    let component = object(json!({
        "kind": { "type": "string", "enum": ["flight", "hotel", "product", "service", "other"] },
        "name": string(), "detail": string(), "unitAmountMinor": integer(),
        "quantity": integer(), "sourceId": integer(), "quote": string()
    }));
    let offer = object(json!({
        "currency": { "type": "string", "enum": ["USD", "EUR", "GBP", "CAD", "AUD"] },
        "basis": { "type": "string", "enum": ["tripTotal", "itemTotal", "serviceTotal", "stayTotal", "perNight", "perPersonRoundTrip"] },
        "scope": string(),
        "components": { "type": "array", "items": component },
        "exclusions": string()
    }));
    let destination = object(json!({
        "sourceId": integer(), "linkId": { "type": ["integer", "null"] }, "label": string()
    }));
    let option = object(json!({
        "name": string(), "fit": string(), "details": string(), "tradeoffs": string(),
        "sources": ids(), "offer": nullable(offer),
        "destinations": { "type": "array", "items": destination }
    }));
    let finding = object(json!({ "title": string(), "detail": string(), "sources": ids() }));
    let report = object(json!({
        "intent": { "type": "string", "enum": ["travel", "shopping", "general", "research"] },
        "title": string(), "summary": string(),
        "recommendedOption": { "type": ["integer", "null"] },
        "options": { "type": "array", "items": option },
        "findings": { "type": "array", "items": finding },
        "gaps": { "type": "array", "items": string() }
    }));
    let flight = object(json!({
        "origin": string(), "destination": string(), "departDate": string(),
        "returnDate": { "type": ["string", "null"] },
        "adults": integer(), "children": integer(), "infants": integer(),
        "cabin": { "type": "string", "enum": ["economy", "premiumEconomy", "business", "first"] }
    }));
    let stay = object(json!({
        "place": string(), "checkIn": string(), "checkOut": string(),
        "adults": integer(), "childAges": { "type": "array", "items": integer() }
    }));
    object(json!({
        "action": { "type": "string", "enum": ["search", "flightSearch", "hotelSearch", "followLink", "needsInput", "unable", "finish"] },
        "query": { "type": ["string", "null"] },
        "flight": nullable(flight),
        "stay": nullable(stay),
        "linkId": { "type": ["integer", "null"] },
        "reason": { "type": ["string", "null"] },
        "message": { "type": ["string", "null"] },
        "answer": { "type": ["string", "null"] },
        "sources": { "type": ["array", "null"], "items": { "type": "integer" } },
        "report": nullable(report)
    }))
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
