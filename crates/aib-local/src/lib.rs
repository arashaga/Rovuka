use anyhow::{Context, bail};
use async_stream::try_stream;
use futures_util::{Stream, StreamExt};
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{pin::Pin, time::Duration};
use sysinfo::System;
use url::Url;

const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_DISCOVERY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Runtime {
    Ollama,
    LmStudio,
}

impl Runtime {
    pub fn default_url(self) -> &'static str {
        match self {
            Self::Ollama => "http://127.0.0.1:11434",
            Self::LmStudio => "http://127.0.0.1:1234",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub ollama_url: String,
    pub lm_studio_url: String,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            ollama_url: Runtime::Ollama.default_url().into(),
            lm_studio_url: Runtime::LmStudio.default_url().into(),
        }
    }
}

fn preferences_path() -> anyhow::Result<std::path::PathBuf> {
    Ok(dirs::config_dir()
        .context("Could not locate configuration directory")?
        .join("AIBrowser")
        .join("local-runtimes.json"))
}

pub fn load_preferences() -> anyhow::Result<Preferences> {
    let path = preferences_path()?;
    if !path.exists() {
        return Ok(Preferences::default());
    }
    let preferences: Preferences =
        serde_json::from_slice(&std::fs::read(path).context("Reading local runtime addresses")?)
            .context("Parsing saved local runtime addresses")?;
    runtime_url(&preferences.ollama_url)?;
    runtime_url(&preferences.lm_studio_url)?;
    Ok(preferences)
}

pub fn save_preferences(preferences: &Preferences) -> anyhow::Result<()> {
    runtime_url(&preferences.ollama_url)?;
    runtime_url(&preferences.lm_studio_url)?;
    let path = preferences_path()?;
    std::fs::create_dir_all(path.parent().context("No configuration directory")?)?;
    std::fs::write(path, serde_json::to_vec_pretty(preferences)?)
        .context("Saving local runtime addresses")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub memory_bytes: u64,
    pub available_memory_bytes: u64,
    pub logical_cpus: usize,
    pub architecture: String,
    pub acceleration_note: String,
}

pub fn hardware() -> Hardware {
    let mut system = System::new();
    system.refresh_memory();
    system.refresh_cpu_all();
    Hardware {
        memory_bytes: system.total_memory(),
        available_memory_bytes: system.available_memory(),
        logical_cpus: system.cpus().len(),
        architecture: std::env::consts::ARCH.into(),
        acceleration_note: "CPU-compatible models. GPU/Metal acceleration is managed by your runtime; available memory is not a guarantee of model fit.".into(),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub download_bytes: u64,
    pub recommended_memory_bytes: u64,
    pub license: &'static str,
    pub source_url: &'static str,
}

pub fn catalog() -> Vec<CatalogModel> {
    vec![
        CatalogModel {
            id: "qwen2.5:1.5b",
            name: "Qwen 2.5 · 1.5B",
            description: "A light starting point for summaries and short questions.",
            download_bytes: 986_000_000,
            recommended_memory_bytes: 8 * 1024 * 1024 * 1024,
            license: "Apache 2.0",
            source_url: "https://ollama.com/library/qwen2.5",
        },
        CatalogModel {
            id: "qwen2.5:3b",
            name: "Qwen 2.5 · 3B",
            description: "More capable multilingual page explanations on everyday PCs.",
            download_bytes: 1_900_000_000,
            recommended_memory_bytes: 12 * 1024 * 1024 * 1024,
            license: "Qwen Research License (review terms)",
            source_url: "https://ollama.com/library/qwen2.5",
        },
        CatalogModel {
            id: "qwen2.5:7b",
            name: "Qwen 2.5 · 7B",
            description: "Stronger answers for machines with more memory; slower on CPU.",
            download_bytes: 4_700_000_000,
            recommended_memory_bytes: 16 * 1024 * 1024 * 1024,
            license: "Apache 2.0",
            source_url: "https://ollama.com/library/qwen2.5",
        },
    ]
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub id: String,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub runtime: Runtime,
    pub base_url: String,
    pub available: bool,
    pub models: Vec<InstalledModel>,
    pub message: String,
}

pub fn runtime_url(base_url: &str) -> anyhow::Result<Url> {
    let mut url = Url::parse(base_url.trim()).context("Enter an absolute local server URL")?;
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    if !loopback
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/" | "/v1" | "/v1/")
    {
        bail!("Use a localhost server URL without credentials, queries or paths other than /v1");
    }
    url.set_path("/");
    Ok(url)
}

fn client() -> anyhow::Result<Client> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .build()
        .context("Creating local runtime client")
}

