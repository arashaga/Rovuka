use super::*;
use serde_json::json;

fn fixture() -> (Vec<Observation>, Vec<Source>) {
    (
        vec![Observation {
            tab_id: 1,
            url: "https://provider.test/offers".into(),
            title: "Offers".into(),
            text: "Round trip $240 per person. Room $120 per night. Desk USD 42.50.".into(),
            headings: vec![],
            links: vec![],
            truncated: false,
        }],
        vec![Source {
            id: 1,
            url: "https://provider.test/offers".into(),
            title: "Offers".into(),
            kind: "page".into(),
        }],
    )
}

fn trip() -> serde_json::Value {
    json!({"currency":"USD","basis":"tripTotal","scope":"Nov 23-28, 2 adults, 1 room, 5 nights",
    "exclusions":"Tax and bags not checked","components":[
        {"kind":"flight","name":"Airline","detail":"Per-person round trip","unitAmountMinor":24000,"quantity":2,"sourceId":1,"quote":"Round trip $240 per person."},
        {"kind":"hotel","name":"Hotel","detail":"One room for five nights","unitAmountMinor":12000,"quantity":5,"sourceId":1,"quote":"Room $120 per night."}
    ]})
}

#[test]
fn trip_subtotal_is_native_component_math_not_a_model_total() {
    let (pages, sources) = fixture();
    let mut offer: Offer = serde_json::from_value(trip()).unwrap();
    offer
        .resolve(Intent::Travel, &[1], &pages, &sources)
        .unwrap();
    assert_eq!(offer.total_minor, 108000);
    let mut invented = trip();
    invented["totalMinor"] = json!(1);
    assert!(serde_json::from_value::<Offer>(invented).is_err());
}

#[test]
fn unsupported_unobserved_search_and_incomplete_trip_prices_are_rejected() {
    let (pages, sources) = fixture();
    for invalid in [
        {
            let mut v = trip();
            v["components"][0]["unitAmountMinor"] = json!(100);
            v
        },
        {
            let mut v = trip();
            v["components"][0]["quote"] = json!("Invented round trip $240");
            v
        },
        {
            let mut v = trip();
            v["components"][0]["sourceId"] = json!(99);
            v
        },
        {
            let mut v = trip();
            v["components"][0]["quantity"] = json!(0);
            v
        },
        {
            let mut v = trip();
            v["components"][0]["quantity"] = json!(101);
            v
        },
        {
            let mut v = trip();
            v["currency"] = json!("JPY");
            v
        },
        {
            let mut v = trip();
            v["components"] = json!([v["components"][0].clone()]);
            v
        },
    ] {
        let mut offer: Offer = serde_json::from_value(invalid).unwrap();
        assert!(
            offer
                .resolve(Intent::Travel, &[1], &pages, &sources)
                .is_err()
        );
    }
    let mut search = sources;
    search[0].kind = "search".into();
    let mut offer: Offer = serde_json::from_value(trip()).unwrap();
    assert!(
        offer
            .resolve(Intent::Travel, &[1], &pages, &search)
            .is_err()
    );
}

#[test]
fn literal_price_parser_is_bounded_and_currency_specific() {
    for (quote, currency, amount) in [
        ("Desk USD 42.50.", "USD", 4250),
        ("Cost $1,234.50 each", "USD", 123450),
        ("USD 42.5", "USD", 4250),
        ("CAD 42.00", "CAD", 4200),
        ("EUR 99.00", "EUR", 9900),
        ("USD 0.00", "USD", 0),
    ] {
        assert!(quoted_amount(quote, currency, amount), "{quote}");
    }
    for quote in [
        "$42.51",
        "$12,34.50",
        "$42.555",
        "CAD $42.50",
        "42.50",
        "$9999999999999999999999999999",
    ] {
        assert!(!quoted_amount(quote, "USD", 4250), "{quote}");
    }
}
