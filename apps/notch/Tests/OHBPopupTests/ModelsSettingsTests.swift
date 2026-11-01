import Foundation
import Testing
@testable import OHBPopup

/// Réglages › Modèles contre un faux openedbot : lecture, préférence, mode, clé API, OAuth par code.
@Suite(.french) @MainActor
struct ModelsSettingsTests {
    static let session = #"{"accessToken":"at","accessTokenExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"rt","organizationId":"org-1"}"#

    static func runtime(provider: String? = nil, model: String? = nil, writable: Bool = true) -> String {
        let p = provider.map { "\"\($0)\"" } ?? "null", m = model.map { "\"\($0)\"" } ?? "null"
        return """
        {"modelAssignmentMode":"global","runtime":{"id":"rt-1","name":"vps-acme","reachability":"connector","selectedProvider":\(p),"selectedModel":\(m),
          "reasoningEffort":null,"lastHealthStatus":"healthy","link":{"connected":true},
          "management":{"kind":"host","credentialsWritable":\(writable),"oauthWritable":\(writable)}}}
        """
    }

    static func catalog(anthropicConnected: Bool) -> String {
        """
        {"runtimeId":"rt-1","runtimeName":"vps-acme","hermesProfile":null,"currentProvider":"opencode-free","runtimeDefaultModel":"big-pickle",
         "hasUsableProvider":\(anthropicConnected),"runtimeConfigWritable":false,"providers":[
          {"slug":"anthropic","name":"Anthropic","isCurrent":false,"authenticated":\(anthropicConnected),"alwaysAuthenticated":false,"provesInference":true,
           "acceptsApiKey":true,"acceptsOauth":true,"warning":null,"authCommand":null,
           "models":[{"id":"claude-sonnet-5-5","fast":false,"reasoning":true,"isRuntimeDefault":false,"freeTier":null}]},
          {"slug":"opencode-free","name":"OpenCode Free","isCurrent":true,"authenticated":true,"alwaysAuthenticated":true,"provesInference":true,
           "acceptsApiKey":false,"acceptsOauth":false,"warning":null,"authCommand":null,
           "models":[{"id":"big-pickle","fast":true,"reasoning":false,"isRuntimeDefault":true,"freeTier":null}]}]}
        """
    }

    private func make(runtime: String = runtime()) async throws -> (ModelsSettingsModel, StubTransport, () -> [URL]) {
        let t = StubTransport()
        let origin = "https://t-\(UUID().uuidString.prefix(8).lowercased()).test"
        let d = TestSupport.defaults("models")
        d.set(origin, forKey: "notch.apiOrigin")
        let k = SessionKeychain(service: TestSupport.keychainService, legacyService: nil)
        try k.save(try OHBotAuthClient.decoder.decode(OHBotSession.self, from: Data(Self.session.utf8)), origin: URL(string: origin)!)
        let account = AccountModel(defaults: d, keychain: k, transport: t)
        await account.restore()
        t.on("/api/runtime", (200, runtime))
        var opened: [URL] = []
        let settings = ModelsSettingsModel(account: account, transport: t, pollInterval: .milliseconds(5), openURL: { opened.append($0) })
        return (settings, t, { opened })
    }

    @Test func loadReadsTheRuntimeAndCatalogAndPublishesItToTheNotch() async throws {
        let (s, t, _) = try await make(runtime: Self.runtime(provider: "anthropic", model: "claude-sonnet-5-5"))
        t.on("/api/runtimes/rt-1/models", (200, Self.catalog(anthropicConnected: true)))
        var published: ModelCatalog?
        s.onCatalog = { published = $0 }
        await s.load()
        #expect(s.phase == .ready)
        #expect(s.assignmentMode == "global" && s.credentialsWritable && s.oauthWritable)
        #expect(s.connectedProviders.map(\.slug) == ["anthropic", "opencode-free"])
        #expect(s.catalog?.providers.first?.acceptsOauth == true)
        #expect(published?.globalModel == "claude-sonnet-5-5" && published?.assignmentMode == "global")
    }

