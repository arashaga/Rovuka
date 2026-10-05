//! Local server for the trusted chrome UI: static assets + a token-authenticated WebSocket.
//!
//! Binds to 127.0.0.1 on a random port. Web content cannot drive the browser because every
//! WebSocket requires a random per-launch token and an allow-listed Origin.

use aib_ipc::{Command, Event};
use aib_models::{ModelSettings, SettingsView};
use anyhow::Context;
use axum::{
    Json, Router,
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{
        IntoResponse, Response,
        sse::{Event as SseEvent, KeepAlive, Sse},
    },
    routing::{get, post, put},
};
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::json;
use std::{
    convert::Infallible,
    sync::{Arc, RwLock},
};

mod agent_api;
mod local_api;
mod safety_api;

#[derive(RustEmbed)]
#[folder = "../../ui/dist"]
#[allow_missing = true]
struct UiAssets;

pub struct ServerInfo {
    pub port: u16,
    pub token: String,
    /// URL the chrome UI BrowserView should load.
    pub ui_url: String,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<anyhow::Result<()>>>,
}

impl ServerInfo {
    pub fn shutdown(&mut self) -> anyhow::Result<()> {
        crate::bus::take_over();
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| anyhow::anyhow!("The trusted UI server thread panicked"))??;
        }
        Ok(())
    }
}

impl Drop for ServerInfo {
    fn drop(&mut self) {
        if let Err(error) = self.shutdown() {
            tracing::error!("Trusted UI server shutdown failed: {error:#}");
        }
    }
}

struct AppState {
    token: String,
    allowed_origins: Vec<String>,
    settings: RwLock<ModelSettings>,
    downloads: Arc<tokio::sync::Semaphore>,
    agent: Arc<crate::agent::Service>,
}

