//! The Dock menu (right click on the Dock icon), as in the Electron shell
//! (`apps/desktop/src/main/tray.ts`, `createDockMenu`): display mode, stay on
//! top, sign out. macOS adds Show and Quit itself.
//!
//! Tauri has no Dock menu API. AppKit asks the application delegate
//! (`applicationDockMenu:`) each time the menu opens: the method is added to
//! tao's delegate class at startup and answers the menu last built here.

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject, Sel};
use objc2::{define_class, msg_send, sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSControlStateValueOff, NSControlStateValueOn, NSMenu, NSMenuItem};
use objc2_foundation::NSString;
use std::cell::RefCell;
use std::sync::OnceLock;
use tauri::{AppHandle, Runtime};

use crate::prefs::DisplayMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockAction {
    DisplayMode(DisplayMode),
    ToggleAlwaysOnTop,
    SignOut,
}

/// What the menu shows.
#[derive(Debug, Clone, Copy)]
pub struct DockState {
    pub display_mode: DisplayMode,
    pub popup_available: bool,
    pub always_on_top: bool,
    pub signed_in: bool,
}

const MODES: [(DisplayMode, &str, isize); 3] = [(DisplayMode::Window, "Fenêtre", 1), (DisplayMode::Popup, "Popup", 2), (DisplayMode::Both, "Fenêtre et popup", 3)];
const TAG_ALWAYS_ON_TOP: isize = 10;
const TAG_SIGN_OUT: isize = 20;

fn action_for(tag: isize) -> Option<DockAction> {
    match tag {
        TAG_ALWAYS_ON_TOP => Some(DockAction::ToggleAlwaysOnTop),
        TAG_SIGN_OUT => Some(DockAction::SignOut),
        _ => MODES.iter().find(|(_, _, mode_tag)| *mode_tag == tag).map(|(mode, _, _)| DockAction::DisplayMode(*mode)),
    }
}

type Handler = Box<dyn Fn(DockAction) + Send + Sync>;
static HANDLER: OnceLock<Handler> = OnceLock::new();

thread_local! {
    // Main thread only: AppKit objects never leave it.
    static MENU: RefCell<Option<Retained<NSMenu>>> = const { RefCell::new(None) };
    static TARGET: RefCell<Option<Retained<DockTarget>>> = const { RefCell::new(None) };
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "OpenedbotDockTarget"]
    #[ivars = ()]
    struct DockTarget;

    impl DockTarget {
        #[unsafe(method(dockItem:))]
        fn dock_item(&self, sender: &NSMenuItem) {
            if let (Some(action), Some(handler)) = (action_for(sender.tag()), HANDLER.get()) {
                handler(action);
            }
        }
    }
);

impl DockTarget {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// `applicationDockMenu:` of the application delegate: the last built menu.
unsafe extern "C-unwind" fn application_dock_menu(_this: *mut AnyObject, _sel: Sel, _app: *mut AnyObject) -> *mut NSMenu {
    MENU.with(|menu| menu.borrow().as_ref().map_or(std::ptr::null_mut(), |menu| Retained::as_ptr(menu).cast_mut()))
}

/// Answers the Dock's question from now on. Call once, after the event loop started.
pub fn install<R: Runtime>(app: &AppHandle<R>, handler: Handler) {
    let _ = HANDLER.set(handler);
    let _ = app.run_on_main_thread(|| {
        let Some(class) = AnyClass::get(c"TaoAppDelegateParent") else {
            log::warn!("Dock menu unavailable: the application delegate class was not found");
            return;
        };
        // SAFETY: the signature matches `- (NSMenu *)applicationDockMenu:(NSApplication *)sender`
        // ("@@:@"); adding a method a class lacks is what the runtime is for.
        let added = unsafe {
            let imp: objc2::runtime::Imp = std::mem::transmute(application_dock_menu as unsafe extern "C-unwind" fn(_, _, _) -> _);
            objc2::ffi::class_addMethod((class as *const AnyClass).cast_mut(), sel!(applicationDockMenu:), imp, c"@@:@".as_ptr())
        };
        if !added.as_bool() {
            log::warn!("Dock menu unavailable: applicationDockMenu: already defined");
        }
    });
}

/// Rebuilds the menu so checkmarks and enabled states follow the app state.
pub fn refresh<R: Runtime>(app: &AppHandle<R>, state: DockState) {
    let _ = app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let target = TARGET.with(|target| target.borrow_mut().get_or_insert_with(|| DockTarget::new(mtm)).clone());
        let menu = NSMenu::new(mtm);
        menu.setAutoenablesItems(false);
        let item = |title: &str, tag: isize, checked: bool, enabled: bool| {
            // SAFETY: plain AppKit object creation on the main thread.
            let item = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &NSString::from_str(title), Some(sel!(dockItem:)), &NSString::from_str("")) };
            unsafe { item.setTarget(Some(&target)) };
            item.setTag(tag);
            item.setState(if checked { NSControlStateValueOn } else { NSControlStateValueOff });
            item.setEnabled(enabled);
            menu.addItem(&item);
        };
        let header = NSMenuItem::new(mtm);
        header.setTitle(&NSString::from_str("Affichage"));
        header.setEnabled(false);
        menu.addItem(&header);
        for (mode, label, tag) in MODES {
            let usable = mode == DisplayMode::Window || state.popup_available;
            let title = if usable { label.to_string() } else { format!("{label} (popup introuvable)") };
            item(&title, tag, state.display_mode == mode, usable);
        }
        menu.addItem(&NSMenuItem::separatorItem(mtm));
        item("Toujours au premier plan", TAG_ALWAYS_ON_TOP, state.always_on_top, true);
        item("Se déconnecter", TAG_SIGN_OUT, false, state.signed_in);
        MENU.with(|current| *current.borrow_mut() = Some(menu));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_map_to_their_actions_only() {
        assert_eq!(action_for(1), Some(DockAction::DisplayMode(DisplayMode::Window)));
        assert_eq!(action_for(3), Some(DockAction::DisplayMode(DisplayMode::Both)));
        assert_eq!(action_for(TAG_ALWAYS_ON_TOP), Some(DockAction::ToggleAlwaysOnTop));
        assert_eq!(action_for(TAG_SIGN_OUT), Some(DockAction::SignOut));
        assert_eq!(action_for(0), None);
    }
}
