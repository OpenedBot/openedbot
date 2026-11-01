import AppKit
import Foundation
import SwiftUI
import Testing
@testable import OHBPopup

/// Exporte les vues en PNG pour les regarder sans ouvrir de fenêtre (une fenêtre volerait le focus).
/// Ne tourne que si `OHB_SNAPSHOT_DIR` est défini : `OHB_SNAPSHOT_DIR=/tmp/ohb-ui swift test --filter SnapshotExport`.
@MainActor
struct SnapshotExportTests {
    @Test func export() async throws {
        guard let dir = ProcessInfo.processInfo.environment["OHB_SNAPSHOT_DIR"] else { return }
        let model = NotchModel()
        let feed = MockBotFeed(model: model, timeScale: 0)
        model.sections = MockBotFeed.sections
        model.bots = MockBotFeed.roster(now: Date())
        feed.simulateApproval()
        await feed.loadModelCatalog()
        model.update("support") { bot in bot.modelID = "GPT-5.6 Luna"; bot.reasoningEffort = "low" }
        model.update("support") { bot in
            bot.thread.append(ChatMessage(role: .user, text: "Vérifie que la commande 4821 a bien été livrée en retard avant de rembourser."))
            bot.thread.append(ChatMessage(role: .tool, text: "shopify.get_order 4821 → delivered_at 2026-10-09, promised 2026-10-03"))
            bot.thread.append(ChatMessage(role: .bot, text: "Six jours de retard, le remboursement est justifié. Je lance le remboursement de 49,00 € : il me faut ton accord pour la commande de paiement."))
        }
        func shoot(_ name: String, _ view: some View, size: CGSize) throws {
            let host = NSHostingView(rootView: view)
            host.frame = NSRect(origin: .zero, size: size)
            host.layoutSubtreeIfNeeded()
            let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds)!
            host.cacheDisplay(in: host.bounds, to: rep)
            try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
        }
        try shoot("snap-dialog-approval", AgentDialogView(model: model, botID: "support", feed: feed, close: {}), size: CGSize(width: 400, height: 520))
        model.update("support") { bot in bot.thread = Array(bot.thread.suffix(2)) }
        try shoot("snap-dialog-approval-short", AgentDialogView(model: model, botID: "support", feed: feed, close: {}), size: CGSize(width: 400, height: 520))
        try shoot("snap-model-picker", ModelPickerView(bot: model.bot("support")!, catalog: model.modelCatalog, feed: feed), size: CGSize(width: 440, height: 280))
        try shoot("snap-dialog-idle", AgentDialogView(model: model, botID: "notes", feed: feed, close: {}), size: CGSize(width: 400, height: 520))
        // Un fil riche : markdown du bot (liste, gras, code) et nom long qui replie la puce sous le nom.
        model.update("notes") { bot in
            bot.name = "Second cerveau · Konosuba"
            bot.thread = [
                ChatMessage(role: .user, text: "Fais-moi le point SEO."),
                ChatMessage(role: .bot, text: """
                **Oui, tu auras des frais** si tu avances le retour de 24 h.

                Sur ton billet Trip.com (PNR **PFM641**) :
                1. **Frais de modification** China Eastern (souvent une centaine d'€ / pers.)
                2. + différence de prix si le vol est plus cher
                3. × 2 (toi + Orlane)

                Le montant exact n'apparaît que dans `Gérer ma réservation`. Ce n'est pas dans le PDF.

                ```sh
                curl -sI https://example.test/sitemap.xml
                ```
                """),
                ChatMessage(role: .user, text: "Hello"),
                ChatMessage(role: .bot, text: "Salut kev ! Quoi de neuf ?"),
            ]
        }
        try shoot("snap-dialog-markdown", AgentDialogView(model: model, botID: "notes", feed: feed, close: {}), size: CGSize(width: 400, height: 520))
        // Le composer avec deux pièces en attente.
        let pending = [
            PendingAttachment(name: "capture-écran-2026-10-11.png", contentType: "image/png", kind: .image, data: Data([1, 2, 3])),
            PendingAttachment(name: "rapport-seo.md", contentType: "text/markdown", kind: .document, data: Data("x".utf8)),
        ]
        try shoot("snap-dialog-attachments", AgentDialogView(model: model, botID: "notes", feed: feed, close: {}, attachments: pending), size: CGSize(width: 400, height: 520))

