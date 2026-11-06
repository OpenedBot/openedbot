//! What ties the parts together: the
//! session's events move the window and the popup, the display mode (window,
//! popup or both) starts and stops the popup and hides the Dock icon, the
//! Google door gets its browser and loopback listener.

use std::future::Future;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;
use url::Url;

use crate::auth::{AuthEvents, GoogleSteps, SignedOutReason, SigninState, StepFailed};
use crate::bridge::{Auth, Shell, SigninStateChanged, UpdateMenuAction, UpdateMenuChosen};
use crate::update_state::{UpdateState, UpdateStatus};
use crate::callback::Loopback;
use crate::popup::{GiveUp, HostToPopup, PopupEvents, PopupHost};
use crate::prefs::DisplayMode;
use crate::window::{self, WindowState};

pub struct PopupHandle(pub Arc<PopupHost<Auth>>);

/// The popup is the native openedbot Notch, macOS only: elsewhere the mode is always the window.
pub const POPUP_SUPPORTED: bool = cfg!(target_os = "macos");

/// The display mode in force: the user's choice, else the configuration's default.
pub fn display_mode<R: Runtime>(app: &AppHandle<R>) -> DisplayMode {
    if !POPUP_SUPPORTED {
        return DisplayMode::Window;
    }
    let configured = app.try_state::<Shell>().is_some_and(|shell| shell.config.popup);
    let fallback = if configured { DisplayMode::Both } else { DisplayMode::Window };
    // No window state: the configuration was refused and nothing started.
    app.try_state::<WindowState>().and_then(|state| state.prefs.get().display_mode).unwrap_or(fallback)
}

fn signed_in<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<Shell>().is_some_and(|shell| shell.auth.is_signed_in())
}

/// Popup-only mode: no Dock icon while the window is hidden, back as soon as it shows.
pub fn visibility_changed<R: Runtime>(app: &AppHandle<R>) {
    if app.try_state::<WindowState>().is_none() {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let hidden_dock = display_mode(app) == DisplayMode::Popup && !window::is_visible(app);
        let _ = app.set_dock_visibility(!hidden_dock);
    }
    refresh_menus(app);
}

/// The Dock menu follows the app state (macOS).
pub fn refresh_menus<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        let state = crate::macos::dock::DockState {
            display_mode: display_mode(app),
            popup_available: app.try_state::<PopupHandle>().is_some_and(|popup| popup.0.available()),
            always_on_top: app.state::<WindowState>().prefs.get().always_on_top,
            signed_in: signed_in(app),
        };
        crate::macos::dock::refresh(app, state);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn set_display_mode<R: Runtime>(app: &AppHandle<R>, mode: DisplayMode) {
    let mode = if POPUP_SUPPORTED { mode } else { DisplayMode::Window };
    app.state::<WindowState>().prefs.update(|prefs| prefs.display_mode = Some(mode));
    if let Some(popup) = app.try_state::<PopupHandle>() {
        if mode == DisplayMode::Window {
            popup.0.stop();
        } else {
            popup.0.start();
        }
    }
    // Popup only hides the window, unless there is no session to show in the popup.
    if mode == DisplayMode::Popup && signed_in(app) {
        window::hide(app);
    } else {
        window::show(app);
    }
    visibility_changed(app);
}

pub fn set_always_on_top<R: Runtime>(app: &AppHandle<R>, value: bool) {
    window::set_always_on_top(app, value);
    refresh_menus(app);
}

/// Signs out from the Dock menu: a revocation that failed is said, the local session is gone anyway.
pub fn sign_out_from_menu<R: Runtime>(app: &AppHandle<R>) {
    let Some(shell) = app.try_state::<Shell>() else { return };
    let auth = shell.auth.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if auth.sign_out().await.revocation_failed {
            warn(
                &app,
                "Déconnexion incomplète",
                "Cette application a oublié la session, mais le serveur n’a pas pu la révoquer. Révoquez-la depuis Réglages → Sécurité sur un autre appareil.",
            );
        }
    });
}

/// A dialog shown as a sheet of the main window, brought forward first.
/// Without a parent, rfd goes through a system alert (`CFUserNotification`,
/// another process) that macOS showed late and off our window: observed
/// with the update prompt.
pub fn dialog<R: Runtime>(app: &AppHandle<R>, message: impl Into<String>) -> tauri_plugin_dialog::MessageDialogBuilder<R> {
    use tauri_plugin_dialog::DialogExt;
    window::bring_to_front(app);
    visibility_changed(app);
    let builder = app.dialog().message(message);
    match window::main_window(app) {
        Some(main) => builder.parent(&main),
        None => builder,
    }
}

