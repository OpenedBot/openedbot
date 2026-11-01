import Foundation
import os

/// Le flux openedbot : le roster, le runtime, l'inbox et les fils des bots actifs, mis à jour par le
/// flux `GET /api/events` (sinon toutes les 60 s), avec les deux écritures de l'encoche.
///
/// Stratégie : les événements ne sont pas appliqués un à un ; ils déclenchent, après une
/// courte attente, une relecture du roster et de l'inbox, et du snapshot des fils touchés.
/// Moins fin, mais toujours juste, et insensible aux deltas en double passe du serveur.
@MainActor
final class OHBotFeed: BotFeed {
    private let model: NotchModel
    private let account: any TokenSource
    private let api: OHBotAPI
    private let sseSession: URLSession
    var onTransition: ((Bot, FeedTransition) -> Void)?

    private var mainTask: Task<Void, Never>?
    private var streamTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var cursor = 0
    private var dirtyThreads: Set<String> = []
    private var routinesLoadedAt: Date?
    private var runtime: RuntimeConfigurationDto?
    private var routines: [String: BotRoutine] = [:]
    private var threadByBot: [String: String] = [:]
    /// Les couples `runId:sequence` déjà appliqués : le serveur pousse chaque delta deux fois
    /// (en direct sans curseur, puis commité avec).
    private var seen: Set<String> = []
    /// Les fils qu'on relit à chaque rafraîchissement : ouverts dans une fenêtre, ou actifs.
    var openThreads: Set<String> = []

    /// Le rythme ; les tests le resserrent.
    struct Timing: Sendable {
        var debounce: Duration = .milliseconds(400)
        var poll: Duration = .seconds(60)
        var routinesEvery: TimeInterval = 10 * 60
        var reconnectCap: Duration = .seconds(5)
    }
    private let timing: Timing
    private static let log = Logger(subsystem: "app.openedbot.popup", category: "feed")

    private func setState(_ state: NotchModel.FeedState?) {
        if state != model.feedState {
            Self.log.notice("\(tr("feed", "flux"), privacy: .public) : \(state?.text ?? tr("stopped", "arrêté"), privacy: .public)")
            let level: JournalEntry.Level = switch state {
            case .failed: .error
            case .retrying: .warning
            default: .info
            }
            model.record(level, .stream, state?.text ?? tr("feed stopped", "flux arrêté"))
        }
        model.feedState = state
    }

    /// Une ligne au journal en direct et au journal système ; jamais de jeton ni de texte de message.
    private func note(_ level: JournalEntry.Level, _ topic: JournalEntry.Topic, _ text: String, key: String? = nil) {
        switch level {
        case .info: Self.log.info("\(topic.rawValue, privacy: .public) : \(text, privacy: .public)")
        case .warning: Self.log.notice("\(topic.rawValue, privacy: .public) : \(text, privacy: .public)")
        case .error: Self.log.error("\(topic.rawValue, privacy: .public) : \(text, privacy: .public)")
        }
        model.record(level, topic, text, key: key)
    }

    private func botName(_ id: String) -> String { model.bot(id)?.name ?? "bot" }
    private static func short(_ id: String) -> String { String(id.prefix(8)) }

    init(model: NotchModel, account: any TokenSource, transport: any HTTPTransport = URLSession.shared,
         sseSession: URLSession = .shared, timing: Timing = Timing()) {
        self.model = model
        self.account = account
        self.api = OHBotAPI(account: account, transport: transport)
        self.sseSession = sseSession
        self.timing = timing
    }

    // MARK: BotFeed

    func start() {
        stop()
        let api = self.api
        RemoteImages.shared.loader = { path in try await api.data(path) }
        setState(.connecting)
        model.bots = []
        model.sections = []
        mainTask = Task { [weak self] in
            guard let self else { return }
            await refresh(threads: [])
            streamTask = Task { [weak self] in await self?.streamForever() }
            while !Task.isCancelled {
                try? await Task.sleep(for: timing.poll)
                if Task.isCancelled { break }
                await refresh(threads: openThreads)
            }
        }
    }

    func stop() {
        mainTask?.cancel(); mainTask = nil
        streamTask?.cancel(); streamTask = nil
        refreshTask?.cancel(); refreshTask = nil
        RemoteImages.shared.loader = nil
        RemoteImages.shared.reset()
        setState(nil)
    }

