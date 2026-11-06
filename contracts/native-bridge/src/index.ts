/**
 * The contract of the desktop app's native bridge (ADR 0001, 4.3 "Pont natif").
 *
 * `bindings.ts` is generated from the Rust commands of
 * `apps/desktop-tauri/src-tauri/src/bridge.rs` by tauri-specta (never edited
 * by hand; `make desktop-tauri-bindings`, checked by `cargo test`). The
 * console reaches it through `apps/console/src/lib/platform/` only.
 */
export * from "./bindings";
export { installTauriRuntime, TauriRuntimeMissing, type TauriRuntime } from "./runtime";
