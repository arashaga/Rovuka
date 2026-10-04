use super::*;
use aib_local::Runtime;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryQuery {
    ollama_url: Option<String>,
    lm_studio_url: Option<String>,
}

pub async fn overview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DiscoveryQuery>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let preferences = match aib_local::load_preferences() {
        Ok(preferences) => preferences,
        Err(error) => {
            tracing::error!("Cannot load local runtime addresses: {error:#}");
            return with_cors(
                api_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("{error:#}")),
                &origin,
            );
        }
    };
    let ollama_url = query
        .ollama_url
        .as_deref()
        .unwrap_or(&preferences.ollama_url);
    let lm_url = query
        .lm_studio_url
        .as_deref()
        .unwrap_or(&preferences.lm_studio_url);
    if let Err(error) =
        aib_local::runtime_url(ollama_url).and_then(|_| aib_local::runtime_url(lm_url))
    {
        return with_cors(
            api_error(StatusCode::BAD_REQUEST, &error.to_string()),
            &origin,
        );
    }
    let (ollama, lm_studio, hardware) = tokio::join!(
        aib_local::discover(Runtime::Ollama, ollama_url),
        aib_local::discover(Runtime::LmStudio, lm_url),
        tokio::task::spawn_blocking(aib_local::hardware),
    );
    match (ollama, lm_studio, hardware) {
        (Ok(ollama), Ok(lm_studio), Ok(hardware)) => with_cors(
            Json(json!({
                "hardware": hardware,
                "runtimes": [ollama, lm_studio],
                "catalog": aib_local::catalog()
            }))
            .into_response(),
            &origin,
        ),
        (ollama, lm, hardware) => {
            tracing::error!("Local discovery failed: {ollama:?}, {lm:?}, {hardware:?}");
            with_cors(
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not inspect local runtimes or hardware",
                ),
                &origin,
            )
        }
    }
}

pub async fn preferences(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(preferences): Json<aib_local::Preferences>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if let Err(error) = aib_local::runtime_url(&preferences.ollama_url)
        .and_then(|_| aib_local::runtime_url(&preferences.lm_studio_url))
    {
        return with_cors(
            api_error(StatusCode::BAD_REQUEST, &error.to_string()),
            &origin,
        );
    }
    if let Err(error) = aib_local::save_preferences(&preferences) {
        tracing::error!("Cannot save local runtime addresses: {error:#}");
        return with_cors(
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not save local runtime addresses",
            ),
            &origin,
        );
    }
    with_cors(Json(preferences).into_response(), &origin)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelRequest {
    runtime: Runtime,
    base_url: String,
    model: String,
}

pub async fn pull(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<LocalModelRequest>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if request.runtime != Runtime::Ollama {
        return with_cors(
            api_error(
                StatusCode::BAD_REQUEST,
                "Download models in LM Studio itself; this download manager uses Ollama.",
            ),
            &origin,
        );
    }
    let permit = match state.downloads.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return with_cors(
                api_error(
                    StatusCode::CONFLICT,
                    "A model download is already being watched. Wait or stop watching it first.",
                ),
                &origin,
            );
        }
    };
    let mut progress = match aib_local::pull(&request.base_url, &request.model).await {
        Ok(progress) => progress,
        Err(error) => {
            tracing::warn!("Cannot start local model download: {error:#}");
            return with_cors(
                api_error(StatusCode::BAD_REQUEST, &format!("{error:#}")),
                &origin,
            );
        }
    };
    let stream = async_stream::stream! {
        let _permit = permit;
        while let Some(event) = progress.next().await {
            match event {
                Ok(event) => {
                    yield Ok::<_, Infallible>(SseEvent::default().event("progress").json_data(event).expect("serializable download progress"));
                }
                Err(error) => {
                    tracing::warn!("Local model download failed: {error:#}");
                    yield Ok(SseEvent::default().event("error").json_data(json!({"message": format!("{error:#}")})).expect("serializable download error"));
                    return;
                }
            }
        }
    };
    with_cors(
        Sse::new(stream)
            .keep_alive(KeepAlive::default())
            .into_response(),
        &origin,
    )
}

pub async fn activate(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<LocalModelRequest>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let discovery = match aib_local::discover(request.runtime, &request.base_url).await {
        Ok(status) => status,
        Err(error) => {
            return with_cors(
                api_error(StatusCode::BAD_REQUEST, &format!("{error:#}")),
                &origin,
            );
        }
    };
    if !discovery.available
        || !discovery
            .models
            .iter()
            .any(|model| model.id == request.model)
    {
        return with_cors(
            api_error(
                StatusCode::BAD_REQUEST,
                "The selected local model is not available. Refresh the model list.",
            ),
            &origin,
        );
    }
    let previous = state
        .settings
        .read()
        .expect("model settings lock poisoned")
        .clone();
    let configured = match aib_models::settings_configured() {
        Ok(configured) => configured,
        Err(error) => {
            tracing::error!("Cannot inspect model settings before switching: {error:#}");
            return with_cors(
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not inspect model settings; model was not switched.",
                ),
                &origin,
            );
        }
    };
    if configured {
        if let Err(error) = aib_models::remember_cloud_settings(&previous) {
            tracing::error!("Could not preserve cloud settings: {error:#}");
            return with_cors(
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not preserve your cloud settings; model was not switched.",
                ),
                &origin,
            );
        }
    }
    let settings = ModelSettings {
        provider: aib_models::Provider::OpenAiCompatible,
        base_url: format!("{}v1", discovery.base_url),
        model: request.model,
        ..ModelSettings::default()
    };
    settings_put(
        State(state),
        headers,
        Json(SaveSettingsRequest {
            settings,
            api_key: None,
            clear_api_key: false,
        }),
    )
    .await
}

pub async fn restore_cloud(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let settings = match aib_models::remembered_cloud_settings() {
        Ok(settings) => settings,
        Err(error) => {
            return with_cors(
                api_error(StatusCode::PRECONDITION_FAILED, &format!("{error:#}")),
                &origin,
            );
        }
    };
    settings_put(
        State(state),
        headers,
        Json(SaveSettingsRequest {
            settings,
            api_key: None,
            clear_api_key: false,
        }),
    )
    .await
}
