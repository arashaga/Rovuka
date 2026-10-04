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

pub enum HostRequest {
    Inspect {
        tab_id: Option<u32>,
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

async fn call(
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
    let tree = call(tab_id, expected_url, "Page.getFrameTree", json!({})).await?;
    let frame_id = tree
        .pointer("/frameTree/frame/id")
        .and_then(JsonValue::as_str)
        .context("Page frame is unavailable")?;
    let world = call(
        tab_id,
        expected_url,
        "Page.createIsolatedWorld",
        json!({"frameId":frame_id,"worldName":"aib-reader"}),
    )
    .await?;
    let context = world
        .get("executionContextId")
        .and_then(JsonValue::as_i64)
        .context("Reader context is unavailable")?;
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
    if observation.url != expected_url || tab.url != expected_url || tab.loading {
        bail!("The page changed during reading. Start a new task after it finishes loading.");
    }
    Ok(observation)
}

pub async fn navigate(
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
