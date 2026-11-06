//! The shell's own preferences (`preferences.json` in the app data
//! directory), as in the Electron shell (`apps/desktop/src/main/preferences.ts`):
//! window placement, stay-on-top, display mode, the console's text zoom,
//! the backend the WebView data belongs to and the idle install of updates. One object for the whole process,
//! written whole (write then rename: a crash mid-write never truncates it).
//!
//! Also the placement rule of the window (`initial_bounds`): the last bounds
//! when they still land on a connected screen, otherwise centred on the
//! primary one (`window.ts:121-142`).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The console's text sizes (10 to 14 px) as page zoom factors, 14 px = 1
/// (`apps/console/src/lib/shell/text-size.ts`).
pub const TEXT_ZOOM_SIZES: [u32; 5] = [10, 11, 12, 13, 14];
pub const DEFAULT_TEXT_ZOOM: f64 = 1.0;

pub fn is_text_zoom(value: f64) -> bool {
    TEXT_ZOOM_SIZES.iter().any(|size| (f64::from(*size) / 14.0 - value).abs() < 1e-9)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DisplayMode {
    /// The console window only.
    #[default]
    Window,
    /// The notch popup only (macOS): the window hides while signed in.
    Popup,
    /// Both.
    Both,
}

/// A window placement in logical points (the global coordinate space of macOS).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub always_on_top: bool,
    pub bounds: Option<Bounds>,
    /// `None` until the user picks one: the configuration decides (`config.popup`).
    pub display_mode: Option<DisplayMode>,
    pub text_zoom: f64,
    /// The API the WebView's stored data belongs to. Another backend at the
    /// next launch purges that data first (`window.rs`): one backend's query
    /// cache never shows on another.
    pub data_origin: Option<String>,
    /// Installs a ready update when the Mac is idle (`update_idle.rs`); on
    /// unless the user turned it off in Settings › Mises à jour.
    pub auto_install_updates: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self { always_on_top: false, bounds: None, display_mode: None, text_zoom: DEFAULT_TEXT_ZOOM, data_origin: None, auto_install_updates: true }
    }
}

impl Preferences {
    /// Drops what a hand-edited or older file got wrong, field by field.
    fn sanitized(mut self) -> Self {
        if !is_text_zoom(self.text_zoom) {
            self.text_zoom = DEFAULT_TEXT_ZOOM;
        }
        if self.bounds.is_some_and(|bounds| ![bounds.x, bounds.y, bounds.width, bounds.height].iter().all(|value| value.is_finite())) {
            self.bounds = None;
        }
        self
    }
}

pub struct PreferenceStore {
    path: Option<PathBuf>,
    current: Mutex<Preferences>,
}

