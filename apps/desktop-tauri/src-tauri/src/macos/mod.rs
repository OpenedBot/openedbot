//! What only macOS has: the menu bar, the Dock menu, a WebView data purge
//! that waits for WebKit's answer, and the idle signals of the idle install.

pub mod dock;
pub mod idle;
pub mod menu;
pub mod webview_data;
