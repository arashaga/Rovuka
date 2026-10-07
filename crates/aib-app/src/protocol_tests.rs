use super::*;

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 10, 4).unwrap()
}

fn parse(value: Value) -> anyhow::Result<Decision> {
    serde_json::from_value::<WireDecision>(value)?.into_decision("missing")
}

/// Every object in the schema must be closed and list every property as required
/// (OpenAI strict structured-output rules).
fn assert_strict(schema: &Value, path: &str) {
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        assert_eq!(
            schema["additionalProperties"], false,
            "{path} must be closed"
        );
        let mut required: Vec<_> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap().to_owned())
            .collect();
        let mut keys: Vec<_> = properties.keys().cloned().collect();
        required.sort();
        keys.sort();
        assert_eq!(required, keys, "{path} must require every property");
        for (key, child) in properties {
            assert_strict(child, &format!("{path}.{key}"));
        }
    }
    for key in ["items"] {
        if let Some(child) = schema.get(key) {
            assert_strict(child, &format!("{path}[]"));
        }
    }
    if let Some(variants) = schema.get("anyOf").and_then(Value::as_array) {
        for variant in variants {
            assert_strict(variant, path);
        }
    }
}

#[test]
fn schema_is_strict_mode_compatible() {
    let schema = decision_schema();
    assert_eq!(schema["type"], "object");
    assert!(schema.get("anyOf").is_none(), "Root must not be anyOf");
    assert_strict(&schema, "decision");
}

#[test]
fn strict_shaped_decisions_map_onto_native_actions() {
    let nulls = json!({"action":null,"query":null,"flight":null,"stay":null,"linkId":null,"sourceId":null,
        "reason":null,"message":null,"answer":null,"sources":null,"report":null});
    let with = |pairs: Value| {
        let mut value = nulls.clone();
        for (key, item) in pairs.as_object().unwrap() {
            value[key] = item.clone();
        }
        value
    };
    assert!(matches!(
        parse(with(
            json!({"action":"search","query":"AUS LAX","reason":"Find fares"})
        ))
        .unwrap(),
        Decision::Search { .. }
    ));
    assert!(matches!(
        parse(with(json!({"action":"followLink","linkId":3}))).unwrap(),
        Decision::FollowLink { link_id: 3, source_id: None, ref reason } if reason == "missing"
    ));
    assert!(matches!(
        parse(with(json!({"action":"followLink","sourceId":2,"linkId":3}))).unwrap(),
        Decision::FollowLink {
            link_id: 3,
            source_id: Some(2),
            ..
        }
    ));
    let flight = json!({"origin":"aus","destination":"LAX","departDate":"2026-11-23","returnDate":"2026-11-28",
        "adults":2,"children":2,"infants":0,"cabin":"economy"});
    assert!(matches!(
        parse(with(
            json!({"action":"flightSearch","flight":flight,"reason":"Exact dates"})
        ))
        .unwrap(),
        Decision::FlightSearch { .. }
    ));
    let stay = json!({"place":"Universal Studios Hollywood","checkIn":"2026-11-23","checkOut":"2026-11-28","adults":2,"childAges":[8,15]});
    assert!(matches!(
        parse(with(json!({"action":"hotelSearch","stay":stay}))).unwrap(),
        Decision::HotelSearch { .. }
    ));
    let legacy = json!({"place":"Universal Studios Hollywood","checkIn":"2026-11-23","checkOut":"2026-11-28","adults":2,"children":2});
    assert!(parse(with(json!({"action":"hotelSearch","stay":legacy}))).is_err());
    let report = json!({"intent":"travel","title":"Trips","summary":"Two options","recommendedOption":0,
        "options":[{"name":"United + Hilton","fit":"Nonstop","details":"Evidence [1][2]","tradeoffs":"Fees",
            "sources":[1,2],
            "offer":{"currency":"USD","basis":"tripTotal","scope":"4 travelers, 5 nights",
                "components":[{"kind":"flight","name":"United","detail":"Total for 4","unitAmountMinor":157600,
                    "quantity":1,"sourceId":1,"quote":"$1,576 round trip"}],"exclusions":"Bags"},
            "destinations":[{"sourceId":1,"linkId":null,"label":"View flights"}]}],
        "findings":[{"title":"Fares","detail":"Totals include taxes [1]","sources":[1]}],
        "gaps":["Live availability"]});
    let finish = parse(with(
        json!({"action":"finish","answer":"Options [1][2]","sources":[1,2],"report":report}),
    ))
    .unwrap();
    assert!(
        matches!(finish, Decision::Finish { report: Some(ref report), .. } if report.options.len() == 1)
    );
    // Providers without schema enforcement may omit null fields entirely.
    assert!(matches!(
        parse(json!({"action":"needsInput","message":"How many rooms?"})).unwrap(),
        Decision::NeedsInput { .. }
    ));
}

