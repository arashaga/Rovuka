use crate::agent::Source;
use crate::cdp::Observation;
use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

pub const GUIDANCE: &str = concat!(
    include_str!("instructions/general.txt"),
    "\n",
    include_str!("instructions/travel.txt"),
    "\n",
    include_str!("instructions/shopping.txt")
);

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Intent {
    Travel,
    Shopping,
    General,
    #[default]
    Research,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Offer {
    pub currency: String,
    pub basis: PriceBasis,
    pub scope: String,
    pub components: Vec<Component>,
    pub exclusions: String,
    #[serde(skip_deserializing, default)]
    pub total_minor: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum PriceBasis {
    TripTotal,
    ItemTotal,
    ServiceTotal,
    StayTotal,
    PerNight,
    PerPersonRoundTrip,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ComponentKind {
    Flight,
    Hotel,
    Product,
    Service,
    Other,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Component {
    pub kind: ComponentKind,
    pub name: String,
    pub detail: String,
    pub unit_amount_minor: u64,
    pub quantity: u32,
    pub source_id: usize,
    pub quote: String,
}

fn text(value: &str, max: usize) -> anyhow::Result<()> {
    if value.trim().is_empty() || value.len() > max {
        bail!("Offer text must be nonempty and bounded");
    }
    Ok(())
}

fn normalized(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

// Deliberately supports currency-prefixed English decimal prices only.
fn quoted_amount(quote: &str, currency: &str, amount: u64) -> bool {
    price_in_context(quote, currency, amount, "")
}

fn observed_amount(observed: &str, quote: &str, currency: &str, amount: u64) -> bool {
    if !quoted_amount(quote, currency, amount) {
        return false;
    }
    let observed = normalized(observed);
    let quote = normalized(quote);
    observed.match_indices(&quote).any(|(index, _)| {
        let mut before: Vec<_> = observed[..index].split_whitespace().rev().take(3).collect();
        before.reverse();
        price_in_context(&quote, currency, amount, &before.join(" "))
    })
}

fn price_in_context(quote: &str, currency: &str, amount: u64, before: &str) -> bool {
    if ["USD", "EUR", "GBP", "CAD", "AUD"]
        .iter()
        .any(|code| *code != currency && quote.contains(code))
    {
        return false;
    }
    let symbol = match currency {
        "USD" => "$",
        "EUR" => "\u{20ac}",
        "GBP" => "\u{00a3}",
        _ => currency,
    };
    [currency, symbol].iter().any(|prefix| {
        quote.match_indices(prefix).any(|(index, _)| {
            let context = format!("{before} {}", &quote[..index]);
            let leading = context.trim_end();
            let leading = leading
                .strip_suffix(currency)
                .unwrap_or(leading)
                .trim_end()
                .to_ascii_lowercase();
            let words: Vec<_> = leading
                .split_whitespace()
                .rev()
                .take(3)
                .map(|word| word.trim_matches(|character: char| !character.is_alphanumeric()))
                .collect();
            if matches!(
                words.as_slice(),
                ["from", ..] | ["at", "starting" | "starts", ..] | ["as", "low", "as", ..]
            ) {
                return false;
            }
            let tail = quote[index + prefix.len()..].trim_start();
            let token: String = tail
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == ',' || *c == '.')
                .collect();
            let token = token.trim_end_matches('.');
            let mut parts = token.split('.');
            let whole = parts.next().unwrap_or("");
            let fraction = parts.next().unwrap_or("");
            if parts.next().is_some() || fraction.len() > 2 || whole.is_empty() {
                return false;
            }

            let groups: Vec<_> = whole.split(',').collect();
            if groups
                .iter()
                .any(|group| group.is_empty() || !group.bytes().all(|b| b.is_ascii_digit()))
                || (groups.len() > 1
                    && (groups[0].len() > 3 || groups[1..].iter().any(|group| group.len() != 3)))
                || !fraction.bytes().all(|b| b.is_ascii_digit())
            {
                return false;
            }
            let whole = groups.join("").parse::<u64>().ok();
            let fraction = match fraction.len() {
                0 => Some(0),
                1 => fraction.parse::<u64>().ok().map(|value| value * 10),
                _ => fraction.parse::<u64>().ok(),
            };
            whole
                .zip(fraction)
                .and_then(|(whole, fraction)| whole.checked_mul(100)?.checked_add(fraction))
                == Some(amount)
        })
    })
}

#[cfg(test)]
#[path = "offers_tests.rs"]
mod tests;

impl Offer {
    pub fn resolve(
        &mut self,
        intent: Intent,
        supporting: &[usize],
        observations: &[Observation],
        sources: &[Source],
    ) -> anyhow::Result<()> {
        if !matches!(
            self.currency.as_str(),
            "USD" | "EUR" | "GBP" | "CAD" | "AUD"
        ) {
            bail!("Unsupported price currency; omit the offer rather than convert or guess");
        }
        text(&self.scope, 200)?;
        text(&self.exclusions, 500)?;
        if self.components.is_empty() || self.components.len() > 4 {
            bail!("Offers require one to four observed price components");
        }
        if intent == Intent::Travel
            && self.basis == PriceBasis::TripTotal
            && (!self
                .components
                .iter()
                .any(|c| c.kind == ComponentKind::Flight)
                || !self
                    .components
                    .iter()
                    .any(|c| c.kind == ComponentKind::Hotel))
        {
            bail!("A flight + hotel trip subtotal needs both priced components");
        }
        self.total_minor = 0;
        for component in &self.components {
            text(&component.name, 120)?;
            text(&component.detail, 300)?;
            text(&component.quote, 500)?;
            if component.unit_amount_minor > 1_000_000_000_000
                || !(1..=100).contains(&component.quantity)
                || !supporting.contains(&component.source_id)
            {
                bail!("Invalid price amount, quantity or supporting source");
            }
            let source = sources
                .iter()
                .find(|s| s.id == component.source_id && s.kind == "page")
                .context("A price needs a directly read provider page, not search snippets")?;
            let observation = component
                .source_id
                .checked_sub(1)
                .and_then(|index| observations.get(index))
                .filter(|page| page.url == source.url)
                .context("Price observation is unavailable")?;
            let quote = normalized(&component.quote);
            if !observed_amount(
                &observation.text,
                &quote,
                &self.currency,
                component.unit_amount_minor,
            ) {
                bail!(
                    "Price amount/quote does not establish an exact observed price; omit starting/from or unverified pricing"
                );
            }
            self.total_minor = self
                .total_minor
                .checked_add(
                    component
                        .unit_amount_minor
                        .checked_mul(u64::from(component.quantity))
                        .context("Price multiplication overflow")?,
                )
                .context("Price sum overflow")?;
        }
        Ok(())
    }
}
