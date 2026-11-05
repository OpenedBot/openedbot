import { randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

// The shell's own journal: a SQLite file in userData (`diagnostics.sqlite`),
// like any desktop app keeps, so an error seen in the window can be read back
// after the fact (`make logs`). Main-process logs, the page's console errors,
// failed loads, renderer crashes and API answers >= 400 land here.
//
// No electron import: the tests drive it with a temporary file. node:sqlite is
// looked up at run time: the Node that runs electron-vite (22) does not list
// it among its builtins, so a static import would not be kept external.

export type DiagnosticLevel = "info" | "warn" | "error";
export type DiagnosticSource = "main" | "page" | "http" | "load" | "renderer";

const MAX_TEXT = 2000;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 20_000;
const PRUNE_EVERY = 500;
const MAX_BUFFERED = 500;
// A page stuck in a render loop logs the same error thousands of times a
// minute: past this many events per source and minute, only a count is kept.
const MAX_PER_MINUTE = 120;

/**
 * Removes what must never be persisted: bearer tokens, JWTs, long opaque
 * strings (refresh tokens, codes, verifiers), URL queries and fragments (an
 * OAuth callback carries its code there) and e-mail addresses.
 */
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s"'?#]*)[?#][^\s"']*/gi, "$1?[redacted]")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .slice(0, MAX_TEXT);
}

/** Origin and path of a URL, never its query; the input itself when it is not a URL. */
export function pathOnly(raw: string): string {
  try {
    const url = new URL(raw);
    // A local file: its name only, the rest is the user's home directory.
    return url.protocol === "file:" ? `file:${url.pathname.split("/").pop() ?? ""}` : `${url.origin}${url.pathname}`;
  } catch {
    return redact(raw);
  }
}

type Entry = { at: number; level: DiagnosticLevel; source: DiagnosticSource; message: string; detail: string | null };

type State = {
  db: DatabaseSync | null;
  disabled: boolean;
  buffer: Entry[];
  launch: string;
  sinceLastPrune: number;
  window: { start: number; counts: Map<DiagnosticSource, number>; dropped: Map<DiagnosticSource, number> };
};

const state: State = {
  db: null,
  disabled: false,
  buffer: [],
  launch: randomUUID(),
  sinceLastPrune: 0,
  window: { start: 0, counts: new Map(), dropped: new Map() },
};

const SCHEMA = `
  create table if not exists events (
    id      integer primary key,
    at      integer not null,
    launch  text    not null,
    level   text    not null,
    source  text    not null,
    message text    not null,
    detail  text
  );
  create index if not exists events_at on events (at);
`;

function connect(file: string): DatabaseSync {
  const { DatabaseSync: Database } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const db = new Database(file);
  try {
    db.exec("pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 2000;");
    db.exec(SCHEMA);
    db.exec("pragma user_version = 1;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function prune(db: DatabaseSync, now: number): void {
  db.prepare("delete from events where at < ?").run(now - RETENTION_MS);
  db.prepare("delete from events where id <= (select max(id) from events) - ?").run(MAX_ROWS);
}

function disable(reason: string): void {
  state.disabled = true;
  state.buffer = [];
  try {
    state.db?.close();
  } catch {
    // Already unusable: nothing more to release.
  }
  state.db = null;
  console.warn("[openedbot-desktop]", `diagnostics journal disabled (${reason}); logs go to the console only`);
}

function insert(db: DatabaseSync, entry: Entry): void {
  db.prepare("insert into events (at, launch, level, source, message, detail) values (?, ?, ?, ?, ?, ?)").run(
    entry.at,
    state.launch,
    entry.level,
    entry.source,
    entry.message,
    entry.detail,
  );
}

function write(entry: Entry): void {
  if (state.disabled) return;
  if (!state.db) {
    // Before openDiagnostics (config errors, the dev lock): keep the first ones.
    if (state.buffer.length < MAX_BUFFERED) state.buffer.push(entry);
    return;
  }
  try {
    insert(state.db, entry);
    if (++state.sinceLastPrune >= PRUNE_EVERY) {
      state.sinceLastPrune = 0;
      prune(state.db, entry.at);
    }
  } catch (error) {
    // Disk full, file deleted or corrupted under us: stop rather than throw
    // into every caller, and say so once.
    disable(error instanceof Error ? error.message : "write failed");
  }
}

function admit(source: DiagnosticSource, now: number): boolean {
  const window = state.window;
  if (now - window.start >= 60_000) {
    const dropped = [...window.dropped];
    window.start = now;
    window.counts.clear();
    window.dropped.clear();
    for (const [from, count] of dropped) {
      write({ at: now, level: "warn", source: from, message: `${count} more ${from} events dropped in the previous minute`, detail: null });
    }
  }
  const count = (window.counts.get(source) ?? 0) + 1;
  window.counts.set(source, count);
  if (count <= MAX_PER_MINUTE) return true;
  window.dropped.set(source, (window.dropped.get(source) ?? 0) + 1);
  return false;
}

/** Records one event. Never throws; text is redacted and truncated here. */
export function recordDiagnostic(level: DiagnosticLevel, source: DiagnosticSource, message: string, detail?: string): void {
  const now = Date.now();
  if (!admit(source, now)) return;
  write({ at: now, level, source, message: redact(message), detail: detail ? redact(detail) : null });
}

/**
 * Opens (or creates) the journal and flushes what was recorded before. A file
 * that cannot be opened is moved aside once (`.corrupt-<time>`) and replaced:
 * a broken journal must not cost the diagnostics of every later launch.
 */
export function openDiagnostics(file: string, launchDetail: string): void {
  if (state.db || state.disabled) return;
  let db: DatabaseSync;
  try {
    db = connect(file);
  } catch (first) {
    try {
      if (existsSync(file)) renameSync(file, `${file}.corrupt-${Date.now()}`);
      db = connect(file);
      state.buffer.unshift({
        at: Date.now(),
        level: "warn",
        source: "main",
        message: `previous diagnostics journal unreadable, moved aside (${first instanceof Error ? first.message : "error"})`,
        detail: null,
      });
    } catch (second) {
      disable(second instanceof Error ? second.message : "open failed");
      return;
    }
  }
  state.db = db;
  try {
    prune(db, Date.now());
  } catch (error) {
    disable(error instanceof Error ? error.message : "prune failed");
    return;
  }
  const pending = state.buffer;
  state.buffer = [];
  write({ at: Date.now(), level: "info", source: "main", message: "launch", detail: redact(launchDetail) });
  for (const entry of pending) write(entry);
}

export function closeDiagnostics(): void {
  try {
    state.db?.close();
  } catch {
    // Closing at quit: nothing left to do with an error.
  }
  state.db = null;
}

/** Tests only: forget the open file, the buffer and the rate window. */
export function resetDiagnosticsForTests(): void {
  closeDiagnostics();
  state.disabled = false;
  state.buffer = [];
  state.sinceLastPrune = 0;
  state.window = { start: 0, counts: new Map(), dropped: new Map() };
}
