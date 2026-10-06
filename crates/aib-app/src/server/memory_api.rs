use super::*;

fn store(state: &AppState) -> anyhow::Result<Arc<crate::memory::Store>> {
    state
        .memory
        .as_ref()
        .cloned()
        .map_err(|error| anyhow::anyhow!("Local memory is unavailable: {error}"))
}

fn response<T: serde::Serialize>(result: anyhow::Result<T>, origin: &str) -> Response {
    let mut response = match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            tracing::warn!("Local memory operation did not finish: {error:#}");
            let status = if error.is::<rusqlite::Error>() || error.is::<std::io::Error>() {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::CONFLICT
            };
            api_error(status, &format!("{error:#}"))
        }
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    with_cors(response, origin)
}

async fn blocking<T: serde::Serialize + Send + 'static>(
    state: &AppState,
    origin: &str,
    operation: impl FnOnce(Arc<crate::memory::Store>) -> anyhow::Result<T> + Send + 'static,
) -> Response {
    let result = match store(state) {
        Ok(store) => tokio::task::spawn_blocking(move || operation(store))
            .await
            .map_err(|error| anyhow::anyhow!("The local memory worker could not finish: {error}"))
            .and_then(|result| result),
        Err(error) => Err(error),
    };
    response(result, origin)
}

pub(super) async fn overview(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    blocking(&state, &origin, |store| store.overview()).await
}

pub(super) async fn configure(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(config): Json<crate::memory::Config>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    blocking(&state, &origin, move |store| {
        store.configure(config)?;
        store.overview()
    })
    .await
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Search {
    #[serde(default)]
    q: String,
    #[serde(default = "all")]
    kind: String,
    #[serde(default)]
    after: String,
    #[serde(default)]
    offset: u32,
}
fn all() -> String {
    "all".into()
}

pub(super) async fn search(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<Search>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    blocking(&state, &origin, move |store| {
        store.search(&query.q, &query.kind, &query.after, query.offset)
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ItemId {
    id: i64,
}

pub(super) async fn item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ItemId>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    blocking(&state, &origin, move |store| store.item(query.id)).await
}

pub(super) async fn preferences(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    blocking(&state, &origin, |store| store.preferences()).await
}

pub(super) async fn save_preferences(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(preferences): Json<crate::memory::Preferences>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    blocking(&state, &origin, move |store| {
        store.save_preferences(preferences)?;
        store.preferences()
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PageId {
    tab_id: u32,
}

pub(super) async fn save_page(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<PageId>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let result = async {
        let store = store(&state)?;
        let tab = crate::cdp::read_tabs()
            .await?
            .into_iter()
            .find(|tab| tab.target.id == request.tab_id)
            .context("The page tab was closed")?;
        if let Some(reason) = tab.unavailable {
            anyhow::bail!("{reason}");
        }
        let permit = store.permit(tab.target, None)?;
        let page = crate::cdp::memory_snapshot(&permit).await?;
        let id = tokio::task::spawn_blocking(move || store.save_page(&permit, page)).await??;
        Ok(json!({"saved":true,"id":id}))
    }
    .await;
    response(result, &origin)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskId {
    task_id: String,
}

pub(super) async fn save_research(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<TaskId>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let task = state
        .agent
        .view()
        .filter(|task| task.id == request.task_id)
        .or_else(|| {
            state
                .agent
                .findings()
                .filter(|task| task.id == request.task_id)
        });
    let Some(task) = task else {
        return response::<serde_json::Value>(
            Err(anyhow::anyhow!(
                "These findings are no longer available; save completed results before starting another research task"
            )),
            &origin,
        );
    };
    blocking(&state, &origin, move |store| {
        Ok(json!({"saved":true,"id":store.save_research(&task)?}))
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Forget {
    id: i64,
    confirm: bool,
}

pub(super) async fn forget(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Forget>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    blocking(&state, &origin, move |store| {
        if !request.confirm {
            anyhow::bail!("Explicitly confirm forgetting this memory item");
        }
        store.forget(Some(request.id), false)?;
        Ok(json!({"forgotten":true}))
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Clear {
    confirm: bool,
}

pub(super) async fn clear(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Clear>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    blocking(&state, &origin, move |store| {
        if !request.confirm {
            anyhow::bail!("Explicitly confirm clearing all saved pages, research and preferences");
        }
        store.forget(None, true)?;
        Ok(json!({"cleared":true}))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Preview {
    ids: Vec<i64>,
    include_preferences: bool,
}

pub(super) async fn preview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Preview>,
) -> Response {
    let Some(origin) = api_authorized(&headers, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    blocking(&state, &origin, move |store| {
        store.preview(&request.ids, request.include_preferences)
    })
    .await
}
