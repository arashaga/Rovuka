use super::*;

pub(super) async fn view(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    with_cors(
        match state.evaluations.view() {
            Ok(view) => Json(view).into_response(),
            Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
        },
        &origin,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Start {
    consent: bool,
}

pub(super) async fn start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Start>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let result = (|| {
        if !request.consent {
            anyhow::bail!(
                "Explicit consent is required; selected-provider requests may incur charges"
            );
        }
        let _jobs = state.model_jobs.lock().expect("model job lock poisoned");
        if state.agent.view().is_some_and(|task| task.active()) {
            anyhow::bail!("Stop or finish the browser task before evaluating a model");
        }
        let settings = state
            .settings
            .read()
            .expect("model settings lock poisoned")
            .clone();
        aib_models::validate_settings(&settings)?;
        let key = if aib_models::requires_api_key(&settings) {
            Some(
                aib_models::read_api_key(settings.provider)?
                    .context("Configure the selected provider API key first")?,
            )
        } else {
            None
        };
        state.evaluations.start(settings, key)?;
        state.evaluations.view()
    })();
    with_cors(
        match result {
            Ok(view) => Json(view).into_response(),
            Err(error) => {
                tracing::warn!("Could not start model evaluation: {error:#}");
                api_error(StatusCode::CONFLICT, &error.to_string())
            }
        },
        &origin,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Stop {
    id: String,
}

pub(super) async fn stop(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Stop>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    with_cors(
        match state.evaluations.stop(&request.id) {
            Ok(()) => Json(json!({"ok":true})).into_response(),
            Err(error) => api_error(StatusCode::CONFLICT, &error.to_string()),
        },
        &origin,
    )
}

pub(super) async fn import(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(report): Json<crate::evaluations::Report>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    with_cors(
        match state
            .evaluations
            .save(&report)
            .and_then(|_| state.evaluations.view())
        {
            Ok(view) => Json(view).into_response(),
            Err(error) => {
                tracing::warn!("Could not import capability report: {error:#}");
                api_error(StatusCode::BAD_REQUEST, &error.to_string())
            }
        },
        &origin,
    )
}
