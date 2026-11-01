import Foundation

/// Une notification : ce qui s'est passé, pour quel bot, lue ou non.
struct Notice: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable { case approval, failed, offline, message, finished, back }
    enum Priority: Int, Comparable, Sendable {
        case low, normal, high
        static func < (a: Priority, b: Priority) -> Bool { a.rawValue < b.rawValue }
    }

    var id = UUID()
    let kind: Kind
    let botID: String
    let botName: String
    /// Le détail : la commande à autoriser, l'extrait du message, le titre du run.
    var text: String
    var at: Date
    var read = false
    /// La demande d'accord visée, pour la retirer de la file une fois répondue.
    var approvalID: UUID?

    var priority: Priority {
        switch kind {
        case .approval, .failed, .offline: .high
        case .message, .finished: .normal
        case .back: .low
        }
    }

    /// Combien de temps la bannière reste ; nil : jusqu'à la réponse (demande d'accord) ; 0 : pas de bannière.
    var bannerSeconds: Double? {
        switch kind {
        case .approval: nil
        case .failed, .offline: 10
        case .message, .finished: 6
        case .back: 0
        }
    }

    var title: String {
        switch kind {
        case .approval: tr("\(botName) needs your approval", "\(botName) attend ton accord")
        case .failed: tr("\(botName): run failed", "\(botName) : run en échec")
        case .offline: tr("\(botName): runtime offline", "\(botName) : runtime hors ligne")
        case .message: tr("\(botName) replied", "\(botName) a répondu")
        case .finished: tr("\(botName) is done", "\(botName) a fini")
        case .back: tr("\(botName): runtime back online", "\(botName) : runtime de retour")
        }
    }

    var symbol: String {
        switch kind {
        case .approval: "exclamationmark.triangle.fill"
        case .failed: "xmark.octagon.fill"
        case .offline: "bolt.horizontal.circle.fill"
        case .message: "bubble.left.fill"
        case .finished: "checkmark.circle.fill"
        case .back: "checkmark.circle"
        }
    }

    /// Le son macOS joué à l'arrivée ; nil : silence.
    var sound: String? {
        switch kind {
        case .approval: "Funk"
        case .failed, .offline: "Basso"
        case .message, .finished: "Glass"
        case .back: nil
        }
    }
}

/// La boîte : la seule source de vérité des notifications, en mémoire. Les plus récentes d'abord.
/// La file des bannières est séparée : une notification peut rester non lue après sa bannière.
struct Inbox: Equatable, Sendable {
    static let capacity = 50
    private(set) var notices: [Notice] = []
    /// Les notifications qui attendent leur bannière.
    private(set) var queue: [UUID] = []

    var unread: [Notice] { notices.filter { !$0.read } }
    var unreadCount: Int { notices.reduce(0) { $0 + ($1.read ? 0 : 1) } }

    /// Ajoute une notification. Une demande d'accord déjà connue n'est pas doublée ; une notification
    /// basse est enregistrée comme lue (pas de badge pour un runtime qui revient).
    mutating func add(_ notice: Notice) {
        if let a = notice.approvalID, notices.contains(where: { $0.approvalID == a }) { return }
        var n = notice
        if n.priority == .low { n.read = true }
        notices.insert(n, at: 0)
        if n.bannerSeconds != 0 { queue.append(n.id) }
        if notices.count > Self.capacity {
            let dropped = notices[Self.capacity...].map(\.id)
            notices.removeLast(notices.count - Self.capacity)
            queue.removeAll { dropped.contains($0) }
        }
    }

    /// La prochaine bannière : la plus urgente, puis la plus ancienne. Retirée de la file.
    mutating func nextBanner() -> Notice? {
        let waiting = queue.compactMap { id in notices.first { $0.id == id } }
        guard let next = waiting.enumerated().max(by: { a, b in
            a.element.priority != b.element.priority ? a.element.priority < b.element.priority : a.offset > b.offset
        })?.element else {
            queue.removeAll()
            return nil
        }
        queue.removeAll { $0 == next.id }
        return next
    }

    /// Vide la file sans montrer les bannières (le récapitulatif d'absence les remplace) ;
    /// les notifications restent non lues.
    mutating func drainQueue() -> [Notice] {
        let drained = queue.compactMap { id in notices.first { $0.id == id } }
        queue.removeAll()
        return drained
    }

    mutating func markRead(_ id: UUID) {
        if let i = notices.firstIndex(where: { $0.id == id }) { notices[i].read = true }
    }

    mutating func markAllRead() {
        for i in notices.indices { notices[i].read = true }
        queue.removeAll()
    }

