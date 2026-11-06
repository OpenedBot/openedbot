//! The traffic lights centred on the console's top bar at every page zoom, as
//! the Electron shell places them (`apps/desktop/src/main/window.ts`,
//! `trafficLightPosition`, re-applied on each zoom change).
//!
//! The top bar is 46 page pixels high, so 46 × zoom points on screen; the
//! buttons do not zoom. Tauri 2.12 only sets tao's inset when the window is
//! built (no setter at run time), and tao re-applies that inset on every
//! `drawRect:`, so the shell sets no inset at all and moves the standard
//! buttons itself, the way Electron's `WindowButtonsProxy` does: the titlebar
//! container is made as high as the bar, the buttons are centred in it.
//!
//! AppKit puts the buttons back where it wants on some events (resize, leaving
//! full screen, appearance change). Rather than list them, the shell watches
//! the frames of the close button and of the container and lays them out
//! again whenever they move, plus the window's resize and full-screen exit.

use std::cell::Cell;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};

use objc2_app_kit::{NSView, NSViewFrameDidChangeNotification, NSWindow, NSWindowButton, NSWindowDidExitFullScreenNotification, NSWindowDidResizeNotification, NSWindowStyleMask};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSNotificationName, NSOperationQueue, NSPoint, NSSize};

/// The console's top bar (`board-chrome.tsx`), in page pixels.
pub const TITLE_BAR_HEIGHT: f64 = 46.0;
/// The close button's left edge, in points, as in Electron.
pub const LIGHTS_X: f64 = 16.0;

/// The zoom in force, as `f64` bits (read from the AppKit observers).
static ZOOM: AtomicU64 = AtomicU64::new(0x3FF0_0000_0000_0000); // 1.0

thread_local! {
    /// Set while the shell moves the buttons: the frame changes it causes do
    /// not lay them out again from inside.
    static LAYING_OUT: Cell<bool> = const { Cell::new(false) };
}

/// Where the buttons go, in the titlebar container's coordinates.
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    /// The container's height: the top bar's, 46 × zoom points.
    pub container_height: f64,
    /// The bottom left corner of the close, minimise and zoom buttons.
    pub origins: [(f64, f64); 3],
}

/// Electron's `{ x: 16, y: round(46 × zoom / 2 − 7) }` for 14 pt buttons,
/// written for the buttons' real size: their centre is the bar's centre,
/// snapped to the device pixel (`scale`) rather than to the point.
pub fn layout(zoom: f64, button: (f64, f64), stride: f64, scale: f64) -> Layout {
    let snap = |value: f64| (value * scale).round() / scale;
    let bar = TITLE_BAR_HEIGHT * zoom;
    let margin = snap(bar / 2.0 - button.1 / 2.0).max(0.0);
    let container_height = button.1 + 2.0 * margin;
    let origins = std::array::from_fn(|index| (LIGHTS_X + index as f64 * stride, margin));
    Layout { container_height, origins }
}

/// The zoom changed (text size or View menu): the buttons follow at once.
/// Main thread only.
pub fn set_zoom(window: &NSWindow, zoom: f64) {
    ZOOM.store(zoom.to_bits(), Ordering::SeqCst);
    apply(window);
}

fn zoom() -> f64 {
    f64::from_bits(ZOOM.load(Ordering::SeqCst))
}

/// Lays the buttons out for the zoom in force. Nothing moves in full screen
/// (the buttons live in AppKit's own titlebar window there), nor when they
/// already sit where they should.
pub fn apply(window: &NSWindow) {
    if LAYING_OUT.with(Cell::get) || window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }
    let (Some(close), Some(minimise), Some(zoom_button)) = (
        window.standardWindowButton(NSWindowButton::CloseButton),
        window.standardWindowButton(NSWindowButton::MiniaturizeButton),
        window.standardWindowButton(NSWindowButton::ZoomButton),
    ) else {
        return;
    };
    // SAFETY: AppKit view hierarchy reads on the main thread.
    let Some(container) = (unsafe { close.superview().and_then(|titlebar| titlebar.superview()) }) else { return };
    let size = close.frame().size;
    let stride = minimise.frame().origin.x - close.frame().origin.x;
    if stride <= 0.0 {
        return;
    }
    let plan = layout(zoom(), (size.width, size.height), stride, window.backingScaleFactor());
    LAYING_OUT.with(|flag| flag.set(true));
    let mut frame = container.frame();
    let top = window.frame().size.height - plan.container_height;
    if frame.size.height != plan.container_height || frame.origin.y != top {
        frame.size = NSSize::new(frame.size.width, plan.container_height);
        frame.origin.y = top;
        container.setFrame(frame);
    }
    for (button, (x, y)) in [&close, &minimise, &zoom_button].into_iter().zip(plan.origins) {
        let origin = button.frame().origin;
        if origin.x != x || origin.y != y {
            button.setFrameOrigin(NSPoint::new(x, y));
        }
    }
    LAYING_OUT.with(|flag| flag.set(false));
}

