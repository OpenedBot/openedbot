import Foundation

/// Une ligne du journal en direct : ce que le flux, l'API et le runtime viennent de faire.
/// Jamais de jeton ni de contenu de message : des noms, des codes, des durées.
struct JournalEntry: Identifiable, Equatable, Sendable {
    enum Level: Sendable { case info, warning, error }
    enum Topic: String, Sendable, CaseIterable {
        case stream = "flux", api = "api", event = "événement", runtime = "runtime", send = "envoi", demo = "démo"

        /// Le nom affiché du sujet ; le `rawValue` français reste l'identifiant stable.
        var label: String {
            switch self {
            case .stream: tr("stream", "flux")
            case .api: "api"
            case .event: tr("event", "événement")
            case .runtime: "runtime"
            case .send: tr("send", "envoi")
            case .demo: tr("demo", "démo")
            }
        }
    }

    let id: UUID
    var at: Date
    let level: Level
    let topic: Topic
    var text: String
    /// Combien de lignes identiques consécutives cette entrée résume (les deltas d'un run).
    var count: Int
    /// Deux entrées consécutives de même clé fusionnent ; nil = jamais.
    let key: String?
}

/// Le journal borné : les dernières lignes, fusionnées quand elles se répètent.
struct Journal: Equatable, Sendable {
    static let capacity = 400
    private(set) var entries: [JournalEntry] = []

    mutating func record(_ level: JournalEntry.Level, _ topic: JournalEntry.Topic, _ text: String, key: String? = nil, at: Date = Date()) {
        if let key, let last = entries.indices.last, entries[last].key == key {
            entries[last].count += 1
            entries[last].at = at
            entries[last].text = text
            return
        }
        entries.append(JournalEntry(id: UUID(), at: at, level: level, topic: topic, text: text, count: 1, key: key))
        // Par paquets : un `removeFirst` à chaque ligne recopierait le tableau à chaque événement.
        if entries.count > Self.capacity + 50 { entries.removeFirst(entries.count - Self.capacity) }
    }

    mutating func clear() { entries.removeAll() }

    /// Le texte à copier : une ligne par entrée, horodatée.
    func export(since: Date? = nil) -> String {
        let f = DateFormatter()
        f.locale = Language.current.locale
        f.dateFormat = "HH:mm:ss"
        return entries.filter { since == nil || $0.at >= since! }.map { e in
            let mark = switch e.level { case .info: " "; case .warning: "!"; case .error: "✗" }
            return "\(f.string(from: e.at)) \(mark) [\(e.topic.label)] \(e.text)\(e.count > 1 ? " ×\(e.count)" : "")"
        }.joined(separator: "\n")
    }
}

/// Le runtime tel que l'encoche le montre dans sa carte « en vie ».
struct RuntimeStatus: Equatable, Sendable {
    var name: String
    var connected: Bool
    /// `reachability` du serveur (direct, relais…), si connue.
    var reachability: String?
    /// `lastHealthStatus` : healthy, degraded…
    var health: String?
    var lastSeenAt: Date?
    var version: String?
    var latestVersion: String?
    var model: String?

    var outdated: Bool {
        guard let version, let latestVersion, !version.isEmpty else { return false }
        return ConnectorVersion.isNewer(latestVersion, than: version)
    }

    init(name: String, connected: Bool, reachability: String? = nil, health: String? = nil, lastSeenAt: Date? = nil,
         version: String? = nil, latestVersion: String? = nil, model: String? = nil) {
        self.name = name; self.connected = connected; self.reachability = reachability; self.health = health
        self.lastSeenAt = lastSeenAt; self.version = version; self.latestVersion = latestVersion; self.model = model
    }

    /// Faute de configuration serveur (démo), le runtime que portent les bots.
    init(_ runtime: BotRuntime) {
        self.init(name: runtime.name, connected: runtime.connected, lastSeenAt: runtime.lastSeenAt,
                  version: runtime.connectorVersion.isEmpty ? nil : runtime.connectorVersion,
                  latestVersion: runtime.latestVersion, model: runtime.model)
    }
}

/// Ce que dit le témoin de l'orbe : une seule couleur pour le flux et le runtime réunis.
enum Liveness: Hashable, Sendable {
    /// Flux en direct et runtime joignable : le point vert respire.
    case alive
    /// Connexion ou reconnexion en cours, ou runtime en retard de version.
    case degraded
    /// Flux arrêté ou runtime hors ligne.
    case down
    /// Démo, ou pas encore de nouvelles.
    case unknown

    static func of(feed: NotchModel.FeedState?, runtime: RuntimeStatus?) -> Liveness {
        if case .failed = feed { return .down }
        if let runtime, !runtime.connected { return .down }
        switch feed {
        case .live: return runtime == nil ? .degraded : .alive
        case .connecting, .retrying: return .degraded
        case .failed: return .down
        case nil: return runtime?.connected == true ? .alive : .unknown
        }
    }
}
