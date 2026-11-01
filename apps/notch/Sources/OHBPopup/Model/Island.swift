import Foundation

/// Ce que l'île montre, calculé du roster sans rien dessiner : l'état compact autour de la caméra,
/// les lignes du panneau déplié, et les messages brefs (run fini, accord donné).
enum Island {
    /// L'état compact : les avatars des bots actifs à gauche de la caméra, les compteurs à droite.
    struct Compact: Equatable, Sendable {
        /// Au plus trois bots, ceux qui attendent d'abord.
        var botIDs: [String]
        /// Les bots actifs au-delà des trois avatars.
        var extra: Int
        var working: Int
        var waiting: Int
        /// Les notifications non lues : la cloche à droite de la caméra, même sans bot actif.
        var unread: Int = 0
        /// Au repos : rien ne travaille, rien n'attend, tout est lu. L'île montre alors les bots et leur nombre.
        var idle = false
        /// Combien de bots suit l'île.
        var total = 0
    }

    /// L'île au repos reste lisible, comme Vibe Island : les avatars des bots à gauche de la caméra,
    /// leur nombre et l'état de la connexion à droite. Nil seulement quand aucun bot n'est encore connu.
    /// Bots actifs : ceux-là d'abord ; sinon, une notification non lue : l'avatar de son bot.
    static func compact(bots: [Bot], unread: Int = 0, latestUnreadBotID: String? = nil) -> Compact? {
        let waiting = bots.filter { $0.activity == .waiting }
        let working = bots.filter { $0.activity == .working }
        let active = waiting + working
        if active.isEmpty, unread == 0 {
            guard !bots.isEmpty else { return nil }
            return Compact(botIDs: bots.prefix(3).map(\.id), extra: max(0, bots.count - 3),
                           working: 0, waiting: 0, unread: 0, idle: true, total: bots.count)
        }
        let ids = active.isEmpty ? [latestUnreadBotID].compactMap { $0 } : active.prefix(3).map(\.id)
        return Compact(botIDs: ids, extra: max(0, active.count - 3),
                       working: working.count, waiting: waiting.count, unread: unread, total: bots.count)
    }

    /// Un message bref à côté de la caméra, à la place de l'état compact, quelques secondes.
    struct Flash: Equatable, Sendable {
        enum Kind: Equatable, Sendable { case finished, offline, back, allowed, denied }
        var botID: String
        var botName: String
        var kind: Kind

        var symbol: String {
            switch kind {
            case .finished, .allowed: "checkmark"
            case .offline: "exclamationmark.triangle.fill"
            case .back: "circle.fill"
            case .denied: "xmark"
            }
        }

        var text: String {
            switch kind {
            case .finished: tr("Done", "Fini")
            case .offline: tr("Offline", "Hors ligne")
            case .back: tr("Back online", "De retour")
            case .allowed: tr("Allowed", "Autorisé")
            case .denied: tr("Denied", "Refusé")
            }
        }
    }

    /// La largeur de chaque côté de la caméra, d'après ce qu'il contient (les deux côtés sont égaux :
    /// la caméra reste au milieu). Un message bref a besoin de place pour le nom.
    static func sideWidth(compact: Compact?, flash: Flash?, cameraHeight: CGFloat) -> CGFloat {
        let wing = NotchGeometry.islandWing(cameraHeight: cameraHeight)
        if flash != nil { return max(wing, 132) }
        guard let compact else { return wing }
        // Mesures du dessin : avatar à 60 % de la hauteur, chevauchement de 6 pt, chiffres de 7 pt.
        func digits(_ n: Int) -> CGFloat { CGFloat(String(n).count) * 7 }
        let avatar = cameraHeight * 0.6
        let n = CGFloat(compact.botIDs.count)
        var left = 10 + max(0, n * avatar - (n - 1) * 6) + 6
        if compact.extra > 0 { left += 9 + 7 + digits(compact.extra) }
        var items: [CGFloat] = []
        if compact.idle { items.append(6 + 5 + digits(compact.total) + 27) }
        if compact.working > 0 { items.append(cameraHeight * 0.42 + (compact.working > 1 || compact.waiting > 0 ? 3 + digits(compact.working) : 0)) }
        if compact.waiting > 0 { items.append(7 + (compact.waiting > 1 || compact.working > 0 ? 3 + digits(compact.waiting) : 0)) }
        if compact.unread > 0 { items.append(10 + 3 + digits(compact.unread)) }
        let right = 10 + items.reduce(0, +) + CGFloat(max(0, items.count - 1)) * 7 + 6
        return max(wing, left.rounded(.up), right.rounded(.up))
    }

