//! The main window: the embedded console on the local origin.
//!
//! - placement remembered, brought back onto a connected screen (`prefs.rs`);
//! - closing hides (the Dock icon, the shortcut or a second launch bring it
//!   back); only quitting closes it;
//! - no title bar: the console's 46 px top bar is the window's, the traffic
//!   lights float over it, centred on it at every zoom (macOS);
//! - navigation locked on the local origin; web links go to the system
//!   browser, nothing else does;
//! - signing out unloads the console and purges the WebView's data before
//!   `/login` shows (no account's data is left for the next one); only the
//!   device's own preferences (theme, language, text size, layout) are carried
//!   over; a backend other than the one the
//!   data belongs to purges it at launch.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

use crate::config::ShellConfig;
use crate::prefs::{initial_bounds, Area, Bounds, PreferenceStore, MIN_HEIGHT, MIN_WIDTH};

pub const MAIN_WINDOW: &str = "main";
/// The full console.
pub const START_PATH: &str = "/";
pub const LOGIN_PATH: &str = "/login";
const BLANK: &str = "about:blank";
/// The console's frame surface (light #e8e8eb, dark #0d0d0d): painted behind
/// the page so a launch never flashes white in dark mode.
const FRAME_LIGHT: tauri::window::Color = tauri::window::Color(232, 232, 235, 255);
const FRAME_DARK: tauri::window::Color = tauri::window::Color(13, 13, 13, 255);
const ZOOM_STEP: f64 = 1.1;
const ZOOM_RANGE: (f64, f64) = (0.5, 3.0);
/// How long a purge may wait for the console to unload and the store to clear.
const PURGE_STEP_LIMIT: Duration = Duration::from_secs(5);
/// The console's device preferences in its local storage: not account data,
/// kept across a sign-out (`browser/ui-kit` theme, `browser/i18n` locale,
/// `lib/shell/text-size.ts`, `lib/shell/account-layout.ts`, `lib/bots/bot-accent-preference.ts`).
pub const DEVICE_PREFERENCE_KEYS: [&str; 5] = ["openedbot:theme", "openedbot:locale", "openedbot:settings-text-size", "openedbot:accountLayout", "openedbot:bot-accent"];
const MAX_PREFERENCE_LENGTH: usize = 4096;
/// A page the shell serves itself (never the console): it writes the carried
/// preferences into the fresh storage, then opens its target.
pub const RESTORE_PATH: &str = "/__openedbot/restore";
/// An empty page of the local origin, served by the shell: a purge that does
/// not start from the console (a launch on another backend) loads it to read
/// the device preferences from the origin's storage, without running the
/// console and its persister.
pub const EMPTY_PATH: &str = "/__openedbot/empty";
const EMPTY_PAGE: &str = "<!doctype html><meta charset=utf-8><title>openedbot</title>";

/// What a purge carries to the next page.
#[derive(Debug, Default)]
struct Carry {
    preferences: BTreeMap<String, String>,
    target: String,
}

/// The console's theme request (`<html data-theme-mode>`): "system" follows macOS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
    System,
}

/// What the window remembers while the app runs.
pub struct WindowState {
    pub prefs: std::sync::Arc<PreferenceStore>,
    /// Set on quit: closing really closes instead of hiding.
    pub quitting: AtomicBool,
    /// The last page the WebView finished loading (purge waits on it).
    loaded: tokio::sync::watch::Sender<String>,
    /// The page zoom in force: the console's text zoom, or a View menu step.
    zoom: Mutex<f64>,
    carry: Mutex<Carry>,
    /// The last placement seen (moved, resized): saved at quit, when the
    /// window may already be gone or unable to answer.
    placed: Mutex<Option<Bounds>>,
}

impl WindowState {
    pub fn new(prefs: std::sync::Arc<PreferenceStore>) -> Self {
        let zoom = prefs.get().text_zoom;
        Self { prefs, quitting: AtomicBool::new(false), loaded: tokio::sync::watch::channel(String::new()).0, zoom: Mutex::new(zoom), carry: Mutex::new(Carry::default()), placed: Mutex::new(None) }
    }
}

pub fn is_local_origin(url: &Url) -> bool {
    matches!((url.scheme(), url.host_str()), ("tauri", Some("localhost")) | ("http", Some("tauri.localhost")) | ("https", Some("tauri.localhost")))
}

/// What a navigation of the main window may do: stay (local origin, or the
/// blank page of a sign-out), go to the system browser (a web link), or nothing.
#[derive(Debug, PartialEq, Eq)]
pub enum NavigationDecision {
    Allow,
    OpenInBrowser,
    Refuse,
}

