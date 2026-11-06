//! The shell's own journal, as in the Electron shell
//! (`apps/desktop/src/main/diagnostics.ts`): `diagnostics.sqlite` in the app
//! data directory, so an error seen in the window can be read back after the
//! fact. The shell's warnings and errors, the page's errors and failed API
//! calls (relayed by the bridge, `report_diagnostic`), and a WebView content
//! process that died land here, redacted, rate limited, kept 14 days.

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_TEXT: usize = 2000;
const RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);
const MAX_ROWS: i64 = 20_000;
const PRUNE_EVERY: u32 = 500;
const MAX_BUFFERED: usize = 500;
/// Past this many events per source and minute, only a count is kept: a page
/// stuck in a render loop logs the same error thousands of times.
const MAX_PER_MINUTE: u32 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Main,
    Page,
    Http,
    Load,
    Renderer,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Page => "page",
            Self::Http => "http",
            Self::Load => "load",
            Self::Renderer => "renderer",
        }
    }
}

/// Removes what must never be persisted: bearer tokens, JWTs, long opaque
/// strings (refresh tokens, codes, verifiers), URL queries and fragments (an
/// OAuth callback carries its code there) and e-mail addresses. Same rules as
/// the Electron journal, without a regex engine.
pub fn redact(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    // Any whitespace separates words: a URL after a line break is still a URL.
    let mut words = text.split(char::is_whitespace).peekable();
    while let Some(word) = words.next() {
        if word.eq_ignore_ascii_case("bearer") && words.peek().is_some_and(|next| !next.is_empty()) {
            words.next();
            out.push("Bearer [redacted]".into());
            continue;
        }
        out.push(redact_word(word));
    }
    let joined = out.join(" ");
    let mut end = joined.len().min(MAX_TEXT);
    while !joined.is_char_boundary(end) {
        end -= 1;
    }
    joined[..end].to_string()
}

fn redact_word(word: &str) -> String {
    // A URL keeps its scheme, host and path, never its query or fragment,
    // even inside punctuation: `(https://…?code=…)`, `"https://…#…",`.
    if let Some(separator) = word.find("://") {
        let scheme_start = word[..separator].rfind(|c: char| !(c.is_ascii_alphanumeric() || "+.-".contains(c))).map_or(0, |at| at + 1);
        if scheme_start < separator {
            if let Some(cut) = word[separator..].find(['?', '#']).map(|at| separator + at) {
                let rest = &word[cut..];
                let closing = &rest[rest.trim_end_matches(|c: char| ")]}>\"'.,;:".contains(c)).len()..];
                return format!("{}?[redacted]{closing}", redact_runs(&word[..cut]));
            }
        }
    }
    if let Some(at) = word.find('@') {
        let (local, domain) = (&word[..at], &word[at + 1..]);
        if !local.is_empty() && domain.contains('.') && !domain.starts_with('.') {
            return "[email]".into();
        }
    }
    redact_runs(word)
}

