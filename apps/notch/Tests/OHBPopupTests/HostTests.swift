import Foundation
import Testing
@testable import OHBPopup

// Le mode hébergé : le protocole ligne à ligne, et la source de jetons branchée sur de vrais pipes,
// avec un faux openedbot à l'autre bout.

@Suite(.french)
struct HostProtocolTests {
    @Test func validHostLinesParse() {
        #expect(HostProtocol.parse(#"{"type":"hello","protocol":1,"apiOrigin":"https://openedbot.app","consoleUrl":"https://openedbot.app"}"#)
            == .success(.hello(protocol: 1, apiOrigin: "https://openedbot.app", consoleURL: "https://openedbot.app")))
        #expect(HostProtocol.parse(#"{"type":"signedIn"}"#) == .success(.signedIn))
        #expect(HostProtocol.parse(#"{"type":"signedOut","extra":true}"#) == .success(.signedOut))
        let granted = #"{"type":"token","id":"3","accessToken":"at-1","expiresAt":"2099-01-01T00:00:00.000Z","organizationId":"org-1"}"#
        #expect(HostProtocol.parse(granted) == .success(.token(.init(id: "3", accessToken: "at-1", expiresAt: "2099-01-01T00:00:00.000Z", organizationId: "org-1"))))
        let down = #"{"type":"token","id":"4","accessToken":null,"expiresAt":null,"organizationId":null,"error":"unavailable"}"#
        #expect(HostProtocol.parse(down) == .success(.token(.init(id: "4", unavailable: true))))
    }

    @Test func malformedLinesAreRefusedWithAReason() {
        #expect(HostProtocol.parse("pas du json") == .failure(.invalidJSON))
        #expect(HostProtocol.parse("[1]") == .failure(.notAnObject))
        #expect(HostProtocol.parse(#"{"type":"launch"}"#) == .failure(.unknownType))
        #expect(HostProtocol.parse(#"{"type":"hello","protocol":true,"apiOrigin":"https://a.b","consoleUrl":"https://a.b"}"#) == .failure(.invalidFields))
        #expect(HostProtocol.parse(#"{"type":"hello","protocol":1.5,"apiOrigin":"https://a.b","consoleUrl":"https://a.b"}"#) == .failure(.invalidFields))
        // Un jeton sans son organisation, une erreur qui porte un jeton, un champ absent : refusés.
        #expect(HostProtocol.parse(#"{"type":"token","id":"1","accessToken":"a","expiresAt":"x","organizationId":null}"#) == .failure(.invalidFields))
        #expect(HostProtocol.parse(#"{"type":"token","id":"1","accessToken":"a","expiresAt":"x","organizationId":"o","error":"unavailable"}"#) == .failure(.invalidFields))
        #expect(HostProtocol.parse(#"{"type":"token","id":"1","accessToken":null,"expiresAt":null}"#) == .failure(.invalidFields))
        #expect(HostProtocol.parse(#"{"type":"token","id":"a b","accessToken":null,"expiresAt":null,"organizationId":null}"#) == .failure(.invalidFields))
        #expect(HostProtocol.parse(String(repeating: "x", count: HostProtocol.maxLineLength + 1)) == .failure(.tooLong))
    }

    @Test func anUnknownVersionStillParses() {
        // C'est HostTokenSource qui décide de s'arrêter (voir plus bas).
        #expect(HostProtocol.parse(#"{"type":"hello","protocol":2,"apiOrigin":"https://a.b","consoleUrl":"https://a.b"}"#)
            == .success(.hello(protocol: 2, apiOrigin: "https://a.b", consoleURL: "https://a.b")))
    }

    @Test func outgoingMessagesAreOneLineOfKnownFields() throws {
        let messages: [(HostProtocol.Outgoing, [String: AnyHashable])] = [
            (.ready(protocol: 1, version: "0.1.0"), ["type": "ready", "protocol": 1, "version": "0.1.0"]),
            (.token(id: "7", force: true), ["type": "token", "id": "7", "force": true]),
            (.openConsole(path: "/bot/b\n1"), ["type": "openConsole", "path": "/bot/b\n1"]),
            (.signOut, ["type": "signOut"]),
            (.fatal(code: "STANDALONE_RUNNING"), ["type": "fatal", "code": "STANDALONE_RUNNING"]),
        ]
        for (message, expected) in messages {
            let data = HostProtocol.encode(message)
            #expect(data.last == 0x0A)
            #expect(!data.dropLast().contains(0x0A))
            let decoded = try #require(try JSONSerialization.jsonObject(with: data) as? [String: AnyHashable])
            #expect(decoded == expected)
        }
    }

    @Test func splitterJoinsChunksAndDropsOverlongLines() {
        var s = HostLineSplitter(maxLength: 10)
        #expect(s.push(Array("{\"a\"".utf8)).lines.isEmpty)
        #expect(s.push(Array(":1}\r\n\nok\n".utf8)).lines == ["{\"a\":1}", "ok"])
        let long = s.push(Array("0123456789ABC".utf8))
        #expect(long.lines.isEmpty && long.overflowed == 1)
        #expect(s.push(Array(" suite\nnext\n".utf8)).lines == ["next"])
    }

    @Test func helloOriginsFollowTheShellRules() {
        #expect(HostProtocol.origin(from: "https://openedbot.app")?.absoluteString == "https://openedbot.app")
        #expect(HostProtocol.origin(from: "http://localhost:1420")?.absoluteString == "http://localhost:1420")
        #expect(HostProtocol.origin(from: "http://10.0.0.50:8787") != nil)
        #expect(HostProtocol.origin(from: "http://lab.local") != nil)
        #expect(HostProtocol.origin(from: "http://example.com") == nil)
        #expect(HostProtocol.origin(from: "https://openedbot.app/api") == nil)
        #expect(HostProtocol.origin(from: "ftp://openedbot.app") == nil)
        #expect(HostProtocol.consoleURL(from: "https://lab.example/console")?.path == "/console")
    }

    @Test func consolePathOfABot() {
        #expect(AppDelegate.consolePath(botID: "0b6c-42") == "/bot/0b6c-42")
        #expect(AppDelegate.consolePath(botID: "a/b?c") == "/bot/a%2Fb%3Fc")
    }

    @Test func hostedFlagAndSeedingNeverTouchTheStandaloneSession() {
        #expect(LaunchMode.isHosted(["OHBPopup", "--hosted"]))
        #expect(!LaunchMode.isHosted(["OHBPopup"]))
        #expect(!LaunchMode.isHosted(["--hosted"])) // argv[0] n'est pas une option
        let suite = TestSupport.defaults("hosted-seed")
        LaunchMode.seed(suite, from: ["notch.edge": "bottom", "notch.apiOrigin": "https://other.example", "notch.sessionFile": "/tmp/s.json",
                                     "app.language": "fr", "NSWindow Frame SettingsWindow": "0 0 1 1"])
        #expect(suite.string(forKey: "notch.edge") == "bottom")
        #expect(suite.string(forKey: "app.language") == "fr")
        #expect(suite.object(forKey: "notch.apiOrigin") == nil)
        #expect(suite.object(forKey: "notch.sessionFile") == nil)
        #expect(suite.object(forKey: "NSWindow Frame SettingsWindow") == nil)
        // Une seule fois : la suite vit ensuite sa vie.
        suite.set("right", forKey: "notch.edge")
        LaunchMode.seed(suite, from: ["notch.edge": "bottom"])
        #expect(suite.string(forKey: "notch.edge") == "right")
    }
}

