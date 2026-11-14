//! What only macOS has: the menu bar, the Dock menu, a WebView data purge
//! that waits for WebKit's answer, the idle signals of the idle install, and
//! the traffic lights centred on the zoomed top bar, and the title bar's
//! double click as the system setting asks.

pub mod dock;
pub mod idle;
pub mod menu;
pub mod titlebar;
pub mod traffic_lights;
pub mod webview_data;