/// Start the server on a background tokio runtime and return once it is listening.
pub fn start() -> anyhow::Result<ServerInfo> {
    let token = random_token();
    let model_settings = aib_models::load_settings()?;
    let audit = Arc::new(crate::audit::Store::open()?);
    let (tx, rx) = std::sync::mpsc::channel();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let token_for_thread = token.clone();

    let thread = std::thread::Builder::new()
        .name("aib-server".into())
        .spawn(move || -> anyhow::Result<()> {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .context("Could not create the trusted UI runtime")?;
            let result = rt.block_on(async move {
                let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
                    Ok(l) => l,
                    Err(e) => {
                        let error =
                            anyhow::Error::new(e).context("Could not bind the trusted UI server");
                        let _ = tx.send(Err(anyhow::anyhow!("{error:#}")));
                        return Err(error);
                    }
                };
                let port = listener.local_addr().unwrap().port();
                let dev_url = std::env::var("AIB_UI_DEV_URL")
                    .ok()
                    .map(|u| u.trim_end_matches('/').to_string());

                let mut allowed_origins = vec![format!("http://127.0.0.1:{port}")];
                if let Some(dev) = &dev_url {
                    if let Ok(u) = url::Url::parse(dev) {
                        allowed_origins.push(u.origin().ascii_serialization());
                    }
                }
                let ui_url = match &dev_url {
                    Some(dev) => format!("{dev}/?port={port}&token={token_for_thread}"),
                    None => format!("http://127.0.0.1:{port}/?token={token_for_thread}"),
                };

                let state = Arc::new(AppState {
                    token: token_for_thread.clone(),
                    allowed_origins,
                    settings: RwLock::new(model_settings),
                    downloads: Arc::new(tokio::sync::Semaphore::new(1)),
                    agent: Arc::new(crate::agent::Service::new(audit)),
                });
                crate::bus::set_agent(state.agent.clone());
                let app = Router::new()
                    .route("/ws", get(ws_handler))
                    .route(
                        "/api/settings",
                        get(settings_get).put(settings_put).options(preflight),
                    )
                    .route("/api/chat/stream", post(chat_stream).options(preflight))
                    .route(
                        "/api/agent",
                        get(agent_api::view)
                            .post(agent_api::start)
                            .options(preflight),
                    )
                    .route(
                        "/api/agent/approve",
                        post(agent_api::approve).options(preflight),
                    )
                    .route("/api/agent/stop", post(agent_api::stop).options(preflight))
                    .route(
                        "/api/agent/revoke-research",
                        post(agent_api::revoke_research).options(preflight),
                    )
                    .route(
                        "/api/agent/reply",
                        post(agent_api::reply).options(preflight),
                    )
                    .route("/api/safety", get(safety_api::overview).options(preflight))
                    .route(
                        "/api/safety/clear",
                        post(safety_api::clear).options(preflight),
                    )
                    .route("/api/local", get(local_api::overview).options(preflight))
                    .route(
                        "/api/local/preferences",
                        put(local_api::preferences).options(preflight),
                    )
                    .route("/api/local/pull", post(local_api::pull).options(preflight))
                    .route(
                        "/api/local/activate",
                        post(local_api::activate).options(preflight),
                    )
                    .route(
                        "/api/local/restore-cloud",
                        post(local_api::restore_cloud).options(preflight),
                    )
                    .fallback(static_handler)
                    .with_state(state);

                tx.send(Ok((port, token_for_thread, ui_url)))
                    .map_err(|_| anyhow::anyhow!("The UI server startup caller disconnected"))?;
                tokio::select! {
                    biased;
                    _ = stopped => Ok(()),
                    result = async { axum::serve(listener, app).await } => {
                        result.context("The trusted UI server stopped unexpectedly")
                    }
                }
            });
            // Join the runtime's blocking workers before Windows terminates process threads.
            drop(rt);
            tracing::info!("Trusted UI server runtime stopped");
            result
        })?;

    let startup = rx.recv();
    let (port, server_token, ui_url) = match startup {
        Ok(Ok(info)) => info,
        result => {
            thread
                .join()
                .map_err(|_| anyhow::anyhow!("The trusted UI server startup thread panicked"))??;
            return Err(match result {
                Ok(Err(error)) => error,
                Err(error) => error.into(),
                Ok(Ok(_)) => unreachable!(),
            });
        }
    };
    let info = ServerInfo {
        port,
        token: server_token,
        ui_url,
        stop: Some(stop),
        thread: Some(thread),
    };
    debug_assert_eq!(info.token, token);
    tracing::info!(port = info.port, "UI server listening");
    Ok(info)
}

pub(crate) fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Deserialize)]
struct WsQuery {
    token: String,
}

async fn ws_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<WsQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let origin_ok = headers
        .get(header::ORIGIN)
        .and_then(|o| o.to_str().ok())
        .is_some_and(|o| state.allowed_origins.iter().any(|a| a == o));
    if !constant_time_eq(q.token.as_bytes(), state.token.as_bytes()) || !origin_ok {
        tracing::warn!(
            origin_ok,
            token_ok = constant_time_eq(q.token.as_bytes(), state.token.as_bytes()),
            "Rejected UI WebSocket authorization"
        );
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(handle_socket)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn request_origin(headers: &HeaderMap, state: &AppState) -> Option<String> {
    let origin = match headers.get(header::ORIGIN) {
        Some(origin) => origin.to_str().ok()?.to_owned(),
        None => format!("http://{}", headers.get(header::HOST)?.to_str().ok()?),
    };
    state
        .allowed_origins
        .iter()
        .any(|allowed| allowed == &origin)
        .then_some(origin)
}

fn api_authorized(headers: &HeaderMap, state: &AppState) -> Option<String> {
    let origin = request_origin(headers, state)?;
    let token = headers.get("x-aib-token")?.to_str().ok()?;
    constant_time_eq(token.as_bytes(), state.token.as_bytes()).then_some(origin)
}

fn with_cors(mut response: Response, origin: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(origin) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}

async fn preflight(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(origin) = request_origin(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_str(&origin).expect("validated Origin is a header value"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, PUT, POST, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type, x-aib-token"),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Origin"));
    response
}

async fn settings_get(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let settings = state
        .settings
        .read()
        .expect("model settings lock poisoned")
        .clone();
    let api_key_configured = match aib_models::api_key_configured(&settings) {
        Ok(configured) => configured,
        Err(error) => {
            tracing::error!("Could not read model API key: {error:#}");
            return with_cors(
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not read the saved API key from the system credential store",
                ),
                &origin,
            );
        }
    };
    let mut view = SettingsView::from(settings);
    view.api_key_configured = api_key_configured;
    view.configured = match aib_models::settings_configured() {
        Ok(configured) => configured,
        Err(error) => {
            tracing::error!("Could not check saved model settings: {error:#}");
            return with_cors(
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not check model settings",
                ),
                &origin,
            );
        }
    };
    with_cors(Json(view).into_response(), &origin)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveSettingsRequest {
    settings: ModelSettings,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    clear_api_key: bool,
}