    func respond(approvalID: UUID, allow: Bool) {
        guard let bot = model.bots.first(where: { $0.pending?.id == approvalID }), let remote = bot.pending?.remoteID else { return }
        struct Body: Encodable { var choice: String }
        Task { [weak self] in
            guard let self else { return }
            do {
                let _: OHBotAPI.Empty = try await api.post("/api/approvals/\(remote)/respond", json: Body(choice: allow ? "once" : "deny"))
                note(.info, .send, allow ? tr("\(bot.name): approval allowed once", "\(bot.name) : approbation autorisée une fois")
                                          : tr("\(bot.name): approval denied", "\(bot.name) : approbation refusée"))
                model.update(bot.id) { b in
                    b.pending = nil
                    b.thread.append(ChatMessage(role: .system, text: allow ? tr("Allowed once", "Autorisé une fois") : tr("Denied", "Refusé")))
                }
            } catch OHBotAuthError.http(409, let code) {
                // Déjà tranchée, expirée ou run fini : on retire la carte, le serveur a raison.
                model.update(bot.id) { b in
                    b.pending = nil
                    b.thread.append(ChatMessage(role: .system, text: Self.conflictText(code)))
                }
            } catch {
                note(.error, .send, tr("\(bot.name): approval response rejected: \(Self.text(error))",
                                         "\(bot.name) : réponse à l'approbation refusée : \(Self.text(error))"))
                model.update(bot.id) { b in b.thread.append(ChatMessage(role: .system, text: tr("Response not sent: \(Self.text(error))", "Réponse non envoyée : \(Self.text(error))"))) }
            }
            await refresh(threads: Set([bot.threadID].compactMap { $0 }))
        }
    }

    func send(_ text: String, attachments: [PendingAttachment], replyTo: String?, to botID: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty, let bot = model.bot(botID), let thread = bot.threadID else { return }
        // `attachments` absent plutôt que `[]` : la route lit le champ seulement s'il est là.
        struct Body: Encodable { var input: String; var attachments: [WireAttachment]?; var replyToId: String? }
        let body = Body(input: trimmed, attachments: attachments.isEmpty ? nil : attachments.map(\.wire), replyToId: replyTo)
        let key = UUID().uuidString.lowercased()
        model.update(botID) { b in b.thread.append(ChatMessage(role: .user, text: trimmed, attachments: attachments.map(\.name))) }
        Task { [weak self] in
            guard let self else { return }
            do {
                let started = Date()
                let accepted: SendMessageAcceptedDto = try await api.post("/api/threads/\(thread)/messages", json: body,
                                                                           headers: ["Idempotency-Key": key])
                let pieces = attachments.isEmpty ? "" : tr(" with \(attachments.count) attachment\(attachments.count > 1 ? "s" : "")",
                                                            " avec \(attachments.count) pièce\(attachments.count > 1 ? "s" : "")")
                note(.info, .send, tr("\(bot.name): message accepted\(pieces), run \(Self.short(accepted.runId)) (\(Self.ms(since: started)))",
                                        "\(bot.name) : message accepté\(pieces), run \(Self.short(accepted.runId)) (\(Self.ms(since: started)))"))
                model.update(botID) { b in
                    if !b.runs.contains(where: { $0.id == accepted.runId }) {
                        b.runs.insert(BotRun(id: accepted.runId, kind: .dm, title: String((trimmed.isEmpty ? attachments.first?.name ?? tr("attachment", "pièce jointe") : trimmed).prefix(40)), detail: tr("queued", "en file"),
                                             status: .queued, usedSteps: 0, maxSteps: 0, tokens: 0, since: Date()), at: 0)
                    }
                }
            } catch {
                let total = attachments.reduce(0) { $0 + $1.bytes }
                let pieces = attachments.isEmpty ? "" : tr(" (\(attachments.count) attachment\(attachments.count > 1 ? "s" : ""), \(total) bytes)",
                                                            " (\(attachments.count) pièce\(attachments.count > 1 ? "s" : ""), \(total) octets)")
                note(.error, .send, tr("\(bot.name): message rejected\(pieces): \(Self.text(error))", "\(bot.name) : message refusé\(pieces) : \(Self.text(error))"))
                model.update(botID) { b in b.thread.append(ChatMessage(role: .system, text: tr("Message not sent: \(Self.text(error))", "Message non envoyé : \(Self.text(error))"))) }
            }
            await refresh(threads: [thread])
        }
    }

