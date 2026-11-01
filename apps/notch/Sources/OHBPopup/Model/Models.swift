import Foundation
import SwiftUI

// MARK: - Le domaine openedbot, réduit à ce que l'encoche montre

enum RunKind: String, Sendable, Equatable {
    case dm, group, routine
    var label: String {
        switch self { case .dm: "DM"; case .group: tr("Group", "Groupe"); case .routine: "Routine" }
    }
}

/// `ProductRunStatus` d'openedbot, sans les états internes de réconciliation.
enum RunStatus: String, Sendable, Equatable {
    case queued, running, awaitingApproval, completed, failed

    var word: String {
        switch self {
        case .queued: tr("queued", "en file")
        case .running: tr("working", "travaille")
        case .awaitingApproval: tr("waiting", "attend")
        case .completed: tr("done", "terminé")
        case .failed: tr("failed", "échec")
        }
    }
}

struct BotRun: Identifiable, Equatable, Sendable {
    let id: String
    var kind: RunKind
    var title: String
    var detail: String
    var status: RunStatus
    var usedSteps: Int
    var maxSteps: Int
    var tokens: Int
    var since: Date

    var progress: Double { maxSteps > 0 ? min(1, Double(usedSteps) / Double(maxSteps)) : 0 }
    var stepText: String { "\(usedSteps)/\(maxSteps)" }
    var name: String { "\(kind.label) · \(title)" }
    var isLive: Bool { status == .running || status == .awaitingApproval || status == .queued }
}

/// `ApprovalRequestDto` en attente : l'API ne connaît que `once` et `deny`.
struct Approval: Identifiable, Equatable, Sendable {
    var id = UUID()
    /// L'identifiant openedbot (`POST /api/approvals/:id/respond`) ; nil pour la démo.
    var remoteID: String?
    let botID: String
    let runID: String
    let tool: String
    let command: String
    var expiresAt: Date
}

/// Ce que `RuntimeLinkDto` et `BotDto` disent du runtime d'un bot.
struct BotRuntime: Equatable, Sendable {
    var name: String
    var model: String
    /// `permissionMode` : auto, manuel, plan, bypass.
    var mode: String
    var connected: Bool
    var lastSeenAt: Date
    var connectorVersion: String
    var latestVersion: String?
    var downSince: Date?

    var outdated: Bool { latestVersion.map { ConnectorVersion.isNewer($0, than: connectorVersion) } ?? false }
}

/// Les versions du connecteur (`v0.5.9`, `0.6.0-rc.1`). Le serveur peut annoncer une « dernière » version
/// plus ancienne que celle installée (connecteur publié avant le manifeste) : seule une version plus
/// récente vaut une mise à jour.
enum ConnectorVersion {
    static func isNewer(_ candidate: String, than installed: String) -> Bool {
        guard let new = parse(candidate), let old = parse(installed) else { return false }
        for i in 0..<max(new.core.count, old.core.count) {
            let n = i < new.core.count ? new.core[i] : 0, o = i < old.core.count ? old.core[i] : 0
            if n != o { return n > o }
        }
        // À cœur égal, une version publiée passe avant sa préversion.
        switch (new.pre, old.pre) {
        case (nil, .some): return true
        case let (.some(n), .some(o)): return n.compare(o, options: .numeric) == .orderedDescending
        default: return false
        }
    }

    /// nil si la version n'est pas de la forme `[v]1.2.3[-pré][+build]` : on n'annonce rien plutôt qu'à tort.
    private static func parse(_ raw: String) -> (core: [Int], pre: String?)? {
        var text = raw.trimmingCharacters(in: .whitespaces)
        if text.first == "v" || text.first == "V" { text.removeFirst() }
        if let plus = text.firstIndex(of: "+") { text = String(text[..<plus]) }
        let parts = text.split(separator: "-", maxSplits: 1)
        guard let head = parts.first else { return nil }
        let core = head.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard !core.isEmpty, core.allSatisfy({ $0 != nil }) else { return nil }
        return (core.compactMap { $0 }, parts.count > 1 ? String(parts[1]) : nil)
    }
}

