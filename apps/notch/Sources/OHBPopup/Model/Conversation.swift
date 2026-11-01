import Foundation

/// Le visage d'un bot tel que l'API le décrit (`BotFaceSpec`) : une illustration du catalogue,
/// une image importée (`/api/attachments/…`), ou un visage bloub (couleur, forme, expression).
struct BotFace: Equatable, Sendable, Hashable {
    var artwork: String?
    var palette: String?
    var shape: String?
    var eyes: String?
}

/// Une pièce jointe d'un message, telle que le fil la renvoie (`displayContent`) :
/// la charge n'y est pas, seulement de quoi la demander à `GET /api/attachments/:id`.
struct ConversationAttachment: Equatable, Sendable, Hashable, Identifiable {
    /// nil sur un vieux message, ou sur un envoi pas encore admis : on la montre sans pouvoir l'ouvrir.
    var remoteID: String?
    var name: String
    var contentType: String
    var kind: String
    var bytes: Int?

    var id: String { remoteID ?? "\(name)#\(bytes ?? 0)" }
    var isImage: Bool { kind == "image" || contentType.hasPrefix("image/") }
}

/// Un message persisté du fil.
struct ConversationMessage: Equatable, Sendable, Identifiable {
    enum Role: Sendable { case user, assistant }
    var id: String
    var role: Role
    var text: String
    var attachments: [ConversationAttachment]
    var runID: String?
    var at: Date
    /// Un message écrit par un bot : l'assistant du fil, ou un autre bot (rôle user + auteur).
    var authorBotID: String? = nil
    var authorName: String? = nil
    var authorFace: BotFace? = nil
    var reactions: [MessageReaction] = []
    var replyTo: ReplyQuote? = nil
}

/// Une réaction agrégée d'un message : l'émoji, combien, et si c'est la vôtre.
struct MessageReaction: Equatable, Sendable, Hashable {
    var emoji: String
    var count: Int
    var mine: Bool
}

/// Le message cité au-dessus d'une réponse : qui, et le début de ce qu'il disait.
struct ReplyQuote: Equatable, Sendable, Hashable {
    var messageID: String
    var authorName: String
    var excerpt: String
}

/// Les réactions de la console (`MESSAGE_REACTION_EMOJIS`) ; 👍 et 👎 s'excluent.
enum Reactions {
    static let all = ["👍", "❤️", "😂", "😮", "😢", "🎉", "👎"]
    static let helpful = "👍"
    static let unhelpful = "👎"

    /// Bascule `emoji` pour vous ; 👍 retire 👎 et inversement. Renvoie aussi les émojis à retirer côté serveur.
    static func toggle(_ emoji: String, in reactions: [MessageReaction]) -> (reactions: [MessageReaction], removed: [String], added: Bool) {
        var out = reactions
        var removed: [String] = []
        func drop(_ e: String) {
            guard let i = out.firstIndex(where: { $0.emoji == e }), out[i].mine else { return }
            out[i].count -= 1
            out[i].mine = false
            if out[i].count <= 0 { out.remove(at: i) }
            removed.append(e)
        }
        let active = out.first { $0.emoji == emoji }?.mine == true
        if active {
            drop(emoji)
            return (out, removed, false)
        }
        if emoji == helpful { drop(unhelpful) }
        if emoji == unhelpful { drop(helpful) }
        if let i = out.firstIndex(where: { $0.emoji == emoji }) {
            out[i].count += 1
            out[i].mine = true
        } else {
            out.append(MessageReaction(emoji: emoji, count: 1, mine: true))
        }
        return (out, removed, true)
    }
}

/// Un événement de run (`OrganizationEvent`), réduit à ce que le fil affiche.
struct ConversationEvent: Equatable, Sendable {
    var runID: String
    var sequence: Int
    var type: String
    var at: Date
    var text: String?
    var tool: String?
    var preview: String?
    var toolCallID: String?
    var durationMs: Double?
    var failed: Bool
    var errorMessage: String?
    var resultExcerpt: String?

    var key: String { "\(runID):\(sequence)" }
}

/// Un run du fil : son état et quand il a commencé, pour le chronomètre du direct.
struct ConversationRun: Equatable, Sendable {
    var status: RunStatus
    var startedAt: Date
}

