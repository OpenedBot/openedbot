//! Writes the TypeScript bindings of the native bridge:
//! `cargo run --example export-bindings -- <path>` (`make desktop-tauri-bindings`).

fn main() {
    let path = std::env::args().nth(1).expect("usage: export-bindings <path>");
    std::fs::write(&path, openedbot_desktop::bridge::bindings_typescript()).expect("write bindings");
    println!("bindings written to {path}");
}
