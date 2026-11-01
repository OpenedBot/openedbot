import Foundation
import Observation

/// The interface language. English unless the user picks French in Settings › General.
enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    case en, fr

    var id: String { rawValue }
    /// Each language names itself, so the picker stays readable whatever language is active.
    var nativeName: String { self == .en ? "English" : "Français" }
    var locale: Locale { Locale(identifier: self == .en ? "en_US" : "fr_FR") }
}

/// The active language, shared by SwiftUI views (observed), AppKit menus (notification) and the
/// model code that writes user-facing text (journal lines, errors). Thread-safe: the feed writes
/// from background tasks.
final class Language: Observable, @unchecked Sendable {
    static let shared = Language()
    static let defaultsKey = "app.language"

    /// Forces a language for the current task only (tests run in parallel; a global switch would race).
    @TaskLocal static var override: AppLanguage?

    /// The language every string should use right now.
    static var current: AppLanguage { override ?? shared.value }

    private let registrar = ObservationRegistrar()
    private let lock = NSLock()
    private var stored: AppLanguage = .en
    /// Where the choice is saved; nil until `load(from:)`, so tests never write preferences.
    private var defaults: UserDefaults?

    var value: AppLanguage {
        get {
            registrar.access(self, keyPath: \.value)
            return lock.withLock { stored }
        }
        set {
            let changed = lock.withLock { () -> Bool in
                guard stored != newValue else { return false }
                return true
            }
            guard changed else { return }
            registrar.withMutation(of: self, keyPath: \.value) { lock.withLock { stored = newValue } }
            defaults?.set(newValue.rawValue, forKey: Self.defaultsKey)
            NotificationCenter.default.post(name: .languageDidChange, object: nil)
        }
    }

    /// Reads the saved choice (English when none or unknown) and saves later changes there.
    func load(from defaults: UserDefaults) {
        let saved = defaults.string(forKey: Self.defaultsKey).flatMap(AppLanguage.init(rawValue:)) ?? .en
        registrar.withMutation(of: self, keyPath: \.value) { lock.withLock { stored = saved } }
        self.defaults = defaults
    }
}

extension Notification.Name {
    /// Posted after the language changes; AppKit menus and window titles rebuild on it.
    static let languageDidChange = Notification.Name("app.openedbot.popup.languageDidChange")
}

/// The text in the active language. Both versions sit at the call site, so a missing translation
/// cannot happen and the French copy stays greppable next to the English one.
func tr(_ en: String, _ fr: String) -> String {
    Language.current == .fr ? fr : en
}
