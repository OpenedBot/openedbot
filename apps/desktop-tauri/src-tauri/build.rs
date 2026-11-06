include!("src/bridge_commands.rs");

fn main() {
    ensure_console_dist();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri-build");
}

/// `generate_context!` embeds `../console-dist` and fails without it. A bare
/// `cargo test` or `cargo clippy` (no console build) gets a placeholder page;
/// `scripts/build-mac.ts` always builds the console first and refuses to
/// package the placeholder.
fn ensure_console_dist() {
    let dist = std::path::Path::new("../console-dist");
    if !dist.join("index.html").exists() {
        std::fs::create_dir_all(dist).expect("console-dist");
        std::fs::write(
            dist.join("index.html"),
            "<!doctype html><!-- openedbot-console-placeholder --><title>openedbot preview</title><p>Console not built: run make desktop-tauri-console.</p>\n",
        )
        .expect("placeholder index.html");
    }
    println!("cargo:rerun-if-changed=../console-dist");
}