/// A non-blocking warning dialog.
pub fn warn<R: Runtime>(app: &AppHandle<R>, title: &str, detail: &str) {
    dialog(app, detail).title(title).kind(tauri_plugin_dialog::MessageDialogKind::Warning).show(|_| {});
}

/// One purge at a time: a sign-out, a lost session and the startup purge
/// share the load signal and the carried preferences.
#[derive(Default)]
pub struct Purging(tokio::sync::Mutex<()>);

/// A purge runs: the page it opens once done is chosen then.
pub fn purging<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<Purging>().is_some_and(|purging| purging.0.try_lock().is_err())
}

/// Purges, then opens the page `target` picks once the purge is over (the
/// session may have changed meanwhile). A request made while a purge runs
/// joins it (`None`): that purge already ends on the page the session
/// calls for. `Some(false)`: the user quit.
pub async fn purge_and_open<R: Runtime>(app: &AppHandle<R>, target: impl FnOnce() -> String) -> Option<bool> {
    let purging = app.state::<Purging>();
    let Ok(_running) = purging.0.try_lock() else {
        log::info!("a WebView purge already runs: this request joins it");
        return None;
    };
    Some(window::purge_then_open(app, target).await)
}

/// Purges tried in a row before the user is asked.
const PURGE_ATTEMPTS: u32 = 2;

/// Tries `purge` until it succeeds, asking `retry` after each series of
/// failed attempts; `false` once the user declines.
pub async fn until_purged<Purge, Retry>(mut purge: impl FnMut() -> Purge, mut retry: impl FnMut() -> Retry) -> bool
where
    Purge: Future<Output = bool>,
    Retry: Future<Output = bool>,
{
    loop {
        for _ in 0..PURGE_ATTEMPTS {
            if purge().await {
                return true;
            }
        }
        if !retry().await {
            return false;
        }
    }
}

/// Clears the WebView's data and answers `true` only once the store has
/// confirmed it: no console page ever loads over another session's or
/// another backend's data. The data's origin is forgotten first, so a purge
/// cut short (quit, crash) runs again at the next launch. `false`: the user
/// chose to quit, the app is exiting.
pub async fn purge_confirmed<R: Runtime>(app: &AppHandle<R>) -> bool {
    let prefs = &app.state::<WindowState>().prefs;
    prefs.update(|prefs| prefs.data_origin = None);
    if !until_purged(|| window::purge_data(app), || ask_retry_purge(app)).await {
        log::error!("WebView data not cleared, the user quit");
        app.exit(0);
        return false;
    }
    if let Some(shell) = app.try_state::<Shell>() {
        let origin = shell.config.api_origin.clone();
        prefs.update(|prefs| prefs.data_origin = Some(origin));
    }
    true
}

async fn ask_retry_purge<R: Runtime>(app: &AppHandle<R>) -> bool {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    let (answer, answered) = tokio::sync::oneshot::channel();
    dialog(
        app,
        format!("{} n’a pas pu effacer les données de la session précédente. La console reste fermée tant qu’elles sont là. Réessayez, ou quittez : l’effacement sera repris au prochain lancement.", app.package_info().name))
        .title("Effacement des données impossible")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom("Réessayer".into(), "Quitter".into()))
        .show(move |retry| {
            let _ = answer.send(retry);
        });
    answered.await.unwrap_or(false)
}

pub struct ShellEvents<R: Runtime> {
    pub app: AppHandle<R>,
}

impl<R: Runtime> ShellEvents<R> {
    fn popup(&self, message: HostToPopup) {
        if let Some(popup) = self.app.try_state::<PopupHandle>() {
            popup.0.notify(message);
        }
    }
}

impl<R: Runtime> AuthEvents for ShellEvents<R> {
    fn signin_state(&self, state: &SigninState) {
        if let Err(error) = SigninStateChanged(state.clone()).emit(&self.app) {
            log::warn!("sign-in state not delivered ({error})");
        }
    }

    fn signed_in(&self) {
        log::info!("signed in");
        // A purge under way opens the console itself, once the store is clear.
        if !purging(&self.app) {
            window::navigate(&self.app, window::START_PATH);
        }
        window::bring_to_front(&self.app);
        self.popup(HostToPopup::SignedIn);
        visibility_changed(&self.app);
    }

