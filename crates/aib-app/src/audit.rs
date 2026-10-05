//! Bounded, durable task metadata. Never stores goals, page text, responses or full URLs.

use anyhow::{Context, bail};
use chrono::{Datelike, Timelike};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const RETAINED_RUNS: usize = 50;
const MAX_RECORD_BYTES: u64 = 128 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub at: String,
    pub decision: String,
    pub origin: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub id: String,
    pub started_at: String,
    pub updated_at: String,
    pub status: crate::agent::Status,
    pub pages_read: usize,
    pub searches: usize,
    pub options: usize,
    pub privacy: crate::privacy::Summary,
    pub origins: Vec<String>,
    pub events: Vec<Event>,
}

impl Record {
    pub fn from_task(task: &crate::agent::TaskView) -> Self {
        let mut origins: Vec<_> = task
            .sources
            .iter()
            .filter_map(|source| origin(&source.url))
            .chain(
                task.permission_events
                    .iter()
                    .filter_map(|event| event.url.as_deref().and_then(origin)),
            )
            .collect();
        origins.sort();
        origins.dedup();
        Self {
            id: task.id.clone(),
            started_at: task.started_at.clone(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            status: task.status.clone(),
            pages_read: task.pages_read,
            searches: task.searches.len(),
            options: task
                .report
                .as_ref()
                .map_or(0, |report| report.options.len()),
            privacy: task.privacy.clone(),
            origins,
            events: task
                .permission_events
                .iter()
                .map(|event| Event {
                    at: event.at.clone(),
                    decision: crate::privacy::redact(&event.decision).text,
                    origin: event.url.as_deref().and_then(origin),
                })
                .collect(),
        }
    }
}

fn origin(input: &str) -> Option<String> {
    url::Url::parse(input)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .map(|url| url.origin().ascii_serialization())
}

fn valid_id(id: &str) -> bool {
    id.len() == 48
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub struct Store {
    root: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn open() -> anyhow::Result<Self> {
        let root = match std::env::var_os("AIB_AUDIT_DIR") {
            Some(path) => PathBuf::from(path),
            None => dirs::data_local_dir()
                .context("No local application data directory is available")?
                .join("AIBrowser")
                .join("task-audit"),
        };
        Self::at(root)
    }

    fn at(root: PathBuf) -> anyhow::Result<Self> {
        if !root.is_absolute() {
            bail!("Task audit directory must be an absolute path");
        }
        fs::create_dir_all(&root).context("Could not create the private task audit directory")?;
        Ok(Self {
            root,
            lock: Mutex::new(()),
        })
    }

    pub fn path(&self) -> String {
        self.root.display().to_string()
    }

    pub fn write(&self, task: &crate::agent::TaskView) -> anyhow::Result<()> {
        self.write_record(&Record::from_task(task))
    }

    fn write_record(&self, record: &Record) -> anyhow::Result<()> {
        let _guard = self.lock.lock().expect("audit lock poisoned");
        if !valid_id(&record.id) {
            bail!("Invalid task audit ID");
        }
        let bytes = serde_json::to_vec_pretty(record)?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            bail!("Task audit record exceeded its storage bound");
        }
        let path = self.root.join(format!("{}.json", record.id));
        let temporary = self.root.join(format!(
            "{}.{}.tmp",
            record.id,
            crate::server::random_token()
        ));
        let result: anyhow::Result<()> = (|| {
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o600))?;
            }
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &path)?;
            self.prune(&record.id)?;
            Ok(())
        })();
        if result.is_err()
            && temporary.exists()
            && let Err(error) = fs::remove_file(&temporary)
        {
            tracing::warn!("Could not clean up a task audit temporary file: {error}");
        }
        result.context("Could not persist the redacted task audit")
    }

    fn paths(&self) -> anyhow::Result<Vec<PathBuf>> {
        fs::read_dir(&self.root)?
            .filter_map(|entry| match entry {
                Ok(entry)
                    if entry.path().extension().is_some_and(|ext| ext == "json")
                        && entry
                            .path()
                            .file_stem()
                            .and_then(|stem| stem.to_str())
                            .is_some_and(valid_id) =>
                {
                    Some(Ok(entry.path()))
                }
                Ok(_) => None,
                Err(error) => Some(Err(error.into())),
            })
            .collect()
    }

    fn read(path: &Path) -> anyhow::Result<Record> {
        if fs::metadata(path)?.len() > MAX_RECORD_BYTES {
            bail!("An audit record exceeds its storage bound");
        }
        let record: Record = serde_json::from_slice(&fs::read(path)?)?;
        if path.file_stem().and_then(|stem| stem.to_str()) != Some(&record.id) {
            bail!("An audit record has a mismatched ID");
        }
        for timestamp in [&record.started_at, &record.updated_at] {
            let parsed = chrono::DateTime::parse_from_rfc3339(timestamp)
                .context("An audit record has an invalid timestamp")?;
            if !(1970..=9999).contains(&parsed.year()) || parsed.nanosecond() >= 1_000_000_000 {
                bail!("An audit timestamp is outside the supported range");
            }
        }
        for event in &record.events {
            let valid = !event.at.is_empty()
                && event.at.bytes().all(|byte| byte.is_ascii_digit())
                && event
                    .at
                    .parse::<i64>()
                    .ok()
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .is_some();
            if !valid {
                bail!("An audit permission event has an invalid timestamp");
            }
        }
        for value in record.origins.iter().chain(
            record
                .events
                .iter()
                .filter_map(|event| event.origin.as_ref()),
        ) {
            if origin(value).as_deref() != Some(value.as_str()) {
                bail!("An audit record contains more than a site origin");
            }
        }
        Ok(record)
    }

    fn prune(&self, current: &str) -> anyhow::Result<()> {
        let mut records: Vec<_> = self
            .paths()?
            .into_iter()
            .map(|path| Ok((Self::read(&path)?, path)))
            .collect::<anyhow::Result<_>>()?;
        records.sort_by(|(a, _), (b, _)| {
            b.started_at
                .cmp(&a.started_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        let mut retained = 0;
        for (record, path) in records {
            if record.id == current {
                continue;
            }
            retained += 1;
            if retained >= RETAINED_RUNS {
                fs::remove_file(path).context("Could not enforce task audit retention")?;
            }
        }
        Ok(())
    }

    pub fn records(&self) -> anyhow::Result<Vec<Record>> {
        let _guard = self.lock.lock().expect("audit lock poisoned");
        let mut records: Vec<_> = self
            .paths()?
            .iter()
            .map(|path| Self::read(path))
            .collect::<anyhow::Result<_>>()?;
        records.sort_by(|a, b| {
            b.started_at
                .cmp(&a.started_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok(records)
    }

    pub fn clear(&self) -> anyhow::Result<()> {
        let _guard = self.lock.lock().expect("audit lock poisoned");
        for path in self.paths()? {
            fs::remove_file(path).context("Could not delete a task audit record")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(index: usize) -> Record {
        Record {
            id: format!("{index:048x}"),
            started_at: format!("2026-10-05T09:{index:02}:00Z"),
            updated_at: "2026-10-05T10:00:00Z".into(),
            status: crate::agent::Status::Completed,
            pages_read: 2,
            searches: 1,
            options: 3,
            privacy: crate::privacy::Summary {
                redactions: 4,
                blocked_links: 1,
            },
            origins: vec!["https://site.test".into()],
            events: vec![],
        }
    }

    #[test]
    fn records_persist_across_store_instances_and_retention_is_bounded() {
        let root = std::env::temp_dir().join(format!(
            "rovuka-audit-test-{}",
            crate::server::random_token()
        ));
        let store = Store::at(root.clone()).unwrap();
        for index in 0..55 {
            store.write_record(&record(index)).unwrap();
        }
        let reopened = Store::at(root.clone()).unwrap();
        let records = reopened.records().unwrap();
        assert_eq!(records.len(), RETAINED_RUNS);
        assert_eq!(records[0].id, record(54).id);
        assert_eq!(records.last().unwrap().id, record(5).id);
        assert!(
            fs::read_dir(&root)
                .unwrap()
                .all(|entry| entry.unwrap().path().extension().unwrap() == "json")
        );
        fs::write(root.join("unrelated.json"), b"keep me").unwrap();
        reopened.clear().unwrap();
        assert!(reopened.records().unwrap().is_empty());
        assert!(root.join("unrelated.json").exists());
        fs::remove_file(root.join("unrelated.json")).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn audit_drops_url_credentials_paths_queries_and_fragments() {
        assert_eq!(
            origin("https://site.test/private/person?q=personal#secret"),
            Some("https://site.test".into())
        );
        assert!(origin("not a URL").is_none());
        assert!(!valid_id("../other-file"));
    }

    #[test]
    fn corrupt_and_unwritable_audits_fail_explicitly() {
        let root = std::env::temp_dir().join(format!(
            "rovuka-audit-failure-{}",
            crate::server::random_token()
        ));
        let store = Store::at(root.clone()).unwrap();
        let corrupt = root.join(format!("{}.json", record(1).id));
        fs::write(&corrupt, b"not json").unwrap();
        assert!(store.records().is_err());
        store.clear().unwrap();
        fs::remove_dir(&root).unwrap();
        assert!(store.write_record(&record(2)).is_err());
    }

    #[test]
    fn malformed_timestamps_and_nonorigin_urls_are_rejected_before_rendering() {
        let root = std::env::temp_dir().join(format!(
            "rovuka-audit-metadata-{}",
            crate::server::random_token()
        ));
        let store = Store::at(root.clone()).unwrap();
        let path = root.join(format!("{}.json", record(1).id));
        let mut invalid = record(1);
        invalid.started_at = "not a date".into();
        fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(store.records().is_err());
        for at in ["not a number", "8640000000000001"] {
            let mut invalid = record(1);
            invalid.events.push(Event {
                at: at.into(),
                decision: "Navigation approved".into(),
                origin: None,
            });
            fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(store.records().is_err());
        }
        let mut invalid = record(1);
        invalid.origins = vec!["https://site.test/private?q=personal".into()];
        fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(store.records().is_err());
        store.clear().unwrap();
        fs::remove_dir(root).unwrap();
    }
}