pub fn navigation_decision(url: &Url) -> NavigationDecision {
    if is_local_origin(url) || url.as_str() == BLANK {
        NavigationDecision::Allow
    } else if web_link(url) {
        NavigationDecision::OpenInBrowser
    } else {
        NavigationDecision::Refuse
    }
}

/// Only web links go to the OS: `file:`, custom schemes and the like would let
/// a page launch arbitrary local handlers.
pub fn web_link(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http") && url.host_str().is_some() && url.username().is_empty() && url.password().is_none()
}

fn open_in_browser<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    use tauri_plugin_opener::OpenerExt;
    if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
        log::warn!("system browser could not be opened");
    }
}

pub fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW)
}

/// The origin Tauri serves the embedded console from on this platform.
/// Never read back from the WebView: wry panics on a WebView without a URL yet.
fn local_origin() -> Url {
    Url::parse(if cfg!(target_os = "windows") { "http://tauri.localhost/" } else { "tauri://localhost/" }).expect("local origin")
}

/// A path of the local console, or `None` when it would leave the local origin.
pub fn local_url(path_and_query: &str) -> Option<Url> {
    let base = local_origin();
    let target = base.join(path_and_query).ok()?;
    // `Url::origin` is opaque for `tauri:`: compare the parts.
    let parts = |url: &Url| (url.scheme().to_string(), url.host_str().map(str::to_string), url.port());
    (parts(&target) == parts(&base) && is_local_origin(&target)).then_some(target)
}

/// Shows a path of the local console in the main window (not raised).
pub fn navigate<R: Runtime>(app: &AppHandle<R>, path_and_query: &str) {
    let Some(window) = main_window(app) else { return };
    match local_url(path_and_query) {
        Some(target) => {
            let _ = window.navigate(target);
        }
        None => log::warn!("navigation outside the local origin refused"),
    }
}

pub fn show<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = main_window(app) else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = main_window(app) {
        let _ = window.hide();
    }
}

pub fn is_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    main_window(app).is_some_and(|window| window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false))
}

/// Visible means hide, whatever the focus (the shortcut toggles).
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    if is_visible(app) {
        hide(app);
    } else {
        show(app);
    }
}

/// Raised above other apps (sign-in, the browser's return, the popup's `openConsole`).
pub fn bring_to_front<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    show(app);
}

fn logical_areas<R: Runtime>(app: &AppHandle<R>) -> (Vec<Area>, Option<Area>) {
    let area = |monitor: &tauri::Monitor| {
        let scale = monitor.scale_factor();
        let rect = monitor.work_area();
        Area {
            x: f64::from(rect.position.x) / scale,
            y: f64::from(rect.position.y) / scale,
            width: f64::from(rect.size.width) / scale,
            height: f64::from(rect.size.height) / scale,
        }
    };
    let areas = app.available_monitors().unwrap_or_default().iter().map(area).collect();
    let primary = app.primary_monitor().ok().flatten().map(|monitor| area(&monitor));
    (areas, primary)
}

/// The window's placement in logical points, unless minimised or full screen.
fn current_bounds<R: Runtime>(window: &WebviewWindow<R>) -> Option<Bounds> {
    if window.is_minimized().unwrap_or(true) || window.is_fullscreen().unwrap_or(true) {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(Bounds { x: position.x, y: position.y, width: size.width, height: size.height })
}

pub fn remember_bounds<R: Runtime>(window: &WebviewWindow<R>, prefs: &PreferenceStore) {
    if let Some(bounds) = current_bounds(window) {
        prefs.update(|current| current.bounds = Some(bounds));
    }
}

/// Saves the last placement seen: at quit the window is not asked.
pub fn save_placement<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<WindowState>() else { return };
    let placed = *state.placed.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(bounds) = placed {
        state.prefs.update(|current| current.bounds = Some(bounds));
    }
}

/// The values the console reads before its first module runs.
pub fn initialization_script(config: &ShellConfig, version: &str) -> String {
    let shell = serde_json::json!({
        "platform": crate::bridge::Platform::current(),
        "version": version,
        "bridgeVersion": crate::bridge::BRIDGE_VERSION,
    });
    format!(
        "Object.defineProperty(window, '__OPENEDBOT_SHELL__', {{ value: Object.freeze({shell}), writable: false, configurable: false }});\n\
         window.__OPENEDBOT_API_ORIGIN__ = {api};\n\
         window.__OPENEDBOT_PUBLIC_CONSOLE_URL__ = {console};\n",
        api = serde_json::Value::String(config.api_origin.clone()),
        console = serde_json::Value::String(config.public_console_url.clone()),
    )
}

