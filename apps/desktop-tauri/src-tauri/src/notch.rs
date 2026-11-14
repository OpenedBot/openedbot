//! The notch: whether the popup runs, the first-run choice
//! and its demo, the pause after a crash loop.
//!
//! The popup only runs with a session. Until the user has chosen (no
//! `display_mode` in the preferences), each launch with a session asks once
//! (`onboarding`): the popup plays its scripted demo, fictional bots and no
//! network, while the console shows the choice. « Garder l'encoche » saves
//! window + notch and the demo gives way to the session's bots; « Pas
//! maintenant » saves the window and stops the popup; leaving without a
//! choice saves nothing, so the next launch asks again. An update keeps the
//! preferences, so it never asks again.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use crate::bridge::Shell;
use crate::popup::GiveUp;
use crate::prefs::DisplayMode;
use crate::shell::{PopupHandle, POPUP_SUPPORTED};
use crate::window::WindowState;

/// How many loops of the demo (about 12 s each) « Revoir la démonstration »
/// plays before the popup goes back to what the saved choice says.
pub const REPLAY_CYCLES: u32 = 2;

/// What this launch learned about the notch; nothing here is saved.
#[derive(Default)]
pub struct NotchSession {
    /// The first-run choice is up: a session exists and nothing was chosen.
    onboarding: AtomicBool,
    /// The popup crashed in a loop: stopped until the next launch or a new choice.
    suspended: AtomicBool,
    /// The demo cannot play this launch (the popup failed or quit during it).
    demo_failed: AtomicBool,
    /// A screen has a camera housing, last read on the main thread.
    camera_housing: AtomicBool,
}

/// How the notch stands, for Réglages › Encoche and the first-run choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NotchState {
    /// The notch exists on this system (macOS).
    pub supported: bool,
    /// The popup ships in the app and the configuration leaves it on.
    pub available: bool,
    /// The display mode in force.
    pub mode: DisplayMode,
    /// Nothing chosen yet: the first-run choice asks, once a session exists.
    pub choice_pending: bool,
    /// The popup plays the scripted demo; otherwise the console shows a still preview.
    pub demo_supported: bool,
    /// The first-run choice is to be shown now.
    pub onboarding: bool,
    /// A screen has a camera housing (the copy says « autour de la caméra »);
    /// otherwise the notch sits under the menu bar.
    pub camera_housing: bool,
}

/// Pushed on every change of `NotchState`: the console opens or closes the
/// first-run choice and refreshes Réglages › Encoche from it.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct NotchStateChanged(pub NotchState);

/// Why a notch command was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotchRefusal {
    /// Not macOS, no popup in the app, or turned off by the configuration.
    Unavailable,
    /// The popup cannot play the demo (too old, or it failed this launch).
    DemoUnavailable,
    /// No session: the notch only runs signed in.
    SignedOut,
}

/// The display mode in force: the window when the popup cannot run, after a
/// crash loop, and as long as nothing was chosen; otherwise the choice.
pub fn resolve_display_mode(available: bool, chosen: Option<DisplayMode>, suspended: bool) -> DisplayMode {
    if !available || suspended {
        return DisplayMode::Window;
    }
    chosen.unwrap_or(DisplayMode::Window)
}

/// What the popup should be doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PopupPlan {
    Stopped,
    /// The first-run demo.
    Demo,
    /// The session's bots (a replay of the demo may run on top).
    Live,
    /// A replay of the demo in window mode: it stops the popup itself once over.
    Keep,
}

pub struct PlanInputs {
    pub available: bool,
    pub signed_in: bool,
    pub choice_pending: bool,
    pub onboarding: bool,
    pub demo_playable: bool,
    pub mode: DisplayMode,
    pub demo_active: bool,
}

pub fn popup_plan(inputs: &PlanInputs) -> PopupPlan {
    if !inputs.available || !inputs.signed_in {
        return PopupPlan::Stopped;
    }
    if inputs.choice_pending {
        return if inputs.onboarding && inputs.demo_playable { PopupPlan::Demo } else { PopupPlan::Stopped };
    }
    match (inputs.mode, inputs.demo_active) {
        (DisplayMode::Window, true) => PopupPlan::Keep,
        (DisplayMode::Window, false) => PopupPlan::Stopped,
        _ => PopupPlan::Live,
    }
}

