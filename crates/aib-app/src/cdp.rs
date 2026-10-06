//! In-process CDP bridge. Only native code can enqueue these requests.

use anyhow::{Context, bail};
use cef::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::atomic::{AtomicI32, Ordering},
    time::Duration,
};
use tokio::sync::oneshot;

pub type Reply = oneshot::Sender<anyhow::Result<JsonValue>>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadTarget {
    pub id: u32,
    pub url: String,
    pub title: String,
    pub document_epoch: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTab {
    pub target: ReadTarget,
    pub unavailable: Option<String>,
}

pub enum SnapshotStep {
    FrameTree,
    World { frame_id: String },
    Read { context_id: i64 },
}

impl SnapshotStep {
    pub fn request(self) -> (&'static str, JsonValue) {
        match self {
            Self::FrameTree => ("Page.getFrameTree", json!({})),
            Self::World { frame_id } => (
                "Page.createIsolatedWorld",
                json!({"frameId":frame_id,"worldName":"aib-comparison-reader"}),
            ),
            Self::Read { context_id } => (
                "Runtime.evaluate",
                json!({"expression":include_str!("perception.js"),"contextId":context_id,"returnByValue":true}),
            ),
        }
    }
}

#[derive(Debug)]
pub struct PageLoading;
impl std::fmt::Display for PageLoading {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The task page is still loading")
    }
}
impl std::error::Error for PageLoading {}

/// The page moved to a URL the native guard approved (same-site redirect or same-document update).
#[derive(Debug)]
pub struct PageMoved(pub String);
impl std::fmt::Display for PageMoved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The task page moved within its approved navigation")
    }
}
impl std::error::Error for PageMoved {}

pub enum HostRequest {
    ReadTabs {
        reply: Reply,
    },
    Snapshot {
        id: i32,
        permit: crate::agent::comparison::ReadPermit,
        step: SnapshotStep,
        reply: Reply,
    },
    ValidateSelected {
        task_id: String,
        target: ReadTarget,
        reply: Reply,
    },
    Workspace {
        task_id: String,
        reply: Reply,
    },
    Inspect {
        tab_id: Option<u32>,
        reply: Reply,
    },
    Ready {
        tab_id: u32,
        expected_url: String,
        reply: Reply,
    },
    Lease {
        tab_id: u32,
        lease_id: String,
        reply: Reply,
    },
    Begin {
        tab_id: u32,
        expected_url: String,
        lease_id: String,
        reply: Reply,
    },
    End {
        tab_id: u32,
        lease_id: String,
    },
    Call {
        id: i32,
        tab_id: u32,
        expected_url: String,
        method: &'static str,
        params: JsonValue,
        reply: Reply,
    },
    Navigate {
        tab_id: u32,
        expected_url: String,
        url: String,
        lease_id: String,
        reply: Reply,
    },
    Operate {
        id: i32,
        tab_id: u32,
        expected_url: String,
        lease_id: String,
        approval_id: String,
        reply: Reply,
    },
    Cancel {
        id: i32,
    },
}

struct Pending {
    browser_id: i32,
    reply: Reply,
    _registration: Registration,
}

thread_local! {
    static PENDING: RefCell<HashMap<i32, Pending>> = RefCell::new(HashMap::new());
}

static NEXT_ID: AtomicI32 = AtomicI32::new(1_000_000);

pub fn cancel(id: i32) {
    let pending = PENDING.with(|p| p.borrow_mut().remove(&id));
    drop(pending);
}

pub fn close(browser_id: i32) {
    let removed = PENDING.with(|p| {
        let mut pending = p.borrow_mut();
        let ids: Vec<_> = pending
            .iter()
            .filter(|(_, v)| v.browser_id == browser_id)
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter()
            .filter_map(|id| pending.remove(&id))
            .collect::<Vec<_>>()
    });
    for item in removed {
        let _ = item
            .reply
            .send(Err(anyhow::anyhow!("The task tab was closed")));
    }
}

