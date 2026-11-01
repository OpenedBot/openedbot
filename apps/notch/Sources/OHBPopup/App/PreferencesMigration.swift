import Foundation

/// L'encoche a vécu un temps sous `app.openedbot.notch` ; elle est `app.openedbot.popup`. Au premier lancement
/// sous le nouvel identifiant, ses réglages (`notch.*` : bord, taille, serveur…) sont repris une fois.
/// L'ancien domaine n'est pas effacé ici : c'est à l'opérateur de le supprimer.
enum PreferencesMigration {
    static let legacyDomain = "app.openedbot.notch"
    static let doneKey = "notch.migratedFromLegacyDomain"

    static func run(into defaults: UserDefaults = .standard, legacy: [String: Any]? = UserDefaults.standard.persistentDomain(forName: legacyDomain)) {
        guard !defaults.bool(forKey: doneKey) else { return }
        for (key, value) in legacy ?? [:] where key.hasPrefix("notch.") && defaults.object(forKey: key) == nil {
            defaults.set(value, forKey: key)
        }
        defaults.set(true, forKey: doneKey)
    }
}