impl PreferenceStore {
    /// Reads `preferences.json` in `dir`; missing or unreadable: defaults. `None`: memory only.
    pub fn open(dir: Option<&Path>) -> Self {
        let path = dir.map(|dir| dir.join("preferences.json"));
        let current = path
            .as_deref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Preferences>(&bytes).ok())
            .unwrap_or_default()
            .sanitized();
        Self { path, current: Mutex::new(current) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Preferences> {
        self.current.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn get(&self) -> Preferences {
        self.lock().clone()
    }

    /// Changes and persists; a write failure is logged, the change kept in memory.
    ///
    /// The lock is held through the write: two updates reach the disk in the
    /// order they changed memory, and never share the temporary file.
    pub fn update(&self, change: impl FnOnce(&mut Preferences)) {
        let mut current = self.lock();
        let before = current.clone();
        change(&mut current);
        if *current == before {
            return;
        }
        let Some(path) = &self.path else { return };
        if let Err(error) = write_atomically(path, &serde_json::to_vec(&*current).expect("preferences serialize")) {
            log::warn!("could not persist preferences ({})", error.kind());
        }
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path)
}

/// A screen's usable area (menu bar and Dock excluded), logical points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub const DEFAULT_WIDTH: f64 = 1280.0;
pub const DEFAULT_HEIGHT: f64 = 820.0;
pub const MIN_WIDTH: f64 = 800.0;
pub const MIN_HEIGHT: f64 = 560.0;
const WIDTH_SHARE: f64 = 0.75;
const HEIGHT_SHARE: f64 = 0.8;
const SCREEN_MARGIN: f64 = 16.0;

fn overlap(bounds: &Bounds, area: &Area) -> f64 {
    let width = (bounds.x + bounds.width).min(area.x + area.width) - bounds.x.max(area.x);
    let height = (bounds.y + bounds.height).min(area.y + area.height) - bounds.y.max(area.y);
    width.max(0.0) * height.max(0.0)
}

/// The last bounds when they still land on a connected screen (a laptop
/// unplugged from its monitor must not reopen off-screen), otherwise centred
/// on the primary screen: a share of it, never below the former fixed size,
/// never past its usable area.
pub fn initial_bounds(saved: Option<Bounds>, areas: &[Area], primary: Area) -> Bounds {
    if let Some(saved) = saved.filter(|saved| saved.width >= MIN_WIDTH && saved.height >= MIN_HEIGHT) {
        // The screen it overlaps most, as Electron's `getDisplayMatching`.
        let best = areas.iter().map(|area| (overlap(&saved, area), area)).filter(|(shared, _)| *shared > 0.0).max_by(|a, b| a.0.total_cmp(&b.0));
        if let Some((_, area)) = best {
            let visible = saved.x < area.x + area.width - SCREEN_MARGIN
                && saved.x + saved.width > area.x + SCREEN_MARGIN
                && saved.y >= area.y - SCREEN_MARGIN
                && saved.y < area.y + area.height - SCREEN_MARGIN;
            if visible {
                return saved;
            }
        }
    }
    let width = (DEFAULT_WIDTH.max((primary.width * WIDTH_SHARE).round())).min(primary.width - 2.0 * SCREEN_MARGIN);
    let height = (DEFAULT_HEIGHT.max((primary.height * HEIGHT_SHARE).round())).min(primary.height - 2.0 * SCREEN_MARGIN);
    Bounds { width, height, x: (primary.x + (primary.width - width) / 2.0).round(), y: (primary.y + (primary.height - height) / 2.0).round() }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Area = Area { x: 0.0, y: 25.0, width: 1512.0, height: 900.0 };
    const MONITOR: Area = Area { x: 1512.0, y: -300.0, width: 2560.0, height: 1415.0 };

    #[test]
    fn keeps_bounds_that_land_on_a_connected_screen() {
        let on_monitor = Bounds { x: 2000.0, y: 0.0, width: 1400.0, height: 900.0 };
        assert_eq!(initial_bounds(Some(on_monitor), &[LAPTOP, MONITOR], LAPTOP), on_monitor);
    }

    #[test]
    fn brings_the_window_back_when_its_screen_is_unplugged() {
        let on_monitor = Bounds { x: 2000.0, y: 0.0, width: 1400.0, height: 900.0 };
        let placed = initial_bounds(Some(on_monitor), &[LAPTOP], LAPTOP);
        assert!(placed.x >= LAPTOP.x && placed.x + placed.width <= LAPTOP.x + LAPTOP.width, "{placed:?}");
        assert!(placed.y >= LAPTOP.y && placed.y + placed.height <= LAPTOP.y + LAPTOP.height, "{placed:?}");
    }

    #[test]
    fn refuses_a_sliver_or_a_title_bar_out_of_reach() {
        // 10 points visible on the right edge of the laptop: not enough to grab.
        let sliver = Bounds { x: 1502.0, y: 100.0, width: 1000.0, height: 700.0 };
        assert_ne!(initial_bounds(Some(sliver), &[LAPTOP], LAPTOP), sliver);
        // The title bar above the top of the screen.
        let too_high = Bounds { x: 100.0, y: -200.0, width: 1000.0, height: 700.0 };
        assert_ne!(initial_bounds(Some(too_high), &[LAPTOP], LAPTOP), too_high);
        // Below the minimum size: not a placement the user made.
        let tiny = Bounds { x: 100.0, y: 100.0, width: 300.0, height: 200.0 };
        assert_ne!(initial_bounds(Some(tiny), &[LAPTOP], LAPTOP), tiny);
    }

    #[test]
    fn the_first_launch_takes_a_share_of_the_screen_within_its_area() {
        let big = Area { x: 0.0, y: 0.0, width: 2560.0, height: 1440.0 };
        let placed = initial_bounds(None, &[big], big);
        assert_eq!((placed.width, placed.height), (1920.0, 1152.0));
        let small = Area { x: 0.0, y: 0.0, width: 1280.0, height: 800.0 };
        let placed = initial_bounds(None, &[small], small);
        assert_eq!((placed.width, placed.height), (1248.0, 768.0));
    }

    #[test]
    fn preferences_survive_a_round_trip_and_drop_bad_fields() {
        let dir = std::env::temp_dir().join(format!("openedbot-prefs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = PreferenceStore::open(Some(&dir));
        assert_eq!(store.get(), Preferences::default());
        store.update(|prefs| {
            prefs.always_on_top = true;
            prefs.text_zoom = 12.0 / 14.0;
            prefs.display_mode = Some(DisplayMode::Both);
        });
        assert!(store.get().auto_install_updates, "the idle install is on by default");
        store.update(|prefs| prefs.auto_install_updates = false);
        let reopened = PreferenceStore::open(Some(&dir)).get();
        assert!(!reopened.auto_install_updates);
        assert!(reopened.always_on_top);
        assert_eq!(reopened.display_mode, Some(DisplayMode::Both));
        assert!(is_text_zoom(reopened.text_zoom));
        std::fs::write(dir.join("preferences.json"), r#"{"textZoom":3,"alwaysOnTop":true,"bounds":{"x":1,"y":2,"width":"wide","height":4}}"#).unwrap();
        // A field of the wrong type makes the file unreadable as a whole: defaults.
        assert_eq!(PreferenceStore::open(Some(&dir)).get(), Preferences::default());
        std::fs::write(dir.join("preferences.json"), r#"{"textZoom":3,"alwaysOnTop":true}"#).unwrap();
        let partly = PreferenceStore::open(Some(&dir)).get();
        assert!(partly.always_on_top);
        assert_eq!(partly.text_zoom, DEFAULT_TEXT_ZOOM);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn concurrent_updates_reach_the_disk_whole_and_in_order() {
        let dir = std::env::temp_dir().join(format!("openedbot-prefs-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = std::sync::Arc::new(PreferenceStore::open(Some(&dir)));
        let writers: Vec<_> = (0..8)
            .map(|writer| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for step in 0..50 {
                        store.update(|prefs| {
                            prefs.data_origin = Some(format!("http://127.0.0.1:{}", 9000 + writer * 100 + step));
                            prefs.always_on_top = !prefs.always_on_top;
                        });
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        // The file is valid JSON and holds the last state in memory, not an older snapshot.
        let on_disk: Preferences = serde_json::from_slice(&std::fs::read(dir.join("preferences.json")).unwrap()).unwrap();
        assert_eq!(on_disk, store.get());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
