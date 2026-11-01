import Foundation
import Testing
@testable import OHBPopup

@Suite(.french)
struct SSEParserTests {
    @Test func framesCommentsAndLineEndings() {
        var p = SSEParser()
        var frames = p.feed(Array(": connected\n\nid: 12\nevent: run.completed\ndata: {\"a\":1}\n\n".utf8))
        #expect(frames == [SSEParser.Frame(id: "12", event: "run.completed", data: "{\"a\":1}")])
        // CRLF, data multi-lignes, l'id persiste d'une trame à l'autre, l'event non.
        frames = p.feed(Array("data: ligne 1\r\ndata: ligne 2\r\n\r\n".utf8))
        #expect(frames == [SSEParser.Frame(id: "12", event: nil, data: "ligne 1\nligne 2")])
        // Une trame coupée en deux morceaux.
        frames = p.feed(Array("event: stream.gap\ndata: {\"from\":1".utf8))
        #expect(frames.isEmpty)
        frames = p.feed(Array(",\"to\":9}\n\n".utf8))
        #expect(frames == [SSEParser.Frame(id: "12", event: "stream.gap", data: "{\"from\":1,\"to\":9}")])
        // Un heartbeat seul ne donne rien ; un id avec un nul est ignoré.
        #expect(p.feed(Array(": heartbeat 15000\n\n".utf8)).isEmpty)
        frames = p.feed(Array("id: bad\u{0}\ndata: x\n\n".utf8))
        #expect(frames.first?.id == "12")
    }
}

@Suite(.french)
struct OHBotMappingTests {
    @Test func defaultArtworkMatchesTheConsoleHash() {
        #expect(OHBotMapping.defaultArtwork(for: "support") == "confetti")
        #expect(OHBotMapping.defaultArtwork(for: "b-7f3e") == "aurora")
        #expect(OHBotMapping.artwork(face: nil, botID: "support") == "confetti")
        #expect(OHBotMapping.artwork(face: RosterDto.Face(artwork: "mecha"), botID: "x") == "mecha")
        #expect(OHBotMapping.artwork(face: RosterDto.Face(artwork: "/api/attachments/abc"), botID: "x") == nil) // pièce jointe : initiale
        #expect(OHBotMapping.artwork(face: RosterDto.Face(artwork: nil), botID: "x") == nil) // visage vectoriel
    }

    @Test func statusesAndKinds() {
        #expect(OHBotMapping.status("queued") == .queued && OHBotMapping.status("pending") == .queued && OHBotMapping.status("starting") == .queued)
        #expect(OHBotMapping.status("running") == .running && OHBotMapping.status("relaying") == .running)
        #expect(OHBotMapping.status("awaiting_approval") == .awaitingApproval)
        #expect(OHBotMapping.status("completed") == .completed)
        #expect(OHBotMapping.status("cancelled") == .failed && OHBotMapping.status("unknown") == .failed)
        #expect(OHBotMapping.kind("routine") == .routine && OHBotMapping.kind(nil) == .dm)
    }

    @Test func runsKeepLiveAndRecentOnesWithWorkflowSteps() {
        let now = Date()
        func run(_ id: String, _ status: String, ended: TimeInterval?, wf: String? = nil, input: String = "Trie les tickets") -> RunDto {
            RunDto(id: id, status: status, input: input, output: nil, usage: nil, error: nil, createdAt: now.addingTimeInterval(-600),
                   startedAt: now.addingTimeInterval(-500), endedAt: ended.map { now.addingTimeInterval($0) }, workflowId: wf)
        }
        let wf = WorkflowDto(id: "w1", kind: "routine", status: "running", rootRunId: "r1", usedSteps: 3, maxSteps: 8, usedTokens: 1200, errorMessage: nil)
        let runs = OHBotMapping.runs([run("old", "completed", ended: -3600), run("recent", "completed", ended: -60),
                                      run("r1", "running", ended: nil, wf: "w1"), run("err", "failed", ended: -30)],
                                     workflows: [wf], botName: "Support", now: now)
        #expect(runs.map(\.id).sorted() == ["err", "r1", "recent"]) // le run d'il y a une heure est oublié
        let live = runs.first { $0.id == "r1" }!
        #expect(live.kind == .routine && live.usedSteps == 3 && live.maxSteps == 8 && live.tokens == 1200 && live.title == "Trie les tickets")
        #expect(runs.first { $0.id == "recent" }!.progress == 1) // terminé sans workflow : plein
    }