    /// Une ligne du panneau déplié.
    struct Row: Identifiable, Equatable, Sendable {
        let id: String
        var name: String
        var activity: BotActivity
        /// Ce que le bot fait, en une ligne.
        var status: String
        /// Le dernier geste du run en direct (outil, rédaction), sous la ligne.
        var detail: String?
        /// Depuis quand le run en cours tourne.
        var since: Date?
    }

    /// L'ordre du panneau : qui attend, qui travaille, qui a fini, qui est tombé, puis les autres.
    static func rows(bots: [Bot]) -> [Row] {
        func rank(_ a: BotActivity) -> Int {
            switch a { case .waiting: 0; case .working: 1; case .success: 2; case .offline: 3; case .idle: 4 }
        }
        return bots.enumerated()
            .sorted { (rank($0.element.activity), $0.offset) < (rank($1.element.activity), $1.offset) }
            .map { row(for: $0.element) }
    }

    static func row(for bot: Bot) -> Row {
        let run = bot.activeRun
        var status: String
        switch bot.activity {
        case .waiting:
            status = bot.pending.map { tr("Needs your approval: \($0.tool)", "Attend ton accord : \($0.tool)") } ?? bot.activity.word
        case .working:
            status = run.map { "\($0.title) · \(tr("step", "étape")) \($0.stepText)" } ?? bot.activity.word
        case .success:
            status = tr("Done · click to open", "Terminé · cliquer pour ouvrir")
        case .offline, .idle:
            status = bot.activity.word
        }
        var detail: String?
        if bot.activity == .working {
            // Le geste en direct d'openedbot, sinon la dernière ligne d'outil du run (démo).
            detail = bot.liveActivity?.word
                ?? bot.thread.last(where: { $0.role == .tool && ($0.runID == nil || $0.runID == run?.id) })?.text
        }
        return Row(id: bot.id, name: bot.name, activity: bot.activity, status: status, detail: detail, since: run?.since)
    }

    /// Les demandes d'accord à montrer en tête du panneau, deux au plus.
    static func approvals(bots: [Bot]) -> [(bot: Bot, approval: Approval)] {
        Array(bots.compactMap { b in b.pending.map { (bot: b, approval: $0) } }.prefix(2))
    }

    /// « v0.5.7 », que le serveur envoie « 0.5.7 » ou déjà « v0.5.7 ».
    static func version(_ raw: String) -> String {
        raw.isEmpty || raw.hasPrefix("v") ? raw : "v\(raw)"
    }

    /// Les dernières notifications montrées dans le panneau (trois quand une demande d'accord prend la place).
    static let noticeLimit = 5

    /// Combien de lignes le panneau montre avant « + N bots ».
    static let maxRows = 6

    /// La hauteur de la liste des bots : les lignes visibles (plus hautes avec un geste en direct),
    /// au plus `limit` lignes ; le reste défile.
    static func listHeight(rows: [Row], limit: Int) -> CGFloat {
        rows.prefix(limit).reduce(0) { $0 + ($1.detail == nil ? 46 : 60) + 2 }
    }

    /// Les lignes de bots qui tiennent encore sous les demandes d'accord (deux lignes chacune) et les
    /// notifications (une ligne pour deux) : le panneau ne dépasse jamais sa hauteur maximale.
    static func rowLimit(approvals: Int, notices: Int) -> Int {
        max(2, maxRows - 2 * approvals - (notices + 1) / 2)
    }
}