    /// Unloads the console and purges the WebView's data before `/login`
    /// shows: the next account never meets this one's cache.
    fn signed_out(&self, reason: SignedOutReason) {
        log::info!("signed out ({reason:?})");
        self.popup(HostToPopup::SignedOut);
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let chooser = app.clone();
            let purged = purge_and_open(&app, move || {
                // A sign-in that landed meanwhile wins over this sign-out.
                match (signed_in(&chooser), reason) {
                    (true, _) => window::START_PATH,
                    (false, SignedOutReason::SessionLost) => "/login?reason=session-lost",
                    (false, SignedOutReason::SignedOut) => window::LOGIN_PATH,
                }
                .to_string()
            })
            .await;
            if purged != Some(true) {
                return;
            }
            log::info!("WebView data purged after sign-out");
            // Signing in happens in the window, whatever the display mode.
            if !window::is_visible(&app) {
                window::bring_to_front(&app);
            }
            visibility_changed(&app);
        });
    }
}

pub struct ShellPopupEvents<R: Runtime> {
    pub app: AppHandle<R>,
}

fn give_up_message(reason: &GiveUp) -> String {
    match reason {
        GiveUp::Missing => "openedbot notch n’est pas embarquée dans cette version d’openedbot. openedbot repasse en mode Fenêtre.".into(),
        GiveUp::Crashing(failures) => format!("La popup s’est arrêtée {failures} fois de suite. openedbot repasse en mode Fenêtre."),
        GiveUp::Protocol(0) => "Cette version d’openedbot notch est antérieure au mode popup d’openedbot : reconstruisez-la (make bundle dans openedbot-notch). openedbot repasse en mode Fenêtre.".into(),
        GiveUp::Protocol(version) => format!("Cette popup parle une autre version du protocole ({version}). openedbot repasse en mode Fenêtre."),
        GiveUp::Fatal(code) if code == "STANDALONE_RUNNING" => "openedbot notch tourne déjà seule. Quittez-la, puis choisissez à nouveau Popup dans le menu du Dock.".into(),
        GiveUp::Fatal(code) => format!("La popup a refusé de démarrer ({code}). openedbot repasse en mode Fenêtre."),
    }
}

impl<R: Runtime> PopupEvents for ShellPopupEvents<R> {
    fn open_console(&self, path: &str) {
        // During a purge the page stays blank: the purge opens the console once the store is clear.
        if signed_in(&self.app) && !purging(&self.app) {
            window::navigate(&self.app, path);
        }
        window::bring_to_front(&self.app);
        visibility_changed(&self.app);
    }

    fn gave_up(&self, reason: &GiveUp) {
        log::warn!("popup unavailable ({reason:?}), back to the window");
        set_display_mode(&self.app, DisplayMode::Window);
        warn(&self.app, "Popup désactivée", &give_up_message(reason));
    }

    fn user_closed(&self) {
        set_display_mode(&self.app, DisplayMode::Window);
    }

    fn greeting(&self) -> Vec<HostToPopup> {
        self.app.try_state::<Arc<UpdateStatus>>().map(|status| vec![update_line(&status.get())]).unwrap_or_default()
    }
}

/// The notch's line for an update state.
pub fn update_line(state: &UpdateState) -> HostToPopup {
    let (status, version) = state.summary();
    HostToPopup::UpdateState { status, version: version.filter(|version| notch_version(version)) }
}

/// The notch takes a version of digits and dots only (`HostProtocol.isVersion`,
/// 1 to 32 characters) and drops the whole line otherwise: a test build
/// (`1.1.1-test`) is announced without its number, so its dot still shows.
fn notch_version(version: &str) -> bool {
    (1..=32).contains(&version.len()) && version.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.')
}

/// The app menu's update item: with an update ready, the console asks the
/// user to restart (never a restart from here); otherwise a check starts and
/// the console opens Settings › Mises à jour.
pub fn update_menu_chosen<R: Runtime>(app: &AppHandle<R>) {
    let Some(status) = app.try_state::<Arc<UpdateStatus>>() else { return };
    let action = if status.get().ready_version().is_some() {
        UpdateMenuAction::Install
    } else {
        if let Some(updates) = app.try_state::<crate::bridge::Updates>() {
            let control = updates.0.clone();
            tauri::async_runtime::spawn(async move { control.check().await });
        }
        UpdateMenuAction::Check
    };
    window::bring_to_front(app);
    visibility_changed(app);
    if let Err(error) = (UpdateMenuChosen { action }).emit(app) {
        log::warn!("update menu choice not delivered ({error})");
    }
}

