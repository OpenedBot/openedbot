//! A double click on the console's title bar, as macOS does it
//! (notes: `tauri2-react-fenetre-macos.md`, § 2).
//!
//! tao's `maximize()` is `NSWindow zoom:`, whose animation blocks the main
//! thread: the frame grew while the WebView kept its old size, stuck in the
//! top left corner, until the end. And it ignored the system setting
//! (Réglages › Bureau et Dock › « Double-cliquer sur la barre de titre pour »).
//! Here the setting decides: minimise, nothing, or fill the screen, animated
//! through the `animator` proxy, which leaves the main thread free so the
//! WebView follows every frame. A second double click restores the frame from
//! before.
//!
//! Not covered: the green button with Option and Window › Zoom keep AppKit's
//! own `zoom:`.

use std::cell::Cell;

use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_app_kit::NSWindow;
use objc2_foundation::{NSRect, NSString, NSUserDefaults};

/// The fill animation, in seconds (AppKit's own is about as long).
const FILL_SECONDS: f64 = 0.25;

thread_local! {
    /// The frame before the last fill, for the next double click. Main thread only.
    static BEFORE_FILL: Cell<Option<NSRect>> = const { Cell::new(None) };
}

/// What a double click does, from the system setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Minimise,
    Nothing,
    Fill,
}

/// `AppleActionOnDoubleClick` (« Minimize », « None », « Fill », « Maximize »),
/// or, when absent, the older `AppleMiniaturizeOnDoubleClick`. Anything else
/// fills the screen, the system's default.
pub fn action(setting: Option<&str>, legacy_minimise: bool) -> Action {
    match setting {
        Some("Minimize") => Action::Minimise,
        Some("None") => Action::Nothing,
        Some(_) => Action::Fill,
        None if legacy_minimise => Action::Minimise,
        None => Action::Fill,
    }
}

/// What filling does from the current frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fill {
    /// Grow to the screen's visible frame, remembering the current one.
    To(NSRect),
    /// Already filled by this path: back to the frame from before.
    Restore(NSRect),
    /// Already filled by another path (green button, Window menu): AppKit's
    /// own zoom knows where it came from.
    AppKitZoom,
}

pub fn fill(current: NSRect, visible: NSRect, before: Option<NSRect>) -> Fill {
    if !same(current, visible) {
        return Fill::To(visible);
    }
    match before {
        Some(frame) => Fill::Restore(frame),
        None => Fill::AppKitZoom,
    }
}

/// Frames within a point of each other: AppKit rounds the frames it sets.
fn same(a: NSRect, b: NSRect) -> bool {
    (a.origin.x - b.origin.x).abs() < 1.0
        && (a.origin.y - b.origin.y).abs() < 1.0
        && (a.size.width - b.size.width).abs() < 1.0
        && (a.size.height - b.size.height).abs() < 1.0
}

/// Main thread only.
pub fn double_click(window: &NSWindow) {
    match system_action() {
        Action::Nothing => {}
        Action::Minimise => window.miniaturize(None),
        Action::Fill => {
            let Some(screen) = window.screen() else { return };
            let current = window.frame();
            match fill(current, screen.visibleFrame(), BEFORE_FILL.with(Cell::get)) {
                Fill::To(target) => {
                    BEFORE_FILL.with(|before| before.set(Some(current)));
                    animate_to(window, target);
                }
                Fill::Restore(frame) => {
                    BEFORE_FILL.with(|before| before.set(None));
                    animate_to(window, frame);
                }
                Fill::AppKitZoom => window.zoom(None),
            }
        }
    }
}

fn system_action() -> Action {
    let defaults = NSUserDefaults::standardUserDefaults();
    let setting = defaults.stringForKey(&NSString::from_str("AppleActionOnDoubleClick")).map(|value| value.to_string());
    let legacy = defaults.boolForKey(&NSString::from_str("AppleMiniaturizeOnDoubleClick"));
    action(setting.as_deref(), legacy)
}

/// Sets the frame through the `animator` proxy, inside an animation group:
/// the animation runs without holding the main thread.
fn animate_to(window: &NSWindow, frame: NSRect) {
    // SAFETY: AppKit messages with their documented signatures, on the main
    // thread: `NSAnimationContext` class methods and `-[NSWindow animator]`,
    // whose proxy answers `setFrame:display:`.
    unsafe {
        let context = class!(NSAnimationContext);
        let _: () = msg_send![context, beginGrouping];
        let current: *mut AnyObject = msg_send![context, currentContext];
        let _: () = msg_send![current, setDuration: FILL_SECONDS];
        let animator: *mut AnyObject = msg_send![window, animator];
        let _: () = msg_send![animator, setFrame: frame, display: Bool::YES];
        let _: () = msg_send![context, endGrouping];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_foundation::{NSPoint, NSSize};

    fn rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
    }

    #[test]
    fn the_system_setting_decides() {
        assert_eq!(action(Some("Minimize"), false), Action::Minimise);
        assert_eq!(action(Some("None"), true), Action::Nothing);
        assert_eq!(action(Some("Fill"), true), Action::Fill);
        assert_eq!(action(Some("Maximize"), false), Action::Fill);
        assert_eq!(action(None, true), Action::Minimise);
        assert_eq!(action(None, false), Action::Fill);
    }

    #[test]
    fn fill_then_restore_then_appkit_for_a_foreign_fill() {
        let visible = rect(0.0, 25.0, 1512.0, 920.0);
        let window = rect(200.0, 150.0, 1100.0, 760.0);
        assert_eq!(fill(window, visible, None), Fill::To(visible));
        assert_eq!(fill(rect(0.4, 25.0, 1511.6, 920.0), visible, Some(window)), Fill::Restore(window));
        assert_eq!(fill(visible, visible, None), Fill::AppKitZoom);
    }
}