/// Le fil d'un bot comme la console le tient : messages persistés + événements, fusionnés en direct.
struct Conversation: Equatable, Sendable {
    var messages: [ConversationMessage] = []
    var events: [ConversationEvent] = []
    var runs: [String: ConversationRun] = [:]

    /// Ajoute un événement du flux, une seule fois (`runId:sequence`), dans l'ordre du run.
    @discardableResult
    mutating func apply(_ event: ConversationEvent) -> Bool {
        if events.contains(where: { $0.runID == event.runID && $0.sequence == event.sequence }) { return false }
        events.append(event)
        switch event.type {
        case "run.completed": runs[event.runID, default: ConversationRun(status: .completed, startedAt: event.at)].status = .completed
        case "run.error": runs[event.runID, default: ConversationRun(status: .failed, startedAt: event.at)].status = .failed
        case "approval.requested": runs[event.runID, default: ConversationRun(status: .awaitingApproval, startedAt: event.at)].status = .awaitingApproval
        default:
            if runs[event.runID] == nil { runs[event.runID] = ConversationRun(status: .running, startedAt: event.at) }
            else if runs[event.runID]!.status == .queued || runs[event.runID]!.status == .awaitingApproval {
                runs[event.runID]!.status = .running
            }
        }
        return true
    }

    /// Une relecture remplace le fil ; les événements du direct plus récents que le snapshot restent.
    /// Seul le direct d'un run encore en cours survit : un run conclu, ou sorti de la page relue
    /// (`/history` n'en rend que les 15 derniers tours), disparaît avec ses événements.
    mutating func replace(with fresh: Conversation) {
        let known = Set(fresh.events.map(\.key))
        let livePending = events.filter { event in
            guard !known.contains(event.key), isLive(event.runID) else { return false }
            return fresh.runs[event.runID].map { !$0.status.isTerminal } ?? true
        }
        self = fresh
        for event in livePending { apply(event) }
    }

    func isLive(_ runID: String) -> Bool { runs[runID].map { !$0.status.isTerminal } ?? false }
}

extension RunStatus {
    var isTerminal: Bool { self == .completed || self == .failed }
}

// MARK: - Le fil affiché

/// Un appel d'outil, ou plusieurs du même nom à la suite (« ×3 »), comme `groupToolCalls`.
struct ToolCallGroup: Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    var previews: [String]
    var count: Int
    var durationMs: Double
    var failures: Int
    var running: Int
    var firstError: String?
}

/// Un tour d'un bot : ce qu'il a fait (outils, narration) et sa réponse.
struct Turn: Equatable, Sendable, Identifiable {
    enum Step: Equatable, Sendable { case narration(String), tools(ToolCallGroup) }
    var id: String
    var runID: String?
    var authorName: String
    var authorFace: BotFace?
    var authorID: String?
    var at: Date
    /// Tout ce qui précède la réponse finale, quand le tour a utilisé des outils.
    var activity: [Step]
    var answer: String
    var attachments: [ConversationAttachment]
    var live: Bool
    var error: String?
    /// Le dernier événement du tour, pour le libellé du direct (« Utilise web_search… »).
    var lastEventType: String?
    var lastTool: String?
    var startedAt: Date
    /// Le message persisté de la réponse : la cible des réactions, de la réponse citée, de la copie.
    var messageID: String? = nil
    var reactions: [MessageReaction] = []
    var replyTo: ReplyQuote? = nil

    var toolCount: Int { activity.reduce(0) { if case .tools(let g) = $1 { return $0 + g.count } else { return $0 } } }
    var failureCount: Int { activity.reduce(0) { if case .tools(let g) = $1 { return $0 + g.failures } else { return $0 } } }
    var totalDurationMs: Double { activity.reduce(0) { if case .tools(let g) = $1 { return $0 + g.durationMs } else { return $0 } } }
}

enum TimelineItem: Equatable, Sendable, Identifiable {
    case day(Date)
    case user(id: String, text: String, attachments: [ConversationAttachment], at: Date,
              reactions: [MessageReaction] = [], replyTo: ReplyQuote? = nil)
    case turn(Turn)
    /// Un message écrit dans ce fil par un autre bot.
    case inbound(id: String, authorName: String, face: BotFace?, authorID: String?, text: String, at: Date)
    case local(ChatMessage)

