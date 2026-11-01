import Foundation
import Testing
@testable import OHBPopup

/// Un transport qui répond par chemin, et garde ce qu'on lui a envoyé.
final class StubTransport: HTTPTransport, @unchecked Sendable {
    struct Call { let method: String; let path: String; let body: [String: Any]; let headers: [String: String] }
    private let lock = NSLock()
    private var scripts: [String: [(Int, String)]] = [:]
    private(set) var calls: [Call] = []

    /// Les réponses pour un chemin, servies dans l'ordre ; la dernière se répète.
    func on(_ path: String, _ responses: (Int, String)...) {
        lock.withLock { scripts[path] = responses }
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let next: (Int, String)? = lock.withLock {
            calls.append(Call(method: request.httpMethod ?? "", path: path, body: body, headers: request.allHTTPHeaderFields ?? [:]))
            guard var queue = scripts[path], let first = queue.first else { return nil }
            if queue.count > 1 { queue.removeFirst(); scripts[path] = queue }
            return first
        }
        guard let (status, json) = next else { throw URLError(.cannotConnectToHost) }
        let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (Data(json.utf8), http)
    }
}


/// Attend qu'une condition devienne vraie, jusqu'à deux secondes : les suites d'une connexion
/// passent par le trousseau hors du thread principal, un simple `yield` ne suffit plus.
@MainActor
func waitUntil(_ condition: @MainActor () -> Bool) async {
    for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
}

private let sessionJSON = """
{"accessToken":"at-1","accessTokenExpiresAt":"2099-01-01T00:00:00.000Z","refreshToken":"rt-1","organizationId":"org-1"}
"""

@Suite(.french)
struct PKCETests {
    @Test func verifierIsSixtyFourHexCharacters() throws {
        let v = try PKCE.makeVerifier()
        #expect(v.count == 64)
        #expect(v.allSatisfy { "0123456789abcdef".contains($0) })
        #expect(try PKCE.makeVerifier() != v)
    }

    @Test func challengeIsBase64urlSha256() {
        // sha256("abc") en base64url sans padding.
        #expect(PKCE.challenge(for: "abc") == "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0")
        #expect(!PKCE.challenge(for: "x").contains("="))
    }
}

@Suite(.french)
struct OriginTests {
    @Test func onlyAnHTTPSOriginIsAccepted() {
        #expect(OHBotAuthClient.origin(from: " https://openedbot.app/ ")?.absoluteString == "https://openedbot.app")
        #expect(OHBotAuthClient.origin(from: "https://lab.example.com:8443")?.absoluteString == "https://lab.example.com:8443")
        #expect(OHBotAuthClient.origin(from: "http://localhost:3000")?.absoluteString == "http://localhost:3000")
        #expect(OHBotAuthClient.origin(from: "http://openedbot.app") == nil) // pas de clair hors localhost
        #expect(OHBotAuthClient.origin(from: "https://openedbot.app/api") == nil) // pas de chemin
        #expect(OHBotAuthClient.origin(from: "https://user:pw@openedbot.app") == nil)
        #expect(OHBotAuthClient.origin(from: "openedbot.app") == nil)
        #expect(OHBotAuthClient.origin(from: "") == nil)
    }

    @Test func googleURLMustPointToGoogleOrTheAPI() {
        let api = URL(string: "https://openedbot.app")!
        #expect(OHBotAuthClient.validAuthorizeURL("https://accounts.google.com/o/oauth2/v2/auth?x=1", origin: api) != nil)
        #expect(OHBotAuthClient.validAuthorizeURL("https://openedbot.app/api/auth/dev", origin: api) != nil)
        #expect(OHBotAuthClient.validAuthorizeURL("https://evil.example/auth", origin: api) == nil)
        #expect(OHBotAuthClient.validAuthorizeURL("https://accounts.google.com:8443/auth", origin: api) == nil)
        #expect(OHBotAuthClient.validAuthorizeURL("javascript:alert(1)", origin: api) == nil)
    }
}