/// Watches what makes AppKit move the buttons back, for the life of the
/// window (the main window is built once and only hidden). Main thread only.
pub fn install(window: &NSWindow) {
    apply(window);
    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else { return };
    // SAFETY: as in `apply`.
    let container = unsafe { close.superview().and_then(|titlebar| titlebar.superview()) };
    let center = NSNotificationCenter::defaultCenter();
    // SAFETY: AppKit constant strings.
    let (frame_changed, resized, left_full_screen) = unsafe { (NSViewFrameDidChangeNotification, NSWindowDidResizeNotification, NSWindowDidExitFullScreenNotification) };
    let views: [&NSView; 2] = [&close, container.as_deref().unwrap_or(&close)];
    for view in views {
        observe(&center, frame_changed, view);
    }
    observe(&center, resized, window);
    observe(&center, left_full_screen, window);
}

fn observe(center: &NSNotificationCenter, name: &NSNotificationName, sender: &objc2::runtime::AnyObject) {
    let block = block2::RcBlock::new(|notification: NonNull<NSNotification>| {
        // SAFETY: AppKit hands a valid notification to the block.
        let object = unsafe { notification.as_ref() }.object();
        let Some(object) = object else { return };
        let window = if let Some(view) = object.downcast_ref::<NSView>() { view.window() } else { object.downcast::<NSWindow>().ok() };
        if let Some(window) = window {
            apply(&window);
        }
    });
    // SAFETY: a sender filter on a view or window that lives as long as the
    // process, the main queue; the block only lays the buttons out. The token
    // lives for the process, like the window.
    let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), Some(sender), Some(&NSOperationQueue::mainQueue()), &block) };
    std::mem::forget(token);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn electron_position_at_100_percent() {
        // Electron: { x: 16, y: round(46 / 2 - 7) } = { 16, 16 }, centre y 23.
        let plan = layout(1.0, (14.0, 14.0), 20.0, 2.0);
        assert_eq!(plan.origins, [(16.0, 16.0), (36.0, 16.0), (56.0, 16.0)]);
        assert_eq!(plan.container_height, 46.0);
    }

    #[test]
    fn the_centre_is_the_bar_centre_at_every_text_size() {
        for zoom in [0.8, 0.9, 1.0, 1.1, 1.125, 1.25, 1.4, 1.5] {
            for (height, scale) in [(14.0, 2.0), (16.0, 2.0), (14.0, 1.0)] {
                let plan = layout(zoom, (14.0, height), 20.0, scale);
                let centre = plan.origins[0].1 + height / 2.0;
                let bar_centre = TITLE_BAR_HEIGHT * zoom / 2.0;
                assert!((centre - bar_centre).abs() <= 0.5 / scale + 1e-9, "zoom {zoom}, height {height}, scale {scale}: {centre} vs {bar_centre}");
                assert_eq!(plan.container_height, height + 2.0 * plan.origins[0].1);
            }
        }
    }

    #[test]
    fn matches_electron_rounding_where_it_lands_on_a_point() {
        for zoom in [1.0, 1.25, 1.5] {
            let electron = (TITLE_BAR_HEIGHT * zoom / 2.0 - 7.0).round();
            assert_eq!(layout(zoom, (14.0, 14.0), 20.0, 1.0).origins[0].1, electron);
        }
    }

    #[test]
    fn the_buttons_keep_the_system_spacing() {
        let plan = layout(1.25, (14.0, 14.0), 23.0, 2.0);
        assert_eq!(plan.origins.map(|(x, _)| x), [16.0, 39.0, 62.0]);
        assert!(plan.origins.iter().all(|(_, y)| *y == plan.origins[0].1));
    }
}