    /// Bascule une réaction tout de suite à l'écran, puis l'écrit ; un refus du serveur remet l'état relu.
    func react(botID: String, messageID: String, emoji: String) {
        guard let bot = model.bot(botID), let thread = bot.threadID,
              let i = bot.conversation?.messages.firstIndex(where: { $0.id == messageID }) else { return }
        let before = bot.conversation!.messages[i].reactions
        let next = Reactions.toggle(emoji, in: before)
        model.update(botID) { b in b.conversation?.messages[i].reactions = next.reactions }
        struct Body: Encodable { var emoji: String }
        let path = "/api/threads/\(thread)/messages/\(messageID)/reactions"
        Task { [weak self] in
            guard let self else { return }
            do {
                for removed in next.removed where removed != emoji || !next.added {
                    let _: OHBotAPI.Empty = try await api.post(path, json: Body(emoji: removed), method: "DELETE")
                }
                if next.added { let _: OHBotAPI.Empty = try await api.post(path, json: Body(emoji: emoji), method: "PUT") }
                note(.info, .send, next.added ? tr("\(bot.name): reaction \(emoji) added", "\(bot.name) : réaction \(emoji) ajoutée")
                                               : tr("\(bot.name): reaction \(emoji) removed", "\(bot.name) : réaction \(emoji) retirée"))
            } catch {
                note(.error, .send, tr("\(bot.name): reaction \(emoji) rejected: \(Self.text(error))", "\(bot.name) : réaction \(emoji) refusée : \(Self.text(error))"))
                model.update(botID) { b in
                    if let j = b.conversation?.messages.firstIndex(where: { $0.id == messageID }) { b.conversation?.messages[j].reactions = before }
                }
            }
            await refresh(threads: [thread])
        }
    }

    // MARK: Lecture