/// Builds the main window. `start`: the console path, or `None` for the blank
/// page a launch purge starts from.
pub fn build<R: Runtime>(app: &AppHandle<R>, config: &ShellConfig, version: &str, start: Option<&str>, visible: bool) -> tauri::Result<WebviewWindow<R>> {
    let state = app.state::<WindowState>();
    let prefs = state.prefs.get();
    let (areas, primary) = logical_areas(app);
    let fallback = Area { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };
    let bounds = initial_bounds(prefs.bounds, &areas, primary.unwrap_or(fallback));
    let url = match start {
        Some(path) => WebviewUrl::App(path.trim_start_matches('/').into()),
        None => WebviewUrl::External(Url::parse(BLANK).expect("blank")),
    };
    let api_origin = config.api_origin.clone();
    let (navigating, opening, loads, serving) = (app.clone(), app.clone(), app.clone(), app.clone());
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, url)
        .title(&app.package_info().name)
        .inner_size(bounds.width, bounds.height)
        .position(bounds.x, bounds.y)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .always_on_top(prefs.always_on_top)
        .visible(visible)
        .background_color(FRAME_LIGHT)
        .initialization_script(initialization_script(config, version))
        .on_web_resource_request(move |request, response| {
            if request.uri().path() == RESTORE_PATH {
                let carry = std::mem::take(&mut *serving.state::<WindowState>().carry.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
                let target = if carry.target.is_empty() { LOGIN_PATH } else { carry.target.as_str() };
                *response.body_mut() = Cow::Owned(restore_page(&carry.preferences, target).into_bytes());
                return;
            }
            if request.uri().path() == EMPTY_PATH {
                *response.body_mut() = Cow::Borrowed(EMPTY_PAGE.as_bytes());
                return;
            }
            let html = response.headers().get("content-type").and_then(|value| value.to_str().ok()).is_some_and(|value| value.starts_with("text/html"));
            if html {
                if let Some(filled) = crate::csp::fill(response.body(), &api_origin) {
                    *response.body_mut() = Cow::Owned(filled);
                }
            }
        })
        .on_navigation(move |url| match navigation_decision(url) {
            NavigationDecision::Allow => true,
            NavigationDecision::OpenInBrowser => {
                open_in_browser(&navigating, url);
                false
            }
            NavigationDecision::Refuse => {
                log::warn!("navigation refused ({})", url.scheme());
                false
            }
        })
        .on_new_window(move |url, _features| {
            if web_link(&url) {
                open_in_browser(&opening, &url);
            } else {
                log::warn!("new window refused ({})", url.scheme());
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Some(state) = loads.try_state::<WindowState>() {
                    publish_zoom(&window, *state.zoom.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
                    let url = payload.url();
                    state.loaded.send_replace(if url.as_str() == BLANK { BLANK.to_string() } else { url.path().to_string() });
                }
            }
        });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        // No tao inset: the shell centres the buttons on the zoomed top bar
        // itself (`macos/traffic_lights.rs`), tao would put its own back.
        .hidden_title(true);
    let window = builder.build()?;
    let zoom = *state.zoom.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = window.set_zoom(zoom);
    place_traffic_lights(&window, zoom, true);
    paint_background(&window);
    Ok(window)
}

fn paint_background<R: Runtime>(window: &WebviewWindow<R>) {
    let color = if window.theme().ok() == Some(tauri::Theme::Dark) { FRAME_DARK } else { FRAME_LIGHT };
    let _ = window.set_background_color(Some(color));
}

/// Window events: closing hides and remembers the placement; a theme change repaints the frame.
pub fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    let app = window.app_handle();
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            let state = app.state::<WindowState>();
            if let Some(main) = main_window(app) {
                remember_bounds(&main, &state.prefs);
            }
            if !state.quitting.load(Ordering::SeqCst) {
                api.prevent_close();
                let _ = window.hide();
                crate::shell::visibility_changed(app);
            }
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            if let Some(bounds) = main_window(app).as_ref().and_then(current_bounds) {
                *app.state::<WindowState>().placed.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(bounds);
            }
        }
        tauri::WindowEvent::Focused(true) => crate::ensure_toggle_shortcut(app),
        tauri::WindowEvent::ThemeChanged(_) => {
            if let Some(main) = main_window(app) {
                paint_background(&main);
            }
        }
        _ => {}
    }
}

/// The console's theme request: the window's appearance follows (traffic lights, frame colour).
pub fn set_theme<R: Runtime>(app: &AppHandle<R>, mode: ThemeMode) {
    let Some(window) = main_window(app) else { return };
    let theme = match mode {
        ThemeMode::Light => Some(tauri::Theme::Light),
        ThemeMode::Dark => Some(tauri::Theme::Dark),
        ThemeMode::System => None,
    };
    let _ = window.set_theme(theme);
    paint_background(&window);
}