/// The browser and the loopback listener of a Google attempt.
pub struct ShellGoogle<R: Runtime> {
    pub app: AppHandle<R>,
    pub loopback: Loopback,
    /// `false` when the redirect is the deep link: no listener is needed.
    pub uses_loopback: bool,
}

impl<R: Runtime> GoogleSteps for ShellGoogle<R> {
    fn start_loopback(&self, attempt: u64) -> Result<(), StepFailed> {
        if !self.uses_loopback {
            return Ok(());
        }
        self.loopback.start(attempt).map(|_| ()).map_err(|error| {
            log::warn!("loopback listener unavailable ({})", error.kind());
            StepFailed
        })
    }

    fn stop_loopback(&self, attempt: u64) {
        self.loopback.stop(attempt);
    }

    fn open_browser(&self, url: &Url) -> Result<(), StepFailed> {
        use tauri_plugin_opener::OpenerExt;
        self.app.opener().open_url(url.as_str(), None::<&str>).map_err(|_| {
            log::warn!("system browser could not be opened");
            StepFailed
        })
    }
}

/// A notification was clicked: the window comes forward and the page opens
/// what the notification was about. `None`: shown before this launch, or
/// its id could not be read: the window still comes forward.
pub fn notification_clicked<R: Runtime>(app: &AppHandle<R>, id: Option<i32>) {
    window::bring_to_front(app);
    visibility_changed(app);
    if let Some(id) = id {
        let clicked = crate::bridge::NotificationClicked { id };
        if let Err(error) = clicked.emit(app) {
            log::warn!("notification click not delivered ({error})");
        }
    }
}

/// The browser step is over (deep link or loopback page): poll the claim now, show the window.
pub fn browser_returned<R: Runtime>(app: &AppHandle<R>) {
    if let Some(shell) = app.try_state::<Shell>() {
        shell.auth.nudge();
    }
    window::bring_to_front(app);
    visibility_changed(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_purge_is_retried_until_it_succeeds_or_the_user_quits() {
        use std::cell::Cell;
        let attempts = Cell::new(0);
        let asked = Cell::new(0);
        // Fails four times: two series, the user asks to retry twice, the fifth works.
        let purged = until_purged(
            || {
                attempts.set(attempts.get() + 1);
                let done = attempts.get() == 5;
                async move { done }
            },
            || {
                asked.set(asked.get() + 1);
                async { true }
            },
        )
        .await;
        assert!(purged);
        assert_eq!((attempts.get(), asked.get()), (5, 2));

        let attempts = Cell::new(0);
        let purged = until_purged(
            || {
                attempts.set(attempts.get() + 1);
                async { false }
            },
            || async { false },
        )
        .await;
        assert!(!purged, "quitting never reports a purge");
        assert_eq!(attempts.get(), PURGE_ATTEMPTS);
    }

    #[test]
    fn the_notch_hears_of_a_test_build_without_its_number() {
        let ready = |version: &str| crate::update_state::UpdateState { phase: crate::update_state::UpdatePhase::Ready { version: version.into() }, required: None, last_error: None, auto_install: true, last_check: None };
        assert_eq!(update_line(&ready("1.1.0")), HostToPopup::UpdateState { status: "ready", version: Some("1.1.0".into()) });
        // The notch drops a line whose version is not digits and dots: no dot at all.
        assert_eq!(update_line(&ready("1.1.1-test")), HostToPopup::UpdateState { status: "ready", version: None });
        assert!(!notch_version(&"1.".repeat(17)));
    }

    #[test]
    fn every_give_up_reason_is_explained() {
        assert!(give_up_message(&GiveUp::Missing).contains("pas embarquée"));
        assert!(give_up_message(&GiveUp::Crashing(5)).contains("5 fois"));
        assert!(give_up_message(&GiveUp::Protocol(0)).contains("antérieure"));
        assert!(give_up_message(&GiveUp::Protocol(2)).contains("(2)"));
        assert!(give_up_message(&GiveUp::Fatal("STANDALONE_RUNNING".into())).contains("tourne déjà seule"));
        assert!(give_up_message(&GiveUp::Fatal("UNSUPPORTED_OS".into())).contains("UNSUPPORTED_OS"));
    }
}