    var id: String {
        switch self {
        case .day(let d): "day:\(Int(d.timeIntervalSince1970))"
        case .user(let id, _, _, _, _, _): "user:\(id)"
        case .turn(let t): "turn:\(t.id)"
        case .inbound(let id, _, _, _, _, _): "inbound:\(id)"
        case .local(let m): "local:\(m.id.uuidString)"
        }
    }

    var at: Date? {
        switch self {
        case .day(let d): d
        case .user(_, _, _, let at, _, _): at
        case .turn(let t): t.at
        case .inbound(_, _, _, _, _, let at): at
        case .local(let m): m.at
        }
    }
}

/// Construit le fil affiché à partir des messages et des événements, comme `thread-timeline-model.ts` :
/// le texte d'un tour vient des événements `agent.message` (le direct), sa réponse finale du message
/// persisté quand il existe ; un appel d'outil coupe la narration ; tout ce qui précède la réponse
/// finale d'un tour avec outils part dans le bloc d'activité ; une puce par jour.
enum ThreadTimeline {
    static func build(_ c: Conversation, botName: String, botID: String?, botFace: BotFace?, locals: [ChatMessage],
                      calendar: Calendar = .current) -> [TimelineItem] {
        let eventsByRun = Dictionary(grouping: c.events, by: \.runID).mapValues { $0.sorted { $0.sequence < $1.sequence } }
        let answers = Dictionary(grouping: c.messages.filter { $0.role == .assistant && $0.runID != nil }, by: { $0.runID! })
        var emitted: Set<String> = []
        var items: [TimelineItem] = []

        func turn(for run: String) -> Turn? {
            guard !emitted.contains(run) else { return nil }
            let events = eventsByRun[run] ?? []
            let persisted = answers[run] ?? []
            guard !events.isEmpty || !persisted.isEmpty else { return nil }
            emitted.insert(run)
            return makeTurn(run: run, events: events, persisted: persisted, conversation: c,
                            botName: botName, botID: botID, botFace: botFace)
        }

        for m in c.messages {
            switch m.role {
            case .user where m.authorBotID != nil:
                items.append(.inbound(id: m.id, authorName: m.authorName ?? tr("A bot", "Un bot"), face: m.authorFace, authorID: m.authorBotID,
                                      text: m.text, at: m.at))
            case .user:
                items.append(.user(id: m.id, text: m.text, attachments: m.attachments, at: m.at,
                                   reactions: m.reactions, replyTo: m.replyTo))
                if let run = m.runID, let t = turn(for: run) { items.append(.turn(t)) }
            case .assistant:
                if let run = m.runID {
                    if let t = turn(for: run) { items.append(.turn(t)) }
                } else if !m.text.isEmpty || !m.attachments.isEmpty {
                    items.append(.turn(Turn(id: m.id, runID: nil, authorName: m.authorName ?? botName, authorFace: m.authorFace ?? botFace,
                                            authorID: m.authorBotID ?? botID, at: m.at, activity: [], answer: m.text,
                                            attachments: m.attachments, live: false, error: nil, lastEventType: nil, lastTool: nil,
                                            startedAt: m.at, messageID: m.id, reactions: m.reactions, replyTo: m.replyTo)))
                }
            }
        }
        // Les runs sans message dans la page : une routine, ou le direct d'un envoi pas encore relu.
        let orphans = eventsByRun.keys.filter { !emitted.contains($0) }
            .sorted { (eventsByRun[$0]?.first?.at ?? .distantPast) < (eventsByRun[$1]?.first?.at ?? .distantPast) }
        // Rangés à leur heure, jamais d'office en bas du fil.
        for run in orphans {
            guard let t = turn(for: run) else { continue }
            let index = items.lastIndex { ($0.at ?? .distantPast) <= t.at }.map { $0 + 1 } ?? 0
            items.insert(.turn(t), at: min(index, items.count))
        }

        // Les lignes locales (envoi en cours, refus, reçu d'approbation), rangées à leur heure.
        for local in locals {
            let index = items.lastIndex { ($0.at ?? .distantPast) <= local.at }.map { $0 + 1 } ?? items.count
            items.insert(.local(local), at: min(index, items.count))
        }
        return withDays(items, calendar: calendar)
    }

