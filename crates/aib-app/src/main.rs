#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod audit;
mod bus;
mod cdp;
mod diagnostics;
mod evaluations;
mod evidence;
mod graphics;
mod host;
mod navigation;
mod offers;
mod policy;
mod privacy;
mod protocol;
mod server;
mod structured;
mod verification;

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
    let graphics_mode = if is_browser_process {
        let value =
            CefString::from(&cmd_line.switch_value(Some(&CefString::from("graphics")))).to_string();
        Some(graphics::resolve(&value)?)
    } else {
        None
    };
    let mut app = host::AibApp::new();
    let code = execute_process(
        Some(args.as_main_args()),
        Some(&mut app),
        std::ptr::null_mut(),
    );
    if !is_browser_process {
        std::process::exit(code);
    }

    diagnostics::init();

    if graphics_mode == Some(graphics::GraphicsMode::Software) {
        tracing::warn!(
            "Software browser rendering enabled for graphics compatibility. \
             Use --graphics=gpu to test hardware acceleration. This does not control local model acceleration."
        );
    } else {
        tracing::info!("Hardware browser rendering enabled");
    }
    let mut server = server::start()?;
    let start_url = {
        let v = CefString::from(&cmd_line.switch_value(Some(&CefString::from("url")))).to_string();
        (!v.is_empty()).then_some(v)
    };
    host::configure(server.ui_url.clone(), start_url);

    let profile_override =
        CefString::from(&cmd_line.switch_value(Some(&CefString::from("profile-dir")))).to_string();
    let profile_dir = if profile_override.is_empty() {
        dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("AIBrowser")
            .join("Profile")
    } else {
        let path = std::path::PathBuf::from(profile_override);
        if !path.is_absolute() {
            anyhow::bail!("--profile-dir must be an absolute path");
        }
        path
    };
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
    if initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        std::ptr::null_mut(),
    ) != 1
    {
        anyhow::bail!("CEF initialization failed (is another instance using the same profile?)");
    }

    run_message_loop();
    tracing::info!("Browser message loop ended");
    let server_shutdown = server.shutdown();
    shutdown();
    tracing::info!("CEF shutdown finished");
    server_shutdown?;
    Ok(())
}