        // Le fil openedbot : citation et réactions, un tour fini avec ses actions, un tour en direct en arbre déplié.
        let now = Date()
        var c = Conversation()
        c.messages = [
            ConversationMessage(id: "u1", role: .user, text: "Fais le point sur la veille de la semaine.", attachments: [], runID: "r1",
                                at: now.addingTimeInterval(-600)),
            ConversationMessage(id: "a1", role: .assistant, text: "Trois sujets : A2A, Hermes 0.9 et la sortie de Codex 6.", attachments: [],
                                runID: "r1", at: now.addingTimeInterval(-560), authorBotID: "notes", authorName: "Notes",
                                reactions: [MessageReaction(emoji: "👍", count: 1, mine: true), MessageReaction(emoji: "🎉", count: 2, mine: false)]),
            ConversationMessage(id: "u2", role: .user, text: "Creuse le premier, avec les sources.", attachments: [], runID: "r2",
                                at: now.addingTimeInterval(-60), replyTo: ReplyQuote(messageID: "a1", authorName: "Notes",
                                excerpt: "Trois sujets : A2A, Hermes 0.9 et la sortie de Codex 6.")),
        ]
        c.runs = ["r1": ConversationRun(status: .completed, startedAt: now.addingTimeInterval(-590)),
                  "r2": ConversationRun(status: .running, startedAt: now.addingTimeInterval(-55))]
        func e(_ type: String, _ seq: Int, text: String? = nil, tool: String? = nil, preview: String? = nil, call: String? = nil, ms: Double? = nil, failed: Bool = false) -> ConversationEvent {
            ConversationEvent(runID: "r2", sequence: seq, type: type, at: now.addingTimeInterval(-50 + Double(seq)), text: text, tool: tool,
                              preview: preview, toolCallID: call, durationMs: ms, failed: failed, errorMessage: failed ? "délai dépassé" : nil, resultExcerpt: nil)
        }
        c.events = [e("agent.message", 1, text: "Je cherche les annonces A2A récentes."),
                    e("tool.call", 2, tool: "web_search", preview: "A2A protocol octobre 2026", call: "s1"),
                    e("tool.result", 3, tool: "web_search", call: "s1", ms: 1240),
                    e("tool.call", 4, tool: "web_search", preview: "A2A Hermes router", call: "s2"),
                    e("tool.result", 5, tool: "web_search", call: "s2", ms: 980, failed: true),
                    e("tool.call", 6, tool: "web_extract", preview: "https://a2a.dev/blog", call: "x1")]
        model.update("notes") { bot in bot.name = "Notes"; bot.thread = []; bot.conversation = c }
        try shoot("snap-dialog-thread", AgentDialogView(model: model, botID: "notes", feed: feed, close: {},
                                                        replyingTo: ReplyQuote(messageID: "a1", authorName: "Notes", excerpt: "Trois sujets : A2A, Hermes 0.9 et la sortie de Codex 6.")),
                  size: CGSize(width: 570, height: 650))

