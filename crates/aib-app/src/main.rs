#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bus;
mod host;
mod server;

use cef::*;

fn main() -> anyhow::Result<()> {
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    let args = args::Args::new();
    let Some(cmd_line) = args.as_cmd_line() else {
        anyhow::bail!("failed to parse command line");
    };

    // Renderer/GPU/utility subprocesses re-enter here and exit inside execute_process.
    let type_switch = CefString::from("type");
    let is_browser_process = cmd_line.has_switch(Some(&type_switch)) == 0;
    let mut app = host::AibApp::new();
    let code = execute_process(Some(args.as_main_args()), Some(&mut app), std::ptr::null_mut());
    if !is_browser_process {
        std::process::exit(code);
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let server = server::start()?;
    let start_url = {
        let v = CefString::from(&cmd_line.switch_value(Some(&CefString::from("url")))).to_string();
        (!v.is_empty()).then_some(v)
    };
    host::configure(server.ui_url.clone(), start_url);

    let profile_dir = dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("AIBrowser")
        .join("Profile");
    std::fs::create_dir_all(&profile_dir)?;
    let profile = CefString::from(profile_dir.to_string_lossy().as_ref());

    let settings = Settings {
        no_sandbox: 1,
        root_cache_path: profile.clone(),
        cache_path: profile,
        persist_session_cookies: 1,
        background_color: 0xFF1E1F22,
        log_severity: LogSeverity::WARNING,
        ..Default::default()
    };
    if initialize(Some(args.as_main_args()), Some(&settings), Some(&mut app), std::ptr::null_mut()) != 1 {
        anyhow::bail!("CEF initialization failed (is another instance using the same profile?)");
    }

    run_message_loop();
    shutdown();
    Ok(())
}
