use anyhow::{Context, bail};
use futures_util::StreamExt;
use serde_json::Value;
use std::time::{Duration, Instant};

pub struct Reply {
    pub text: String,
    pub elapsed_ms: u64,
    pub structured: bool,
    pub fallback: Option<String>,
}

pub async fn request(
    settings: &aib_models::ModelSettings,
    key: Option<&str>,
    instruction: &str,
    input: &str,
    name: &str,
    schema: &Value,
    limit: usize,
) -> anyhow::Result<Reply> {
    let started = Instant::now();
    let reply = tokio::time::timeout(Duration::from_secs(90), async {
        let response = aib_models::structured_stream(
            settings,
            key,
            instruction,
            input,
            &aib_models::OutputSchema { name, schema },
        )
        .await?;
        let mut stream = response.stream;
        let mut text = String::new();
        while let Some(delta) = stream.next().await {
            text.push_str(&delta?);
            if text.len() > limit {
                bail!("The structured {name} response exceeded its {limit}-byte limit");
            }
        }
        Ok::<_, anyhow::Error>((text, response.structured, response.fallback))
    })
    .await
    .context("The structured model request timed out after 90 seconds")??;
    if let Some(fallback) = &reply.2 {
        tracing::warn!(
            protocol = name,
            "{fallback}; continuing without a response schema"
        );
    }
    Ok(Reply {
        text: crate::privacy::redact(&reply.0).text,
        elapsed_ms: started.elapsed().as_millis() as u64,
        structured: reply.1,
        fallback: reply.2,
    })
}