@Suite(.french)
struct SessionDecodingTests {
    @Test func emptyTokensAreRejected() {
        let bad = Data("""
        {"accessToken":"","accessTokenExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"rt","organizationId":"o"}
        """.utf8)
        #expect(throws: (any Error).self) { try OHBotAuthClient.decoder.decode(OHBotSession.self, from: bad) }
        let ok = try? OHBotAuthClient.decoder.decode(OHBotSession.self, from: Data(sessionJSON.utf8))
        #expect(ok?.accessToken == "at-1")
        #expect(ok?.expires(within: 30) == false)
        #expect(ok?.expires(within: 30, now: Date(timeIntervalSince1970: 4_102_444_800 - 10)) == true) // 10 s avant 2099-01-01
    }

    @Test func accountLabelSurvivesMissingFields() {
        let a = try? OHBotAuthClient.decoder.decode(OHBotAccount.self, from: Data(#"{"user":{"email":"k@example.com"},"organization":{"name":"Acme"},"role":"operator"}"#.utf8))
        #expect(a?.label == "k@example.com · Acme · operator")
        let b = try? OHBotAuthClient.decoder.decode(OHBotAccount.self, from: Data("{}".utf8))
        #expect(b?.label == "compte inconnu")
    }
}

@MainActor
@Suite(.french)
struct AuthClientTests {
    private func make() -> (OHBotAuthClient, StubTransport) {
        let t = StubTransport()
        return (OHBotAuthClient(origin: URL(string: "https://api.test")!, transport: t), t)
    }

    @Test func passwordLoginAuthorizesThenExchangesTheCode() async throws {
        let (c, t) = make()
        t.on("/api/auth/native/authorize", (200, #"{"code":"c-1","redirectUri":"ohb://auth/callback"}"#))
        t.on("/api/auth/native/token", (200, sessionJSON))
        let outcome = try await c.login(email: " k@example.com ", password: "pw", organizationSlug: "", emailCode: nil, verifier: "v")
        guard case .signedIn(let s) = outcome else {
            Issue.record("expected signed-in outcome")
            return
        }
        #expect(s.refreshToken == "rt-1")
        let authorize = t.calls[0]
        #expect(authorize.body["email"] as? String == "k@example.com")
        #expect(authorize.body["codeChallenge"] as? String == PKCE.challenge(for: "v"))
        #expect(authorize.body["clientId"] as? String == "ohb-notch")
        #expect(authorize.body["organizationSlug"] == nil) // vide → absent
        let token = t.calls[1]
        #expect(token.body["grantType"] as? String == "authorization_code")
        #expect(token.body["code"] as? String == "c-1" && token.body["codeVerifier"] as? String == "v")
    }

    @Test func passwordLoginReturnsCodeRequiredWithoutTokenExchange() async throws {
        let (c, t) = make()
        t.on("/api/auth/native/authorize", (202, #"{"status":"code_required"}"#))

        let outcome = try await c.login(email: "k@example.com", password: "pw", organizationSlug: nil, emailCode: "", verifier: "v")

        #expect(outcome == .codeRequired)
        #expect(t.calls.map(\.path) == ["/api/auth/native/authorize"])
        #expect(t.calls[0].body["emailCode"] == nil)
    }

    @Test func secondPasswordLoginCarriesEmailCode() async throws {
        let (c, t) = make()
        t.on(
            "/api/auth/native/authorize",
            (202, #"{"status":"code_required"}"#),
            (200, #"{"code":"c-1"}"#)
        )
        t.on("/api/auth/native/token", (200, sessionJSON))

        #expect(try await c.login(email: "k@example.com", password: "pw", organizationSlug: nil, emailCode: nil, verifier: "v") == .codeRequired)
        let outcome = try await c.login(email: "k@example.com", password: "pw", organizationSlug: nil, emailCode: "123456", verifier: "v")

        guard case .signedIn = outcome else {
            Issue.record("expected signed-in outcome")
            return
        }
        #expect(t.calls[0].body["emailCode"] == nil)
        #expect(t.calls[1].body["emailCode"] as? String == "123456")
        #expect(t.calls[2].path == "/api/auth/native/token")
    }

    @Test func apiErrorsCarryTheirCode() async {
        let (c, t) = make()
        t.on("/api/auth/native/authorize", (403, #"{"error":{"code":"ALPHA_CLOSED","message":"nope"}}"#))
        await #expect(throws: OHBotAuthError.http(status: 403, code: "ALPHA_CLOSED")) {
            try await c.login(email: "k", password: "p", organizationSlug: nil, emailCode: nil, verifier: "v")
        }
        #expect(OHBotAuthError.http(status: 403, code: "ALPHA_CLOSED").userMessage.contains("alpha"))
        t.on("/api/auth/native/authorize", (500, "not json"))
        await #expect(throws: OHBotAuthError.http(status: 500, code: nil)) {
            try await c.login(email: "k", password: "p", organizationSlug: nil, emailCode: nil, verifier: "v")
        }
        #expect(OHBotAuthError.http(status: 401, code: "EMAIL_LOGIN_CODE_INVALID").userMessage == "Code invalide ou expiré.")
        #expect(OHBotAuthError.http(status: 429, code: "EMAIL_LOGIN_CODE_COOLDOWN").userMessage == "Patientez une minute avant de demander un nouveau code.")
        #expect(OHBotAuthError.http(status: 503, code: "EMAIL_LOGIN_CODE_UNSENT").userMessage == "Le code n’a pas pu être envoyé. Réessayez.")
    }

    @Test func networkFailureAndBadJSONAreDistinct() async {
        let (c, t) = make()
        await #expect(throws: OHBotAuthError.self) { try await c.providers() } // rien de scripté : injoignable
        t.on("/api/auth/providers", (200, "{not json"))
        await #expect(throws: OHBotAuthError.invalidResponse) { try await c.providers() }
        t.on("/api/auth/providers", (200, #"{"google":{"enabled":false,"reason":"no client id"},"password":{"enabled":true}}"#))
        let p = try? await c.providers()
        #expect(p?.googleEnabled == false && p?.passwordEnabled == true && p?.google?.reason == "no client id")
    }

    @Test func authenticatedCallsCarryBearerAndOrganization() async throws {
        let (c, t) = make()
        t.on("/api/auth/me", (200, #"{"user":{"email":"k@example.com"}}"#))
        let s = try OHBotAuthClient.decoder.decode(OHBotSession.self, from: Data(sessionJSON.utf8))
        _ = try await c.me(s)
        #expect(t.calls[0].headers["Authorization"] == "Bearer at-1")
        #expect(t.calls[0].headers["X-OHB-Organization"] == "org-1")
    }

    @Test func googleStartRejectsForeignURLs() async throws {
        let (c, t) = make()
        t.on("/api/auth/native/google/start", (200, #"{"attemptId":"a1","authorizeUrl":"https://evil.example/x"}"#))
        await #expect(throws: OHBotAuthError.unexpectedAuthorizeURL) { try await c.startGoogle(verifier: "v") }
        t.on("/api/auth/native/google/start", (200, #"{"attemptId":"","authorizeUrl":"https://accounts.google.com/x"}"#))
        await #expect(throws: OHBotAuthError.invalidResponse) { try await c.startGoogle(verifier: "v") }
        t.on("/api/auth/native/google/claim", (200, #"{"status":"pending"}"#), (200, #"{"status":"failed","code":"AUTH_DENIED"}"#), (200, #"{"status":"done","code":""}"#))
        let first = try await c.claimGoogle(attemptID: "a1", verifier: "v")
        #expect(first == .pending)
        let second = try await c.claimGoogle(attemptID: "a1", verifier: "v")
        #expect(second == .failed(code: "AUTH_DENIED"))
        await #expect(throws: OHBotAuthError.invalidResponse) { try await c.claimGoogle(attemptID: "a1", verifier: "v") }
    }
}

/// Les tests tournent en parallèle : chacun a son origine, donc son entrée de trousseau.
@MainActor
@Suite(.french)
struct AccountModelTests {
    /// `fresh: false` garde l'entrée de trousseau : pour une seconde instance sur la même origine.
    private func make(origin: String = "https://t-\(UUID().uuidString.prefix(8).lowercased()).test", fresh: Bool = true,
                      timing: AccountModel.Timing = .init(pollInterval: .zero, timeout: .seconds(5), maxPollFailures: 2, sleep: { _ in }))
        -> (AccountModel, StubTransport, SessionKeychain, UserDefaults, @MainActor () -> [URL]) {
        let t = StubTransport()
        let d = TestSupport.defaults("account")
        d.set(origin, forKey: "notch.apiOrigin")
        let k = SessionKeychain(service: TestSupport.keychainService, legacyService: nil)
        if fresh { try? k.delete(origin: URL(string: origin)!) }
        final class Box: @unchecked Sendable { var urls: [URL] = [] }
        let box = Box()
        let m = AccountModel(defaults: d, keychain: k, transport: t, timing: timing, openURL: { box.urls.append($0) })
        return (m, t, k, d, { box.urls })
    }

    @Test func passwordSignInStoresTheSessionAndLoadsTheAccount() async throws {
        let (m, t, k, _, _) = make()
        t.on("/api/auth/native/authorize", (200, #"{"code":"c-1"}"#))
        t.on("/api/auth/native/token", (200, sessionJSON))
        t.on("/api/auth/me", (200, #"{"user":{"email":"k@example.com"},"organization":{"name":"Acme"},"role":"operator"}"#))
        await m.signIn(email: "k@example.com", password: "pw", organizationSlug: "acme", emailCode: nil)
        #expect(m.phase == .signedIn && m.error == nil)
        #expect(m.account?.label == "k@example.com · Acme · operator")
        let stored = try k.load(origin: m.origin!)
        #expect(stored?.accessToken == "at-1")
        #expect(t.calls[0].body["organizationSlug"] as? String == "acme")
        // Une nouvelle instance reprend la session du trousseau.
        let (m2, t2, _, _, _) = make(origin: m.originText, fresh: false)
        t2.on("/api/auth/me", (200, #"{"user":{"email":"k@example.com"}}"#))
        await m2.restore()
        #expect(m2.phase == .signedIn && m2.account?.user?.email == "k@example.com")
        await m2.signOut()
        let afterSignOut = try k.load(origin: m.origin!)
        #expect(m2.phase == .signedOut && afterSignOut == nil)
        #expect(t2.calls.last?.path == "/api/auth/logout")
    }

    @Test func accountKeepsCodeRequiredStateAndResubmitsTheCode() async throws {
        let (m, t, k, _, _) = make()
        t.on(
            "/api/auth/native/authorize",
            (202, #"{"status":"code_required"}"#),
            (401, #"{"error":{"code":"EMAIL_LOGIN_CODE_INVALID"}}"#),
            (200, #"{"code":"c-1"}"#)
        )
        t.on("/api/auth/native/token", (200, sessionJSON))
        t.on("/api/auth/me", (200, #"{"user":{"email":"k@example.com"}}"#))

        await m.signIn(email: "k@example.com", password: "pw", organizationSlug: "", emailCode: nil)
        #expect(m.phase == .codeRequired(email: "k@example.com"))
        #expect(m.error == nil)
        #expect(t.calls.filter { $0.path.hasSuffix("/token") }.isEmpty)

        await m.signIn(email: "k@example.com", password: "pw", organizationSlug: "", emailCode: "000000")
        #expect(m.phase == .codeRequired(email: "k@example.com"))
        #expect(m.error == "Code invalide ou expiré.")

        await m.signIn(email: "k@example.com", password: "pw", organizationSlug: "", emailCode: "123456")
        #expect(m.phase == .signedIn)
        #expect(t.calls.first?.body["emailCode"] == nil)
        #expect(t.calls.filter { $0.path.hasSuffix("/authorize") }[1].body["emailCode"] as? String == "000000")
        #expect(t.calls.filter { $0.path.hasSuffix("/authorize") }[2].body["emailCode"] as? String == "123456")
        try k.delete(origin: m.origin!)
    }

    @Test func emptyFieldsAndBadOriginFailBeforeAnyRequest() async {
        let (m, t, _, _, _) = make()
        await m.signIn(email: "", password: "", organizationSlug: "", emailCode: nil)
        #expect(m.error == "E-mail et mot de passe sont requis." && t.calls.isEmpty)
        m.originText = "ftp://nope"
        await m.signIn(email: "k", password: "p", organizationSlug: "", emailCode: nil)
        #expect(m.error == OHBotAuthError.invalidOrigin.userMessage && t.calls.isEmpty && m.phase == .signedOut)
    }

    @Test func googleFlowOpensTheBrowserThenPollsUntilDone() async throws {
        let (m, t, k, _, opened) = make()
        t.on("/api/auth/native/google/start", (200, #"{"attemptId":"a1","authorizeUrl":"https://accounts.google.com/o/oauth2/auth?s=1"}"#))
        t.on("/api/auth/native/google/claim", (200, #"{"status":"pending"}"#), (503, "down"), (200, #"{"status":"done","code":"c-9"}"#))
        t.on("/api/auth/native/token", (200, sessionJSON))
        t.on("/api/auth/me", (200, "{}"))
        m.signInWithGoogle()
        #expect(m.phase == .busy("Connexion Google dans le navigateur…"))
        await waitUntil { !(m.phase != .signedIn && m.error == nil) }
        #expect(m.phase == .signedIn && m.error == nil)
        #expect(opened().first?.host == "accounts.google.com")
        #expect(t.calls.filter { $0.path.hasSuffix("/claim") }.count == 3) // pending, 503 toléré, done
        #expect(t.calls.last { $0.path.hasSuffix("/token") }?.body["code"] as? String == "c-9")
        try k.delete(origin: m.origin!)
    }

    @Test func googleRefusalAndCancellationEndCleanly() async {
        let (m, t, _, _, _) = make()
        t.on("/api/auth/native/google/start", (200, #"{"attemptId":"a1","authorizeUrl":"https://accounts.google.com/x"}"#))
        t.on("/api/auth/native/google/claim", (200, #"{"status":"failed","code":"AUTH_NOT_A_MEMBER"}"#))
        m.signInWithGoogle()
        await waitUntil { !(m.error == nil) }
        #expect(m.error == OHBotAuthError.refused(code: "AUTH_NOT_A_MEMBER").userMessage && m.phase == .signedOut)

        let (m2, t2, _, _, _) = make(timing: .init(pollInterval: .seconds(10), timeout: .seconds(60), maxPollFailures: 2,
                                                  sleep: { try await Task.sleep(for: $0) }))
        t2.on("/api/auth/native/google/start", (200, #"{"attemptId":"a1","authorizeUrl":"https://accounts.google.com/x"}"#))
        m2.signInWithGoogle()
        for _ in 0..<50 { await Task.yield() }
        m2.cancelGoogle()
        await waitUntil { !(m2.error == nil) }
        #expect(m2.error == OHBotAuthError.cancelled.userMessage && m2.phase == .signedOut)
    }

    @Test func expiringTokenIsRefreshedOnceAndARefusedRefreshSignsOut() async throws {
        let (m, t, k, _, _) = make()
        let origin = m.origin!
        let old = OHBotSession(accessToken: "old", refreshToken: "rt-old", organizationId: "org-1", accessTokenExpiresAt: Date().addingTimeInterval(5))
        try k.save(old, origin: origin)
        t.on("/api/auth/native/token", (200, sessionJSON))
        t.on("/api/auth/me", (200, "{}"))
        await m.restore()
        #expect(m.phase == .signedIn)
        #expect(m.session?.accessToken == "at-1") // rafraîchi avant `me`
        #expect(t.calls.first?.body["grantType"] as? String == "refresh_token" && t.calls.first?.body["refreshToken"] as? String == "rt-old")
        let rotated = try k.load(origin: origin)
        #expect(rotated?.refreshToken == "rt-1") // le refresh rotatif est persisté

        try k.save(old, origin: origin)
        let (m2, t2, _, _, _) = make(origin: m.originText, fresh: false)
        t2.on("/api/auth/native/token", (401, #"{"error":{"code":"REFRESH_TOKEN_INVALID"}}"#))
        await m2.restore()
        #expect(m2.phase == .signedOut && m2.session == nil)
        #expect(m2.error == OHBotAuthError.http(status: 401, code: "REFRESH_TOKEN_INVALID").userMessage)
        let gone = try k.load(origin: origin)
        #expect(gone == nil)
        try k.delete(origin: origin)
    }

    @Test func unreachableServerKeepsTheSession() async throws {
        let (m, _, k, _, _) = make()
        let origin = m.origin!
        try k.save(OHBotSession(accessToken: "ok", refreshToken: "rt", organizationId: "o", accessTokenExpiresAt: Date().addingTimeInterval(3600)), origin: origin)
        await m.restore()
        #expect(m.phase == .signedIn && m.account == nil)
        #expect(m.error?.hasPrefix("Serveur injoignable") == true)
        try k.delete(origin: origin)
    }
}