fn apply_zoom<R: Runtime>(app: &AppHandle<R>, factor: f64) {
    let state = app.state::<WindowState>();
    *state.zoom.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = factor;
    if let Some(window) = main_window(app) {
        let _ = window.set_zoom(factor);
        publish_zoom(&window, factor);
        place_traffic_lights(&window, factor, false);
    }
}

/// macOS: the traffic lights centred on the top bar, 46 × `zoom` points high;
/// `install` also watches what makes AppKit move them back (window built).
#[cfg(target_os = "macos")]
fn place_traffic_lights<R: Runtime>(window: &WebviewWindow<R>, zoom: f64, install: bool) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(pointer) = target.ns_window() else { return };
        // SAFETY: tao's NSWindow for this window, alive while the window is
        // (built once, only hidden), read on the main thread.
        let Some(ns_window) = (unsafe { pointer.cast::<objc2_app_kit::NSWindow>().as_ref() }) else { return };
        crate::macos::traffic_lights::set_zoom(ns_window, zoom);
        if install {
            crate::macos::traffic_lights::install(ns_window);
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn place_traffic_lights<R: Runtime>(_window: &WebviewWindow<R>, _zoom: f64, _install: bool) {}

/// The zoom in force, for `native-titlebar.css`: the traffic lights are not
/// zoomed, the space kept for them is divided by it. Sent on every change
/// (text size or View menu) and after every load.
fn publish_zoom<R: Runtime>(window: &WebviewWindow<R>, factor: f64) {
    let _ = window.eval(zoom_script(factor));
}

fn zoom_script(factor: f64) -> String {
    format!("document.documentElement.setAttribute('data-native-zoom','');document.documentElement.style.setProperty('--openedbot-native-zoom','{factor}')")
}

/// The console's text size (Réglages › Apparence), already validated: the
/// one place the page zoom is applied and remembered across launches.
pub fn set_text_zoom<R: Runtime>(app: &AppHandle<R>, factor: f64) {
    app.state::<WindowState>().prefs.update(|prefs| prefs.text_zoom = factor);
    apply_zoom(app, factor);
}

/// View › Actual Size: back to the text size's zoom, not to 100 %.
pub fn reset_zoom<R: Runtime>(app: &AppHandle<R>) {
    let factor = app.state::<WindowState>().prefs.get().text_zoom;
    apply_zoom(app, factor);
}

/// View › Zoom In / Zoom Out.
pub fn step_zoom<R: Runtime>(app: &AppHandle<R>, zoom_in: bool) {
    let current = *app.state::<WindowState>().zoom.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let next = if zoom_in { current * ZOOM_STEP } else { current / ZOOM_STEP };
    apply_zoom(app, next.clamp(ZOOM_RANGE.0, ZOOM_RANGE.1));
}

pub fn set_always_on_top<R: Runtime>(app: &AppHandle<R>, value: bool) {
    if let Some(window) = main_window(app) {
        let _ = window.set_always_on_top(value);
    }
    app.state::<WindowState>().prefs.update(|prefs| prefs.always_on_top = value);
}

/// Waits until the WebView finished loading `path` (or the blank page).
async fn loaded<R: Runtime>(app: &AppHandle<R>, path: &str) -> bool {
    let mut loaded = app.state::<WindowState>().loaded.subscribe();
    tokio::time::timeout(PURGE_STEP_LIMIT, loaded.wait_for(|current| current == path)).await.is_ok_and(|waited| waited.is_ok())
}

/// JSON text for a `<script>`: `<` escaped, so no value can close the element.
fn script_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("json").replace('<', "\\u003c")
}

/// The restore page: writes the carried preferences, then replaces itself by
/// `target` (a console path the shell chose).
pub fn restore_page(preferences: &BTreeMap<String, String>, target: &str) -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>openedbot</title><script>\n\
         const entries = {entries};\n\
         try {{ for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); }} catch (error) {{}}\n\
         location.replace({target});\n\
         </script>",
        entries = script_json(preferences),
        target = script_json(&target),
    )
}

/// Keeps the device preferences out of a JSON object read from the page.
pub fn device_preferences(raw: &str) -> BTreeMap<String, String> {
    let parsed: BTreeMap<String, serde_json::Value> = serde_json::from_str(raw).unwrap_or_default();
    parsed
        .into_iter()
        .filter(|(key, _)| DEVICE_PREFERENCE_KEYS.contains(&key.as_str()))
        .filter_map(|(key, value)| value.as_str().filter(|text| text.len() <= MAX_PREFERENCE_LENGTH).map(|text| (key, text.to_string())))
        .collect()
}

