import Foundation
import Testing
@testable import OHBPopup

// Le journal en direct, le témoin « en vie », la carte accrochée à l'orbe, et le flux qui survit
// à l'expiration de son jeton au lieu de s'arrêter pour « accès révoqué ».

@Suite(.french)
struct JournalTests {
    @Test func consecutiveSameKeyLinesMergeWithACount() {
        var j = Journal()
        let t0 = Date(timeIntervalSince1970: 1000)
        j.record(.info, .event, "Seo : agent.message · run 1", key: "agent.message:r1", at: t0)
        j.record(.info, .event, "Seo : agent.message · run 1", key: "agent.message:r1", at: t0.addingTimeInterval(1))
        j.record(.info, .event, "Seo : agent.message · run 1", key: "agent.message:r1", at: t0.addingTimeInterval(2))
        #expect(j.entries.count == 1)
        #expect(j.entries[0].count == 3)
        #expect(j.entries[0].at == t0.addingTimeInterval(2))
        j.record(.info, .event, "Seo : tool.call · run 1", key: "tool.call:r1")
        j.record(.info, .event, "Seo : agent.message · run 1", key: "agent.message:r1")
        #expect(j.entries.count == 3) // une autre clé entre-temps : nouvelle ligne
        j.record(.error, .send, "refusé")
        j.record(.error, .send, "refusé")
        #expect(j.entries.count == 5) // sans clé : jamais fusionné
    }

    @Test func capacityDropsTheOldestInBatches() {
        var j = Journal()
        for i in 0..<(Journal.capacity + 51) { j.record(.info, .api, "ligne \(i)") }
        #expect(j.entries.count == Journal.capacity)
        #expect(j.entries.first?.text == "ligne 51")
        #expect(j.entries.last?.text == "ligne \(Journal.capacity + 50)")
        j.clear()
        #expect(j.entries.isEmpty)
    }

    @Test func exportMarksLevelsTopicsAndCounts() {
        var j = Journal()
        j.record(.info, .stream, "flux ouvert")
        j.record(.error, .send, "message refusé : Le serveur a répondu 500 : Erreur interne. Référence : abc")
        j.record(.warning, .event, "Seo : agent.reasoning", key: "k")
        j.record(.warning, .event, "Seo : agent.reasoning", key: "k")
        let lines = j.export().split(separator: "\n").map(String.init)
        #expect(lines.count == 3)
        #expect(lines[0].hasSuffix("  [flux] flux ouvert"))
        #expect(lines[1].contains("✗ [envoi] message refusé") && lines[1].contains("Référence : abc"))
        #expect(lines[2].hasSuffix("! [événement] Seo : agent.reasoning ×2"))
    }

    @Test func livenessCombinesFeedAndRuntime() {
        let up = RuntimeStatus(name: "vps", connected: true)
        let down = RuntimeStatus(name: "vps", connected: false)
        #expect(Liveness.of(feed: .live, runtime: up) == .alive)
        #expect(Liveness.of(feed: .live, runtime: nil) == .degraded)
        #expect(Liveness.of(feed: .live, runtime: down) == .down)
        #expect(Liveness.of(feed: .retrying("x"), runtime: up) == .degraded)
        #expect(Liveness.of(feed: .connecting, runtime: up) == .degraded)
        #expect(Liveness.of(feed: .failed("x"), runtime: up) == .down)
        #expect(Liveness.of(feed: nil, runtime: up) == .alive) // démo
        #expect(Liveness.of(feed: nil, runtime: nil) == .unknown)
    }

    @Test func runtimeStatusFlagsAnOutdatedConnectorOnlyWhenKnown() {
        #expect(RuntimeStatus(name: "a", connected: true, version: "1.2", latestVersion: "1.3").outdated)
        #expect(!RuntimeStatus(name: "a", connected: true, version: "1.3", latestVersion: "1.3").outdated)
        #expect(!RuntimeStatus(name: "a", connected: true, version: nil, latestVersion: "1.3").outdated)
        #expect(!RuntimeStatus(name: "a", connected: true, version: "", latestVersion: "1.3").outdated)
        // Le serveur annonce parfois une « dernière » version plus ancienne que celle installée.
        #expect(!RuntimeStatus(name: "a", connected: true, version: "0.5.9", latestVersion: "0.5.8").outdated)
    }