pub fn dispatch(browser: Browser, id: i32, method: &str, params: JsonValue, reply: Reply) {
    if reply.is_closed() {
        return;
    }
    let Some(host) = browser.host() else {
        let _ = reply.send(Err(anyhow::anyhow!("The task browser is unavailable")));
        return;
    };
    let mut observer = Observer::new();
    let Some(registration) = host.add_dev_tools_message_observer(Some(&mut observer)) else {
        let _ = reply.send(Err(anyhow::anyhow!("Could not register the CDP observer")));
        return;
    };
    PENDING.with(|p| {
        p.borrow_mut().insert(
            id,
            Pending {
                browser_id: browser.identifier(),
                reply,
                _registration: registration,
            },
        )
    });
    let bytes = json!({"id":id,"method":method,"params":params}).to_string();
    if host.send_dev_tools_message(Some(bytes.as_bytes())) == 0 {
        let pending = PENDING.with(|p| p.borrow_mut().remove(&id));
        if let Some(pending) = pending {
            let _ = pending
                .reply
                .send(Err(anyhow::anyhow!("CEF rejected the CDP request")));
        }
    }
}

wrap_dev_tools_message_observer! {
    struct Observer;

    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self, browser: Option<&mut Browser>, message_id: i32, success: i32, result: Option<&[u8]>) {
            let Some(browser) = browser else { return };
            let pending = PENDING.with(|p| {
                let mut pending = p.borrow_mut();
                if pending.get(&message_id).is_some_and(|v| v.browser_id == browser.identifier()) {
                    pending.remove(&message_id)
                } else { None }
            });
            if let Some(pending) = pending {
                let response = if success == 0 {
                    Err(anyhow::anyhow!("CDP method failed: {}", String::from_utf8_lossy(result.unwrap_or_default())))
                } else {
                    result.filter(|bytes| bytes.len() <= 1_000_000)
                        .context("CDP response is absent or exceeds the safety limit")
                        .and_then(|bytes| serde_json::from_slice(bytes).context("Invalid CDP response"))
                };
                let _ = pending.reply.send(response);
            }
        }
    }
}

struct Cleanup(i32);
impl Drop for Cleanup {
    fn drop(&mut self) {
        crate::bus::send_agent(HostRequest::Cancel { id: self.0 });
    }
}

async fn receive(rx: oneshot::Receiver<anyhow::Result<JsonValue>>) -> anyhow::Result<JsonValue> {
    tokio::time::timeout(Duration::from_secs(15), rx)
        .await
        .context("Timed out waiting for the task webpage")?
        .context("Browser request was interrupted")?
}

pub async fn inspect(tab_id: Option<u32>) -> anyhow::Result<aib_ipc::TabInfo> {
    let (reply, rx) = oneshot::channel();
    crate::bus::send_agent(HostRequest::Inspect { tab_id, reply });
    serde_json::from_value(receive(rx).await?).context("Invalid native tab metadata")
}

pub(crate) async fn call(
    tab_id: u32,
    expected_url: &str,
    method: &'static str,
    params: JsonValue,
) -> anyhow::Result<JsonValue> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let _cleanup = Cleanup(id);
    let (reply, rx) = oneshot::channel();
    crate::bus::send_agent(HostRequest::Call {
        id,
        tab_id,
        expected_url: expected_url.into(),
        method,
        params,
        reply,
    });
    receive(rx).await
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: u32,
    pub name: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub tab_id: u32,
    pub url: String,
    pub title: String,
    pub text: String,
    pub headings: Vec<String>,
    pub links: Vec<Link>,
    pub truncated: bool,
}

pub struct Lease {
    tab_id: u32,
    id: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        crate::bus::send_agent(HostRequest::End {
            tab_id: self.tab_id,
            lease_id: self.id.clone(),
        });
    }
}

pub async fn begin(tab_id: u32, expected_url: &str, lease_id: &str) -> anyhow::Result<Lease> {
    // Construct before awaiting so cancellation also releases an enqueued guard.
    let lease = Lease {
        tab_id,
        id: lease_id.into(),
    };
    let (reply, rx) = oneshot::channel();
    crate::bus::send_agent(HostRequest::Begin {
        tab_id,
        expected_url: expected_url.into(),
        lease_id: lease_id.into(),
        reply,
    });
    receive(rx).await?;
    Ok(lease)
}

