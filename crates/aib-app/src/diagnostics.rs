//! Local diagnostics: a persistent log file and the identity of the running build.
//!
//! The log stays on this machine. It contains task goals, URLs, guard decisions and rejected
//! model responses so failures can be investigated after the fact; it never contains API keys.

use std::{fs, path::PathBuf, sync::Mutex, sync::OnceLock};
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

const LOG_FILE: &str = "rovuka.log";
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

static LOG_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static BUILD: OnceLock<String> = OnceLock::new();

fn log_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("AIB_LOG_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("AIBrowser")
        .join("logs")
}

fn open_log() -> std::io::Result<(PathBuf, fs::File)> {
    let dir = log_dir();
    fs::create_dir_all(&dir)?;
    let path = dir.join(LOG_FILE);
    if fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_LOG_BYTES) {
        // Keep one previous generation; a failed rotation just keeps appending.
        let _ = fs::rename(&path, dir.join(format!("{LOG_FILE}.1")));
    }
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    Ok((path, file))
}

/// Installs console + file logging. Console-only if the log file cannot be opened.
pub fn init() {
    let filter = || EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    match open_log() {
        Ok((path, file)) => {
            tracing_subscriber::registry()
                .with(filter())
                .with(fmt::layer())
                .with(fmt::layer().with_ansi(false).with_writer(Mutex::new(file)))
                .init();
            let _ = LOG_PATH.set(Some(path));
        }
        Err(error) => {
            tracing_subscriber::registry()
                .with(filter())
                .with(fmt::layer())
                .init();
            let _ = LOG_PATH.set(None);
            tracing::warn!("Diagnostic log file unavailable: {error}");
        }
    }
    tracing::info!(
        build = %build(),
        log = ?log_path(),
        "Rovuka browser process starting"
    );
}

pub fn log_path() -> Option<String> {
    LOG_PATH
        .get()
        .and_then(|path| path.as_ref())
        .map(|path| path.display().to_string())
}

/// Version plus the executable's path and modification time, so a stale binary is obvious.
pub fn build() -> String {
    BUILD
        .get_or_init(|| {
            let exe = std::env::current_exe().ok();
            let built = exe
                .as_ref()
                .and_then(|path| fs::metadata(path).ok())
                .and_then(|meta| meta.modified().ok())
                .map(|time| {
                    chrono::DateTime::<chrono::Local>::from(time)
                        .format("%Y-%m-%d %H:%M:%S")
                        .to_string()
                })
                .unwrap_or_else(|| "unknown time".into());
            format!(
                "{} built {built} ({})",
                env!("CARGO_PKG_VERSION"),
                exe.map(|path| path.display().to_string())
                    .unwrap_or_else(|| "unknown executable".into())
            )
        })
        .clone()
}

/// Origin and path only, for user-facing messages; full URLs go to the log.
pub fn short_url(url: &str) -> String {
    url::Url::parse(url)
        .map(|parsed| format!("{}{}", parsed.origin().ascii_serialization(), parsed.path()))
        .unwrap_or_else(|_| "an invalid URL".into())
}