async fn read_json(response: Response) -> anyhow::Result<Value> {
    if !response.status().is_success() {
        bail!("Local runtime returned HTTP {}", response.status());
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("Reading local runtime response")?;
        if body.len() + chunk.len() > MAX_DISCOVERY_BYTES {
            bail!("Local runtime discovery response exceeds 4 MB");
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).context("Local runtime returned invalid JSON")
}

fn installed_models(runtime: Runtime, value: Value) -> anyhow::Result<Vec<InstalledModel>> {
    let (collection, id_key) = match runtime {
        Runtime::Ollama => ("models", "name"),
        Runtime::LmStudio => ("data", "id"),
    };
    let models = value
        .get(collection)
        .and_then(Value::as_array)
        .context("The server did not return the expected model list")?;
    models
        .iter()
        .filter(|model| {
            runtime != Runtime::Ollama
                || (!model.get("remote_host").is_some_and(|host| !host.is_null())
                    && !model
                        .get("remote_model")
                        .is_some_and(|name| !name.is_null()))
        })
        .map(|model| {
            Ok(InstalledModel {
                id: model
                    .get(id_key)
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .context("A local model entry has no model identifier")?
                    .to_owned(),
                size_bytes: model.get("size").and_then(Value::as_u64),
            })
        })
        .collect()
}

pub async fn discover(runtime: Runtime, base_url: &str) -> anyhow::Result<RuntimeStatus> {
    let base = runtime_url(base_url)?;
    let route = match runtime {
        Runtime::Ollama => "api/tags",
        Runtime::LmStudio => "v1/models",
    };
    let response = client()?
        .get(base.join(route)?)
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    let result = match response {
        Ok(response) => read_json(response)
            .await
            .and_then(|value| installed_models(runtime, value)),
        Err(error) if error.is_connect() => {
            return Ok(RuntimeStatus {
                runtime,
                base_url: base.to_string(),
                available: false,
                models: Vec::new(),
                message: "Server not running. Start your local runtime, then refresh.".into(),
            });
        }
        Err(error) => Err(error).context("Local runtime did not respond"),
    };
    match result {
        Ok(models) => Ok(RuntimeStatus {
            runtime,
            base_url: base.to_string(),
            available: true,
            message: match runtime {
                Runtime::Ollama => "Ready. Cloud-backed Ollama models are excluded.".into(),
                Runtime::LmStudio => "Ready. Models exposed by your LM Studio server.".into(),
            },
            models,
        }),
        Err(error) => Ok(RuntimeStatus {
            runtime,
            base_url: base.to_string(),
            available: false,
            models: Vec::new(),
            message: format!("{error:#}"),
        }),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub status: String,
    #[serde(default)]
    pub digest: Option<String>,
    #[serde(default)]
    pub total: Option<u64>,
    #[serde(default)]
    pub completed: Option<u64>,
}

pub type PullStream = Pin<Box<dyn Stream<Item = anyhow::Result<PullProgress>> + Send>>;

fn parse_progress(line: &[u8]) -> anyhow::Result<Option<PullProgress>> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    let value: Value = serde_json::from_slice(line).context("Invalid Ollama download progress")?;
    if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
        bail!("Ollama download failed: {error}");
    }
    Ok(Some(serde_json::from_value(value)?))
}