    @Test func messagesSplitToolCallsAndNameOtherBots() {
        let now = Date()
        let dtos = [
            ThreadMessageDto(id: "m1", role: "user", content: [.init(type: "text", text: "Salut", toolName: nil, name: nil)], runId: nil, createdAt: now, authorBot: nil),
            ThreadMessageDto(id: "m2", role: "assistant", content: [
                .init(type: "reasoning", text: "je réfléchis", toolName: nil, name: nil),
                .init(type: "tool-call", text: nil, toolName: "zendesk.list_tickets", name: nil),
                .init(type: "text", text: "14 tickets ouverts.", toolName: nil, name: nil),
            ], runId: "r", createdAt: now, authorBot: nil),
            ThreadMessageDto(id: "m3", role: "user", content: [.init(type: "text", text: "Brouillon prêt", toolName: nil, name: nil)], runId: nil, createdAt: now,
                             authorBot: .init(id: "b2", name: "Growth")),
        ]
        let out = OHBotMapping.messages(dtos)
        #expect(out.map(\.role) == [.user, .tool, .bot, .bot]) // l'outil avant le texte qu'il a permis
        #expect(out[1].text == "zendesk.list_tickets" && out[2].text == "14 tickets ouverts.")
        #expect(out[3].text == "Growth : Brouillon prêt")
        #expect(out.allSatisfy { $0.remoteID != nil })
    }

    @Test func approvalTakesTheCommandFromTheSnapshotAndTheDeadlineFromTheInbox() {
        let due = Date().addingTimeInterval(500)
        let item = InboxDto.Item(kind: "approval", id: "ap-1", botId: "b", threadId: "t", approvalId: "ap-1", runId: "r", summary: "Rembourser", expiresAt: due, occurredAt: nil)
        let request = ApprovalRequestDto(id: "ap-1", runId: "r", kind: "shell", action: "payments refunds create", detail: nil, status: "pending", requestedAt: nil)
        let a = OHBotMapping.approval(item: item, botID: "b", request: request)
        #expect(a.remoteID == "ap-1" && a.command == "payments refunds create" && a.expiresAt == due && a.tool == "shell")
        let b = OHBotMapping.approval(item: item, botID: "b", request: nil)
        #expect(b.command == "Rembourser") // sans snapshot : le résumé, jamais rien
    }

    @Test func routineShowsTheNextEnabledOne() {
        let now = Date()
        let r = OHBotMapping.routine([
            .init(id: "1", name: "Désactivée", enabled: false, nextRunAt: now.addingTimeInterval(60)),
            .init(id: "2", name: "Veille", enabled: true, nextRunAt: now.addingTimeInterval(2 * 3600 + 18 * 60)),
            .init(id: "3", name: "Tri", enabled: true, nextRunAt: nil),
        ], now: now)
        #expect(r?.name == "Veille" && r?.next == "dans 2 h 18")
        #expect(OHBotMapping.routine([], now: now) == nil)
    }
}

/// Le flux complet contre un transport bouchon : pas de réseau, pas de SSE.
@MainActor
@Suite(.french)
struct OHBotFeedTests {
    static let session = """
    {"accessToken":"at","accessTokenExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"rt","organizationId":"org-1"}
    """
    static let roster = """
    {"cursor":41,"sections":[{"id":"s2","name":"Interne","position":2},{"id":"s1","name":"Clients","position":1}],
     "bots":[
      {"id":"b-sup","threadId":"t-sup","name":"Support","sectionId":"s1","model":null,"face":{"artwork":"explorer"},"permissionMode":"manual","awaitingApproval":true,"running":true,"unread":true},
      {"id":"b-ops","threadId":"t-ops","name":"Ops","sectionId":"s2","model":"gpt-5-codex","face":null,"awaitingApproval":false,"running":false},
      {"id":"b-old","threadId":"t-old","name":"Archivé","sectionId":"s2","face":null,"archivedAt":"2026-01-01T00:00:00Z"}
     ]}
    """
    static let runtime = """
    {"runtime":{"name":"vps-paris","reachability":"connector","selectedModel":"claude-sonnet-5-5","lastHealthStatus":"healthy",
      "link":{"connected":true,"lastSeenAt":"2026-10-11T10:00:00Z","connector":{"version":"1.4.2","latestVersion":"1.5.0"}}}}
    """
    static let inbox = """
    {"items":[{"kind":"approval","id":"ap-1","botId":"b-sup","threadId":"t-sup","approvalId":"ap-1","runId":"r-1","summary":"Rembourser 4821","expiresAt":"2099-01-01T00:10:00Z","occurredAt":"2099-01-01T00:00:00Z"},
              {"kind":"needs_review","id":"w-9","botId":"b-sup","threadId":"t-sup","occurredAt":"2099-01-01T00:00:00Z"}],
     "counts":{"approval":1,"needsReview":1,"needsYou":0,"total":2}}
    """
    static func snapshot(now: Date) -> String {
        let iso = ISO8601DateFormatter().string(from: now.addingTimeInterval(-120))
        return """
        {"id":"t-sup","cursor":41,
         "messages":[{"id":"m1","role":"user","content":[{"type":"text","text":"Trie les tickets"}],"runId":"r-1","createdAt":"\(iso)"},
                     {"id":"m2","role":"assistant","content":[{"type":"tool-call","toolCallId":"c","toolName":"zendesk.list_tickets","args":{}},{"type":"text","text":"Il me faut ton accord."}],"runId":"r-1","createdAt":"\(iso)"}],
         "runs":[{"id":"r-1","status":"awaiting_approval","input":"Trie les tickets","output":null,"usage":null,"error":null,"createdAt":"\(iso)","startedAt":"\(iso)","endedAt":null,"workflowId":"w-1"}],
         "workflows":[{"id":"w-1","kind":"routine","status":"awaiting_approval","rootRunId":"r-1","usedSteps":3,"maxSteps":8,"usedTokens":900,"errorMessage":null}],
         "approvals":[{"id":"ap-1","runId":"r-1","threadId":"t-sup","kind":"shell","action":"payments refunds create --amount 4900","detail":"Rembourser 4821","choices":["once","deny"],"status":"pending","requestedAt":"\(iso)","respondedAt":null}]}
        """
    }

