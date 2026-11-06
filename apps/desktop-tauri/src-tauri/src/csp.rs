//! The console's Content-Security-Policy with the runtime API origin.
//!
//! The desktop build of the console (`VITE_OPENEDBOT_SHELL=tauri`) carries its
//! policy in a `<meta>` tag, computed by `apps/console/vite-csp.ts` like the
//! web one (inline script hashes included), except that the API origin is a
//! placeholder: it is a runtime setting here (`config.rs`), not a build one.
//! The shell fills it in as it serves `index.html`.

/// Must match `DESKTOP_API_ORIGIN_PLACEHOLDER` in `apps/console/vite-csp.ts`.
pub const API_ORIGIN_PLACEHOLDER: &str = "__OPENEDBOT_DESKTOP_API_ORIGIN__";

/// Replaces the placeholder in an HTML document. `api_origin` comes out of
/// `config::validate_origin`: an ASCII origin without space, quote or `;`,
/// so it cannot break out of the directive.
pub fn fill(html: &[u8], api_origin: &str) -> Option<Vec<u8>> {
    debug_assert!(api_origin.bytes().all(|byte| byte.is_ascii_graphic() && byte != b'"' && byte != b';' && byte != b'\''));
    let text = std::str::from_utf8(html).ok()?;
    text.contains(API_ORIGIN_PLACEHOLDER).then(|| text.replace(API_ORIGIN_PLACEHOLDER, api_origin).into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_every_directive_and_leaves_other_documents_alone() {
        let html = format!(r#"<meta http-equiv="Content-Security-Policy" content="connect-src 'self' {API_ORIGIN_PLACEHOLDER}; img-src {API_ORIGIN_PLACEHOLDER}">"#);
        let filled = String::from_utf8(fill(html.as_bytes(), "http://127.0.0.1:8790").unwrap()).unwrap();
        assert_eq!(filled.matches("http://127.0.0.1:8790").count(), 2);
        assert!(!filled.contains(API_ORIGIN_PLACEHOLDER));
        assert_eq!(fill(b"<html></html>", "https://api.openedbot.app"), None);
    }
}