    /// Roster + runtime + inbox, puis les snapshots des fils demandés et des bots actifs.
    func refresh(threads requested: Set<String>) async {
        let now = Date()
        do {
            async let rosterCall: RosterDto = api.get("/api/bots")
            async let runtimeCall: RuntimeConfigurationDto? = fetchRuntime()
            async let inboxCall: InboxDto = api.get("/api/inbox", query: ["limit": "200"])
            let (roster, runtimeDto, inbox) = try await (rosterCall, runtimeCall, inboxCall)
            if let runtimeDto {
                runtime = runtimeDto
                applyRuntime(runtimeDto)
            }
            if let c = roster.cursor, c > cursor, streamTask == nil { cursor = c }

            if routinesLoadedAt.map({ now.timeIntervalSince($0) > timing.routinesEvery }) ?? true {
                await loadRoutines(for: roster.bots.map(\.id), now: now)
            }

            let previous = Dictionary(model.bots.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let inboxByBot = Dictionary(grouping: inbox.items.filter { $0.botId != nil }, by: { $0.botId! })
            var bots: [Bot] = []
            for dto in roster.bots where dto.hidden != true && dto.archivedAt == nil {
                threadByBot[dto.id] = dto.threadId
                let old = previous[dto.id]
                var bot = Bot(id: dto.id, name: dto.name, threadID: dto.threadId, sectionID: dto.sectionId,
                              artwork: OHBotMapping.artwork(face: dto.face, botID: dto.id),
                              runtime: OHBotMapping.runtime(runtime, model: dto.model, mode: dto.permissionMode, previous: old?.runtime, now: now),
                              routine: routines[dto.id], runs: old?.runs ?? [], pending: old?.pending, thread: old?.thread ?? [],
                              inboxCount: inboxByBot[dto.id]?.count ?? 0, notifyOnFinish: dto.notifyOnFinish ?? true,
                              liveActivity: old?.liveActivity, modelID: dto.model, reasoningEffort: dto.reasoningEffort,
                              face: dto.face?.model, conversation: old?.conversation)
                if dto.awaitingApproval != true { bot.pending = nil }
                if dto.running != true, old == nil { bot.runs = [] }
                bots.append(bot)
            }
            model.sections = roster.sections.sorted { ($0.position ?? 0) < ($1.position ?? 0) }.map { BotSection(id: $0.id, name: $0.name) }

            // Les fils à relire : demandés, ouverts, actifs, ou avec une approbation dont on n'a pas la commande.
            var threads = requested.union(openThreads)
            for dto in roster.bots where dto.running == true || dto.awaitingApproval == true { threads.insert(dto.threadId) }
            for bot in bots where previous[bot.id]?.runs.contains(where: \.isLive) == true { threads.insert(bot.threadID ?? "") }
            threads.remove("")
            let snapshots = await fetchSnapshots(threads)

            for i in bots.indices {
                guard let thread = bots[i].threadID else { continue }
                let approvalItem = inboxByBot[bots[i].id]?.first { $0.kind == "approval" }
                if let snap = snapshots[thread] {
                    bots[i].runs = OHBotMapping.runs(snap.runs, workflows: snap.workflows ?? [], botName: bots[i].name, now: now)
                    var conversation = previous[bots[i].id]?.conversation ?? Conversation()
                    conversation.replace(with: OHBotMapping.conversation(snap))
                    bots[i].conversation = conversation
                    // Ne restent en local que l'envoi pas encore relu et les lignes système récentes.
                    let lastRemote = snap.messages.last?.createdAt ?? .distantPast
                    let persisted = Set(snap.messages.map(\.id))
                    let oldThread: [ChatMessage] = previous[bots[i].id]?.thread ?? []
                    bots[i].thread = oldThread.filter { Self.keepLocal($0, after: lastRemote, persisted: persisted) }
                    if !bots[i].runs.contains(where: \.isLive) { bots[i].liveActivity = nil }
                    else { bots[i].liveActivity = previous[bots[i].id]?.liveActivity }
                    if let item = approvalItem {
                        let request = snap.approvals?.first { $0.status == "pending" && ($0.id == item.approvalId || $0.runId == item.runId) }
                        bots[i].pending = Self.keepingID(previous[bots[i].id]?.pending, OHBotMapping.approval(item: item, botID: bots[i].id, request: request))
                    }
                } else if let item = approvalItem, bots[i].pending == nil {
                    bots[i].pending = OHBotMapping.approval(item: item, botID: bots[i].id, request: nil)
                }
                // Un run en attente d'accord sans approbation connue : on le dit quand même.
                if bots[i].pending == nil, let r = bots[i].runs.firstIndex(where: { $0.status == .awaitingApproval }), approvalItem == nil {
                    bots[i].runs[r].status = .running
                }
                bots[i].trimHistory()
            }

            announceTransitions(from: previous, to: bots)
            model.bots = bots
            note(.info, .api, tr("refresh: \(bots.count) bots, \(snapshots.count) thread\(snapshots.count > 1 ? "s" : ""), cursor \(cursor) (\(Self.ms(since: now)))",
                                 "relecture : \(bots.count) bots, \(snapshots.count) fil\(snapshots.count > 1 ? "s" : ""), curseur \(cursor) (\(Self.ms(since: now)))"),
                 key: "refresh")
        } catch OHBotAuthError.cancelled {
        } catch OHBotAuthError.http(let status, let code) where status == 401 || status == 403 {
            setState(.failed(OHBotAuthError.http(status: status, code: code).userMessage))
            streamTask?.cancel(); streamTask = nil
        } catch {
            note(.error, .api, tr("refresh failed: \(Self.text(error))", "relecture échouée : \(Self.text(error))"), key: "refresh-error")
            if model.feedState != .live { setState(.retrying(Self.text(error))) }
        }
    }

    // MARK: Modèles

    private var catalogLoadedAt: Date?

    /// Le catalogue du runtime actif, gardé 30 s comme le cache serveur.
    func loadModelCatalog() async {
        if let at = catalogLoadedAt, Date().timeIntervalSince(at) < 30, model.modelCatalog != nil { return }
        var current = runtime
        if current == nil { current = await fetchRuntime() }
        guard let r = current, let id = r.runtime?.id else { return }
        runtime = r
        do {
            let dto: RuntimeModelCatalogDto = try await api.get("/api/runtimes/\(id)/models")
            model.modelCatalog = OHBotMapping.catalog(dto, runtime: r)
            catalogLoadedAt = Date()
        } catch {
            note(.warning, .api, tr("model catalog unavailable: \(Self.text(error))", "catalogue de modèles indisponible : \(Self.text(error))"))
        }
    }

    /// Le choix du bot ; en mode global, l'organisation passe « par bot » pour qu'il serve, comme la console.
    func setModel(botID: String, model modelID: String?, effort: String?) async throws {
        struct Body: Encodable { var model: String?; var provider: String?; var reasoningEffort: String? }
        struct Mode: Encodable { var mode: String }
        let provider = modelID.flatMap { model.modelCatalog?.provider(of: $0)?.slug }
        let _: OHBotAPI.Empty = try await api.post("/api/bots/\(botID)", json: Body(model: modelID, provider: provider, reasoningEffort: effort), method: "PATCH")
        if model.modelCatalog?.assignmentMode == "global", modelID != nil || effort != nil {
            let _: OHBotAPI.Empty = try await api.post("/api/runtimes/assignment-mode", json: Mode(mode: "per_bot"), method: "PUT")
            model.modelCatalog?.assignmentMode = "per_bot"
        }
        model.update(botID) { b in
            b.modelID = modelID
            b.reasoningEffort = effort
            if let modelID { b.runtime.model = modelID } else if let g = self.model.modelCatalog?.globalModel { b.runtime.model = g }
        }
    }

    /// Le runtime de l'organisation pour la carte de l'orbe ; ses bascules vont au journal.
    private func applyRuntime(_ dto: RuntimeConfigurationDto) {
        guard let r = dto.runtime else { return }
        let connected = r.link?.connected ?? (r.lastHealthStatus == "healthy")
        let status = RuntimeStatus(name: r.name ?? "runtime", connected: connected, reachability: r.reachability,
                                   health: r.lastHealthStatus, lastSeenAt: r.link?.lastSeenAt,
                                   version: r.link?.connector?.version, latestVersion: r.link?.connector?.latestVersion,
                                   model: r.selectedModel)
        if let old = model.runtime {
            if old.connected != status.connected {
                note(status.connected ? .info : .error, .runtime, status.connected ? tr("\(status.name) back online", "\(status.name) de nouveau en ligne")
                                                                                     : tr("\(status.name) offline", "\(status.name) hors ligne"))
            } else if old.health != status.health, let h = status.health {
                note(h == "healthy" ? .info : .warning, .runtime, tr("\(status.name): health \(h)", "\(status.name) : santé \(h)"))
            }
        } else {
            let connector = status.version.map { tr(", connector \($0)", ", connecteur \($0)") } ?? ""
            note(connected ? .info : .warning, .runtime, connected ? tr("\(status.name) online\(connector)", "\(status.name) en ligne\(connector)")
                                                                   : tr("\(status.name) offline\(connector)", "\(status.name) hors ligne\(connector)"))
        }
        model.runtime = status
    }

    private static func ms(since start: Date) -> String { "\(Int(Date().timeIntervalSince(start) * 1000)) ms" }

    private func fetchRuntime() async -> RuntimeConfigurationDto? {
        // Un serveur sans la route, ou sans runtime : on garde le dernier connu.
        try? await api.get("/api/runtime")
    }

    /// Un fil à la fois : il n'y en a que quelques-uns (ouverts ou actifs), et un snapshot
    /// qui échoue ne doit pas faire tomber les autres.
    private func fetchSnapshots(_ threads: Set<String>) async -> [String: ThreadSnapshotDto] {
        var out: [String: ThreadSnapshotDto] = [:]
        for t in threads.sorted() {
            if Task.isCancelled { break }
            do {
                // Un fil ouvert se lit comme la console : `/history`, événements complets (narration,
                // outils), une page de 15 tours. Les autres n'ont besoin que des runs et des approbations.
                let snap: ThreadSnapshotDto = openThreads.contains(t)
                    ? try await api.get("/api/threads/\(t)/history", query: ["turns": "15"])
                    : try await api.get("/api/threads/\(t)", query: ["events": "compact"])
                out[t] = snap
            } catch {
                note(.warning, .api, tr("thread \(Self.short(t)) unreadable: \(Self.text(error))", "fil \(Self.short(t)) illisible : \(Self.text(error))"), key: "snapshot:\(t)")
            }
        }
        return out
    }

    private func loadRoutines(for botIDs: [String], now: Date) async {
        var out: [String: BotRoutine] = [:]
        for id in botIDs {
            if Task.isCancelled { return }
            if let dto: RoutinesDto = try? await api.get("/api/bots/\(id)/routines") { out[id] = OHBotMapping.routine(dto.routines, now: now) }
        }
        routines = out
        routinesLoadedAt = now
    }

    /// Une ligne locale survit à la relecture tant que le serveur ne l'a pas : un envoi dont le message
    /// n'est pas encore dans le fil, une ligne système plus récente que le dernier message distant.
    nonisolated static func keepLocal(_ m: ChatMessage, after lastRemote: Date, persisted: Set<String>) -> Bool {
        if let rid = m.remoteID { return !persisted.contains(rid) && m.role == .user }
        return m.at > lastRemote
    }

    private static func keepingID(_ old: Approval?, _ new: Approval) -> Approval {
        guard let old, old.remoteID == new.remoteID else { return new }
        var kept = new
        kept.id = old.id
        return kept
    }

    private func announceTransitions(from previous: [String: Bot], to bots: [Bot]) {
        guard !previous.isEmpty else { return }
        for bot in bots {
            guard let old = previous[bot.id] else { continue }
            if old.runtime.connected != bot.runtime.connected { onTransition?(bot, bot.runtime.connected ? .back : .offline); continue }
            if bot.activity == .waiting, old.activity != .waiting { onTransition?(bot, .waiting); continue }
            if old.activity == .working, bot.activity == .success || bot.activity == .idle {
                // Le run suivi a-t-il échoué ? Une erreur ne s'annonce pas comme un run fini.
                let failed = old.activeRun.flatMap { run in bot.runs.first { $0.id == run.id } }?.status == .failed
                onTransition?(bot, failed ? .failed : .finished)
            }
        }
    }

    // MARK: Flux

    /// Le serveur a coupé le flux par `stream.revoked`.
    private struct StreamRevoked: Error {}

    private func streamForever() async {
        var attempt = 0
        var unauthorizedOnce = false
        /// Quand le flux en cours s'est ouvert ; un refus juste après un jeton neuf est un vrai retrait d'accès.
        var openedAt: Date?
        /// L'échéance du jeton qui porte le flux en cours : une coupure à cette heure-là est la rotation prévue.
        var tokenExpiresAt: Date?
        var quickRevokes = 0
        while !Task.isCancelled {
            do {
                let session = try await account.validToken()
                let request = try api.request("GET", "/api/events", query: ["cursor": String(cursor)], session: session,
                                              headers: ["Accept": "text/event-stream", "Last-Event-ID": String(cursor)])
                var req = request
                req.timeoutInterval = 50
                let (bytes, response) = try await sseSession.bytes(for: req)
                guard let http = response as? HTTPURLResponse else { throw OHBotAuthError.invalidResponse }
                if http.statusCode == 401, !unauthorizedOnce {
                    unauthorizedOnce = true
                    _ = try await account.refreshedToken()
                    continue
                }
                guard (200..<300).contains(http.statusCode) else {
                    throw OHBotAuthError.http(status: http.statusCode, code: nil)
                }
                attempt = 0
                unauthorizedOnce = false
                openedAt = Date()
                tokenExpiresAt = session.expiresAt
                note(.info, .stream, tr("feed opened at cursor \(cursor)", "flux ouvert au curseur \(cursor)"))
                setState(.live)
                var parser = SSEParser()
                var buffer: [UInt8] = []
                for try await byte in bytes {
                    buffer.append(byte)
                    if byte == 0x0A || buffer.count >= 4096 {
                        for frame in parser.feed(buffer) where handle(frame) == .revoked { throw StreamRevoked() }
                        buffer.removeAll(keepingCapacity: true)
                    }
                    if Task.isCancelled { return }
                }
                throw OHBotAuthError.network(tr("feed closed by the server", "flux terminé par le serveur"))
            } catch is StreamRevoked {
                // Le flux est lié au jeton d'accès (15 min) : le serveur le refuse dès que ce jeton expire
                // ou tourne. On rafraîchit et on rouvre ; seul un refus répété sur jeton neuf est un retrait.
                let lived = openedAt.map { Date().timeIntervalSince($0) } ?? 0
                quickRevokes = lived < 30 ? quickRevokes + 1 : 0
                if quickRevokes >= 2 {
                    setState(.failed(tr("organization access revoked", "accès à l'organisation révoqué")))
                    return
                }
                if Self.isScheduledRotation(at: Date(), tokenExpiresAt: tokenExpiresAt) {
                    note(.info, .stream, tr("access token renewed after \(Int(lived)) s, feed reopened",
                                            "jeton d'accès renouvelé après \(Int(lived)) s, flux rouvert"))
                } else {
                    note(.warning, .stream, tr("feed rejected by the server after \(Int(lived)) s, new token and reconnect",
                                               "flux refusé par le serveur après \(Int(lived)) s, nouveau jeton et reconnexion"))
                }
                do {
                    _ = try await account.refreshedToken()
                } catch OHBotAuthError.cancelled {
                    return
                } catch OHBotAuthError.http(let status, let code) where status == 401 || status == 403 {
                    setState(.failed(OHBotAuthError.http(status: status, code: code).userMessage))
                    return
                } catch {
                    setState(.retrying(Self.text(error)))
                    try? await Task.sleep(for: timing.reconnectCap)
                }
            } catch OHBotAuthError.cancelled {
                return
            } catch OHBotAuthError.http(let status, let code) where status == 401 || status == 403 {
                setState(.failed(OHBotAuthError.http(status: status, code: code).userMessage))
                return
            } catch {
                if Task.isCancelled { return }
                attempt += 1
                setState(.retrying(Self.text(error)))
                // 250 ms × 2^n plafonné, avec une moitié aléatoire : le même rythme que le client iOS.
                let base = min(timing.reconnectCap, .milliseconds(250 * (1 << min(attempt, 5))))
                let jittered = base / 2 + Duration.milliseconds(Int.random(in: 0...max(1, Int(base.components.seconds * 1000 + base.components.attoseconds / 1_000_000_000_000_000) / 2)))
                try? await Task.sleep(for: jittered)
            }
        }
    }

    /// Le serveur coupe le flux à l'échéance du jeton d'accès (15 min) : c'est attendu, pas une alerte.
    /// Une minute de marge couvre le décalage d'horloge entre le Mac et le serveur.
    nonisolated static func isScheduledRotation(at now: Date, tokenExpiresAt: Date?) -> Bool {
        guard let tokenExpiresAt else { return false }
        return now >= tokenExpiresAt.addingTimeInterval(-60)
    }

    enum FrameOutcome: Equatable { case handled, revoked }

    @discardableResult
    func handle(_ frame: SSEParser.Frame) -> FrameOutcome {
        guard let data = frame.data.data(using: .utf8) else { return .handled }
        switch frame.event {
        case "stream.revoked":
            // Seulement pour notre organisation, comme le client web.
            struct R: Decodable { var organizationId: String? }
            let org = (try? JSONDecoder().decode(R.self, from: data))?.organizationId
            if let mine = account.organizationId, let org, org != mine { return .handled }
            return .revoked
        case "stream.gap":
            note(.warning, .stream, tr("gap in the feed, refreshing", "trou dans le flux, relecture"))
            scheduleRefresh(threads: openThreads)
            return .handled
        case "stream.cursor":
            struct C: Decodable { var cursor: Int }
            if let c = try? JSONDecoder().decode(C.self, from: data) { cursor = max(cursor, c.cursor) }
            return .handled
        default: break
        }
        guard let event = try? OHBotAuthClient.decoder.decode(OrganizationEventDto.self, from: data) else { return .handled }
        ingest(event)
        return .handled
    }

    /// Un événement : le curseur avance sur la version commitée, l'effet s'applique une seule fois
    /// (en direct de préférence, c'est lui qui arrive le premier).
    func ingest(_ event: OrganizationEventDto) {
        if let org = account.organizationId, event.organizationId != org { return }
        if let c = event.cursor {
            guard c > cursor else { return }
            cursor = c
        }
        if let run = event.runId, let seq = event.sequence {
            let key = "\(run):\(seq)"
            if seen.contains(key) { return }
            if seen.count > 4000 { seen.removeAll() }
            seen.insert(key)
        }
        Self.log.debug("événement \(event.type, privacy: .public) curseur \(event.cursor ?? -1)")
        guard Self.relevant.contains(event.type) else { return }
        let who = event.threadId.flatMap { t in threadByBot.first(where: { $0.value == t })?.key }.map(botName) ?? tr("organization", "organisation")
        let run = event.runId.map { " · run \(Self.short($0))" } ?? ""
        let level: JournalEntry.Level = event.type == "run.error" ? .error : event.type == "approval.requested" ? .warning : .info
        // Les deltas d'un même run (raisonnement, texte) fusionnent en une ligne avec un compteur.
        note(level, .event, "\(who) : \(event.type)\(run)", key: "\(event.type):\(event.runId ?? "")")
        applyLive(event)
        guard Self.refreshing.contains(event.type) else { return }
        if let t = event.threadId { dirtyThreads.insert(t) }
        scheduleRefresh(threads: dirtyThreads)
    }

    /// Ce qui se voit tout de suite, sans attendre la relecture : le bot réfléchit, écrit,
    /// appelle un outil ; le texte s'écrit delta par delta comme dans la console.
    private func applyLive(_ event: OrganizationEventDto) {
        guard let thread = event.threadId, let botID = threadByBot.first(where: { $0.value == thread })?.key,
              let run = event.runId else { return }
        let p = event.payload
        model.update(botID) { bot in
            // Comme la console (`applyProductEventToSnapshot`) : l'événement rejoint le fil, la vue le dérive.
            if let e = OHBotMapping.event(event) {
                if bot.conversation == nil { bot.conversation = Conversation() }
                bot.conversation?.apply(e)
            }
            func markRunning() {
                if let r = bot.runs.firstIndex(where: { $0.id == run }) {
                    if bot.runs[r].status == .queued { bot.runs[r].status = .running }
                } else {
                    bot.runs.insert(BotRun(id: run, kind: .dm, title: bot.name, detail: tr("running", "en cours"), status: .running,
                                           usedSteps: 0, maxSteps: 0, tokens: 0, since: Date()), at: 0)
                }
            }
            switch event.type {
            case "message.admitted":
                // Le message qu'on vient d'envoyer existe côté serveur : il porte désormais son identifiant.
                if let id = p?.messageId, let i = bot.thread.lastIndex(where: { $0.role == .user && $0.remoteID == nil }) {
                    bot.thread[i].remoteID = id
                    bot.thread[i].runID = run
                }
                bot.conversation?.runs[run] = ConversationRun(status: .queued, startedAt: event.occurredAt ?? Date())
                bot.liveActivity = .queued
                markRunning()
            case "agent.reasoning":
                bot.liveActivity = .thinking
                markRunning()
            case "agent.message":
                guard let delta = p?.text, !delta.isEmpty else { return }
                bot.liveActivity = .writing
                markRunning()
            case "tool.call":
                bot.liveActivity = .tool(p?.tool ?? tr("tool", "outil"))
                markRunning()
            case "tool.result":
                bot.liveActivity = .thinking
            case "run.completed", "run.error":
                bot.liveActivity = nil
                if let r = bot.runs.firstIndex(where: { $0.id == run }) {
                    bot.runs[r].status = event.type == "run.completed" ? .completed : .failed
                    if let m = p?.message, event.type == "run.error" { bot.runs[r].detail = m }
                }
            case "system.notice":
                if let m = p?.message, p?.kind == "cancelled" || p?.kind == "SUPERSEDED_BY_FOLLOWUP" {
                    bot.liveActivity = nil
                    bot.thread.append(ChatMessage(role: .system, text: m))
                }
            default: break
            }
        }
    }

    /// Les types qui changent quelque chose à l'écran.
    private static let relevant: Set<String> = ["message.admitted", "agent.reasoning", "agent.message", "tool.call", "tool.result",
                                                "approval.requested", "approval.responded", "run.completed", "run.error",
                                                "system.notice", "bot.message"]
    /// Ceux qui valent une relecture du serveur (le reste est appliqué en direct seulement).
    private static let refreshing: Set<String> = ["approval.requested", "approval.responded", "run.completed", "run.error",
                                                  "system.notice", "bot.message"]

    /// Une relecture au plus toutes les `debounce` : une rafale d'événements n'en vaut qu'une.
    private func scheduleRefresh(threads: Set<String>) {
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: timing.debounce)
            refreshTask = nil
            guard !Task.isCancelled else { return }
            let threads = dirtyThreads.union(openThreads)
            dirtyThreads = []
            await refresh(threads: threads)
        }
    }

    // MARK: Textes

    private static func text(_ error: Error) -> String {
        (error as? OHBotAuthError)?.userMessage ?? error.localizedDescription
    }

    private static func conflictText(_ code: String?) -> String {
        switch code {
        case "APPROVAL_EXPIRED": tr("This request expired before your response.", "Cette demande a expiré avant votre réponse.")
        case "APPROVAL_RUN_NOT_ACTIVE": tr("The run ended before your response.", "Le run s'est terminé avant votre réponse.")
        default: tr("This request has already been decided.", "Cette demande a déjà été tranchée.")
        }
    }
}
