//! Clears the WKWebView's data store and says when it is done.
//!
//! wry's `clear_all_browsing_data` starts the removal and returns at once:
//! a `/login` loaded right after could still meet the previous account's
//! IndexedDB. Here the store's completion handler answers a channel.

use objc2::MainThreadMarker;
use objc2_foundation::NSDate;
use objc2_web_kit::{WKWebView, WKWebsiteDataStore};
use std::sync::Mutex;
use tauri::{Runtime, WebviewWindow};

/// Resolves once every data type of the window's store is removed; dropped
/// (receiver error) if the WebView is gone.
pub fn clear<R: Runtime>(window: &WebviewWindow<R>) -> tokio::sync::oneshot::Receiver<()> {
    let (done, receiver) = tokio::sync::oneshot::channel();
    let done = Mutex::new(Some(done));
    let started = window.with_webview(move |platform| {
        let Some(mtm) = MainThreadMarker::new() else { return };
        // SAFETY: on macOS `PlatformWebview::inner` is the window's live WKWebView,
        // and `with_webview` runs this on the main thread.
        let view: &WKWebView = unsafe { &*platform.inner().cast::<WKWebView>() };
        let store = unsafe { view.configuration().websiteDataStore() };
        let types = unsafe { WKWebsiteDataStore::allWebsiteDataTypes(mtm) };
        let since = NSDate::dateWithTimeIntervalSince1970(0.0);
        let handler = block2::RcBlock::new(move || {
            if let Some(done) = done.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
                let _ = done.send(());
            }
        });
        unsafe { store.removeDataOfTypes_modifiedSince_completionHandler(&types, &since, &handler) };
    });
    if started.is_err() {
        log::warn!("the WebView could not be reached to clear its data");
    }
    receiver
}

/// Runs `script` in the window's page and answers its string result (`None`
/// when the page threw, returned something else, or is gone).
pub fn evaluate<R: Runtime>(window: &WebviewWindow<R>, script: &str) -> tokio::sync::oneshot::Receiver<Option<String>> {
    let (done, receiver) = tokio::sync::oneshot::channel();
    let done = Mutex::new(Some(done));
    let script = script.to_string();
    let started = window.with_webview(move |platform| {
        let script = objc2_foundation::NSString::from_str(&script);
        // SAFETY: as in `clear`: the live WKWebView, on the main thread.
        let view: &WKWebView = unsafe { &*platform.inner().cast::<WKWebView>() };
        let handler = block2::RcBlock::new(move |result: *mut objc2::runtime::AnyObject, _error: *mut objc2_foundation::NSError| {
            // SAFETY: WebKit hands a valid object or nil; only an NSString is read.
            let text = unsafe { result.as_ref() }.and_then(|object| object.downcast_ref::<objc2_foundation::NSString>()).map(|text| text.to_string());
            if let Some(done) = done.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
                let _ = done.send(text);
            }
        });
        unsafe { view.evaluateJavaScript_completionHandler(&script, Some(&handler)) };
    });
    if started.is_err() {
        log::warn!("the WebView could not be reached to read its preferences");
    }
    receiver
}