async fn settings_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<SaveSettingsRequest>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if let Err(error) = aib_models::validate_settings(&request.settings) {
        return with_cors(
            api_error(StatusCode::BAD_REQUEST, &error.to_string()),
            &origin,
        );
    }
    if let Some(key) = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        if let Err(error) = aib_models::write_api_key(request.settings.provider, key) {
            tracing::error!("Could not store model API key: {error:#}");
            return with_cors(
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not store the API key in the system credential store",
                ),
                &origin,
            );
        }
    } else if request.clear_api_key {
        if let Err(error) = aib_models::delete_api_key(request.settings.provider) {
            tracing::error!("Could not delete model API key: {error:#}");
            return with_cors(
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not remove the API key from the system credential store",
                ),
                &origin,
            );
        }
    }
    if let Err(error) = aib_models::save_settings(&request.settings) {
        tracing::error!("Could not save model settings: {error:#}");
        return with_cors(
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not save model settings",
            ),
            &origin,
        );
    }
    *state
        .settings
        .write()
        .expect("model settings lock poisoned") = request.settings;
    let saved_settings = state
        .settings
        .read()
        .expect("model settings lock poisoned")
        .clone();
    let api_key_configured = match aib_models::api_key_configured(&saved_settings) {
        Ok(configured) => configured,
        Err(error) => {
            tracing::error!("Could not verify saved model API key: {error:#}");
            return with_cors(
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not verify the saved API key",
                ),
                &origin,
            );
        }
    };
    let mut view = SettingsView::from(saved_settings);
    view.api_key_configured = api_key_configured;
    view.configured = true;
    with_cors(Json(view).into_response(), &origin)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    question: String,
    page_text: Option<String>,
}