/// Un faux openedbot au bout de deux vrais pipes : il lit ce que la popup écrit et lui répond.
final class FakeHost: @unchecked Sendable {
    let toPopup = Pipe()
    let fromPopup = Pipe()
    private let lock = NSLock()
    private var messages: [[String: Any]] = []

    var received: [[String: Any]] { lock.withLock { messages } }
    var tokenRequests: [[String: Any]] { received.filter { $0["type"] as? String == "token" } }

    init() {
        let reading = fromPopup.fileHandleForReading
        Thread { [weak self] in
            var splitter = HostLineSplitter()
            while let chunk = HostChannel.readAvailable(reading.fileDescriptor) {
                for line in splitter.push(chunk).lines {
                    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
                    self?.lock.withLock { self?.messages.append(object) }
                }
            }
        }.start()
    }

    func write(_ line: String) {
        toPopup.fileHandleForWriting.write(Data((line + "\n").utf8))
    }

    func hello(protocol version: Int = 1) {
        write(#"{"type":"hello","protocol":\#(version),"apiOrigin":"https://api.acme.test","consoleUrl":"https://console.acme.test"}"#)
    }

    func grant(_ id: String, token: String, org: String = "org-1", expires: String = "2099-01-01T00:00:00.000Z") {
        write(#"{"type":"token","id":"\#(id)","accessToken":"\#(token)","expiresAt":"\#(expires)","organizationId":"\#(org)"}"#)
    }

    /// stdin de la popup fermé : ce que voit une popup dont l'hôte quitte ou meurt.
    func close() {
        try? toPopup.fileHandleForWriting.close()
    }

    deinit {
        try? toPopup.fileHandleForWriting.close()
        try? fromPopup.fileHandleForWriting.close()
    }
}

@Suite(.french) @MainActor
struct HostTokenSourceTests {
    final class Harness {
        let host = FakeHost()
        let channel: HostChannel
        let source: HostTokenSource
        var eofs = 0
        var fatal: String?

        @MainActor init() {
            channel = HostChannel(input: host.toPopup.fileHandleForReading, output: host.fromPopup.fileHandleForWriting, watchdog: nil)
            let channel = self.channel
            source = HostTokenSource(send: { channel.send($0) }, timeout: .seconds(5))
            source.onFatal = { [weak self] in self?.fatal = $0 }
            channel.start(onLine: { [weak source] in source?.receive(line: $0) },
                          onEOF: { [weak self] in
                              self?.source.hostClosed()
                              self?.eofs += 1
                          })
        }

        /// `hello` puis `signedIn`, comme openedbot après `ready`.
        @MainActor func signIn() async {
            host.hello()
            host.write(#"{"type":"signedIn"}"#)
            await waitUntil { self.source.isSignedIn && self.source.isReady }
        }
    }

    @Test func helloSetsTheOriginAndATokenIsServedThenReused() async throws {
        let h = Harness()
        await h.signIn()
        #expect(h.source.origin?.absoluteString == "https://api.acme.test")
        #expect(h.source.consoleURL?.absoluteString == "https://console.acme.test")

        let pending = Task { try await h.source.validToken() }
        await waitUntil { h.host.tokenRequests.count == 1 }
        let request = try #require(h.host.tokenRequests.first)
        #expect(request["force"] as? Bool == false)
        h.host.grant(request["id"] as! String, token: "at-1")
        let token = try await pending.value
        #expect(token.accessToken == "at-1" && token.organizationId == "org-1")
        #expect(h.source.organizationId == "org-1")

        // Encore valide : servi sans redemander.
        _ = try await h.source.validToken()
        #expect(h.host.tokenRequests.count == 1)
    }

    @Test func concurrentCallersShareOneRequest() async throws {
        let h = Harness()
        await h.signIn()
        let a = Task { try await h.source.validToken() }
        let b = Task { try await h.source.validToken() }
        await waitUntil { h.host.tokenRequests.count == 1 }
        h.host.grant(h.host.tokenRequests[0]["id"] as! String, token: "at-1")
        let (ta, tb) = try await (a.value, b.value)
        #expect(ta == tb)
        #expect(h.host.tokenRequests.count == 1)
    }

    @Test func a401AsksForAForcedTokenThenReplays() async throws {
        let h = Harness()
        await h.signIn()
        let stub = StubTransport()
        stub.on("/api/bots", (401, #"{"error":{"code":"AUTH_REQUIRED"}}"#), (200, "ok"))
        let api = OHBotAPI(account: h.source, transport: stub)
        // openedbot répond à chaque demande, avec un jeton neuf.
        let responder = Task { @MainActor in
            var answered = 0
            while !Task.isCancelled {
                let requests = h.host.tokenRequests
                while answered < requests.count {
                    answered += 1
                    h.host.grant(requests[answered - 1]["id"] as! String, token: "at-\(answered)")
                }
                try? await Task.sleep(for: .milliseconds(5))
            }
        }
        defer { responder.cancel() }

        let data = try await api.data("/api/bots")
        #expect(String(decoding: data, as: UTF8.self) == "ok")
        #expect(h.host.tokenRequests.map { $0["force"] as? Bool } == [false, true])
        #expect(stub.calls.map { $0.headers["Authorization"] } == ["Bearer at-1", "Bearer at-2"])
        #expect(stub.calls.allSatisfy { $0.headers["X-OHB-Organization"] == "org-1" })
    }

    @Test func signedOutFailsTheRequestsInFlight() async throws {
        let h = Harness()
        await h.signIn()
        let pending = Task { try await h.source.validToken() }
        await waitUntil { h.host.tokenRequests.count == 1 }
        h.host.write(#"{"type":"signedOut"}"#)
        await #expect(throws: OHBotAuthError.http(status: 401, code: "AUTH_REQUIRED")) { try await pending.value }
        #expect(!h.source.isSignedIn)
        // Plus de session : rien ne repart vers l'hôte.
        await #expect(throws: OHBotAuthError.http(status: 401, code: "AUTH_REQUIRED")) { try await h.source.validToken() }
        #expect(h.host.tokenRequests.count == 1)
    }

    @Test func aNullReplyMeansSignedOutButUnavailableKeepsTheSession() async throws {
        let h = Harness()
        await h.signIn()
        let first = Task { try await h.source.validToken() }
        await waitUntil { h.host.tokenRequests.count == 1 }
        h.host.write(#"{"type":"token","id":"\#(h.host.tokenRequests[0]["id"] as! String)","accessToken":null,"expiresAt":null,"organizationId":null,"error":"unavailable"}"#)
        await #expect(throws: OHBotAuthError.self) { try await first.value }
        #expect(h.source.isSignedIn)

        let second = Task { try await h.source.validToken() }
        await waitUntil { h.host.tokenRequests.count == 2 }
        h.host.write(#"{"type":"token","id":"\#(h.host.tokenRequests[1]["id"] as! String)","accessToken":null,"expiresAt":null,"organizationId":null}"#)
        await #expect(throws: OHBotAuthError.http(status: 401, code: "AUTH_REQUIRED")) { try await second.value }
        #expect(!h.source.isSignedIn)
    }

    @Test func repliesOutOfOrderReachTheirOwnRequest() async throws {
        let h = Harness()
        await h.signIn()
        let normal = Task { try await h.source.validToken() }
        await waitUntil { h.host.tokenRequests.count == 1 }
        let forced = Task { try await h.source.refreshedToken() }
        await waitUntil { h.host.tokenRequests.count == 2 }
        let ids = h.host.tokenRequests.map { $0["id"] as! String }
        #expect(h.host.tokenRequests.map { $0["force"] as? Bool } == [false, true])
        // Une réponse sans requête et une réponse en double : ignorées, sans rien casser.
        h.host.grant("999", token: "at-x")
        h.host.grant(ids[1], token: "at-forced")
        h.host.grant(ids[1], token: "at-again")
        h.host.grant(ids[0], token: "at-normal")
        #expect(try await forced.value.accessToken == "at-forced")
        #expect(try await normal.value.accessToken == "at-normal")
    }

    @Test func endOfStdinStopsCleanly() async throws {
        let h = Harness()
        await h.signIn()
        let pending = Task { try await h.source.validToken() }
        await waitUntil { h.host.tokenRequests.count == 1 }
        h.host.close()
        await waitUntil { h.eofs == 1 }
        #expect(h.eofs == 1)
        await #expect(throws: OHBotAuthError.cancelled) { try await pending.value }
        // Canal fermé : la demande suivante échoue tout de suite, sans attendre le délai.
        await #expect(throws: OHBotAuthError.cancelled) { try await h.source.refreshedToken() }
        #expect(!h.channel.send(.signOut))
    }

    @Test func anUnknownProtocolOrABadOriginIsFatal() async {
        let h = Harness()
        h.host.hello(protocol: 2)
        await waitUntil { h.fatal != nil }
        #expect(h.fatal == "PROTOCOL_UNSUPPORTED")
        #expect(!h.source.isReady)

        let other = Harness()
        other.host.write(#"{"type":"hello","protocol":1,"apiOrigin":"http://example.com","consoleUrl":"https://console.acme.test"}"#)
        await waitUntil { other.fatal != nil }
        #expect(other.fatal == "BAD_HELLO")
    }

    @Test func gesturesGoToTheHost() async {
        let h = Harness()
        await h.signIn()
        h.source.openConsole(path: "/bot/b-1")
        h.source.signOut()
        await waitUntil { h.host.received.count == 2 }
        #expect(h.host.received.map { $0["type"] as? String } == ["openConsole", "signOut"])
        #expect(h.host.received.first?["path"] as? String == "/bot/b-1")
    }
}
