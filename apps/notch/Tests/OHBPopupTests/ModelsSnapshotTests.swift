import AppKit
import Foundation
import SwiftUI
import Testing
@testable import OHBPopup

/// La page Réglages › Modèles en PNG, comme `SnapshotExportTests` : seulement avec `OPENEDBOT_SNAPSHOT_DIR`.
@Suite(.french) @MainActor
struct ModelsSnapshotTests {
    @Test func export() async throws {
        guard let dir = ProcessInfo.processInfo.environment["OPENEDBOT_SNAPSHOT_DIR"] else { return }
        func shoot(_ name: String, _ view: some View, size: CGSize = CGSize(width: 720, height: 760)) throws {
            let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height, alignment: .topLeading)
                .background(Surface.window).preferredColorScheme(.dark))
            host.frame = NSRect(origin: .zero, size: size)
            host.layoutSubtreeIfNeeded()
            let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds)!
            host.cacheDisplay(in: host.bounds, to: rep)
            try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
        }
        let t = StubTransport()
        let origin = "https://t-\(UUID().uuidString.prefix(8).lowercased()).test"
        let d = TestSupport.defaults("models-snap")
        d.set(origin, forKey: "notch.apiOrigin")
        let k = SessionKeychain(service: TestSupport.keychainService, legacyService: nil)
        try k.save(try OHBotAuthClient.decoder.decode(OHBotSession.self, from: Data(ModelsSettingsTests.session.utf8)), origin: URL(string: origin)!)
        let account = AccountModel(defaults: d, keychain: k, transport: t)
        await account.restore()
        t.on("/api/runtime", (200, ModelsSettingsTests.runtime(provider: "anthropic", model: "claude-sonnet-5-5")))
        t.on("/api/runtimes/rt-1/models", (200, ModelsSettingsTests.catalog(anthropicConnected: true)))
        let notch = NotchModel()
        let s = ModelsSettingsModel(account: account, transport: t, pollInterval: .seconds(3600))
        await s.load()
        func page(_ expanded: String? = nil) -> some View {
            ScrollView { ModelsPage(account: account, notch: notch, openAccount: {}, settings: s, expanded: expanded).padding(28) }
        }
        try shoot("snap-settings-models", page())
        try shoot("snap-settings-models-key", page("anthropic"))
        // Un modèle à part : les pages déjà capturées, en disparaissant, annulent l'autorisation du leur.
        t.on("/api/runtimes/rt-1/providers/anthropic/auth",
             (200, #"{"sessionId":"s","provider":"anthropic","status":"pending","verificationUri":"https://auth.example.com/device","userCode":"ABCD-1234","error":null,"expiresAt":"2099-01-01T00:00:00Z"}"#))
        let o = ModelsSettingsModel(account: account, transport: t, pollInterval: .seconds(3600))
        await o.load()
        o.startOAuth(provider: "anthropic")
        await waitUntil { o.oauth?.session != nil }
        try shoot("snap-settings-models-oauth", ScrollView { ModelsPage(account: account, notch: notch, openAccount: {}, settings: o, expanded: "anthropic").padding(28) })
        o.cancelOAuth()
        let signedOut = AccountModel(defaults: TestSupport.defaults("models-out"), keychain: SessionKeychain(service: TestSupport.keychainService, legacyService: nil), transport: t)
        try shoot("snap-settings-models-out", ScrollView { ModelsPage(account: signedOut, notch: notch, openAccount: {}).padding(28) }, size: CGSize(width: 720, height: 200))
    }
}