pub async fn pull(base_url: &str, model: &str) -> anyhow::Result<PullStream> {
    if !catalog().iter().any(|entry| entry.id == model) {
        bail!("Only models in the reviewed catalog can be downloaded here");
    }
    let base = runtime_url(base_url)?;
    let response = client()?
        .post(base.join("api/pull")?)
        .json(&json!({ "model": model, "stream": true }))
        .send()
        .await
        .context("Cannot connect to Ollama. Start Ollama before downloading a model.")?;
    if !response.status().is_success() {
        bail!("Ollama download returned HTTP {}", response.status());
    }
    let model = model.to_owned();
    let stream = try_stream! {
        let mut chunks = response.bytes_stream();
        let mut pending = Vec::new();
        let mut success = false;
        while let Some(chunk) = chunks.next().await {
            for byte in chunk.context("Reading Ollama download progress")? {
                pending.push(byte);
                if pending.len() > MAX_LINE_BYTES {
                    Err(anyhow::anyhow!("Ollama progress event exceeds 64 KB"))?;
                }
                if byte == b'\n' {
                    if let Some(event) = parse_progress(&pending)? {
                        if event.status == "success" {
                            success = true;
                        } else {
                            yield event;
                        }
                    }
                    pending.clear();
                }
            }
        }
        if let Some(event) = parse_progress(&pending)? {
            if event.status == "success" {
                success = true;
            } else {
                yield event;
            }
        }
        if !success {
            Err(anyhow::anyhow!("Ollama closed the download stream before reporting success. Retry to resume."))?;
        }
        let status = discover(Runtime::Ollama, base.as_str()).await?;
        if !status.available || !status.models.iter().any(|entry| entry.id == model) {
            Err(anyhow::anyhow!("Ollama reported success but the downloaded model is not available. Refresh and retry."))?;
        }
        yield PullProgress { status: "success".into(), digest: None, total: None, completed: None };
    };
    Ok(Box::pin(stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        thread,
        time::Instant,
    };

    fn mock_server(
        responses: Vec<(&'static str, &'static str, &'static str)>,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            for (expected_route, status, body) in responses {
                let start = Instant::now();
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                start.elapsed() < Duration::from_secs(10),
                                "Mock request timed out"
                            );
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&mut socket);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert!(line.contains(expected_route), "{line}");
                let mut content_length = 0;
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        content_length = value.trim().parse::<usize>().unwrap();
                    }
                    assert!(
                        !line.to_lowercase().starts_with("authorization:"),
                        "Local requests must not carry cloud keys"
                    );
                }
                let mut request_body = vec![0; content_length];
                reader.read_exact(&mut request_body).unwrap();
                write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                for fragment in body.as_bytes().chunks(7) {
                    socket.write_all(fragment).unwrap();
                }
            }
        });
        (base_url, server)
    }

    #[test]
    fn local_urls_cannot_escape_loopback() {
        for url in [
            "http://127.0.0.1:11434",
            "http://localhost:1234/v1",
            "http://[::1]:11434/",
        ] {
            assert!(runtime_url(url).is_ok());
        }
        for url in [
            "https://example.com",
            "file:///test",
            "http://localhost.evil.com",
            "http://user:secret@localhost",
            "http://localhost/api/pull",
            "http://localhost?host=example.com",
            "http://localhost/#x",
        ] {
            assert!(runtime_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn excludes_ollama_cloud_models_and_rejects_bad_schema() {
        let models = installed_models(
            Runtime::Ollama,
            json!({"models":[
                {"name":"qwen2.5:1.5b", "size":986000000},
                {"name":"remote-model", "remote_host":"https://ollama.com"}
            ]}),
        )
        .unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "qwen2.5:1.5b");
        assert!(installed_models(Runtime::Ollama, json!({"data":[]})).is_err());
        let lm =
            installed_models(Runtime::LmStudio, json!({"data":[{"id":"local-model"}]})).unwrap();
        assert_eq!(lm[0].id, "local-model");
    }

    #[test]
    fn parses_download_status_and_errors() {
        let event = parse_progress(br#"{"status":"pulling layer","completed":10,"total":100}"#)
            .unwrap()
            .unwrap();
        assert_eq!(event.completed, Some(10));
        assert!(parse_progress(br#"{"error":"not found"}"#).is_err());
        assert!(parse_progress(b"\r\n").unwrap().is_none());
        assert!(parse_progress(b"invalid").is_err());
    }

    #[tokio::test]
    async fn unreviewed_models_are_rejected_before_network_access() {
        assert!(pull("http://127.0.0.1:1", "../model").await.is_err());
    }

    #[tokio::test]
    async fn discovers_local_runtime_models_over_http() {
        let (url, server) = mock_server(vec![(
            "/api/tags",
            "200 OK",
            r#"{"models":[{"name":"qwen2.5:1.5b","size":986000000}]}"#,
        )]);
        let result = discover(Runtime::Ollama, &url).await.unwrap();
        assert!(result.available);
        assert_eq!(result.models[0].id, "qwen2.5:1.5b");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn verifies_download_before_reporting_success() {
        let (url, server) = mock_server(vec![
            (
                "/api/pull",
                "200 OK",
                "{\"status\":\"pulling layer\",\"total\":100,\"completed\":50}\r\n{\"status\":\"success\"}",
            ),
            (
                "/api/tags",
                "200 OK",
                r#"{"models":[{"name":"qwen2.5:1.5b"}]}"#,
            ),
        ]);
        let mut stream = pull(&url, "qwen2.5:1.5b").await.unwrap();
        let first = stream.next().await.unwrap().unwrap();
        assert_eq!(first.completed, Some(50));
        let last = stream.next().await.unwrap().unwrap();
        assert_eq!(last.status, "success");
        assert!(stream.next().await.is_none());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn incomplete_and_unverified_downloads_fail() {
        for responses in [
            vec![("/api/pull", "200 OK", "{\"status\":\"pulling layer\"}\n")],
            vec![
                ("/api/pull", "200 OK", "{\"status\":\"success\"}\n"),
                ("/api/tags", "200 OK", "{\"models\":[]}"),
            ],
            vec![("/api/pull", "200 OK", "{\"error\":\"disk full\"}\n")],
        ] {
            let (url, server) = mock_server(responses);
            let mut stream = pull(&url, "qwen2.5:1.5b").await.unwrap();
            let mut failed = false;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(event) => assert_ne!(event.status, "success"),
                    Err(_) => failed = true,
                }
            }
            assert!(failed);
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn runtime_redirects_are_reported_not_followed() {
        let (url, server) = mock_server(vec![("/v1/models", "302 Found", "{}")]);
        let result = discover(Runtime::LmStudio, &url).await.unwrap();
        assert!(!result.available);
        assert!(result.message.contains("302"));
        server.join().unwrap();
    }
}