pub async fn observe(tab_id: u32, expected_url: &str) -> anyhow::Result<Observation> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut expected = expected_url.to_owned();
        loop {
            expected = wait_ready(tab_id, &expected).await?;
            match read_observation(tab_id, &expected).await {
                Err(error) if error.is::<PageLoading>() || error.is::<PageMoved>() => {
                    tracing::debug!(
                        "Page changed during observation; revalidating its approved URL before reading"
                    );
                }
                result => return result,
            }
        }
    })
    .await
    .context("The approved page did not settle for reading within 30 seconds")?
}

pub async fn read_tabs() -> anyhow::Result<Vec<ReadTab>> {
    let (reply, rx) = oneshot::channel();
    crate::bus::send_agent(HostRequest::ReadTabs { reply });
    serde_json::from_value(receive(rx).await?).context("Invalid native selected-tab listing")
}

pub async fn validate_selected(task_id: &str, target: &ReadTarget) -> anyhow::Result<()> {
    let (reply, rx) = oneshot::channel();
    crate::bus::send_agent(HostRequest::ValidateSelected {
        task_id: task_id.into(),
        target: target.clone(),
        reply,
    });
    receive(rx).await?;
    Ok(())
}

async fn snapshot_call(
    permit: &crate::agent::comparison::ReadPermit,
    step: SnapshotStep,
) -> anyhow::Result<JsonValue> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let _cleanup = Cleanup(id);
    let (reply, rx) = oneshot::channel();
    crate::bus::send_agent(HostRequest::Snapshot {
        id,
        permit: permit.clone(),
        step,
        reply,
    });
    let result = receive(rx).await?;
    crate::bus::selected_read_active(permit)?;
    Ok(result)
}

pub async fn snapshot(
    permit: &crate::agent::comparison::ReadPermit,
) -> anyhow::Result<Observation> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let tree = snapshot_call(permit, SnapshotStep::FrameTree).await?;
        let frame_id = tree
            .pointer("/frameTree/frame/id")
            .and_then(JsonValue::as_str)
            .context("The selected page frame is unavailable")?;
        let world = snapshot_call(
            permit,
            SnapshotStep::World { frame_id: frame_id.into() },
        ).await?;
        let context_id = world.get("executionContextId")
            .and_then(JsonValue::as_i64)
            .context("The selected page reader context is unavailable")?;
        let result = snapshot_call(permit, SnapshotStep::Read { context_id }).await?;
        if result.get("exceptionDetails").is_some() {
            bail!("The selected page reader could not inspect this document");
        }
        let mut value = result.pointer("/result/value")
            .context("The selected page reader returned no observation")?.clone();
        value["tabId"] = json!(permit.target.id);
        let page: Observation = serde_json::from_value(value)
            .context("Invalid selected-page observation")?;
        validate_selected(&permit.task_id, &permit.target).await?;
        if page.url != permit.target.url {
            bail!("A selected page changed during reading. Refresh the tab selection and start a fresh task.");
        }
        Ok(page)
    }).await.context("The selected page reader exceeded its 30-second limit")?
}

pub async fn workspace(task_id: &str) -> anyhow::Result<aib_ipc::TabInfo> {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let (reply, rx) = oneshot::channel();
            crate::bus::send_agent(HostRequest::Workspace {
                task_id: task_id.into(),
                reply,
            });
            match receive(rx).await {
                Ok(value) => {
                    return serde_json::from_value(value)
                        .context("Invalid native research-workspace tab");
                }
                Err(error) if error.is::<PageLoading>() => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(error) => return Err(error),
            }
        }
    })
    .await
    .context("The new research tab did not become ready within 30 seconds")?
}

/// Waits for three settled samples and returns the settled URL. Only moves the native guard
/// approved are adopted; any other URL change fails the task.
pub async fn wait_ready(tab_id: u32, expected_url: &str) -> anyhow::Result<String> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut expected = expected_url.to_owned();
        let mut ready = 0;
        loop {
            let (reply, rx) = oneshot::channel();
            crate::bus::send_agent(HostRequest::Ready {
                tab_id,
                expected_url: expected.clone(),
                reply,
            });
            match receive(rx).await {
                Ok(_) => ready += 1,
                Err(error) if error.is::<PageLoading>() => ready = 0,
                Err(error) => match error.downcast::<PageMoved>() {
                    Ok(PageMoved(url)) => {
                        tracing::debug!("Adopting a guard-approved page move");
                        expected = url;
                        ready = 0;
                    }
                    Err(error) => return Err(error),
                },
            }
            if ready == 3 {
                return Ok(expected);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    })
    .await
    .context("The task page remained loading for 30 seconds")?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseState {
    pub allowed_url: String,
    pub redirect: Option<String>,
    pub followed: Vec<String>,
}