    private func make() throws -> (OHBotFeed, NotchModel, StubTransport, AccountModel) {
        let t = StubTransport()
        let origin = "https://t-\(UUID().uuidString.prefix(8).lowercased()).test"
        let d = TestSupport.defaults("feed")
        d.set(origin, forKey: "notch.apiOrigin")
        let k = SessionKeychain(service: TestSupport.keychainService, legacyService: nil)
        try k.save(try OHBotAuthClient.decoder.decode(OHBotSession.self, from: Data(Self.session.utf8)), origin: URL(string: origin)!)
        let account = AccountModel(defaults: d, keychain: k, transport: t)
        let model = NotchModel()
        let feed = OHBotFeed(model: model, account: account, transport: t, timing: .init(debounce: .zero, poll: .seconds(3600), routinesEvery: 3600, reconnectCap: .zero))
        t.on("/api/bots", (200, Self.roster))
        t.on("/api/runtime", (200, Self.runtime))
        t.on("/api/inbox", (200, Self.inbox))
        t.on("/api/threads/t-sup", (200, Self.snapshot(now: Date())))
        t.on("/api/bots/b-sup/routines", (200, #"{"routines":[{"id":"ro","botId":"b-sup","name":"Tri des tickets","enabled":true,"nextRunAt":"2099-01-01T00:00:00Z"}]}"#))
        t.on("/api/bots/b-ops/routines", (404, #"{"error":{"code":"BOT_NOT_FOUND"}}"#))
        return (feed, model, t, account)
    }

    private func signIn(_ account: AccountModel) async {
        await account.restore() // me non scripté : la session reste, le compte n'est pas vérifié
    }

    @Test func refreshBuildsTheRosterFromRosterRuntimeInboxAndSnapshots() async throws {
        let (feed, model, _, account) = try make()
        await signIn(account)
        await feed.refresh(threads: [])
        #expect(model.sections.map(\.name) == ["Clients", "Interne"]) // triées par position
        #expect(model.bots.map(\.id) == ["b-sup", "b-ops"]) // l'archivé est écarté
        let sup = model.bot("b-sup")!
        #expect(sup.threadID == "t-sup" && sup.artwork == "explorer" && sup.runtime.name == "vps-paris")
        #expect(sup.runtime.model == "claude-sonnet-5-5" && sup.runtime.mode == "manual" && sup.runtime.connected)
        #expect(sup.runtime.connectorVersion == "1.4.2" && sup.runtime.outdated)
        #expect(sup.inboxCount == 2 && sup.isAlert)
        #expect(sup.pending?.remoteID == "ap-1" && sup.pending?.command == "payments refunds create --amount 4900")
        #expect(sup.runs.first?.status == .awaitingApproval && sup.runs.first?.usedSteps == 3 && sup.runs.first?.kind == .routine)
        #expect(sup.activity == .waiting && sup.progress == 3.0 / 8.0)
        // Le fil : messages persistés (le texte, les parts tool-call ne sont pas rendues), aucune ligne locale.
        #expect(sup.conversation?.messages.map(\.role) == [.user, .assistant])
        #expect(sup.conversation?.messages.last?.text == "Il me faut ton accord.")
        #expect(sup.conversation?.runs["r-1"]?.status == .awaitingApproval)
        #expect(sup.thread.isEmpty)
        #expect(sup.routine?.name == "Tri des tickets")
        let ops = model.bot("b-ops")!
        #expect(ops.artwork == OHBotMapping.defaultArtwork(for: "b-ops") && ops.runtime.model == "gpt-5-codex" && ops.runtime.mode == "auto")
        #expect(ops.activity == .idle && ops.thread.isEmpty && ops.conversation == nil && ops.routine == nil)
        #expect(model.feedState == nil) // `start()` n'a pas été appelé : pas de flux SSE dans ce test
    }

    @Test func respondPostsTheChoiceAndClearsTheCard() async throws {
        let (feed, model, t, account) = try make()
        await signIn(account)
        await feed.refresh(threads: [])
        t.on("/api/approvals/ap-1/respond", (202, #"{"decision":{"id":"d","entryHash":"h"}}"#))
        let id = model.bot("b-sup")!.pending!.id
        feed.respond(approvalID: id, allow: true)
        for _ in 0..<100 where model.bot("b-sup")!.pending != nil { await Task.yield() }
        let call = t.calls.first { $0.path == "/api/approvals/ap-1/respond" }
        #expect(call?.body["choice"] as? String == "once")
        #expect(call?.headers["Authorization"] == "Bearer at" && call?.headers["X-OHB-Organization"] == "org-1")
        #expect(model.bot("b-sup")!.thread.last?.text == "Autorisé une fois" || model.bot("b-sup")!.thread.contains { $0.text == "Autorisé une fois" })
    }

    @Test func aSettledApprovalIsRemovedOnConflict() async throws {
        let (feed, model, t, account) = try make()
        await signIn(account)
        await feed.refresh(threads: [])
        t.on("/api/approvals/ap-1/respond", (409, #"{"error":{"code":"APPROVAL_EXPIRED"}}"#))
        feed.respond(approvalID: model.bot("b-sup")!.pending!.id, allow: false)
        for _ in 0..<100 where !model.bot("b-sup")!.thread.contains(where: { $0.text.contains("expiré") }) { await Task.yield() }
        #expect(model.bot("b-sup")!.thread.contains { $0.text == "Cette demande a expiré avant votre réponse." })
    }

    @Test func sendPostsWithAnIdempotencyKeyAndQueuesARun() async throws {
        let (feed, model, t, account) = try make()
        await signIn(account)
        await feed.refresh(threads: [])
        t.on("/api/threads/t-ops/messages", (202, #"{"runId":"r-new","workflowId":null,"status":"queued"}"#))
        t.on("/api/threads/t-ops", (200, #"{"id":"t-ops","messages":[],"runs":[],"workflows":[]}"#))
        feed.send("  Vérifie le disque  ", to: "b-ops")
        for _ in 0..<100 where !t.calls.contains(where: { $0.path == "/api/threads/t-ops/messages" }) { await Task.yield() }
        let call = t.calls.first { $0.path == "/api/threads/t-ops/messages" }!
        #expect(call.body["input"] as? String == "Vérifie le disque")
        #expect(UUID(uuidString: call.headers["Idempotency-Key"] ?? "") != nil)
        #expect(model.bot("b-ops")!.thread.contains { $0.role == .user && $0.text == "Vérifie le disque" })
        feed.send("   ", to: "b-ops")
        #expect(t.calls.filter { $0.path == "/api/threads/t-ops/messages" }.count == 1) // vide : rien
    }

    @Test func aFailedSendTellsTheUserWhy() async throws {
        let (feed, model, t, account) = try make()
        await signIn(account)
        await feed.refresh(threads: [])
        t.on("/api/threads/t-ops/messages", (409, #"{"error":{"code":"THREAD_BUSY"}}"#))
        t.on("/api/threads/t-ops", (200, #"{"id":"t-ops","messages":[],"runs":[],"workflows":[]}"#))
        feed.send("Encore", to: "b-ops")
        for _ in 0..<100 where !model.bot("b-ops")!.thread.contains(where: { $0.role == .system }) { await Task.yield() }
        #expect(model.bot("b-ops")!.thread.last?.text.hasPrefix("Message non envoyé") == true)
    }

    @Test func aStaleTokenIsRefreshedOnceAndReplayed() async throws {
        let (feed, model, t, account) = try make()
        await signIn(account)
        t.on("/api/bots", (401, #"{"error":{"code":"SESSION_EXPIRED"}}"#), (200, Self.roster))
        t.on("/api/auth/native/token", (200, #"{"accessToken":"at-2","accessTokenExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"rt-2","organizationId":"org-1"}"#))
        await feed.refresh(threads: [])
        #expect(model.bots.count == 2)
        let bots = t.calls.filter { $0.path == "/api/bots" }
        #expect(bots.count == 2 && bots.last?.headers["Authorization"] == "Bearer at-2")
    }

    @Test func aRefusedSessionStopsTheFeed() async throws {
        let (feed, model, t, account) = try make()
        await signIn(account)
        t.on("/api/bots", (401, #"{"error":{"code":"SESSION_EXPIRED"}}"#))
        t.on("/api/auth/native/token", (401, #"{"error":{"code":"REFRESH_TOKEN_INVALID"}}"#))
        await feed.refresh(threads: [])
        #expect(model.bots.isEmpty)
        if case .failed = model.feedState {} else { Issue.record("attendu : flux arrêté, obtenu \(String(describing: model.feedState))") }
        #expect(account.phase == .signedOut) // la session morte est jetée
    }

    @Test func transitionsAreAnnouncedBetweenRefreshes() async throws {
        let (feed, model, t, account) = try make()
        await signIn(account)
        var seen: [(String, FeedTransition)] = []
        feed.onTransition = { bot, tr in seen.append((bot.id, tr)) }
        await feed.refresh(threads: [])
        #expect(seen.isEmpty) // la première lecture ne crie pas
        // Support a fini, et le runtime est tombé.
        t.on("/api/bots", (200, Self.roster.replacingOccurrences(of: "\"awaitingApproval\":true,\"running\":true", with: "\"awaitingApproval\":false,\"running\":false")))
        t.on("/api/inbox", (200, #"{"items":[],"counts":{"approval":0,"needsReview":0,"needsYou":0,"total":0}}"#))
        t.on("/api/runtime", (200, Self.runtime.replacingOccurrences(of: "\"connected\":true", with: "\"connected\":false")))
        t.on("/api/threads/t-sup", (200, Self.snapshot(now: Date()).replacingOccurrences(of: "\"status\":\"awaiting_approval\",\"input\"", with: "\"status\":\"completed\",\"input\"")))
        await feed.refresh(threads: [])
        #expect(seen.map(\.1) == [.offline, .offline]) // le runtime d'abord : tombé pour les deux bots
        #expect(model.bot("b-sup")!.runtime.downSince != nil && model.bot("b-sup")!.pending == nil)
        #expect(model.bot("b-sup")!.activity == .offline)
    }
}

/// Les événements appliqués en direct : réfléchit, écrit delta par delta, outils, fin de run.
@MainActor
@Suite(.french)
struct OHBotFeedLiveTests {
    private func event(_ type: String, run: String = "r-live", seq: Int, cursor: Int? = nil, thread: String = "t-ops",
                       payload: [String: Any] = [:]) -> OrganizationEventDto {
        var dict: [String: Any] = ["organizationId": "org-1", "threadId": thread, "runId": run, "sequence": seq, "type": type, "payload": payload]
        if let cursor { dict["cursor"] = cursor }
        let data = try! JSONSerialization.data(withJSONObject: dict)
        return try! OHBotAuthClient.decoder.decode(OrganizationEventDto.self, from: data)
    }

    private func make() async throws -> (OHBotFeed, NotchModel, StubTransport) {
        let t = StubTransport()
        let origin = "https://t-\(UUID().uuidString.prefix(8).lowercased()).test"
        let d = TestSupport.defaults("live")
        d.set(origin, forKey: "notch.apiOrigin")
        let k = SessionKeychain(service: TestSupport.keychainService, legacyService: nil)
        try k.save(try OHBotAuthClient.decoder.decode(OHBotSession.self, from: Data(OHBotFeedTests.session.utf8)), origin: URL(string: origin)!)
        let account = AccountModel(defaults: d, keychain: k, transport: t)
        await account.restore()
        let model = NotchModel()
        let feed = OHBotFeed(model: model, account: account, transport: t, timing: .init(debounce: .zero, poll: .seconds(3600), routinesEvery: 3600, reconnectCap: .zero))
        t.on("/api/bots", (200, OHBotFeedTests.roster))
        t.on("/api/runtime", (200, OHBotFeedTests.runtime))
        t.on("/api/inbox", (200, #"{"items":[],"counts":{"approval":0,"needsReview":0,"needsYou":0,"total":0}}"#))
        t.on("/api/threads/t-sup", (200, OHBotFeedTests.snapshot(now: Date())))
        t.on("/api/threads/t-ops", (200, #"{"id":"t-ops","messages":[],"runs":[],"workflows":[]}"#))
        await feed.refresh(threads: [])
        return (feed, model, t)
    }

    /// Le tour en cours, tel que la fenêtre le dessine.
    private func liveTurn(_ model: NotchModel, _ id: String = "b-ops") -> Turn? {
        guard let bot = model.bot(id), let c = bot.conversation else { return nil }
        return ThreadTimeline.build(c, botName: bot.name, botID: bot.id, botFace: bot.face, locals: bot.thread)
            .compactMap { if case .turn(let t) = $0 { return t } else { return nil } }.last
    }

    @Test func aTurnStreamsThenSettles() async throws {
        let (feed, model, t) = try await make()
        feed.openThreads = ["t-ops"]
        t.on("/api/threads/t-ops/history", (200, #"{"id":"t-ops","messages":[],"runs":[],"workflows":[],"events":[]}"#))
        t.on("/api/threads/t-ops/messages", (202, #"{"runId":"r-live","workflowId":null,"status":"queued"}"#))
        feed.send("Hello", to: "b-ops")
        for _ in 0..<100 where !t.calls.contains(where: { $0.path == "/api/threads/t-ops/messages" }) { await Task.yield() }
        for _ in 0..<50 { await Task.yield() } // la relecture après l'envoi

        feed.ingest(event("message.admitted", seq: 1, payload: ["messageId": "m-hello", "runId": "r-live", "status": "queued"]))
        var ops = model.bot("b-ops")!
        #expect(ops.liveActivity == .queued)
        #expect(ops.thread.first { $0.role == .user }?.remoteID == "m-hello") // le message local porte son identifiant
        #expect(ops.runs.first?.id == "r-live" && ops.runs.first?.status == .running)
        #expect(ops.conversation?.runs["r-live"]?.status == .queued)

        feed.ingest(event("agent.reasoning", seq: 2, payload: ["text": "je regarde"]))
        #expect(model.bot("b-ops")!.liveActivity == .thinking)
        #expect(liveTurn(model)?.answer.contains("je regarde") == false) // le raisonnement n'est jamais rendu

        feed.ingest(event("agent.message", seq: 3, payload: ["text": "Salut "]))
        feed.ingest(event("agent.message", seq: 4, payload: ["text": "kev !"]))
        ops = model.bot("b-ops")!
        #expect(ops.liveActivity == .writing && ops.activity == .working)
        #expect(liveTurn(model)?.answer == "Salut kev !" && liveTurn(model)?.live == true)
        // Les copies commitées des mêmes deltas (même runId:sequence) ne doublent rien, mais avancent le curseur.
        feed.ingest(event("agent.message", seq: 3, cursor: 201, payload: ["text": "Salut "]))
        feed.ingest(event("agent.message", seq: 4, cursor: 202, payload: ["text": "kev !"]))
        #expect(liveTurn(model)?.answer == "Salut kev !")

        // Un outil coupe la narration : ce qui précède part dans le bloc d'activité.
        feed.ingest(event("tool.call", seq: 5, payload: ["toolCallId": "c1", "tool": "terminal", "preview": "df -h /"]))
        #expect(model.bot("b-ops")!.liveActivity == .tool("terminal"))
        var turn = liveTurn(model)!
        #expect(turn.activity.count == 2 && turn.answer.isEmpty && turn.lastTool == "terminal")
        if case .tools(let g) = turn.activity[1] { #expect(g.name == "terminal" && g.running == 1 && g.previews == ["df -h /"]) }
        else { Issue.record("attendu un groupe d'outils") }
        feed.ingest(event("tool.result", seq: 6, payload: ["toolCallId": "c1", "tool": "terminal", "durationMs": 840, "error": false]))
        feed.ingest(event("agent.message", seq: 7, payload: ["text": "Disque à 61 %."]))
        turn = liveTurn(model)!
        #expect(turn.answer == "Disque à 61 %." && turn.toolCount == 1 && turn.totalDurationMs == 840)
        #expect(turn.activity.first == .narration("Salut kev !"))

        // Le run conclut : la relecture complète (fil ouvert) apporte le message persisté et les événements.
        t.on("/api/threads/t-ops/history", (200, """
        {"id":"t-ops","messages":[{"id":"m-hello","role":"user","content":[{"type":"text","text":"Hello"}],"runId":"r-live","createdAt":"2026-10-11T18:00:00Z"},
          {"id":"m-reply","role":"assistant","content":[{"type":"text","text":"Disque à 61 %."}],"runId":"r-live","createdAt":"2026-10-11T18:00:05Z"}],
         "runs":[{"id":"r-live","status":"completed","input":"Hello","output":"Disque à 61 %.","usage":null,"error":null,"createdAt":"2026-10-11T18:00:00Z","startedAt":"2026-10-11T18:00:00Z","endedAt":"2099-01-01T00:00:00Z"}],
         "workflows":[],
         "events":[{"organizationId":"org-1","threadId":"t-ops","runId":"r-live","sequence":3,"type":"agent.message","payload":{"text":"Salut kev !"},"occurredAt":"2026-10-11T18:00:01Z"},
                   {"organizationId":"org-1","threadId":"t-ops","runId":"r-live","sequence":5,"type":"tool.call","payload":{"toolCallId":"c1","tool":"terminal","preview":"df -h /"},"occurredAt":"2026-10-11T18:00:02Z"},
                   {"organizationId":"org-1","threadId":"t-ops","runId":"r-live","sequence":6,"type":"tool.result","payload":{"toolCallId":"c1","tool":"terminal","durationMs":840,"error":false},"occurredAt":"2026-10-11T18:00:03Z"},
                   {"organizationId":"org-1","threadId":"t-ops","runId":"r-live","sequence":7,"type":"agent.message","payload":{"text":"Disque à 61 %."},"occurredAt":"2026-10-11T18:00:04Z"},
                   {"organizationId":"org-1","threadId":"t-ops","runId":"r-live","sequence":8,"type":"run.completed","payload":{"output":"Disque à 61 %."},"occurredAt":"2026-10-11T18:00:05Z"}]}
        """))
        feed.ingest(event("run.completed", seq: 8, cursor: 208, payload: ["output": "Disque à 61 %."]))
        #expect(model.bot("b-ops")!.liveActivity == nil)
        for _ in 0..<200 where model.bot("b-ops")!.conversation?.messages.isEmpty != false { await Task.yield() }
        ops = model.bot("b-ops")!
        #expect(ops.thread.isEmpty) // l'envoi local a cédé la place au message persisté
        let items = ThreadTimeline.build(ops.conversation!, botName: ops.name, botID: ops.id, botFace: ops.face, locals: ops.thread)
        let kinds = items.map { item -> String in
            switch item { case .day: "day"; case .user: "user"; case .turn: "turn"; case .inbound: "inbound"; case .local: "local" }
        }
        #expect(kinds == ["day", "user", "turn"])
        turn = liveTurn(model)!
        #expect(!turn.live && turn.answer == "Disque à 61 %." && turn.toolCount == 1)
        #expect(ops.activity == .success)
    }

    @Test func aFailedRunAndAForeignOrganizationAreHandled() async throws {
        let (feed, model, _) = try await make()
        feed.ingest(event("agent.message", seq: 1, payload: ["text": "Je commence"]))
        #expect(liveTurn(model)?.answer == "Je commence")
        feed.ingest(event("run.error", seq: 2, payload: ["message": "HERMES_RUN_FAILED", "errorCode": "HERMES_RUN_FAILED"]))
        let ops = model.bot("b-ops")!
        #expect(ops.liveActivity == nil && ops.runs.first?.status == .failed)
        #expect(liveTurn(model)?.error == "HERMES_RUN_FAILED" && liveTurn(model)?.live == false)
        // Une autre organisation, ou un fil inconnu : rien ne bouge.
        let foreign = try OHBotAuthClient.decoder.decode(OrganizationEventDto.self, from: Data(#"{"organizationId":"org-2","threadId":"t-ops","runId":"r-x","sequence":1,"type":"agent.message","payload":{"text":"intrus"}}"#.utf8))
        feed.ingest(foreign)
        feed.ingest(event("agent.message", run: "r-y", seq: 1, thread: "t-inconnu", payload: ["text": "perdu"]))
        let texts = model.bots.compactMap(\.conversation).flatMap(\.events).compactMap(\.text)
        #expect(!texts.contains("intrus") && !texts.contains("perdu"))
    }
}

/// Le modèle du prochain run : la même résolution que la console, et l'enregistrement du choix.
@MainActor
@Suite(.french)
struct ModelCatalogTests {
    static let catalog = ModelCatalog(providers: [
        .init(slug: "anthropic", name: "Anthropic", models: [.init(id: "claude-opus-5-5", reasoning: true), .init(id: "claude-haiku-5-5", reasoning: false)]),
        .init(slug: "openai-codex", name: "OpenAI Codex", models: [.init(id: "GPT-5.6 Luna", reasoning: true)]),
    ], globalModel: "claude-opus-5-5", globalEffort: "high", assignmentMode: "per_bot")

    @Test func resolutionMirrorsTheConsole() {
        let c = Self.catalog
        #expect(c.resolve(botModel: nil, botEffort: nil) == .init(model: "claude-opus-5-5", effort: "high", source: .global))
        #expect(c.resolve(botModel: "GPT-5.6 Luna", botEffort: "low") == .init(model: "GPT-5.6 Luna", effort: "low", source: .perBot))
        #expect(c.resolve(botModel: "claude-haiku-5-5", botEffort: "low")?.effort == nil) // ne raisonne pas : pas d'effort
        #expect(c.resolve(botModel: "disparu", botEffort: nil) == .init(model: "claude-opus-5-5", effort: "high", source: .fallback))
        #expect(c.resolve(botModel: "GPT-5.6 Luna", botEffort: "n'importe")?.effort == nil) // effort inconnu ignoré
        var global = c; global.assignmentMode = "global"
        #expect(global.resolve(botModel: "GPT-5.6 Luna", botEffort: "low") == .init(model: "claude-opus-5-5", effort: "high", source: .global))
        var none = c; none.globalModel = nil
        #expect(none.resolve(botModel: nil, botEffort: nil) == nil)
        #expect(c.provider(of: "GPT-5.6 Luna")?.slug == "openai-codex")
        #expect(ReasoningEffort.label("low") == "Faible" && ReasoningEffort.label(nil) == "Par défaut")
        #expect(ProviderMark.initials("openai-codex", name: nil) == "OC" && ProviderMark.initials("zzz", name: "Zed Labs") == "ZL")
    }

    @Test func catalogMappingKeepsAuthenticatedProvidersWithoutDuplicates() throws {
        let dto = try OHBotAuthClient.decoder.decode(RuntimeModelCatalogDto.self, from: Data("""
        {"runtimeDefaultModel":"gpt-5-codex","providers":[
          {"slug":"openai-codex","name":"OpenAI Codex","authenticated":true,"models":[{"id":"gpt-5-codex","reasoning":true,"isRuntimeDefault":true},{"id":"gpt-5-codex","reasoning":true}]},
          {"slug":"openai-api","name":"OpenAI API","authenticated":true,"models":[{"id":"gpt-5-codex","reasoning":true},{"id":"gpt-4.1","reasoning":false}]},
          {"slug":"anthropic","name":"Anthropic","authenticated":false,"models":[{"id":"claude-opus-5-5","reasoning":true}]},
          {"slug":"vide","name":"Vide","authenticated":true,"models":[]}]}
        """.utf8))
        let runtime = try OHBotAuthClient.decoder.decode(RuntimeConfigurationDto.self, from: Data(#"{"runtime":{"id":"rt","name":"vps","selectedProvider":null,"selectedModel":null,"reasoningEffort":"medium"},"modelAssignmentMode":"global"}"#.utf8))
        let c = OHBotMapping.catalog(dto, runtime: runtime)
        #expect(c.providers.map(\.slug) == ["openai-codex", "openai-api"])
        #expect(c.providers[0].models.map(\.id) == ["gpt-5-codex"] && c.providers[1].models.map(\.id) == ["gpt-4.1"])
        #expect(c.globalModel == "gpt-5-codex" && c.globalEffort == "medium" && c.assignmentMode == "global")
    }

    @Test func setModelPatchesTheBotAndSwitchesToPerBotWhenGlobal() async throws {
        let t = StubTransport()
        let origin = "https://t-\(UUID().uuidString.prefix(8).lowercased()).test"
        let d = TestSupport.defaults("model")
        d.set(origin, forKey: "notch.apiOrigin")
        let k = SessionKeychain(service: TestSupport.keychainService, legacyService: nil)
        try k.save(try OHBotAuthClient.decoder.decode(OHBotSession.self, from: Data(OHBotFeedTests.session.utf8)), origin: URL(string: origin)!)
        let account = AccountModel(defaults: d, keychain: k, transport: t)
        await account.restore()
        let model = NotchModel()
        let feed = OHBotFeed(model: model, account: account, transport: t, timing: .init(debounce: .zero, poll: .seconds(3600), routinesEvery: 3600, reconnectCap: .zero))
        t.on("/api/bots", (200, OHBotFeedTests.roster))
        t.on("/api/runtime", (200, #"{"runtime":{"id":"rt-1","name":"vps-paris","selectedProvider":"anthropic","selectedModel":"claude-opus-5-5","reasoningEffort":"high","link":{"connected":true}},"modelAssignmentMode":"global"}"#))
        t.on("/api/inbox", (200, #"{"items":[],"counts":{"approval":0,"needsReview":0,"needsYou":0,"total":0}}"#))
        t.on("/api/threads/t-sup", (200, OHBotFeedTests.snapshot(now: Date())))
        t.on("/api/runtimes/rt-1/models", (200, #"{"runtimeDefaultModel":"claude-opus-5-5","providers":[{"slug":"anthropic","name":"Anthropic","authenticated":true,"models":[{"id":"claude-opus-5-5","reasoning":true}]},{"slug":"openai-codex","name":"OpenAI Codex","authenticated":true,"models":[{"id":"GPT-5.6 Luna","reasoning":true}]}]}"#))
        t.on("/api/bots/b-ops", (200, "{}"))
        t.on("/api/runtimes/assignment-mode", (200, #"{"modelAssignmentMode":"per_bot"}"#))
        await feed.refresh(threads: [])
        await feed.loadModelCatalog()
        #expect(model.modelCatalog?.modelCount == 2 && model.modelCatalog?.assignmentMode == "global")
        #expect(model.bot("b-ops")?.modelID == "gpt-5-codex") // le roster porte le modèle du bot

        try await feed.setModel(botID: "b-ops", model: "GPT-5.6 Luna", effort: "low")
        let patch = t.calls.first { $0.path == "/api/bots/b-ops" }
        #expect(patch?.method == "PATCH")
        #expect(patch?.body["model"] as? String == "GPT-5.6 Luna" && patch?.body["provider"] as? String == "openai-codex" && patch?.body["reasoningEffort"] as? String == "low")
        let mode = t.calls.first { $0.path == "/api/runtimes/assignment-mode" }
        #expect(mode?.method == "PUT" && mode?.body["mode"] as? String == "per_bot")
        #expect(model.modelCatalog?.assignmentMode == "per_bot")
        let ops = model.bot("b-ops")!
        #expect(ops.modelID == "GPT-5.6 Luna" && ops.reasoningEffort == "low" && ops.runtime.model == "GPT-5.6 Luna")
        #expect(model.modelCatalog?.resolve(botModel: ops.modelID, botEffort: ops.reasoningEffort)?.source == .perBot)

        // Revenir au global : le modèle du runtime, pas de nouveau changement de mode.
        try await feed.setModel(botID: "b-ops", model: nil, effort: nil)
        #expect(t.calls.filter { $0.path == "/api/runtimes/assignment-mode" }.count == 1)
        #expect(model.bot("b-ops")?.modelID == nil && model.bot("b-ops")?.runtime.model == "claude-opus-5-5")
    }

    @Test func theDemoFeedHasACatalogToo() async throws {
        let model = NotchModel()
        let feed = MockBotFeed(model: model, timeScale: 0)
        model.bots = MockBotFeed.roster(now: Date())
        await feed.loadModelCatalog()
        #expect((model.modelCatalog?.modelCount ?? 0) >= 5)
        try await feed.setModel(botID: "notes", model: "GPT-5.6 Luna", effort: "low")
        #expect(model.bot("notes")?.runtime.model == "GPT-5.6 Luna" && model.bot("notes")?.reasoningEffort == "low")
    }
}