async fn chat_stream(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<ChatRequest>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if request.question.trim().is_empty() || request.question.len() > 5_000 {
        return with_cors(
            api_error(
                StatusCode::BAD_REQUEST,
                "Question must contain 1–5,000 bytes",
            ),
            &origin,
        );
    }
    if request
        .page_text
        .as_ref()
        .is_some_and(|text| text.len() > 500_000)
    {
        return with_cors(
            api_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Page text exceeds the 500 KB limit",
            ),
            &origin,
        );
    }
    let settings = state
        .settings
        .read()
        .expect("model settings lock poisoned")
        .clone();
    let api_key = if aib_models::requires_api_key(&settings) {
        match aib_models::read_api_key(settings.provider) {
            Ok(key) => key,
            Err(error) => {
                tracing::error!("Could not read model API key: {error:#}");
                return with_cors(
                    api_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Could not read the saved API key from the system credential store",
                    ),
                    &origin,
                );
            }
        }
    } else {
        None
    };
    if api_key.as_deref().unwrap_or_default().is_empty() && aib_models::requires_api_key(&settings)
    {
        return with_cors(
            api_error(
                StatusCode::PRECONDITION_FAILED,
                "Save an API key for this provider in Ask AI settings first",
            ),
            &origin,
        );
    }
    if let Some(key) = &api_key {
        crate::privacy::remember_secret(key);
    }
    let question = crate::privacy::redact(&request.question);
    let page = request.page_text.as_deref().map(crate::privacy::redact);
    let redactions = question.count + page.as_ref().map_or(0, |page| page.count);
    let stream = match aib_models::chat_stream(
        &settings,
        api_key.as_deref(),
        &question.text,
        page.as_ref().map(|page| page.text.as_str()),
    )
    .await
    {
        Ok(stream) => stream,
        Err(error) => {
            tracing::warn!("Model request could not start: {error:#}");
            return with_cors(
                api_error(StatusCode::BAD_GATEWAY, &error.to_string()),
                &origin,
            );
        }
    };
    let events = stream.map(|result| match result {
        Ok(delta) => Ok::<SseEvent, Infallible>(
            SseEvent::default().data(json!({ "delta": delta }).to_string()),
        ),
        Err(error) => {
            tracing::warn!("Model response stream failed: {error:#}");
            Ok(SseEvent::default().event("error").data(
                json!({ "message": crate::privacy::redact(&error.to_string()).text }).to_string(),
            ))
        }
    });
    let events = futures_util::stream::once(async move {
        Ok::<SseEvent, Infallible>(
            SseEvent::default()
                .event("privacy")
                .data(json!({ "redactions": redactions }).to_string()),
        )
    })
    .chain(events);
    let response = Sse::new(events)
        .keep_alive(KeepAlive::default())
        .into_response();
    with_cors(response, &origin)
}

fn api_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": crate::privacy::redact(message).text })),
    )
        .into_response()
}

async fn handle_socket(socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (snapshot, mut rx) = crate::bus::subscribe();

    let send_task = tokio::spawn(async move {
        for ev in snapshot {
            if send_event(&mut sink, &ev).await.is_err() {
                return;
            }
        }
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    if send_event(&mut sink, &ev).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        if let Message::Text(text) = msg {
            match serde_json::from_str::<Command>(&text) {
                Ok(cmd) => crate::bus::send_command(cmd),
                Err(e) => tracing::warn!("bad command from UI: {e}: {text}"),
            }
        }
    }
    send_task.abort();
}

async fn send_event(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    ev: &Event,
) -> Result<(), axum::Error> {
    let json = serde_json::to_string(ev).expect("event serializes");
    sink.send(Message::Text(json.into())).await
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let file = UiAssets::get(path).or_else(|| UiAssets::get("index.html"));
    match file {
        Some(content) => {
            let mime = content.metadata.mimetype().to_string();
            (
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CACHE_CONTROL, "no-cache".to_string()),
                ],
                content.data.into_owned(),
            )
                .into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            "UI not built. Run `npm run build` in ui/ or set AIB_UI_DEV_URL.",
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_auth_accepts_same_origin_requests_without_origin_header() {
        let state = AppState {
            token: "secret-token".into(),
            allowed_origins: vec!["http://127.0.0.1:12345".into()],
            settings: RwLock::new(ModelSettings::default()),
            downloads: Arc::new(tokio::sync::Semaphore::new(1)),
            agent: Arc::new(crate::agent::Service::default()),
        };
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:12345"));
        headers.insert("x-aib-token", HeaderValue::from_static("secret-token"));
        assert_eq!(
            api_authorized(&headers, &state).as_deref(),
            Some("http://127.0.0.1:12345")
        );
    }

    #[test]
    fn api_auth_rejects_foreign_origins_even_with_the_token() {
        let state = AppState {
            token: "secret-token".into(),
            allowed_origins: vec!["http://127.0.0.1:12345".into()],
            settings: RwLock::new(ModelSettings::default()),
            downloads: Arc::new(tokio::sync::Semaphore::new(1)),
            agent: Arc::new(crate::agent::Service::default()),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://attacker.example"),
        );
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:12345"));
        headers.insert("x-aib-token", HeaderValue::from_static("secret-token"));
        assert!(api_authorized(&headers, &state).is_none());
    }
}