    private static func makeTurn(run: String, events: [ConversationEvent], persisted: [ConversationMessage], conversation c: Conversation,
                                 botName: String, botID: String?, botFace: BotFace?) -> Turn {
        // Les segments dans l'ordre : texte (fragments accolés), outils (appels à la suite).
        enum Segment { case text(String), tools([ConversationEvent]) }
        var segments: [Segment] = []
        var results: [String: ConversationEvent] = [:]
        var error: String?
        for e in events {
            switch e.type {
            case "agent.message":
                guard let t = e.text, !t.isEmpty else { continue }
                if case .text(let s)? = segments.last { segments[segments.count - 1] = .text(s + t) } else { segments.append(.text(t)) }
            case "tool.call":
                if case .tools(let calls)? = segments.last { segments[segments.count - 1] = .tools(calls + [e]) } else { segments.append(.tools([e])) }
            case "tool.result":
                if let id = e.toolCallID { results[id] = e }
            case "run.error":
                error = e.errorMessage ?? e.text ?? tr("Runtime error.", "Erreur du runtime.")
            default: break
            }
        }
        let live = c.isLive(run) && error == nil
        let lastTools = segments.lastIndex { if case .tools = $0 { return true } else { return false } }
        var activity: [Turn.Step] = []
        var finalText = ""
        for (i, segment) in segments.enumerated() {
            switch segment {
            case .text(let s):
                if let lastTools, i < lastTools { activity.append(.narration(s.trimmingCharacters(in: .whitespacesAndNewlines))) }
                else { finalText += s }
            case .tools(let calls):
                for group in groupCalls(calls, results: results, runLive: live) { activity.append(.tools(group)) }
            }
        }
        let persistedText = persisted.map(\.text).joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
        // La réponse : le direct tant que le run tourne ; ensuite le message persisté, qui fait foi
        // (le flux peut avoir perdu des fragments), à défaut le texte des événements.
        let answer = live ? finalText : (persistedText.isEmpty ? finalText : persistedText)
        let first = persisted.first
        let lastEvent = events.last { $0.type != "tool.result" }
        return Turn(id: run, runID: run, authorName: first?.authorName ?? botName, authorFace: first?.authorFace ?? botFace,
                    authorID: first?.authorBotID ?? botID, at: events.first?.at ?? first?.at ?? Date(),
                    activity: activity.filter { if case .narration(let s) = $0 { return !s.isEmpty } else { return true } },
                    answer: answer.trimmingCharacters(in: .whitespacesAndNewlines),
                    attachments: persisted.flatMap(\.attachments), live: live, error: error,
                    lastEventType: lastEvent?.type, lastTool: lastEvent?.type == "tool.call" ? lastEvent?.tool : nil,
                    startedAt: c.runs[run]?.startedAt ?? events.first?.at ?? first?.at ?? Date(),
                    messageID: persisted.last?.id, reactions: persisted.last?.reactions ?? [], replyTo: first?.replyTo)
    }