#[test]
fn missing_required_fields_unknown_fields_and_actions_are_rejected() {
    for invalid in [
        json!({"action":"search"}),
        json!({"action":"followLink","reason":"x"}),
        json!({"action":"flightSearch","reason":"x"}),
        json!({"action":"finish","answer":"x"}),
        json!({"action":"needsInput"}),
        json!({"action":"click","linkId":1}),
        json!({"action":"followLink","linkId":1,"url":"https://evil.test"}),
        json!({"action":"flightSearch","flight":{"origin":"AUS","destination":"LAX","departDate":"2026-11-23",
            "returnDate":null,"adults":1,"children":0,"infants":0,"cabin":"economy","url":"https://evil.test"}}),
    ] {
        assert!(parse(invalid.clone()).is_err(), "{invalid}");
    }
}

fn flight() -> FlightQuery {
    FlightQuery {
        origin: "AUS".into(),
        destination: "LAX".into(),
        depart_date: "2026-11-23".into(),
        return_date: Some("2026-11-28".into()),
        adults: 2,
        children: 2,
        infants: 0,
        cabin: Cabin::Economy,
    }
}

#[test]
fn flight_url_matches_the_verified_google_flights_encoding() {
    assert_eq!(
        flight().url(today()).unwrap(),
        "https://www.google.com/travel/flights/search?tfs=GhoSCjIwMjYtMTEtMjNqBRIDQVVTcgUSA0xBWBoaEgoyMDI2LTExLTI4agUSA0xBWHIFEgNBVVNCBAEBAgJIAZgBAQ&hl=en-US&gl=us&curr=USD"
    );
    let mut lower = flight();
    lower.origin = " aus ".into();
    assert_eq!(lower.url(today()).unwrap(), flight().url(today()).unwrap());
    let mut one_way = flight();
    one_way.return_date = None;
    assert!(one_way.url(today()).unwrap().contains("tfs="));
}

#[test]
fn invalid_flight_searches_are_rejected_natively() {
    let cases: Vec<Box<dyn Fn(&mut FlightQuery)>> = vec![
        Box::new(|q| q.origin = "AUSX".into()),
        Box::new(|q| q.destination = "L4X".into()),
        Box::new(|q| q.destination = "AUS".into()),
        Box::new(|q| q.depart_date = "2026-10-03".into()),
        Box::new(|q| q.depart_date = "11/23/2026".into()),
        Box::new(|q| q.return_date = Some("2026-11-22".into())),
        Box::new(|q| q.return_date = Some("2027-12-01".into())),
        Box::new(|q| q.adults = 0),
        Box::new(|q| q.children = 8),
        Box::new(|q| q.infants = 3),
    ];
    for (index, change) in cases.iter().enumerate() {
        let mut query = flight();
        change(&mut query);
        assert!(query.url(today()).is_err(), "case {index}");
    }
}

#[test]
fn hotel_search_url_matches_the_verified_google_hotels_encoding() {
    let stay = StayQuery {
        place: "Universal Studios Hollywood,  Los Angeles, CA".into(),
        check_in: "2026-11-23".into(),
        check_out: "2026-11-28".into(),
        adults: 2,
        child_ages: vec![8, 15],
    };
    let url = Url::parse(&stay.url(today()).unwrap()).unwrap();
    assert_eq!(url.origin().ascii_serialization(), "https://www.google.com");
    assert_eq!(url.path(), "/travel/search");
    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    // Place only: dates in natural language are ignored by Google when the place has a comma.
    assert_eq!(
        pairs[0],
        (
            "q".into(),
            "Hotels near Universal Studios Hollywood, Los Angeles, CA".into()
        )
    );
    // Verified live: Google shows 4 travelers, Mon Nov 23 - Sat Nov 28, 5 nights.
    assert_eq!(
        pairs[1],
        (
            "ts".into(),
            "CAESFgoCCAMKAggDCgQIAhAICgQIAhAPEAEaGBIWEhQKBwjqDxALGBcSBwjqDxALGBwYBSoHCgU6A1VTRA"
                .into()
        )
    );
    assert_eq!(
        &pairs[2..],
        [
            ("hl".into(), "en-US".into()),
            ("gl".into(), "us".into()),
            ("curr".into(), "USD".into())
        ]
    );
    assert_eq!(
        stay.describe(),
        "Google Hotels: near Universal Studios Hollywood, Los Angeles, CA, 2026-11-23 to 2026-11-28 (5 nights), one room for 2 adult(s), children aged 8, 15"
    );
    for (check_in, check_out) in [
        ("2026-11-28", "2026-11-23"),
        ("2026-11-23", "2026-11-23"),
        ("2026-11-01", "2026-12-15"),
    ] {
        let mut invalid = stay.clone();
        invalid.check_in = check_in.into();
        invalid.check_out = check_out.into();
        assert!(invalid.url(today()).is_err(), "{check_in}..{check_out}");
    }
    for (adults, child_ages) in [(0, vec![]), (2, vec![18]), (5, vec![1, 2, 3, 4, 5])] {
        let mut invalid = stay.clone();
        invalid.adults = adults;
        invalid.child_ages = child_ages;
        assert!(invalid.url(today()).is_err());
    }
    let mut control = stay.clone();
    control.place = "Hotel Zone\u{0}Cancun".into();
    assert!(control.url(today()).is_err());
}