fn session<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, NotchSession>> {
    app.try_state::<NotchSession>()
}

fn flag<R: Runtime>(app: &AppHandle<R>, read: impl FnOnce(&NotchSession) -> &AtomicBool) -> bool {
    session(app).is_some_and(|session| read(&session).load(Ordering::SeqCst))
}

fn set_flag<R: Runtime>(app: &AppHandle<R>, value: bool, write: impl FnOnce(&NotchSession) -> &AtomicBool) {
    if let Some(session) = session(app) {
        write(&session).store(value, Ordering::SeqCst);
    }
}

fn popup<R: Runtime>(app: &AppHandle<R>) -> Option<std::sync::Arc<crate::popup::PopupHost<crate::bridge::Auth>>> {
    app.try_state::<PopupHandle>().map(|popup| popup.0.clone())
}

pub fn signed_in<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<Shell>().is_some_and(|shell| shell.auth.is_signed_in())
}

/// The popup can run: macOS, its bundle found, not turned off by the configuration.
pub fn available<R: Runtime>(app: &AppHandle<R>) -> bool {
    POPUP_SUPPORTED && app.try_state::<Shell>().is_some_and(|shell| shell.config.popup) && popup(app).is_some_and(|popup| popup.available())
}

fn chosen<R: Runtime>(app: &AppHandle<R>) -> Option<DisplayMode> {
    app.try_state::<WindowState>().and_then(|state| state.prefs.get().display_mode)
}

/// Nothing chosen yet, and there is something to choose.
pub fn choice_pending<R: Runtime>(app: &AppHandle<R>) -> bool {
    available(app) && chosen(app).is_none()
}

/// The display mode in force (`resolve_display_mode`).
pub fn display_mode<R: Runtime>(app: &AppHandle<R>) -> DisplayMode {
    resolve_display_mode(available(app), chosen(app), flag(app, |session| &session.suspended))
}

fn demo_playable<R: Runtime>(app: &AppHandle<R>) -> bool {
    available(app) && !flag(app, |session| &session.demo_failed) && popup(app).is_some_and(|popup| popup.demo_supported())
}

/// Reads whether a screen has a camera housing. On the main thread only
/// (AppKit); elsewhere the last reading stands.
pub fn refresh_camera_housing<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    if let Some(mtm) = objc2::MainThreadMarker::new() {
        let housing = objc2_app_kit::NSScreen::screens(mtm).iter().any(|screen| screen.safeAreaInsets().top > 0.0);
        set_flag(app, housing, |session| &session.camera_housing);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn state<R: Runtime>(app: &AppHandle<R>) -> NotchState {
    refresh_camera_housing(app);
    let pending = choice_pending(app);
    NotchState {
        supported: POPUP_SUPPORTED,
        available: available(app),
        mode: display_mode(app),
        choice_pending: pending,
        demo_supported: demo_playable(app),
        onboarding: pending && flag(app, |session| &session.onboarding) && signed_in(app),
        camera_housing: flag(app, |session| &session.camera_housing),
    }
}

/// Tells the console and the Dock menu.
pub fn changed<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = NotchStateChanged(state(app)).emit(app) {
        log::warn!("notch state not delivered ({error})");
    }
    crate::shell::refresh_menus(app);
}

/// Starts, stops or leaves the popup as the session and the choice call for.
pub fn reconcile<R: Runtime>(app: &AppHandle<R>) {
    let Some(popup) = popup(app) else { return };
    let plan = popup_plan(&PlanInputs {
        available: available(app),
        signed_in: signed_in(app),
        choice_pending: choice_pending(app),
        onboarding: flag(app, |session| &session.onboarding),
        demo_playable: demo_playable(app),
        mode: display_mode(app),
        demo_active: popup.demo_active(),
    });
    match plan {
        PopupPlan::Stopped => popup.stop(),
        // Already asked: a second `play_demo` would restart it from the top.
        PopupPlan::Demo if popup.demo_active() => popup.start(),
        PopupPlan::Demo => {
            if !popup.play_demo(0) {
                popup.stop();
            }
        }
        PopupPlan::Live => popup.start(),
        PopupPlan::Keep => {}
    }
}