struct BotRoutine: Equatable, Sendable {
    var name: String
    var next: String
}

enum MessageRole: Sendable, Equatable { case user, bot, tool, system }

struct ChatMessage: Identifiable, Equatable, Sendable {
    var id = UUID()
    /// L'identifiant du message openedbot ; nil pour la démo et les lignes locales.
    var remoteID: String?
    /// Le run qui a produit la ligne, pour le direct ; nil sinon.
    var runID: String?
    let role: MessageRole
    let text: String
    var at = Date()
    /// Les noms des pièces jointes au message, pour les montrer sous la bulle.
    var attachments: [String] = []
}

struct BotSection: Identifiable, Equatable, Sendable, Hashable {
    let id: String
    let name: String
}

/// Ce que l'anneau dit du bot ; l'attente prime sur tout, le runtime tombé sur le reste.
enum BotActivity: Equatable, Sendable {
    case working, waiting, success, offline, idle

    var word: String {
        switch self {
        case .working: tr("working", "travaille")
        case .waiting: tr("needs your approval", "attend ton accord")
        case .success: tr("done", "terminé")
        case .offline: tr("runtime offline", "runtime hors ligne")
        case .idle: tr("available", "disponible")
        }
    }

    var color: Color {
        switch self {
        case .working: Palette.textPrimary
        case .waiting: Palette.waiting
        case .success: Palette.ample
        case .offline: Palette.critical
        case .idle: Palette.ringTrack
        }
    }

    /// Le point d'état posé sur l'avatar. Au repos, l'anneau garde sa piste grise, mais un point de cette
    /// couleur se lit comme « éteint » : un bot au repos sur un runtime en ligne est joignable, donc vert.
    var dotColor: Color { self == .idle ? Palette.ample : color }

    var isActive: Bool { self != .idle }
}

/// Ce que le run fait à l'instant, d'après le flux : la console le montre sous le fil.
enum LiveActivity: Equatable, Sendable {
    case queued, thinking, writing
    case tool(String)

    var word: String {
        switch self {
        case .queued: tr("queued", "en file")
        case .thinking: tr("thinking", "réfléchit")
        case .writing: tr("writing", "écrit")
        case .tool(let name): tr("using \(name)", "utilise \(name)")
        }
    }
}

struct Bot: Identifiable, Equatable, Sendable {
    let id: String
    var name: String
    /// Le thread openedbot du bot (`POST /api/threads/:threadId/messages`) ; nil pour la démo.
    var threadID: String?
    var sectionID: String?
    /// Identifiant d'artwork openedbot (`bot-<artwork>.webp`).
    var artwork: String?
    var runtime: BotRuntime
    var routine: BotRoutine?
    var runs: [BotRun] = []
    var pending: Approval?
    var thread: [ChatMessage] = []
    var inboxCount = 0
    /// Préférence `notifyOnFinish` du bot.
    var notifyOnFinish = true
    /// Pendant un run suivi en direct ; nil dès que le run conclut.
    var liveActivity: LiveActivity?
    /// Le modèle choisi pour ce bot (`BotDto.model`) et son effort de raisonnement ; nil = global.
    var modelID: String?
    var reasoningEffort: String?
    /// Le visage déclaré par l'API ; nil = celui que la console tire de l'identifiant.
    var face: BotFace?
    /// Le fil openedbot (messages + événements) ; nil en démo, où `thread` suffit.
    var conversation: Conversation?

    var activeRun: BotRun? { runs.first { $0.status == .running || $0.status == .awaitingApproval } }

    var activity: BotActivity {
        if !runtime.connected { return .offline }
        if pending != nil || runs.contains(where: { $0.status == .awaitingApproval }) { return .waiting }
        if runs.contains(where: { $0.status == .running }) { return .working }
        if runs.contains(where: { $0.status == .completed }) { return .success }
        return .idle
    }