/// Current native guard state: approved URL, a paused cross-site redirect, and same-site
/// redirects followed during this lease (cumulative).
pub async fn lease_state(tab_id: u32, lease_id: &str) -> anyhow::Result<LeaseState> {
    let (reply, rx) = oneshot::channel();
    crate::bus::send_agent(HostRequest::Lease {
        tab_id,
        lease_id: lease_id.into(),
        reply,
    });
    serde_json::from_value(receive(rx).await?).context("Invalid task navigation guard state")
}

async fn read_observation(tab_id: u32, expected_url: &str) -> anyhow::Result<Observation> {
    let context = isolated_world(tab_id, expected_url, "aib-reader").await?;
    let result = call(tab_id, expected_url, "Runtime.evaluate",
        json!({"expression":include_str!("perception.js"),"contextId":context,"returnByValue":true})).await?;
    if result.get("exceptionDetails").is_some() {
        bail!("The page reader could not inspect this document");
    }
    let value = result
        .pointer("/result/value")
        .context("The page reader returned no observation")?;
    let mut value = value.clone();
    value["tabId"] = json!(tab_id);
    let observation: Observation =
        serde_json::from_value(value).context("Invalid page observation")?;
    let tab = inspect(Some(tab_id)).await?;
    if observation.url != expected_url || tab.url != expected_url {
        return Err(PageMoved(tab.url).into());
    }
    if tab.loading {
        return Err(PageLoading.into());
    }
    Ok(observation)
}

pub(crate) async fn isolated_world(
    tab_id: u32,
    expected_url: &str,
    name: &str,
) -> anyhow::Result<i64> {
    let tree = call(tab_id, expected_url, "Page.getFrameTree", json!({})).await?;
    let frame_id = tree
        .pointer("/frameTree/frame/id")
        .and_then(JsonValue::as_str)
        .context("Page frame is unavailable")?;
    let world = call(
        tab_id,
        expected_url,
        "Page.createIsolatedWorld",
        json!({"frameId":frame_id,"worldName":name}),
    )
    .await?;
    world
        .get("executionContextId")
        .and_then(JsonValue::as_i64)
        .context("The isolated webpage context is unavailable")
}

pub async fn operate(
    tab_id: u32,
    expected_url: &str,
    lease_id: &str,
    approval_id: &str,
) -> anyhow::Result<JsonValue> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let _cleanup = Cleanup(id);
    let (reply, rx) = oneshot::channel();
    crate::bus::send_agent(HostRequest::Operate {
        id,
        tab_id,
        expected_url: expected_url.into(),
        lease_id: lease_id.into(),
        approval_id: approval_id.into(),
        reply,
    });
    receive(rx).await
}

pub async fn navigate(
    tab_id: u32,
    expected_url: &str,
    url: &str,
    lease_id: &str,
) -> anyhow::Result<()> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut expected = expected_url.to_owned();
        loop {
            expected = wait_ready(tab_id, &expected).await?;
            match navigate_ready(tab_id, &expected, url, lease_id).await {
                Err(error) if error.is::<PageLoading>() || error.is::<PageMoved>() => {
                    tracing::debug!(
                        "Page changed before navigation; revalidating its approved URL"
                    );
                }
                result => return result,
            }
        }
    })
    .await
    .context("The current page did not settle before approved navigation")?
}

async fn navigate_ready(
    tab_id: u32,
    expected_url: &str,
    url: &str,
    lease_id: &str,
) -> anyhow::Result<()> {
    let (reply, rx) = oneshot::channel();
    crate::bus::send_agent(HostRequest::Navigate {
        tab_id,
        expected_url: expected_url.into(),
        url: url.into(),
        lease_id: lease_id.into(),
        reply,
    });
    receive(rx).await?;
    Ok(())
}
