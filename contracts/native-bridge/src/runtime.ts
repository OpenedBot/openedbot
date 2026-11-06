/**
 * The two entry points of Tauri the generated bindings call (`invoke`, and
 * the event API), injected by the console's adapter
 * (`apps/console/src/lib/platform/tauri-bridge.ts`, from `@tauri-apps/api`).
 *
 * A contract does no I/O and imports nothing but zod (`.dependency-cruiser.cjs`):
 * the Rust exporter (`apps/desktop-tauri/src-tauri/src/bridge.rs`) points
 * the imports of the tauri-specta output here instead of `@tauri-apps/api`.
 * Until `installTauriRuntime` runs, every call fails with a named error.
 */

export type Event<T> = { event: string; id: number; payload: T };
export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;
export type EventTarget = string | { kind: string; label?: string };

/** A window or webview of `@tauri-apps/api`, as far as the bindings use it. */
export type EventSource = {
  listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn>;
  once<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn>;
  emit(event: string, payload?: unknown): Promise<void>;
  emitTo(target: EventTarget | string, event: string, payload?: unknown): Promise<void>;
};

export type TauriRuntime = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  event: EventSource;
};

let installed: TauriRuntime | null = null;

export class TauriRuntimeMissing extends Error {
  constructor() {
    super("The Tauri runtime is not installed: the native bridge is only available inside the desktop app.");
    this.name = "TauriRuntimeMissing";
  }
}

export function installTauriRuntime(runtime: TauriRuntime): void {
  installed = runtime;
}

function runtime(): TauriRuntime {
  if (!installed) throw new TauriRuntimeMissing();
  return installed;
}

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return runtime().invoke<T>(command, args);
  } catch (error) {
    return Promise.reject(error);
  }
}

export const listen = <T>(event: string, handler: EventCallback<T>) => runtime().event.listen<T>(event, handler);
export const once = <T>(event: string, handler: EventCallback<T>) => runtime().event.once<T>(event, handler);
export const emit = (event: string, payload?: unknown) => runtime().event.emit(event, payload);
export const emitTo = (target: EventTarget | string, event: string, payload?: unknown) => runtime().event.emitTo(target, event, payload);