        let t = StubTransport()
        t.on("/api/auth/providers", (200, #"{"google":{"enabled":true},"password":{"enabled":true}}"#))
        let d = TestSupport.defaults("snap")
        d.set("https://openedbot.app", forKey: "notch.apiOrigin")
        let account = AccountModel(defaults: d, keychain: SessionKeychain(service: TestSupport.keychainService, legacyService: nil), transport: t)
        await account.checkProviders()
        let size = CGSize(width: 640, height: 498) // 470 + la barre de titre fondue
        try shoot("snap-settings-account-out", SettingsView(model: model, feed: feed, account: account), size: size)
        try shoot("snap-settings-notch", SettingsView(model: model, feed: feed, account: account, page: .notch), size: size)
        try shoot("snap-settings-demo", SettingsView(model: model, feed: feed, account: account, page: .demo), size: size)
        t.on("/api/auth/native/authorize", (200, #"{"code":"c"}"#))
        t.on("/api/auth/native/token", (200, #"{"accessToken":"a","accessTokenExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","organizationId":"o"}"#))
        t.on("/api/auth/me", (200, #"{"user":{"email":"operateur@acme.test","name":"Camille"},"organization":{"name":"Acme"},"role":"operator"}"#))
        await account.signIn(email: "operateur@acme.test", password: "x", organizationSlug: "", emailCode: nil)
        try shoot("snap-settings-account-in", SettingsView(model: model, feed: feed, account: account), size: size)

        // Le journal en direct et la carte du runtime, sur un état réaliste.
        model.feedState = .live
        model.runtime = RuntimeStatus(name: "vps-paris", connected: true, health: "healthy", lastSeenAt: Date().addingTimeInterval(-4),
                                      version: "0.9.2", latestVersion: "0.9.3", model: "gpt-6-luna")
        model.journal.clear()
        model.record(.info, .stream, "flux ouvert au curseur 1842")
        model.record(.info, .api, "relecture : 2 bots, 1 fil, curseur 1842 (212 ms)", key: "refresh")
        model.record(.info, .runtime, "vps-paris en ligne, connecteur 0.9.2")
        model.record(.info, .send, "Seo : message accepté, run 3f9a1c2e (184 ms)")
        for _ in 0..<37 { model.record(.info, .event, "Seo : agent.message · run 3f9a1c2e", key: "agent.message:3f9a") }
        model.record(.error, .send, "Seo : message refusé (1 pièce, 1624 octets) : Le serveur a répondu 500 : Erreur interne : une erreur inattendue dans l’API. Référence : 7c1e0b")
        model.record(.warning, .stream, "flux refusé par le serveur après 902 s (jeton expiré), nouveau jeton et reconnexion")
        model.record(.info, .stream, "flux ouvert au curseur 1907")
        try shoot("snap-settings-journal", SettingsView(model: model, feed: feed, account: account, page: .journal), size: CGSize(width: 760, height: 640))
        let metrics = NotchMetrics(scale: 1)
        try shoot("snap-runtime-card", RuntimeCard(runtime: model.runtime, feedState: model.feedState, journal: model.journal, now: Date(),
                                                   direction: NotchEdge.right.tooltipDirection, metrics: metrics, animating: false)
                    .padding(12).background(Color(hex: 0x202020)),
                  size: CGSize(width: metrics.cardWidth + 60, height: 300))
        try shoot("snap-orb", HStack(spacing: 16) {
            ForEach([Liveness.alive, .degraded, .down], id: \.self) { l in
                SettingsOrb(hovering: false, spins: 0, metrics: metrics, liveness: l, animating: false)
            }
        }.padding(16).background(Color(hex: 0x202020)), size: CGSize(width: 3 * metrics.orbDiameter + 64, height: metrics.orbDiameter + 32))

        // L'île sur l'encoche d'un MacBook Pro 16 pouces : état compact, message bref, panneau déplié.
        let place = NotchGeometry.placement(edge: .top, screenFrame: CGRect(x: 0, y: 0, width: 1728, height: 1117),
                                            visibleFrame: CGRect(x: 0, y: 40, width: 1728, height: 1044),
                                            camera: CGRect(x: 771, y: 1085, width: 185, height: 32))
        let island = NotchGeometry(edge: .top, metrics: metrics, cellCount: 1, screen: place.screen, alongOffset: 0,
                                   inset: place.inset, restLength: place.restLength, minBodyLength: place.minBodyLength, anchor: place.anchor)
        let backdrop = Color(hex: 0x3A6EA5)
        try shoot("snap-island-compact", IslandCompactView(model: model, geometry: island, compact: Island.compact(bots: model.bots), flash: nil)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(backdrop),
                  size: CGSize(width: 420, height: 60))
        try shoot("snap-island-flash", IslandCompactView(model: model, geometry: island, compact: nil,
                                                         flash: Island.Flash(botID: "support", botName: "Support", kind: .finished))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(backdrop),
                  size: CGSize(width: 520, height: 60))
        try shoot("snap-island-panel", IslandPanelView(model: model, geometry: island, onOpenDialog: { _ in }, onSettings: {},
                                                       onRespond: { _, _, _ in })
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(backdrop),
                  size: CGSize(width: 520, height: 640))

        // Les notifications de l'île : bannières (message, accord, retour d'absence), cloche, liste du panneau.
        let reply = Notice(kind: .message, botID: "notes", botName: "Notes",
                           text: "Voici ton rapport SEO de la semaine : trois pages à corriger, deux liens cassés.", at: Date())
        let failed = Notice(kind: .failed, botID: "ops", botName: "Ops", text: "Sauvegarde nocturne", at: Date().addingTimeInterval(-300))
        let support = model.bot("support")!
        let ask = Notice(kind: .approval, botID: "support", botName: "Support",
                         text: "\(support.pending!.tool) · \(support.pending!.command)", at: Date(), approvalID: support.pending!.id)
        func banner(_ name: String, _ b: Banner) throws {
            try shoot(name, IslandBannerView(model: model, geometry: island, banner: b, onOpen: { _ in }, onLater: {}, onShowAll: {},
                                             onRespond: { _, _, _ in })
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(backdrop),
                      size: CGSize(width: 520, height: 200))
        }
        try banner("snap-banner-message", .notice(reply))
        try banner("snap-banner-approval", .notice(ask))
        try banner("snap-banner-recap", .recap(count: 3, latest: reply))
        model.inbox.add(failed)
        model.inbox.add(reply)
        try shoot("snap-island-bell", IslandCompactView(model: model, geometry: island,
                                                        compact: Island.compact(bots: [], unread: 2, latestUnreadBotID: "notes"), flash: nil)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(backdrop),
                  size: CGSize(width: 420, height: 60))
        try shoot("snap-island-panel-notices", IslandPanelView(model: model, geometry: island, onOpenDialog: { _ in }, onSettings: {},
                                                               onRespond: { _, _, _ in })
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(backdrop),
                  size: CGSize(width: 520, height: 760))
        // Sans demande d'accord : les cinq dernières, la plus ancienne hors liste.
        let supportIndex = model.bots.firstIndex { $0.id == "support" }!
        let supportPending = model.bots[supportIndex].pending
        model.bots[supportIndex].pending = nil
        for (i, kind) in [Notice.Kind.offline, .back, .finished, .offline].enumerated() {
            model.inbox.add(Notice(kind: kind, botID: "ops", botName: "Ops", text: "vps prod", at: Date().addingTimeInterval(Double(i) * 60)))
        }
        try shoot("snap-island-panel-five", IslandPanelView(model: model, geometry: island, onOpenDialog: { _ in }, onSettings: {},
                                                            onRespond: { _, _, _ in })
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(backdrop),
                  size: CGSize(width: 520, height: 760))
        model.bots[supportIndex].pending = supportPending
        // Dix bots : au repos, puis cinq au travail et deux en attente.
        let idle = model.bots.map { b -> Bot in var b = b; b.runs = []; b.pending = nil; b.runtime.connected = true; return b }
        try shoot("snap-island-rest-10", IslandCompactView(model: model, geometry: island, compact: Island.compact(bots: idle), flash: nil)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(backdrop),
                  size: CGSize(width: 420, height: 60))
        let busy = Island.Compact(botIDs: Array(idle.prefix(3).map(\.id)), extra: 4, working: 5, waiting: 2, unread: 3, total: 10)
        try shoot("snap-island-busy-10", IslandCompactView(model: model, geometry: island, compact: busy, flash: nil)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(backdrop),
                  size: CGSize(width: 420, height: 60))
        try SessionKeychain(service: TestSupport.keychainService, legacyService: nil).delete(origin: account.origin!)
    }
}