/// Reads the device preferences from the console page in the window (macOS).
async fn read_device_preferences<R: Runtime>(window: &WebviewWindow<R>) -> BTreeMap<String, String> {
    #[cfg(target_os = "macos")]
    {
        let keys = serde_json::to_string(&DEVICE_PREFERENCE_KEYS).expect("json");
        let script = format!(
            "(() => {{ try {{ const out = {{}}; for (const key of {keys}) {{ const value = localStorage.getItem(key); if (value !== null) out[key] = value; }} return JSON.stringify(out); }} catch (error) {{ return '{{}}'; }} }})()"
        );
        match tokio::time::timeout(PURGE_STEP_LIMIT, crate::macos::webview_data::evaluate(window, &script)).await {
            Ok(Ok(Some(raw))) => device_preferences(&raw),
            _ => BTreeMap::new(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        BTreeMap::new()
    }
}

/// Purges the WebView's data until it is confirmed (`shell::purge_confirmed`),
/// then opens `target`, with the device preferences the console page held
/// carried over. `false`: nothing opens, the user quit.
pub async fn purge_then_open<R: Runtime>(app: &AppHandle<R>, target: impl FnOnce() -> String) -> bool {
    let Some(window) = main_window(app) else { return false };
    let on_local_page = {
        let state = app.state::<WindowState>();
        let loaded = state.loaded.borrow();
        !loaded.is_empty() && loaded.as_str() != BLANK
    };
    // A launch on another backend starts from the blank page: the storage of
    // the local origin is read from the shell's empty page instead, so the
    // theme and the text size survive a change of backend too.
    let preferences = if on_local_page || open_empty_page(app).await { read_device_preferences(&window).await } else { BTreeMap::new() };
    if !crate::shell::purge_confirmed(app).await {
        return false;
    }
    // Chosen after the purge: a sign-in that landed meanwhile wins.
    let target = target();
    if preferences.is_empty() {
        navigate(app, &target);
    } else {
        *app.state::<WindowState>().carry.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Carry { preferences, target };
        navigate(app, RESTORE_PATH);
    }
    true
}

/// Loads the shell's empty page on the local origin; `false` if it did not load.
async fn open_empty_page<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<WindowState>().loaded.send_replace(String::new());
    navigate(app, EMPTY_PATH);
    let opened = loaded(app, EMPTY_PATH).await;
    if !opened {
        log::warn!("the empty page did not load: device preferences not carried");
    }
    opened
}

/// Unloads the console (so its persister cannot write back), then clears the
/// WebView's whole data store (IndexedDB query cache, local storage, caches)
/// and waits for the store to confirm. `false`: a step failed or timed out,
/// logged; the window stays on `about:blank`.
pub async fn purge_data<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(window) = main_window(app) else { return false };
    // Forget the last load: only this navigation's end counts.
    app.state::<WindowState>().loaded.send_replace(String::new());
    let _ = window.navigate(Url::parse(BLANK).expect("blank"));
    let unloaded = loaded(app, BLANK).await;
    if !unloaded {
        log::warn!("the console did not unload before the purge");
    }
    let cleared = clear_store(&window).await;
    if !cleared {
        log::error!("the WebView data could not be cleared");
    }
    unloaded && cleared
}

#[cfg(target_os = "macos")]
async fn clear_store<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    let receiver = crate::macos::webview_data::clear(window);
    matches!(tokio::time::timeout(PURGE_STEP_LIMIT, receiver).await, Ok(Ok(())))
}

#[cfg(not(target_os = "macos"))]
async fn clear_store<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    // No completion signal from wry here: the next page loads after a pause.
    let cleared = window.clear_all_browsing_data().is_ok();
    tokio::time::sleep(Duration::from_millis(500)).await;
    cleared
}

/// The bridge's window commands, on the main window.
pub struct MainWindowControl<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> crate::bridge::WindowControl for MainWindowControl<R> {
    fn set_theme(&self, mode: ThemeMode) {
        set_theme(&self.0, mode);
    }
    fn set_text_zoom(&self, factor: f64) {
        set_text_zoom(&self.0, factor);
    }
    fn start_drag(&self) {
        if let Some(window) = main_window(&self.0) {
            let _ = window.start_dragging();
        }
    }
    fn toggle_maximize(&self) {
        if let Some(window) = main_window(&self.0) {
            let _ = if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() };
        }
    }
}

#[cfg(test)]
mod tests;
