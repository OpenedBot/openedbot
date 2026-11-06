//! The macOS menu bar, as in the Electron shell (`main.ts`): the app menu,
//! Edit (without it Cmd+C / Cmd+V / Cmd+A never reach the page's text
//! fields), View and Window. No Reload: Cmd+R would drop a half-typed message
//! for nothing. View › Actual Size goes back to the console's text size, not
//! to 100 %.
//!
//! The app menu carries the update item, « Rechercher des mises à jour… »,
//! renamed « Redémarrer pour mettre à jour » once an update is ready. Neither
//! restarts by itself: the console asks first (`UpdateMenuChosen`).

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

pub const ACTUAL_SIZE: &str = "view-actual-size";
pub const ZOOM_IN: &str = "view-zoom-in";
pub const ZOOM_OUT: &str = "view-zoom-out";
pub const UPDATES: &str = "app-updates";

const CHECK_LABEL: &str = "Rechercher des mises à jour…";
const RESTART_LABEL: &str = "Redémarrer pour mettre à jour";

/// The update item, kept to follow the update state (`refresh_update_item`).
pub struct UpdateMenuItem<R: Runtime>(pub MenuItem<R>);

/// The item's label for a state: the restart once an update is ready.
pub fn update_label(state: &crate::update_state::UpdateState) -> &'static str {
    if state.ready_version().is_some() {
        RESTART_LABEL
    } else {
        CHECK_LABEL
    }
}

pub fn refresh_update_item<R: Runtime>(app: &AppHandle<R>, state: &crate::update_state::UpdateState) {
    use tauri::Manager;
    if let Some(item) = app.try_state::<UpdateMenuItem<R>>() {
        let installing = matches!(state.phase, crate::update_state::UpdatePhase::Installing { .. });
        let _ = item.0.set_text(update_label(state));
        let _ = item.0.set_enabled(!installing);
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    use tauri::Manager;
    let product = app.package_info().name.clone();
    let about = AboutMetadata { name: Some(product.clone()), version: Some(app.package_info().version.to_string()), ..Default::default() };
    let updates = MenuItem::with_id(app, UPDATES, CHECK_LABEL, true, None::<&str>)?;
    app.manage(UpdateMenuItem(updates.clone()));
    let app_menu = Submenu::with_items(
        app,
        &product,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &updates,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, ACTUAL_SIZE, "Actual Size", true, Some("CmdOrCtrl+0"))?,
            &MenuItem::with_id(app, ZOOM_IN, "Zoom In", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, ZOOM_OUT, "Zoom Out", true, Some("CmdOrCtrl+-"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

/// The custom items; the predefined ones are handled by AppKit.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    match event.id().as_ref() {
        ACTUAL_SIZE => crate::window::reset_zoom(app),
        ZOOM_IN => crate::window::step_zoom(app, true),
        ZOOM_OUT => crate::window::step_zoom(app, false),
        UPDATES => crate::shell::update_menu_chosen(app),
        _ => {}
    }
}