/// A session exists (sign-in, or a session restored at launch): the popup
/// starts, and the first-run choice is asked if nothing was chosen.
pub fn session_started<R: Runtime>(app: &AppHandle<R>) {
    if choice_pending(app) {
        log::info!("notch choice pending: first-run demo and choice");
        set_flag(app, true, |session| &session.onboarding);
    }
    reconcile(app);
    changed(app);
}

/// The session is gone: no popup, and the choice waits for the next one.
pub fn session_ended<R: Runtime>(app: &AppHandle<R>) {
    set_flag(app, false, |session| &session.onboarding);
    reconcile(app);
    changed(app);
}

/// Saves the user's choice (first-run choice, Réglages › Encoche, Dock menu).
/// A demo playing ends; a crash loop's pause is lifted (the user asks again).
pub fn choose<R: Runtime>(app: &AppHandle<R>, mode: DisplayMode) -> DisplayMode {
    let mode = if available(app) { mode } else { DisplayMode::Window };
    if let Some(state) = app.try_state::<WindowState>() {
        state.prefs.update(|prefs| prefs.display_mode = Some(mode));
    }
    set_flag(app, false, |session| &session.onboarding);
    set_flag(app, false, |session| &session.suspended);
    if let Some(popup) = popup(app) {
        popup.end_demo();
    }
    reconcile(app);
    mode
}

/// « Revoir la démonstration »: plays the demo without touching the saved
/// choice; the popup then goes back to it (`demo_ended`).
pub fn replay<R: Runtime>(app: &AppHandle<R>) -> Result<NotchState, NotchRefusal> {
    if !available(app) {
        return Err(NotchRefusal::Unavailable);
    }
    if !signed_in(app) {
        return Err(NotchRefusal::SignedOut);
    }
    let Some(popup) = popup(app).filter(|_| demo_playable(app)) else { return Err(NotchRefusal::DemoUnavailable) };
    if !popup.play_demo(REPLAY_CYCLES) {
        return Err(NotchRefusal::DemoUnavailable);
    }
    changed(app);
    Ok(state(app))
}

/// The demo stopped by itself. The first-run choice keeps its last frame;
/// a replay gives way to the saved choice.
pub fn demo_ended<R: Runtime>(app: &AppHandle<R>) {
    if choice_pending(app) {
        return;
    }
    let Some(popup) = popup(app) else { return };
    if display_mode(app) == DisplayMode::Window {
        popup.stop();
    } else {
        popup.end_demo();
    }
}

/// The popup's `ready` told what the bundle did not (a demo it cannot play).
pub fn demo_support_changed<R: Runtime>(app: &AppHandle<R>) {
    reconcile(app);
    changed(app);
}

/// What the shell does when the popup gives up or is closed by the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GiveUpOutcome {
    /// During the first-run choice: no demo, a still preview; nothing saved, no dialog.
    DemoUnavailable,
    /// A crash loop: stopped for this launch, the choice kept, the user told.
    Paused,
    /// The popup cannot run (missing, incompatible, refused): back to the window, saved.
    BackToWindow,
}

pub fn give_up_outcome(reason: &GiveUp, choice_pending: bool) -> GiveUpOutcome {
    if choice_pending {
        return GiveUpOutcome::DemoUnavailable;
    }
    match reason {
        GiveUp::Crashing(_) => GiveUpOutcome::Paused,
        GiveUp::Missing | GiveUp::Protocol(_) | GiveUp::Fatal(_) => GiveUpOutcome::BackToWindow,
    }
}

/// Applies `give_up_outcome`; the caller tells the user when it says so.
pub fn gave_up<R: Runtime>(app: &AppHandle<R>, reason: &GiveUp) -> GiveUpOutcome {
    let outcome = give_up_outcome(reason, choice_pending(app));
    match outcome {
        GiveUpOutcome::DemoUnavailable => set_flag(app, true, |session| &session.demo_failed),
        GiveUpOutcome::Paused => set_flag(app, true, |session| &session.suspended),
        GiveUpOutcome::BackToWindow => {
            choose(app, DisplayMode::Window);
        }
    }
    reconcile(app);
    changed(app);
    outcome
}