    @Test func connectorVersionsCompareNumerically() {
        #expect(ConnectorVersion.isNewer("0.5.10", than: "0.5.9"))
        #expect(ConnectorVersion.isNewer("v0.6.0", than: "0.5.9"))
        #expect(ConnectorVersion.isNewer("1.0", than: "0.9.9"))
        #expect(!ConnectorVersion.isNewer("0.5.8", than: "v0.5.9"))
        #expect(!ConnectorVersion.isNewer("0.5.9", than: "0.5.9.0"))
        #expect(!ConnectorVersion.isNewer("0.5.9+build.7", than: "0.5.9"))
        // Une version publiée passe avant sa préversion, pas l'inverse.
        #expect(ConnectorVersion.isNewer("0.6.0", than: "0.6.0-rc.2"))
        #expect(!ConnectorVersion.isNewer("0.6.0-rc.2", than: "0.6.0"))
        #expect(ConnectorVersion.isNewer("0.6.0-rc.10", than: "0.6.0-rc.2"))
        // Illisible : on n'annonce rien plutôt qu'à tort.
        #expect(!ConnectorVersion.isNewer("latest", than: "0.5.9"))
        #expect(!ConnectorVersion.isNewer("0.6.0", than: ""))
    }

    @Test func aCutAtTheTokenDeadlineIsTheScheduledRotation() {
        let expiry = Date(timeIntervalSince1970: 1_000_000)
        #expect(OHBotFeed.isScheduledRotation(at: expiry.addingTimeInterval(-15), tokenExpiresAt: expiry))
        #expect(OHBotFeed.isScheduledRotation(at: expiry.addingTimeInterval(5), tokenExpiresAt: expiry))
        #expect(!OHBotFeed.isScheduledRotation(at: expiry.addingTimeInterval(-300), tokenExpiresAt: expiry))
        #expect(!OHBotFeed.isScheduledRotation(at: expiry, tokenExpiresAt: nil))
    }
}

@Suite(.french)
struct OrbAnchorTests {
    private func geometry(_ edge: NotchEdge, cells: Int = 3) -> NotchGeometry {
        NotchGeometry(edge: edge, metrics: NotchMetrics(scale: 1), cellCount: cells,
                      screen: CGRect(x: 0, y: 0, width: 1728, height: 1117), alongOffset: 0)
    }

    @Test func theRuntimeCardHangsFromTheOrbAndStaysInThePanel() {
        for edge in NotchEdge.allCases {
            let g = geometry(edge)
            let size = CGSize(width: 240, height: 180)
            let r = g.cardRect(anchor: .orb, cardSize: size)
            #expect(r.along.lowerBound >= 8)
            #expect(r.along.upperBound <= g.alongTotal - 8 + 0.001 || r.along.lowerBound == 8)
            #expect(r.across.lowerBound > g.depth) // au-delà du corps, jamais dessus
            // La flèche vise l'orbe, bornée par la carte.
            let mid = (r.along.lowerBound + r.along.upperBound) / 2
            #expect(abs(mid + g.tailOffset(anchor: .orb, cardSize: size) - g.orbCenter.along) < 0.001)
        }
    }

    @Test func cellAnchorsAreUnchanged() {
        let g = geometry(.right)
        let size = CGSize(width: 220, height: 160)
        for i in 0..<3 {
            let a = g.cardRect(forCell: i, cardSize: size)
            let b = g.cardRect(anchor: .cell(i), cardSize: size)
            #expect(a.along == b.along && a.across == b.across)
            #expect(g.tailOffset(forCell: i, cardSize: size) == g.tailOffset(anchor: .cell(i), cardSize: size))
        }
    }

    @MainActor @Test func theModelAttachesTheRuntimeOverlayToTheOrb() {
        let model = NotchModel()
        model.overlay = .card("b"); model.overlayAnchor = 2
        #expect(model.overlayAttachment == .cell(2))
        model.overlay = .runtime; model.overlayAnchor = nil
        #expect(model.overlayAttachment == .orb)
        model.overlay = nil
        #expect(model.overlayAttachment == nil)
    }
}

