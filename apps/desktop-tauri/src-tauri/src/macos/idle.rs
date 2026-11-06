//! Whether anyone uses the Mac, for the idle install (`update_idle.rs`), and
//! the wake from sleep that checks the feed at once (`updater.rs`).
//!
//! - lock: the distributed notifications `com.apple.screenIsLocked` and
//!   `com.apple.screenIsUnlocked` (loginwindow posts them);
//! - screensaver: `com.apple.screensaver.didstart` / `didstop`;
//! - no input: `CGEventSourceSecondsSinceLastEventType`, any input event of
//!   the session (keyboard, mouse, trackpad), the measure macOS itself uses;
//! - wake: `NSWorkspaceDidWakeNotification`.
//!
//! The observers are registered once, on the main thread, for the life of
//! the process (their tokens are kept, never removed).

use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSNotificationCenter, NSOperationQueue, NSString};

use crate::update_idle::{IdleSignal, IdleSource};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(source_state: i32, event_type: u32) -> f64;
}

/// `kCGEventSourceStateCombinedSessionState`.
const COMBINED_SESSION_STATE: i32 = 0;
/// `kCGAnyInputEventType`.
const ANY_INPUT_EVENT: u32 = u32::MAX;

pub struct MacIdle {
    locked: Arc<AtomicBool>,
    screensaver: Arc<AtomicBool>,
}

fn observe(center: &NSNotificationCenter, name: &str, action: impl Fn() + 'static) {
    let name = NSString::from_str(name);
    let block = block2::RcBlock::new(move |_: NonNull<NSNotification>| action());
    // SAFETY: a plain name, no sender filter, the main queue; the block only
    // flips an atomic or wakes a Notify. The token lives for the process.
    let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(&name), None, Some(&NSOperationQueue::mainQueue()), &block) };
    std::mem::forget(token);
}

impl MacIdle {
    /// Registers the observers. `woke` runs on each wake from sleep.
    pub fn install(woke: impl Fn() + 'static) -> Arc<Self> {
        let idle = Arc::new(Self { locked: Arc::new(AtomicBool::new(false)), screensaver: Arc::new(AtomicBool::new(false)) });
        let distributed = NSDistributedNotificationCenter::defaultCenter();
        for (name, flag, value) in [
            ("com.apple.screenIsLocked", &idle.locked, true),
            ("com.apple.screenIsUnlocked", &idle.locked, false),
            ("com.apple.screensaver.didstart", &idle.screensaver, true),
            ("com.apple.screensaver.didstop", &idle.screensaver, false),
        ] {
            let flag = flag.clone();
            observe(&distributed, name, move || {
                log::info!("{name}");
                flag.store(value, Ordering::SeqCst);
            });
        }
        let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
        // SAFETY: an AppKit constant string.
        let wake = unsafe { NSWorkspaceDidWakeNotification };
        let block = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
            log::info!("woke from sleep");
            woke();
        });
        // SAFETY: as in `observe`.
        let token = unsafe { workspace.addObserverForName_object_queue_usingBlock(Some(wake), None, Some(&NSOperationQueue::mainQueue()), &block) };
        std::mem::forget(token);
        idle
    }
}

impl IdleSource for MacIdle {
    fn signal(&self) -> IdleSignal {
        // SAFETY: a CoreGraphics call without pointers, valid from any thread.
        let idle_seconds = unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) };
        IdleSignal { locked: self.locked.load(Ordering::SeqCst), screensaver: self.screensaver.load(Ordering::SeqCst), idle_seconds }
    }
}
