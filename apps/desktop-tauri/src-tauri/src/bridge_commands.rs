// The custom commands of the native bridge, included by `build.rs` (which
// declares them in `AppManifest::commands`, making each one deny-by-default
// with an `allow-<name>` permission) and by `bridge.rs` (tests compare it with
// the registered commands and with `capabilities/main.json`).
pub const COMMANDS: &[&str] = &[
    "read_access_token",
    "refresh",
    "open_external",
    "sign_out",
    "request_email_code",
    "verify_email_code",
    "start_google",
    "cancel_sign_in",
    "signin_state",
    "shell_info",
    "set_theme",
    "set_text_zoom",
    "start_window_drag",
    "toggle_maximize",
    "report_diagnostic",
    "update_state",
    "check_for_updates",
    "install_update",
    "report_update_required",
    "report_runs_in_progress",
    "set_update_auto_install",
    "notch_state",
    "set_notch_mode",
    "play_notch_demo",
];