    /// Les notifications lues s'effacent d'elles-mêmes (à la fermeture du panneau). Celles des demandes
    /// d'accord encore ouvertes restent : elles empêchent la même demande de revenir comme nouvelle.
    mutating func removeRead(keepingApprovals open: Set<UUID>) {
        remove { n in n.read && !(n.approvalID.map(open.contains) ?? false) }
    }

    /// « Effacer » : tout part, lu ou non, sauf les demandes d'accord encore ouvertes.
    mutating func clear(keepingApprovals open: Set<UUID>) {
        remove { n in !(n.approvalID.map(open.contains) ?? false) }
    }

    private mutating func remove(where drop: (Notice) -> Bool) {
        let dropped = Set(notices.filter(drop).map(\.id))
        guard !dropped.isEmpty else { return }
        notices.removeAll { dropped.contains($0.id) }
        queue.removeAll { dropped.contains($0) }
    }

    /// Une demande d'accord répondue (ici, dans la fenêtre ou ailleurs) : lue, et plus de bannière.
    mutating func resolveApproval(_ approvalID: UUID) {
        for i in notices.indices where notices[i].approvalID == approvalID {
            notices[i].read = true
            queue.removeAll { $0 == notices[i].id }
        }
    }
}

/// Ce que l'île montre en dehors du panneau : une notification, ou le récapitulatif d'une absence.
enum Banner: Equatable, Sendable {
    case notice(Notice)
    case recap(count: Int, latest: Notice)

    var id: UUID {
        switch self {
        case .notice(let n): n.id
        case .recap(_, let latest): latest.id
        }
    }
}

/// Es-tu devant l'écran ? Verrouillé, endormi ou sans clavier ni souris depuis deux minutes : non.
enum Presence {
    static let idleLimit: TimeInterval = 120

    static func isAway(locked: Bool, asleep: Bool, idleSeconds: TimeInterval) -> Bool {
        locked || asleep || idleSeconds >= idleLimit
    }

    /// Au retour : une seule bannière. Rien en file : rien ; une : elle ; plusieurs : un récapitulatif.
    static func returnBanner(_ waiting: [Notice]) -> Banner? {
        guard let latest = waiting.max(by: { $0.at < $1.at }) else { return nil }
        if waiting.count == 1 { return .notice(latest) }
        // Une demande d'accord passe devant le récapitulatif : elle attend une réponse.
        if let approval = waiting.first(where: { $0.kind == .approval }) { return .notice(approval) }
        return .recap(count: waiting.count, latest: latest)
    }
}

/// Les nouveaux messages des bots entre deux états du roster, sans les historiques chargés après coup.
enum MessageDiff {
    struct Reply: Equatable, Sendable {
        var botID: String
        var botName: String
        var text: String
        var at: Date
        var count: Int
    }

    /// Les identifiants des messages écrits par le bot (fil openedbot, ou lignes locales en démo).
    static func botMessageIDs(_ bot: Bot) -> Set<String> {
        var ids = Set(bot.thread.filter { $0.role == .bot }.map { $0.remoteID ?? $0.id.uuidString })
        if let c = bot.conversation {
            ids.formUnion(c.messages.filter { $0.role == .assistant || $0.authorBotID == bot.id }.map(\.id))
        }
        return ids
    }

    /// Une réponse par bot au plus (la plus récente), seulement pour des messages postérieurs à `since` :
    /// une page d'historique chargée en remontant le fil n'est pas une nouveauté.
    static func replies(previous: [String: Set<String>], bots: [Bot], since: Date) -> [Reply] {
        bots.compactMap { bot in
            guard let before = previous[bot.id] else { return nil }
            var fresh: [(text: String, at: Date)] = bot.thread
                .filter { $0.role == .bot && !before.contains($0.remoteID ?? $0.id.uuidString) && $0.at >= since }
                .map { ($0.text, $0.at) }
            if let c = bot.conversation {
                fresh += c.messages
                    .filter { ($0.role == .assistant || $0.authorBotID == bot.id) && !before.contains($0.id) && $0.at >= since }
                    .map { ($0.text, $0.at) }
            }
            guard let latest = fresh.max(by: { $0.at < $1.at }) else { return nil }
            return Reply(botID: bot.id, botName: bot.name, text: excerpt(latest.text), at: latest.at, count: fresh.count)
        }
    }

    /// Une ligne lisible : sans markdown lourd, coupée à 160 caractères.
    static func excerpt(_ text: String) -> String {
        let flat = text.replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespaces)
        return flat.count > 160 ? String(flat.prefix(159)) + "…" : flat
    }
}
