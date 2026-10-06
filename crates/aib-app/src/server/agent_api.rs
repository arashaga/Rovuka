use super::*;
use crate::agent::Service;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StartRequest {
    goal: String,
    share_page: bool,
    #[serde(default)]
    start_mode: crate::agent::StartMode,
    #[serde(default)]
    compare_options: bool,
    #[serde(default)]
    mode: crate::agent::operator::Mode,
    #[serde(default)]
    selected_tabs: Vec<crate::cdp::ReadTarget>,
    #[serde(default)]
    preserve_tabs: bool,
}

pub(super) async fn tabs(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    with_cors(
        match crate::cdp::read_tabs().await {
            Ok(tabs) => Json(tabs).into_response(),
            Err(error) => {
                tracing::warn!("Could not list comparison tabs: {error:#}");
                api_error(StatusCode::CONFLICT, &error.to_string())
            }
        },
        &origin,
    )
}

pub(super) async fn view(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    with_cors(Json(state.agent.view()).into_response(), &origin)
}

pub(super) async fn start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<StartRequest>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if !request.share_page || request.goal.trim().is_empty() || request.goal.len() > 5000 {
        return with_cors(
            api_error(
                StatusCode::BAD_REQUEST,
                "Enter a goal (1-5,000 bytes) and explicitly allow sharing task pages with your model",
            ),
            &origin,
        );
    }
    let selected_tabs = if matches!(request.start_mode, crate::agent::StartMode::SelectedTabs) {
        let result = async {
            let tabs = crate::cdp::read_tabs().await?;
            crate::agent::comparison::resolve_selection(&request.selected_tabs, &tabs)
        }
        .await;
        match result {
            Ok(targets) => targets,
            Err(error) => {
                tracing::warn!("Selected-tab scope rejected before sharing: {error}");
                return with_cors(api_error(StatusCode::CONFLICT, &error.to_string()), &origin);
            }
        }
    } else {
        request.selected_tabs
    };
    let settings = state
        .settings
        .read()
        .expect("model settings lock poisoned")
        .clone();
    let result = (|| {
        let _jobs = state.model_jobs.lock().expect("model job lock poisoned");
        if state.evaluations.active() {
            anyhow::bail!("Stop or finish the model evaluation before starting a browser task");
        }
        aib_models::validate_settings(&settings)?;
        let key = if aib_models::requires_api_key(&settings) {
            Some(
                aib_models::read_api_key(settings.provider)?
                    .context("Configure a provider API key in model settings first")?,
            )
        } else {
            None
        };
        if selected_tabs.is_empty() && !request.preserve_tabs {
            return state.agent.start(
                request.goal.trim().into(),
                settings,
                key,
                request.start_mode,
                request.compare_options,
                request.mode,
            );
        }
        state.agent.start_scoped(
            request.goal.trim().into(),
            settings,
            key,
            request.start_mode,
            request.compare_options,
            request.mode,
            selected_tabs,
            request.preserve_tabs,
        )
    })();
    with_cors(
        match result {
            Ok(task) => Json(task).into_response(),
            Err(error) => {
                tracing::warn!("Could not start reader task: {error:#}");
                api_error(StatusCode::CONFLICT, &error.to_string())
            }
        },
        &origin,
    )
}

pub(super) async fn findings(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    with_cors(Json(state.agent.findings()).into_response(), &origin)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ApprovalRequest {
    task_id: String,
    approval_id: String,
    allow: bool,
    #[serde(default)]
    allow_all_research: bool,
    #[serde(default)]
    approve_all: bool,
}

pub(super) async fn approve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<ApprovalRequest>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let result = if request.approve_all {
        state.agent.approve_scoped(
            &request.task_id,
            &request.approval_id,
            request.allow,
            request.allow_all_research,
            request.approve_all,
        )
    } else {
        state.agent.approve(
            &request.task_id,
            &request.approval_id,
            request.allow,
            request.allow_all_research,
        )
    };
    control_response(&state.agent, &origin, result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StopRequest {
    task_id: String,
}

pub(super) async fn stop(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<StopRequest>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    control_response(&state.agent, &origin, state.agent.stop(&request.task_id))
}

pub(super) async fn revoke_research(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<StopRequest>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    control_response(
        &state.agent,
        &origin,
        state.agent.revoke_research(&request.task_id),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReplyRequest {
    task_id: String,
    question_id: String,
    message: String,
}

pub(super) async fn reply(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<ReplyRequest>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    control_response(
        &state.agent,
        &origin,
        state
            .agent
            .reply(&request.task_id, &request.question_id, &request.message),
    )
}

fn control_response(service: &Service, origin: &str, result: anyhow::Result<()>) -> Response {
    with_cors(
        match result {
            Ok(()) => Json(service.view()).into_response(),
            Err(error) => {
                tracing::warn!("Task control rejected: {error}");
                api_error(StatusCode::CONFLICT, &error.to_string())
            }
        },
        origin,
    )
}
