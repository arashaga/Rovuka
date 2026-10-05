use super::*;

pub(super) async fn overview(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let store = match state.agent.audit_store() {
        Ok(store) => store,
        Err(error) => {
            return with_cors(
                api_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
                &origin,
            );
        }
    };
    let directory = store.path();
    let result = tokio::task::spawn_blocking(move || store.records()).await;
    let mut response = match result {
        Ok(Ok(records)) => Json(json!({
            "records": records,
            "retainedRuns": crate::audit::RETAINED_RUNS,
            "directory": directory,
        }))
        .into_response(),
        result => {
            tracing::error!("Could not read task audit history: {result:?}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Local task audit history could not be read. Check its directory and permissions, or explicitly clear the history.",
            )
        }
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    with_cors(response, &origin)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ClearRequest {
    confirm: bool,
}

pub(super) async fn clear(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<ClearRequest>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if !request.confirm {
        return with_cors(
            api_error(
                StatusCode::BAD_REQUEST,
                "Explicitly confirm deletion of local audit history",
            ),
            &origin,
        );
    }
    let agent = state.agent.clone();
    let result = tokio::task::spawn_blocking(move || agent.clear_audit()).await;
    with_cors(
        match result {
            Ok(Ok(())) => Json(json!({ "cleared": true })).into_response(),
            Ok(Err(error)) => {
                tracing::warn!("Task audit deletion refused: {error:#}");
                api_error(StatusCode::CONFLICT, &error.to_string())
            }
            Err(error) => {
                tracing::error!("Task audit deletion worker failed: {error}");
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Task audit deletion could not finish",
                )
            }
        },
        &origin,
    )
}
