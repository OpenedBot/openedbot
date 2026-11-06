use super::*;

#[test]
fn the_zoom_script_carries_a_plain_number() {
    assert!(zoom_script(12.0 / 14.0).ends_with("'--openedbot-native-zoom','0.8571428571428571')"));
    assert!(zoom_script(1.1).contains("'1.1'"));
}

#[test]
fn navigation_stays_on_the_local_origin_and_sends_web_links_out() {
    let decide = |raw: &str| navigation_decision(&Url::parse(raw).unwrap());
    assert_eq!(decide("tauri://localhost/o/acme"), NavigationDecision::Allow);
    assert_eq!(decide("about:blank"), NavigationDecision::Allow);
    assert_eq!(decide("https://github.com/OpenedBot"), NavigationDecision::OpenInBrowser);
    for refused in ["file:///etc/passwd", "javascript:alert(1)", "openedbot://auth/callback", "tauri://evil.example/", "https://user:pw@example.com/", "about:srcdoc"] {
        assert_eq!(decide(refused), NavigationDecision::Refuse, "{refused}");
    }
}

#[test]
fn only_device_preferences_cross_a_sign_out() {
    let kept = device_preferences(r#"{"openedbot:theme":"{\"mode\":\"dark\"}","openedbot:cloud-session":"x","openedbot:locale":"en","openedbot:settings-text-size":12}"#);
    assert_eq!(kept.keys().map(String::as_str).collect::<Vec<_>>(), vec!["openedbot:locale", "openedbot:theme"]);
    assert!(device_preferences("not json").is_empty());
    assert!(device_preferences(&format!(r#"{{"openedbot:locale":"{}"}}"#, "x".repeat(5000))).is_empty());
}

#[test]
fn the_restore_page_cannot_be_broken_out_of() {
    let mut preferences = BTreeMap::new();
    preferences.insert("openedbot:locale".to_string(), "</script><script>alert(1)</script>".to_string());
    let page = restore_page(&preferences, "/login?reason=session-lost");
    assert_eq!(page.matches("</script>").count(), 1, "{page}");
    assert!(page.contains(r#"location.replace("/login?reason=session-lost")"#));
}

#[test]
fn console_paths_stay_on_the_local_origin() {
    assert_eq!(local_url("/login?reason=session-lost").unwrap().as_str(), format!("{}login?reason=session-lost", local_origin()));
    for refused in ["//evil.example/x", "https://evil.example/", "javascript:alert(1)"] {
        assert_eq!(local_url(refused), None, "{refused}");
    }
}

#[test]
fn the_initialization_script_escapes_its_values() {
    let config = ShellConfig {
        api_origin: "http://127.0.0.1:9".into(),
        public_console_url: "https://console.openedbot.app".into(),
        update_url: None,
        popup: false,
    };
    let script = initialization_script(&config, "0.0.1");
    assert!(script.contains(r#"window.__OPENEDBOT_API_ORIGIN__ = "http://127.0.0.1:9";"#));
    assert!(script.contains(r#""version":"0.0.1""#));
    assert!(script.contains(&format!(r#""platform":"{}""#, crate::bridge::Platform::current().as_str())));
}