    /// Les appels consécutifs du même outil se replient en une ligne « ×N ».
    static func groupCalls(_ calls: [ConversationEvent], results: [String: ConversationEvent], runLive: Bool) -> [ToolCallGroup] {
        var groups: [ToolCallGroup] = []
        for call in calls {
            let name = call.tool ?? tr("tool", "outil")
            let result = call.toolCallID.flatMap { results[$0] }
            let preview = (call.preview ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let failed = result?.failed == true
            let running = result == nil && runLive
            if var last = groups.last, last.name == name {
                last.count += 1
                if !preview.isEmpty { last.previews.append(preview) }
                last.durationMs += result?.durationMs ?? 0
                last.failures += failed ? 1 : 0
                last.running += running ? 1 : 0
                if last.firstError == nil, failed { last.firstError = result?.errorMessage }
                groups[groups.count - 1] = last
            } else {
                groups.append(ToolCallGroup(id: call.toolCallID ?? "\(call.runID):\(call.sequence)", name: name,
                                            previews: preview.isEmpty ? [] : [preview], count: 1,
                                            durationMs: result?.durationMs ?? 0, failures: failed ? 1 : 0, running: running ? 1 : 0,
                                            firstError: failed ? result?.errorMessage : nil))
            }
        }
        return groups
    }

    /// Une puce par jour calendaire, avant le premier élément du jour.
    private static func withDays(_ items: [TimelineItem], calendar: Calendar) -> [TimelineItem] {
        var out: [TimelineItem] = []
        var lastDay: Date?
        for item in items {
            if let at = item.at {
                let day = calendar.startOfDay(for: at)
                if day != lastDay { out.append(.day(day)); lastDay = day }
            }
            out.append(item)
        }
        return out
    }
}

/// Les libellés de la console pour les outils (`messages.fr.ts`) et leurs icônes (`thread-tool-activity.tsx`, Lucide → SF Symbols).
enum ToolCopy {
    static func base(_ name: String) -> String {
        guard name.hasPrefix("mcp__") else { return name }
        let rest = name.dropFirst(5)
        guard let sep = rest.range(of: "__") else { return String(rest) }
        return String(rest[sep.upperBound...])
    }

    static func label(_ name: String) -> String? {
        switch base(name) {
        case "terminal", "shell": tr("Runs a command", "Exécute une commande")
        case "skill_view": tr("Views a skill", "Consulte une skill")
        case "delegate_task": tr("Delegates a task", "Délègue une tâche")
        case "async_delegation": tr("Delegates in the background", "Délègue en arrière-plan")
        case "subagent": tr("Starts a subagent", "Lance un sous-agent")
        case "search", "web_search": tr("Searches the web", "Recherche sur le web")
        case "http": tr("Calls a URL", "Appelle une URL")
        case "read_file", "cat": tr("Reads a file", "Lit un fichier")
        case "write_file": tr("Writes a file", "Écrit un fichier")
        case "search_files": tr("Searches files", "Cherche dans les fichiers")
        case "skills_list": tr("Lists skills", "Liste les skills")
        case "execute_code": tr("Runs code", "Exécute du code")
        case "web_extract": tr("Reads a web page", "Lit une page web")
        default: nil
        }
    }

    static func symbol(_ name: String) -> String {
        switch base(name) {
        case "terminal", "shell": "terminal"
        case "skill_view": "book"
        case "skills_list": "list.bullet"
        case "delegate_task", "async_delegation": "arrow.triangle.branch"
        case "subagent": "person.crop.square"
        case "search", "web_search", "web_extract": "globe"
        case "http": "link"
        case "read_file", "cat": "doc.text"
        case "write_file": "square.and.pencil"
        case "search_files": "doc.text.magnifyingglass"
        case "execute_code": "chevron.left.forwardslash.chevron.right"
        default: name.hasPrefix("mcp__") ? "powerplug" : "wrench.and.screwdriver"
        }
    }

    /// « 145 ms » sous la seconde, sinon « 2,4 s ».
    static func duration(_ ms: Double) -> String {
        if ms < 1000 { return "\(Int(ms.rounded())) ms" }
        let f = NumberFormatter()
        f.locale = Language.current.locale
        f.minimumFractionDigits = 1
        f.maximumFractionDigits = 1
        return "\(f.string(from: NSNumber(value: ms / 1000)) ?? String(format: "%.1f", ms / 1000)) s"
    }

    /// Le libellé du direct (`deriveRunActivity`) : file, outil, rédaction, réflexion.
    static func liveLabel(_ turn: Turn, queued: Bool) -> String {
        if queued { return tr("Queued…", "En attente…") }
        switch turn.lastEventType {
        case "tool.call": return tr("Using \(turn.lastTool ?? "a tool")…", "Utilise \(turn.lastTool ?? "un outil")…")
        case "agent.message": return tr("Writing…", "Rédige…")
        default: return tr("Thinking…", "Réfléchit…")
        }
    }

    /// « 12.3s » sous la minute, « 3m05 » au-delà.
    static func elapsed(_ seconds: TimeInterval) -> String {
        let s = max(0, seconds)
        if s < 60 { return String(format: "%.1fs", s) }
        return String(format: "%dm%02d", Int(s) / 60, Int(s) % 60)
    }
}
