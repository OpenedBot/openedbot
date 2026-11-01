import AppKit
import Foundation

/// Autonome (lancée par Launch Services, sa propre connexion) ou hébergée (lancée par openedbot avec
/// `--hosted`, qui garde la session). Le mode hébergé est un second chemin : rien de l'autonome ne
/// change, sauf le refus de tourner à côté d'une autre instance.
enum LaunchMode {
    static let hostedFlag = "--hosted"
    /// Les réglages de la popup hébergée : à part, pour ne jamais écraser ceux de l'autonome.
    static let hostedSuite = "app.openedbot.popup.hosted"
    static let seededKey = "hosted.seededFromStandalone"
    /// Ce que l'hébergée ne reprend pas de l'autonome : l'origine vient de l'hôte, la session aussi.
    static let notSeeded: Set<String> = ["notch.apiOrigin", "notch.sessionFile"]

    static func isHosted(_ arguments: [String] = CommandLine.arguments) -> Bool {
        arguments.dropFirst().contains(hostedFlag)
    }

    /// Les préférences à utiliser. En hébergé, la suite à part est amorcée une fois avec les réglages
    /// de l'autonome (bord, taille, langue…), lus seulement : la suite vit ensuite sa vie.
    static func preferences(hosted: Bool) -> UserDefaults {
        guard hosted, let suite = UserDefaults(suiteName: hostedSuite) else { return .standard }
        let standalone = UserDefaults.standard.persistentDomain(forName: Bundle.main.bundleIdentifier ?? "app.openedbot.popup") ?? [:]
        seed(suite, from: standalone)
        return suite
    }

    static func seed(_ suite: UserDefaults, from standalone: [String: Any]) {
        guard !suite.bool(forKey: seededKey) else { return }
        for (key, value) in standalone where (key.hasPrefix("notch.") || key == Language.defaultsKey) && !notSeeded.contains(key) {
            if suite.object(forKey: key) == nil { suite.set(value, forKey: key) }
        }
        suite.set(true, forKey: seededKey)
    }

    /// Une autre popup déjà lancée (autonome ou hébergée) : même identifiant, autre processus.
    /// Deux encoches au même bord se recouvriraient ; la dernière arrivée s'efface.
    @MainActor
    static func otherInstance() -> NSRunningApplication? {
        guard let id = Bundle.main.bundleIdentifier else { return nil }
        let me = ProcessInfo.processInfo.processIdentifier
        return NSRunningApplication.runningApplications(withBundleIdentifier: id).first { $0.processIdentifier != me && !$0.isTerminated }
    }

    /// La version annoncée à l'hôte dans `ready`.
    static var version: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String).map { String($0.prefix(64)) } ?? "dev"
    }
}