/// « Quitter » in the popup's own menu. During the first-run choice it only
/// ends the demo (the choice stays the user's); otherwise the window mode is saved.
pub fn user_closed<R: Runtime>(app: &AppHandle<R>) -> bool {
    if choice_pending(app) {
        set_flag(app, true, |session| &session.demo_failed);
        reconcile(app);
        changed(app);
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_chosen_means_the_window_until_the_user_says_otherwise() {
        assert_eq!(resolve_display_mode(true, None, false), DisplayMode::Window);
        assert_eq!(resolve_display_mode(true, Some(DisplayMode::Both), false), DisplayMode::Both);
        assert_eq!(resolve_display_mode(true, Some(DisplayMode::Popup), false), DisplayMode::Popup);
        // No popup (other system, missing bundle, kill switch): the window, whatever was chosen.
        assert_eq!(resolve_display_mode(false, Some(DisplayMode::Both), false), DisplayMode::Window);
        // A crash loop pauses the notch for the launch, the choice is kept.
        assert_eq!(resolve_display_mode(true, Some(DisplayMode::Popup), true), DisplayMode::Window);
    }

    fn inputs() -> PlanInputs {
        PlanInputs { available: true, signed_in: true, choice_pending: false, onboarding: false, demo_playable: true, mode: DisplayMode::Both, demo_active: false }
    }

    #[test]
    fn the_popup_only_runs_with_a_session() {
        assert_eq!(popup_plan(&inputs()), PopupPlan::Live);
        assert_eq!(popup_plan(&PlanInputs { signed_in: false, ..inputs() }), PopupPlan::Stopped);
        assert_eq!(popup_plan(&PlanInputs { signed_in: false, choice_pending: true, onboarding: true, ..inputs() }), PopupPlan::Stopped);
        assert_eq!(popup_plan(&PlanInputs { available: false, ..inputs() }), PopupPlan::Stopped);
    }

    #[test]
    fn the_first_run_plays_the_demo_when_it_can() {
        let pending = PlanInputs { choice_pending: true, onboarding: true, mode: DisplayMode::Window, ..inputs() };
        assert_eq!(popup_plan(&pending), PopupPlan::Demo);
        // An older popup, or one that failed: the console shows a still preview, the popup stays off.
        assert_eq!(popup_plan(&PlanInputs { demo_playable: false, ..pending }), PopupPlan::Stopped);
        // Pending but not asked (the session ended meanwhile): off.
        assert_eq!(popup_plan(&PlanInputs { onboarding: false, ..pending }), PopupPlan::Stopped);
    }

    #[test]
    fn a_replay_in_window_mode_runs_until_it_ends() {
        assert_eq!(popup_plan(&PlanInputs { mode: DisplayMode::Window, ..inputs() }), PopupPlan::Stopped);
        assert_eq!(popup_plan(&PlanInputs { mode: DisplayMode::Window, demo_active: true, ..inputs() }), PopupPlan::Keep);
        assert_eq!(popup_plan(&PlanInputs { mode: DisplayMode::Popup, demo_active: true, ..inputs() }), PopupPlan::Live);
    }

    #[test]
    fn a_crash_loop_no_longer_saves_the_window() {
        assert_eq!(give_up_outcome(&GiveUp::Crashing(5), false), GiveUpOutcome::Paused);
        assert_eq!(give_up_outcome(&GiveUp::Missing, false), GiveUpOutcome::BackToWindow);
        assert_eq!(give_up_outcome(&GiveUp::Protocol(2), false), GiveUpOutcome::BackToWindow);
        assert_eq!(give_up_outcome(&GiveUp::Fatal("STANDALONE_RUNNING".into()), false), GiveUpOutcome::BackToWindow);
        // During the first-run choice nothing is saved: the user has not answered.
        assert_eq!(give_up_outcome(&GiveUp::Crashing(5), true), GiveUpOutcome::DemoUnavailable);
        assert_eq!(give_up_outcome(&GiveUp::Protocol(2), true), GiveUpOutcome::DemoUnavailable);
    }
}
