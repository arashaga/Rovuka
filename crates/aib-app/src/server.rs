//! Local server for the trusted chrome UI: static assets + a token-authenticated WebSocket.
//!
//! Binds to 127.0.0.1 on a random port. Web content cannot drive the browser because every
//! WebSocket requires a random per-launch token and an allow-listed Origin.

use aib_ipc::{Command, Event};
use axum::{
    Router,
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use serde::Deserialize;
use std::sync::Arc;

#[derive(RustEmbed)]
#[folder = "../../ui/dist"]
#[allow_missing = true]
struct UiAssets;

#[derive(Clone)]
pub struct ServerInfo {
    pub port: u16,
    pub token: String,
    /// URL the chrome UI BrowserView should load.
    pub ui_url: String,
}

struct AppState {
    token: String,
    allowed_origins: Vec<String>,
}

/// Start the server on a background tokio runtime and return once it is listening.
pub fn start() -> anyhow::Result<ServerInfo> {
    let token = random_token();
    let (tx, rx) = std::sync::mpsc::channel();
    let token_for_thread = token.clone();

    std::thread::Builder::new().name("aib-server".into()).spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async move {
            let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
                Ok(l) => l,
                Err(e) => {
                    let _ = tx.send(Err(anyhow::anyhow!(e)));
                    return;
                }
            };
            let port = listener.local_addr().unwrap().port();
            let dev_url = std::env::var("AIB_UI_DEV_URL").ok().map(|u| u.trim_end_matches('/').to_string());

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

            let state = Arc::new(AppState { token: token_for_thread.clone(), allowed_origins });
            let app = Router::new()
                .route("/ws", get(ws_handler))
                .fallback(static_handler)
                .with_state(state);

            let _ = tx.send(Ok(ServerInfo { port, token: token_for_thread, ui_url }));
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!("server stopped: {e}");
            }
        });
    })?;

    let info = rx.recv()??;
    debug_assert_eq!(info.token, token);
    tracing::info!(port = info.port, "UI server listening");
    Ok(info)
}

fn random_token() -> String {
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
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(handle_socket)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn handle_socket(socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (snapshot, mut rx) = crate::bus::subscribe();

    let send_task = tokio::spawn(async move {
        if let Some(ev) = snapshot {
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