// MARK: - Le flux SSE derrière un faux réseau

/// Sert `GET /api/events` connexion par connexion : chaque entrée est le corps SSE d'une connexion.
final class SSEStubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var bodies: [String] = []
    nonisolated(unsafe) static var connections = 0
    private static let lock = NSLock()

    static func reset(_ bodies: [String]) { lock.withLock { self.bodies = bodies; connections = 0 } }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.path == "/api/events" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body: String? = Self.lock.withLock {
            Self.connections += 1
            return Self.bodies.isEmpty ? nil : Self.bodies.removeFirst()
        }
        guard let body else {
            // Plus de script : on répond 401 pour que la boucle s'arrête (rafraîchit une fois puis échoue).
            let r = HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let r = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!
        client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
@Suite(.french, .serialized)
struct StreamRevocationTests {
    private func make() throws -> (OHBotFeed, NotchModel, StubTransport, AccountModel) {
        let t = StubTransport()
        let origin = "https://t-\(UUID().uuidString.prefix(8).lowercased()).test"
        let d = TestSupport.defaults("revoke")
        d.set(origin, forKey: "notch.apiOrigin")
        let k = SessionKeychain(service: TestSupport.keychainService, legacyService: nil)
        try k.save(try OHBotAuthClient.decoder.decode(OHBotSession.self, from: Data(OHBotFeedTests.session.utf8)), origin: URL(string: origin)!)
        let account = AccountModel(defaults: d, keychain: k, transport: t)
        let model = NotchModel()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SSEStubProtocol.self]
        let feed = OHBotFeed(model: model, account: account, transport: t, sseSession: URLSession(configuration: config),
                             timing: .init(debounce: .zero, poll: .seconds(3600), routinesEvery: 3600, reconnectCap: .zero))
        t.on("/api/bots", (200, OHBotFeedTests.roster))
        t.on("/api/runtime", (200, OHBotFeedTests.runtime))
        t.on("/api/inbox", (200, OHBotFeedTests.inbox))
        t.on("/api/threads/t-sup", (200, OHBotFeedTests.snapshot(now: Date())))
        t.on("/api/bots/b-sup/routines", (200, #"{"routines":[]}"#))
        t.on("/api/bots/b-ops/routines", (200, #"{"routines":[]}"#))
        t.on("/api/auth/native/token", (200, #"{"accessToken":"at2","accessTokenExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"rt2","organizationId":"org-1"}"#))
        return (feed, model, t, account)
    }

    private static let revoked = "event: stream.revoked\ndata: {\"organizationId\":\"org-1\",\"code\":\"WORKSPACE_ACCESS_REVOKED\"}\n\n"

    @Test func anExpiredTokenRevocationRefreshesAndReconnectsBeforeGivingUp() async throws {
        let (feed, model, t, account) = try make()
        await account.restore()
        // Deux refus coup sur coup : le premier vaut un nouveau jeton et une reconnexion, le second un vrai retrait.
        SSEStubProtocol.reset([": connected\n\n" + Self.revoked, ": connected\n\n" + Self.revoked])
        feed.start()
        await waitUntil { if case .failed = model.feedState { return true } else { return false } }
        feed.stop()
        #expect(SSEStubProtocol.connections == 2)
        #expect(t.calls.filter { $0.path == "/api/auth/native/token" }.count == 1)
        // Jeton valable jusqu'en 2099 : le refus n'est pas la rotation prévue, il reste une alerte.
        #expect(model.journal.entries.contains { $0.topic == .stream && $0.level == .warning && $0.text.contains("flux refusé par le serveur") })
    }

    @Test func aSingleRevocationIsNeverFinal() async throws {
        let (feed, model, _, account) = try make()
        await account.restore()
        SSEStubProtocol.reset([": connected\n\n" + Self.revoked])
        feed.start()
        // Une seule reconnexion scriptée ; la suivante reçoit 403 → arrêt, mais après un refresh, pas sur le refus.
        await waitUntil { SSEStubProtocol.connections >= 2 }
        let reasons = model.journal.entries.filter { $0.level == .error }.map(\.text)
        feed.stop()
        #expect(!reasons.contains { $0.contains("accès à l'organisation révoqué") })
    }

    @Test func aRevocationForAnotherOrganizationIsIgnored() async throws {
        let (feed, _, _, account) = try make()
        await account.restore()
        let other = SSEParser.Frame(id: nil, event: "stream.revoked", data: #"{"organizationId":"org-2"}"#)
        let mine = SSEParser.Frame(id: nil, event: "stream.revoked", data: #"{"organizationId":"org-1"}"#)
        let unnamed = SSEParser.Frame(id: nil, event: "stream.revoked", data: "{}")
        #expect(feed.handle(other) == .handled)
        #expect(feed.handle(mine) == .revoked)
        #expect(feed.handle(unnamed) == .revoked)
    }
}

@MainActor
@Suite(.french)
struct ServerErrorTests {
    @Test func aFiveHundredKeepsTheServerCauseAndReference() async throws {
        let t = StubTransport()
        let origin = "https://t-\(UUID().uuidString.prefix(8).lowercased()).test"
        let d = TestSupport.defaults("err")
        d.set(origin, forKey: "notch.apiOrigin")
        let k = SessionKeychain(service: TestSupport.keychainService, legacyService: nil)
        try k.save(try OHBotAuthClient.decoder.decode(OHBotSession.self, from: Data(OHBotFeedTests.session.utf8)), origin: URL(string: origin)!)
        let account = AccountModel(defaults: d, keychain: k, transport: t)
        await account.restore()
        let model = NotchModel()
        let feed = OHBotFeed(model: model, account: account, transport: t,
                             timing: .init(debounce: .zero, poll: .seconds(3600), routinesEvery: 3600, reconnectCap: .zero))
        t.on("/api/bots", (200, OHBotFeedTests.roster))
        t.on("/api/runtime", (200, OHBotFeedTests.runtime))
        t.on("/api/inbox", (200, OHBotFeedTests.inbox))
        t.on("/api/threads/t-sup", (200, OHBotFeedTests.snapshot(now: Date())))
        t.on("/api/threads/t-ops", (200, #"{"id":"t-ops","messages":[],"runs":[],"workflows":[]}"#))
        t.on("/api/bots/b-sup/routines", (200, #"{"routines":[]}"#))
        t.on("/api/bots/b-ops/routines", (200, #"{"routines":[]}"#))
        await feed.refresh(threads: [])
        #expect(model.runtime != nil)
        t.on("/api/threads/t-ops/messages", (500, #"{"error":{"code":"INTERNAL_ERROR","message":"Erreur interne : un service dont l’API dépend est injoignable. Référence : req-42","details":{"reference":"req-42"}}}"#))
        let item = PendingAttachment(name: "n.md", contentType: "text/markdown", kind: .document, data: Data("x".utf8))
        feed.send("Lis ça", attachments: [item], to: "b-ops")
        await waitUntil { model.bot("b-ops")!.thread.contains { $0.role == .system } }
        let line = model.bot("b-ops")!.thread.last!.text
        #expect(line.contains("500") && line.contains("injoignable") && line.contains("req-42"))
        #expect(model.journal.entries.contains { $0.level == .error && $0.topic == .send && $0.text.contains("req-42") && $0.text.contains("1 pièce") })
        // L'envoi a bien porté la pièce au format du web.
        let call = t.calls.first { $0.path == "/api/threads/t-ops/messages" }!
        let sent = call.body["attachments"] as? [[String: Any]]
        #expect(sent?.first?["kind"] as? String == "document")
    }

    @Test func aFiveHundredWithoutBodyStaysAPlainStatus() {
        #expect(OHBotAuthError.http(status: 500, code: nil).userMessage == "Le serveur a répondu 500.")
        #expect(OHBotAuthError.server(status: 502, code: "X", message: "Erreur interne : y. Référence : z").userMessage
                == "Le serveur a répondu 502 : Erreur interne : y. Référence : z")
    }
}