/// Any run of 40+ token characters (`[A-Za-z0-9_-]`, dots allowed inside a JWT).
fn redact_runs(word: &str) -> String {
    let token_char = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let mut out = String::with_capacity(word.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.len() >= 40 || (run.starts_with("eyJ") && run.matches('.').count() == 2) {
            out.push_str(if run.starts_with("eyJ") { "[jwt]" } else { "[redacted]" });
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in word.chars() {
        if token_char(c) || (c == '.' && run.starts_with("eyJ")) {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

struct Entry {
    at: i64,
    level: Level,
    source: Source,
    message: String,
    detail: Option<String>,
}

struct Window {
    start: i64,
    counts: std::collections::HashMap<Source, u32>,
    dropped: std::collections::HashMap<Source, u32>,
}

struct Journal {
    db: Option<Connection>,
    disabled: bool,
    buffer: Vec<Entry>,
    launch: String,
    since_prune: u32,
    window: Window,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or(0)
}

const SCHEMA: &str = "
  pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 2000;
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
  pragma user_version = 1;
";

fn connect(path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    db.execute_batch(SCHEMA)?;
    Ok(db)
}

fn prune(db: &Connection, now: i64) -> rusqlite::Result<()> {
    db.execute("delete from events where at < ?1", params![now - RETENTION.as_millis() as i64])?;
    db.execute("delete from events where id <= (select max(id) from events) - ?1", params![MAX_ROWS])?;
    Ok(())
}

impl Journal {
    fn new() -> Self {
        let launch = format!("{:x}-{:x}", now_ms(), std::process::id());
        Self { db: None, disabled: false, buffer: Vec::new(), launch, since_prune: 0, window: Window { start: 0, counts: Default::default(), dropped: Default::default() } }
    }

    fn disable(&mut self, reason: &str) {
        self.disabled = true;
        self.buffer.clear();
        self.db = None;
        eprintln!("[openedbot] diagnostics journal disabled ({reason})");
    }

    fn write(&mut self, entry: Entry) {
        if self.disabled {
            return;
        }
        let Some(db) = &self.db else {
            if self.buffer.len() < MAX_BUFFERED {
                self.buffer.push(entry);
            }
            return;
        };
        let inserted = db.execute(
            "insert into events (at, launch, level, source, message, detail) values (?1, ?2, ?3, ?4, ?5, ?6)",
            params![entry.at, self.launch, entry.level.as_str(), entry.source.as_str(), entry.message, entry.detail],
        );
        let pruned = match inserted {
            Ok(_) => {
                self.since_prune += 1;
                if self.since_prune >= PRUNE_EVERY {
                    self.since_prune = 0;
                    prune(db, entry.at)
                } else {
                    Ok(())
                }
            }
            Err(error) => Err(error),
        };
        // Disk full, file deleted or corrupted under us: stop rather than fail every caller.
        if let Err(error) = pruned {
            self.disable(&error.to_string());
        }
    }

    fn admit(&mut self, source: Source, now: i64) -> bool {
        if now - self.window.start >= 60_000 {
            let dropped: Vec<(Source, u32)> = self.window.dropped.drain().collect();
            self.window.start = now;
            self.window.counts.clear();
            for (from, count) in dropped {
                self.write(Entry { at: now, level: Level::Warn, source: from, message: format!("{count} more {} events dropped in the previous minute", from.as_str()), detail: None });
            }
        }
        let count = self.window.counts.entry(source).or_insert(0);
        *count += 1;
        if *count <= MAX_PER_MINUTE {
            return true;
        }
        *self.window.dropped.entry(source).or_insert(0) += 1;
        false
    }
}

fn journal() -> &'static Mutex<Journal> {
    static JOURNAL: OnceLock<Mutex<Journal>> = OnceLock::new();
    JOURNAL.get_or_init(|| Mutex::new(Journal::new()))
}

fn locked() -> std::sync::MutexGuard<'static, Journal> {
    journal().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Records one event. Never fails; text is redacted and truncated here.
pub fn record(level: Level, source: Source, message: &str, detail: Option<&str>) {
    let now = now_ms();
    let mut journal = locked();
    if !journal.admit(source, now) {
        return;
    }
    journal.write(Entry { at: now, level, source, message: redact(message), detail: detail.map(redact) });
}

/// Opens (or creates) the journal and flushes what was recorded before. A file
/// that cannot be opened is moved aside once (`.corrupt-<time>`) and replaced:
/// a broken journal must not cost the diagnostics of every later launch.
pub fn open(path: &Path, launch_detail: &str) {
    let mut journal = locked();
    if journal.db.is_some() || journal.disabled {
        return;
    }
    let db = match connect(path) {
        Ok(db) => db,
        Err(first) => {
            let aside = path.with_extension(format!("sqlite.corrupt-{}", now_ms()));
            let _ = std::fs::rename(path, aside);
            match connect(path) {
                Ok(db) => {
                    journal.buffer.insert(0, Entry { at: now_ms(), level: Level::Warn, source: Source::Main, message: format!("previous diagnostics journal unreadable, moved aside ({first})"), detail: None });
                    db
                }
                Err(second) => return journal.disable(&second.to_string()),
            }
        }
    };
    if let Err(error) = prune(&db, now_ms()) {
        return journal.disable(&error.to_string());
    }
    journal.db = Some(db);
    let pending = std::mem::take(&mut journal.buffer);
    journal.write(Entry { at: now_ms(), level: Level::Info, source: Source::Main, message: "launch".into(), detail: Some(redact(launch_detail)) });
    for entry in pending {
        journal.write(entry);
    }
}

#[cfg(test)]
pub fn reset_for_tests() {
    *locked() = Journal::new();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_tokens_queries_and_addresses() {
        let long = "a".repeat(48);
        let text = format!(
            "GET https://api.openedbot.app/api/x?code=abc#frag failed for dev@openedbot.local with Bearer {long} and eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl, refresh {long}"
        );
        let redacted = redact(&text);
        assert!(redacted.contains("https://api.openedbot.app/api/x?[redacted]"), "{redacted}");
        assert!(redacted.contains("[email]") && redacted.contains("Bearer [redacted]") && redacted.contains("[jwt]"), "{redacted}");
        for leaked in ["code=abc", "frag", "dev@openedbot.local", long.as_str(), "eyJhbGciOi"] {
            assert!(!redacted.contains(leaked), "{leaked} in {redacted}");
        }
        assert_eq!(redact(&"é".repeat(3000)).len(), MAX_TEXT);
    }

    #[test]
    fn redacts_a_url_query_inside_punctuation_or_after_a_line_break() {
        assert_eq!(redact("Failed (https://example.com/callback?code=123456#private)"), "Failed (https://example.com/callback?[redacted])");
        assert_eq!(redact("open \"http://127.0.0.1:47813/callback?state=s&code=c\","), "open \"http://127.0.0.1:47813/callback?[redacted]\",");
        assert_eq!(redact("load failed:\nhttps://accounts.google.com/o?client_id=x"), "load failed: https://accounts.google.com/o?[redacted]");
        // Not a URL: a bare `://` keeps the word as it is.
        assert_eq!(redact("odd ://x?y"), "odd ://x?y");
    }

    // One test touches the process-wide journal: no parallel interference.
    #[test]
    fn journal_buffers_writes_rate_limits_and_survives_a_corrupt_file() {
        reset_for_tests();
        let dir = std::env::temp_dir().join(format!("openedbot-diagnostics-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("diagnostics.sqlite");
        std::fs::write(&path, b"not a sqlite file, not at all, really not").unwrap();

        record(Level::Error, Source::Page, "before open, token Bearer secret-value", None);
        open(&path, "openedbot preview 0.0.0");
        for index in 0..200 {
            record(Level::Warn, Source::Http, &format!("GET /api/x {index} 500"), Some("fetch"));
        }
        let db = Connection::open(&path).unwrap();
        let count = |source: &str| -> i64 { db.query_row("select count(*) from events where source = ?1", [source], |row| row.get(0)).unwrap() };
        assert_eq!(count("http"), i64::from(MAX_PER_MINUTE));
        assert_eq!(count("page"), 1);
        let page: String = db.query_row("select message from events where source = 'page'", [], |row| row.get(0)).unwrap();
        assert!(!page.contains("secret-value"), "{page}");
        let launches: i64 = db.query_row("select count(*) from events where message = 'launch'", [], |row| row.get(0)).unwrap();
        assert_eq!(launches, 1);
        assert!(std::fs::read_dir(&dir).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().contains("corrupt-")));
        reset_for_tests();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
