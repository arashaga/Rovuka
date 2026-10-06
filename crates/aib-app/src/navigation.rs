use url::Url;

#[derive(Clone)]
pub(crate) struct PublicHttpFallback {
    pub https: Url,
    pub http: String,
}

impl PublicHttpFallback {
    pub fn from_omnibox(input: &str, destination: &str) -> Option<Self> {
        let input = input.trim().trim_end_matches('/');
        let https = Url::parse(destination).ok()?;
        if input.contains([':', '/', '?', '#', '@'])
            || input.contains(char::is_whitespace)
            || https.scheme() != "https"
            || !https.username().is_empty()
            || https.password().is_some()
            || https.port().is_some()
            || https.path() != "/"
            || https.query().is_some()
            || https.fragment().is_some()
            || !https.host_str()?.eq_ignore_ascii_case(input)
            || !input.contains('.')
            || input.parse::<std::net::IpAddr>().is_ok()
        {
            return None;
        }
        let mut http = https.clone();
        http.set_scheme("http").ok()?;
        Some(Self {
            https,
            http: http.into(),
        })
    }

    pub fn applies(&self, failed_url: &str, code: i32) -> bool {
        matches!(code, -7 | -100 | -101 | -102 | -118)
            && Url::parse(failed_url).is_ok_and(|url| url == self.https)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_root_hosts_can_follow_real_http_redirects_after_connection_failure() {
        let fallback = PublicHttpFallback::from_omnibox("HOTEL.com/", "https://hotel.com").unwrap();
        assert_eq!(fallback.http, "http://hotel.com/");
        assert!(fallback.applies("https://hotel.com/", -102));
        assert!(!fallback.applies("https://different.com/", -102));
        for code in [-3, -105, -106, -200, -201, -202, -107, -501] {
            assert!(!fallback.applies("https://hotel.com/", code), "{code}");
        }
    }

    #[test]
    fn explicit_https_and_data_bearing_or_local_addresses_never_downgrade() {
        for input in [
            "https://hotel.com",
            "http://hotel.com",
            "hotel.com/private",
            "hotel.com?destination=Cancun",
            "hotel.com#private",
            "user@hotel.com",
            "hotel.com:443",
            "127.0.0.1",
            "localhost",
            "hotel.com anything",
        ] {
            let destination = aib_ipc::resolve_omnibox_input(input, "https://search.test/?q={q}");
            assert!(
                PublicHttpFallback::from_omnibox(input, &destination).is_none(),
                "{input}"
            );
        }
    }
}