    /// L'arc de l'anneau : l'avancement du run en cours, plein quand le dernier a fini.
    var progress: Double {
        if let run = activeRun { return run.progress }
        return activity == .success ? 1 : 0
    }

    var isAlert: Bool { pending != nil || inboxCount > 0 }
    var subtitle: String { "\(runtime.name) · \(runtime.model) · mode \(runtime.mode)" }

    /// Ce que l'app garde en mémoire par bot : l'encoche n'est pas un historique.
    static let threadCap = 200
    static let completedRunsCap = 6

    /// Borne le fil et les runs terminés, les plus récents d'abord : un bot qui tourne
    /// depuis des jours ne doit pas faire grossir l'app indéfiniment.
    mutating func trimHistory() {
        if thread.count > Self.threadCap { thread.removeFirst(thread.count - Self.threadCap) }
        var finished = 0
        runs.removeAll { run in
            if run.isLive { return false }
            finished += 1
            return finished > Self.completedRunsCap
        }
    }
}

// MARK: - Ce que l'encoche montre selon la vue

enum ViewMode: String, CaseIterable, Sendable {
    case sections, active, all
    var title: String {
        switch self { case .sections: tr("By section", "Par section"); case .active: tr("Active only", "Actifs seulement"); case .all: tr("All rings", "Tous les anneaux") }
    }
}

enum NotchItem: Equatable, Sendable {
    case bot(String)
    case pile(BotSection, [String])
    case more([String])

    var botID: String? { if case .bot(let id) = self { return id }; return nil }
}

enum LayoutRules {
    /// Au-delà de ce nombre, la vue « par section » replie les sections en piles.
    static let pileThreshold = 6

    static func items(bots: [Bot], sections: [BotSection], view: ViewMode) -> [NotchItem] {
        let ordered = ordered(bots: bots, sections: sections)
        switch view {
        case .all:
            return ordered.map { .bot($0.id) }
        case .active:
            let active = ordered.filter { $0.activity.isActive || $0.isAlert }
                .sorted { ($0.isAlert ? 0 : 1) < ($1.isAlert ? 0 : 1) }
            var items: [NotchItem] = active.map { .bot($0.id) }
            let rest = ordered.filter { b in !active.contains(where: { $0.id == b.id }) }
            if !rest.isEmpty { items.append(.more(rest.map(\.id))) }
            return items
        case .sections:
            if bots.count <= pileThreshold { return ordered.map { .bot($0.id) } }
            let promoted = ordered.filter(\.isAlert)
            var items: [NotchItem] = promoted.map { .bot($0.id) }
            for section in sections {
                let members = ordered.filter { $0.sectionID == section.id && !$0.isAlert }
                if !members.isEmpty { items.append(.pile(section, members.map(\.id))) }
            }
            // Sans section, ou dont la section a disparu du roster : une pile « Autres », en dernier.
            let orphans = ordered.filter { b in !b.isAlert && !sections.contains(where: { $0.id == b.sectionID }) }
            if !orphans.isEmpty { items.append(.pile(BotSection(id: "", name: tr("Others", "Autres")), orphans.map(\.id))) }
            return items
        }
    }

    /// L'ordre du roster : section par section, puis les bots sans section.
    static func ordered(bots: [Bot], sections: [BotSection]) -> [Bot] {
        var result: [Bot] = []
        for s in sections { result += bots.filter { $0.sectionID == s.id } }
        result += bots.filter { b in !sections.contains(where: { $0.id == b.sectionID }) }
        return result
    }
}

enum ElapsedCopy {
    static func text(since: Date, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(since)))
        if s < 60 { return "\(s) s" }
        if s < 3600 { return "\(s / 60) min" }
        return "\(s / 3600) h \(String(format: "%02d", (s % 3600) / 60))"
    }
}