    @Test func noRuntimeAndFailuresAreSaid() async throws {
        let (s, t, _) = try await make(runtime: #"{"runtime":null}"#)
        await s.load()
        #expect(s.phase == .noRuntime)
        t.on("/api/runtime", (403, #"{"error":{"code":"ALPHA_CLOSED"}}"#))
        await s.load()
        #expect(s.phase == .failed("Ce serveur est en alpha fermée : votre adresse IP n'est pas autorisée."))
    }

    @Test func aConfirmedKeyReloadsTheCatalogAndBecomesTheDefaultWhenNoneIsUsable() async throws {
        let (s, t, _) = try await make()
        t.on("/api/runtimes/rt-1/models", (200, Self.catalog(anthropicConnected: false)), (200, Self.catalog(anthropicConnected: true)))
        await s.load()
        t.on("/api/runtimes/rt-1/providers/anthropic/credentials",
             (200, #"{"runtimeId":"rt-1","provider":"anthropic","label":"ohb-1","verification":"confirmed","provesInference":true,"detail":null}"#))
        t.on("/api/runtimes/rt-1/model-selection",
             (200, #"{"id":"rt-1","name":"vps-acme","selectedProvider":"anthropic","selectedModel":"claude-sonnet-5-5","reasoningEffort":"medium"}"#))
        let ok = await s.saveKey(provider: "anthropic", apiKey: "  sk-test-key \n")
        #expect(ok)
        let post = t.calls.first { $0.path.hasSuffix("/credentials") }
        #expect(post?.method == "POST" && post?.body["apiKey"] as? String == "sk-test-key")
        let put = t.calls.first { $0.path.hasSuffix("/model-selection") }
        #expect(put?.method == "PUT" && put?.body["provider"] as? String == "anthropic"
                && put?.body["model"] as? String == "claude-sonnet-5-5" && put?.body["reasoningEffort"] as? String == "medium")
        #expect(s.runtime?.selectedModel == "claude-sonnet-5-5" && s.runtime?.management?.kind == "host") // gardé d'avant la réponse
        #expect(s.notices["anthropic"]?.tone == .success && s.connectedProviders.contains { $0.slug == "anthropic" })
    }

    @Test func aRefusedKeyKeepsThePreferenceAndSaysWhy() async throws {
        let (s, t, _) = try await make()
        t.on("/api/runtimes/rt-1/models", (200, Self.catalog(anthropicConnected: false)))
        await s.load()
        t.on("/api/runtimes/rt-1/providers/anthropic/credentials",
             (200, #"{"runtimeId":"rt-1","provider":"anthropic","label":"ohb-1","verification":"denied","provesInference":false,"detail":"401 invalid x-api-key"}"#))
        #expect(await s.saveKey(provider: "anthropic", apiKey: "bad") == false)
        #expect(s.notices["anthropic"] == .init(tone: .error, text: "401 invalid x-api-key"))
        #expect(!t.calls.contains { $0.path.hasSuffix("/model-selection") })
        // Une clé vide ou un slug qui sortirait du chemin ne partent pas.
        #expect(await s.saveKey(provider: "anthropic", apiKey: "   ") == false)
        #expect(await s.saveKey(provider: "../bots", apiKey: "k") == false)
        #expect(t.calls.filter { $0.path.hasSuffix("/credentials") }.count == 1)
    }

    @Test func clearingThePreferenceSendsExplicitNullsAndRoleErrorsAreReadable() async throws {
        let (s, t, _) = try await make(runtime: Self.runtime(provider: "anthropic", model: "claude-sonnet-5-5"))
        t.on("/api/runtimes/rt-1/models", (200, Self.catalog(anthropicConnected: true)))
        await s.load()
        t.on("/api/runtimes/rt-1/model-selection", (200, #"{"id":"rt-1","selectedProvider":null,"selectedModel":null,"reasoningEffort":null}"#))
        await s.select(provider: nil, model: nil, effort: nil)
        let put = t.calls.last { $0.path.hasSuffix("/model-selection") }
        #expect(put?.body.keys.sorted() == ["model", "provider", "reasoningEffort"] && put?.body["provider"] is NSNull)
        #expect(s.runtime?.selectedProvider == nil && s.runtime?.name == "vps-acme")

        t.on("/api/runtimes/assignment-mode", (403, #"{"error":{"code":"ROLE_REQUIRED","message":"Droits insuffisants."}}"#))
        await s.setAssignmentMode("per_bot")
        #expect(s.assignmentMode == "global")
        #expect(s.notices[""]?.text.hasPrefix("Votre rôle ne permet pas") == true)
        t.on("/api/runtimes/assignment-mode", (200, #"{"modelAssignmentMode":"per_bot"}"#))
        await s.setAssignmentMode("per_bot")
        #expect(s.assignmentMode == "per_bot" && t.calls.last?.body["mode"] as? String == "per_bot")
    }

    @Test func oauthShowsTheCodeOpensThePageAndFinishesConnected() async throws {
        let (s, t, opened) = try await make(runtime: Self.runtime(provider: "opencode-free", model: "big-pickle"))
        t.on("/api/runtimes/rt-1/models", (200, Self.catalog(anthropicConnected: false)), (200, Self.catalog(anthropicConnected: true)))
        await s.load()
        let pending = #"{"sessionId":"sess-1","provider":"anthropic","status":"pending","verificationUri":"https://auth.example.com/device","userCode":"ABCD-1234","error":null,"expiresAt":"2099-01-01T00:00:00Z"}"#
        let done = #"{"sessionId":"sess-1","provider":"anthropic","status":"connected","verificationUri":null,"userCode":null,"error":null,"expiresAt":"2099-01-01T00:00:00Z"}"#
        // Même chemin pour l'ouverture (POST) et la sonde (GET) : servis dans l'ordre.
        t.on("/api/runtimes/rt-1/providers/anthropic/auth", (200, pending), (200, pending), (200, done))
        s.startOAuth(provider: "anthropic")
        await waitUntil { s.oauth?.session?.userCode == "ABCD-1234" }
        s.openVerification()
        #expect(opened() == [URL(string: "https://auth.example.com/device")!])
        await waitUntil { s.oauth == nil }
        #expect(s.notices["anthropic"]?.tone == .success)
        let polls = t.calls.filter { $0.path.hasSuffix("/auth") && $0.method == "GET" }
        #expect(polls.count >= 1)
        // La préférence (OpenCode Free, utilisable) n'est pas remplacée.
        #expect(!t.calls.contains { $0.path.hasSuffix("/model-selection") })
    }

    @Test func cancellingAPendingAuthorizationCancelsItOnTheHost() async throws {
        let (s, t, _) = try await make()
        t.on("/api/runtimes/rt-1/models", (200, Self.catalog(anthropicConnected: false)))
        await s.load()
        t.on("/api/runtimes/rt-1/providers/anthropic/auth",
             (200, #"{"sessionId":"sess-9","provider":"anthropic","status":"pending","verificationUri":"https://auth.example.com/device","userCode":"WXYZ","error":null,"expiresAt":"2099-01-01T00:00:00Z"}"#))
        s.startOAuth(provider: "anthropic")
        await waitUntil { s.oauth?.session != nil }
        s.cancelOAuth()
        #expect(s.oauth == nil)
        await waitUntil { t.calls.contains { $0.method == "DELETE" } }
        let delete = t.calls.first { $0.method == "DELETE" }
        #expect(delete?.path == "/api/runtimes/rt-1/providers/anthropic/auth")
    }

    @Test func aFailedAuthorizationSaysWhyAndALostSessionStopsPolling() async throws {
        let (s, t, _) = try await make()
        t.on("/api/runtimes/rt-1/models", (200, Self.catalog(anthropicConnected: false)))
        await s.load()
        t.on("/api/runtimes/rt-1/providers/anthropic/auth",
             (200, #"{"sessionId":"s","provider":"anthropic","status":"pending","verificationUri":null,"userCode":"C","error":null,"expiresAt":"2099-01-01T00:00:00Z"}"#),
             (200, #"{"sessionId":"s","provider":"anthropic","status":"failed","verificationUri":null,"userCode":null,"error":"Code expiré","expiresAt":"2099-01-01T00:00:00Z"}"#))
        s.startOAuth(provider: "anthropic")
        await waitUntil { s.oauth?.error != nil }
        #expect(s.oauth?.error == "Code expiré")

        t.on("/api/runtimes/rt-1/providers/anthropic/auth",
             (200, #"{"sessionId":"s2","provider":"anthropic","status":"pending","verificationUri":null,"userCode":"C","error":null,"expiresAt":"2099-01-01T00:00:00Z"}"#),
             (404, #"{"error":{"code":"OAUTH_SESSION_NOT_FOUND"}}"#))
        s.startOAuth(provider: "anthropic")
        await waitUntil { s.oauth?.error != nil }
        #expect(s.oauth?.error?.hasPrefix("La session d'autorisation est perdue") == true)
        let count = t.calls.count
        try await Task.sleep(for: .milliseconds(50))
        #expect(t.calls.count == count) // plus de sonde
    }

    @Test func slugsNeverLeaveTheirPathSegment() {
        #expect(ModelsSettingsModel.isSlug("openai-codex") && ModelsSettingsModel.isSlug("z_ai2"))
        #expect(!ModelsSettingsModel.isSlug("") && !ModelsSettingsModel.isSlug("../x") && !ModelsSettingsModel.isSlug("Anthropic")
                && !ModelsSettingsModel.isSlug("a/b") && !ModelsSettingsModel.isSlug("a?b") && !ModelsSettingsModel.isSlug("é"))
    }
}
