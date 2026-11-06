//! A small file logger: `~/Library/Logs/<bundle id>/<file>` (`preview.log`,
//! `openedbot.log` for the production app, `identity.rs`), one line per
//! record, never a token (callers log kinds and codes only). Warnings and
//! errors are copied to the diagnostics journal (`diagnostics.rs`).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

struct FileLogger {
    file: Mutex<std::fs::File>,
}

impl log::Log for FileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info && metadata.target().starts_with("openedbot")
            || metadata.level() <= log::Level::Warn
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let now = OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default();
        let line = format!("{now} {} [{}] {}\n", record.level(), record.target(), record.args());
        if let Ok(mut file) = self.file.lock() {
            let _ = file.write_all(line.as_bytes());
        }
        // The shell's warnings and errors also go to the SQLite journal.
        let level = match record.level() {
            log::Level::Error => Some(crate::diagnostics::Level::Error),
            log::Level::Warn => Some(crate::diagnostics::Level::Warn),
            _ => None,
        };
        if let Some(level) = level {
            crate::diagnostics::record(level, crate::diagnostics::Source::Main, &record.args().to_string(), Some(record.target()));
        }
        if cfg!(debug_assertions) {
            eprint!("{line}");
        }
    }

    fn flush(&self) {
        if let Ok(mut file) = self.file.lock() {
            let _ = file.flush();
        }
    }
}

/// Installs the logger once; a second call (tests) is a no-op.
pub fn init(dir: PathBuf, file_name: &str) -> Option<PathBuf> {
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(file_name);
    let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).ok()?;
    let logger = Box::leak(Box::new(FileLogger { file: Mutex::new(file) }));
    if log::set_logger(logger).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    Some(path)
}
