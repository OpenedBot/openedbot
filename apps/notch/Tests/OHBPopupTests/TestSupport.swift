import Foundation

/// Ce que les tests laissent derrière eux : rien. Préférences en mémoire, éléments de trousseau du
/// service de test effacés à la fin du processus.
enum TestSupport {
    static let keychainService = "app.openedbot.popup.tests"
    private static let registered: Void = { atexit { TestSupport.cleanUp() } }()

    /// Des préférences propres au test, en mémoire : aucun fichier dans ~/Library/Preferences.
    /// (Un domaine `suiteName` laissait un plist, réécrit par cfprefsd après la fin du processus.)
    static func defaults(_ prefix: String) -> UserDefaults {
        _ = registered
        return InMemoryDefaults(memory: ())!
    }

    static func cleanUp() {
        // Tous les éléments du service de test, un par un (`security` n'en supprime qu'un par appel).
        for _ in 0..<1000 {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/security")
            p.arguments = ["delete-generic-password", "-s", keychainService]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            guard (try? p.run()) != nil else { break }
            p.waitUntilExit()
            if p.terminationStatus != 0 { break }
        }
    }
}


/// Un `UserDefaults` entièrement en mémoire : les accesseurs (`string`, `bool`, `double`…) passent par
/// `object(forKey:)`, rien n'atteint cfprefsd.
final class InMemoryDefaults: UserDefaults, @unchecked Sendable {
    private var store: [String: Any] = [:]
    private let lock = NSLock()

    // `init()` de UserDefaults est un initialiseur de commodité ; le seul désigné est `init?(suiteName:)`.
    init?(memory: Void) { super.init(suiteName: nil) }

    override func object(forKey defaultName: String) -> Any? { lock.withLock { store[defaultName] } }
    override func set(_ value: Any?, forKey defaultName: String) { lock.withLock { store[defaultName] = value } }
    override func removeObject(forKey defaultName: String) { lock.withLock { store[defaultName] = nil } }
    override func string(forKey defaultName: String) -> String? { object(forKey: defaultName) as? String }
    override func bool(forKey defaultName: String) -> Bool { (object(forKey: defaultName) as? Bool) ?? false }
    override func double(forKey defaultName: String) -> Double { (object(forKey: defaultName) as? Double) ?? 0 }
    override func integer(forKey defaultName: String) -> Int { (object(forKey: defaultName) as? Int) ?? 0 }
    override func set(_ value: Bool, forKey defaultName: String) { set(value as Any?, forKey: defaultName) }
    override func set(_ value: Double, forKey defaultName: String) { set(value as Any?, forKey: defaultName) }
    override func set(_ value: Int, forKey defaultName: String) { set(value as Any?, forKey: defaultName) }
    override func dictionaryRepresentation() -> [String: Any] { lock.withLock { store } }
}
