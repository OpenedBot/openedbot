import Foundation
import Testing
@testable import OHBPopup

// Le fil comme la console le dessine : outils tirés des événements, narration, réponse persistée,
// direct, puces de jour, pièces jointes ; visages bloub et marques de fournisseurs de la console.

private func at(_ s: TimeInterval) -> Date { Date(timeIntervalSince1970: 1_791_700_000 + s) }

private func ev(_ type: String, run: String = "r1", seq: Int, t: TimeInterval = 0, text: String? = nil, tool: String? = nil,
                preview: String? = nil, call: String? = nil, ms: Double? = nil, failed: Bool = false, error: String? = nil) -> ConversationEvent {
    ConversationEvent(runID: run, sequence: seq, type: type, at: at(t), text: text, tool: tool, preview: preview, toolCallID: call,
                      durationMs: ms, failed: failed, errorMessage: error, resultExcerpt: nil)
}

private func turns(_ items: [TimelineItem]) -> [Turn] {
    items.compactMap { if case .turn(let t) = $0 { return t } else { return nil } }
}

@Suite(.french)
struct ConversationTests {
    @Test func eventsApplyOnceAndMoveTheRunState() {
        var c = Conversation()
        let first = c.apply(ev("message.admitted", seq: 0))
        #expect(first)
        #expect(c.runs["r1"]?.status == .running)
        let again = c.apply(ev("message.admitted", seq: 0))
        #expect(!again) // même runId:sequence : ignoré
        c.apply(ev("approval.requested", seq: 1))
        #expect(c.runs["r1"]?.status == .awaitingApproval && c.isLive("r1"))
        c.apply(ev("agent.message", seq: 2, text: "ok"))
        #expect(c.runs["r1"]?.status == .running) // l'approbation tranchée, le run reprend
        c.apply(ev("run.completed", seq: 3))
        #expect(c.runs["r1"]?.status == .completed && !c.isLive("r1"))
        c.apply(ev("run.error", run: "r2", seq: 1, error: "boom"))
        #expect(c.runs["r2"]?.status == .failed)
    }

    @Test func aRefreshKeepsLiveEventsTheSnapshotDoesNotHaveYet() {
        var live = Conversation()
        live.apply(ev("agent.message", run: "r-now", seq: 1, text: "Je "))
        live.apply(ev("agent.message", run: "r-now", seq: 2, text: "cherche"))
        live.apply(ev("agent.message", run: "r-old", seq: 9, text: "vieux"))
        var fresh = Conversation()
        fresh.events = [ev("agent.message", run: "r-now", seq: 1, text: "Je ")]
        fresh.runs = ["r-now": ConversationRun(status: .running, startedAt: at(0)),
                      "r-old": ConversationRun(status: .completed, startedAt: at(0))]
        live.replace(with: fresh)
        #expect(live.events.map(\.key) == ["r-now:1", "r-now:2"]) // le direct d'un run conclu cède au snapshot
        #expect(live.runs["r-old"]?.status == .completed)
    }
}

@Suite(.french)
struct ThreadTimelineTests {
    private let user = ConversationMessage(id: "m1", role: .user, text: "Fais le point", attachments: [], runID: "r1", at: at(0))

    @Test func toolsSplitNarrationAndThePersistedMessageIsTheAnswer() {
        var c = Conversation()
        c.messages = [user, ConversationMessage(id: "m2", role: .assistant, text: "Voici le point complet.", attachments: [],
                                                runID: "r1", at: at(10), authorBotID: "b", authorName: "Nova", authorFace: nil)]
        c.runs["r1"] = ConversationRun(status: .completed, startedAt: at(1))
        c.events = [
            ev("agent.message", seq: 1, t: 1, text: "Je charge "), ev("agent.message", seq: 2, t: 1, text: "les skills."),
            ev("tool.call", seq: 3, t: 2, tool: "skill_view", preview: "veille", call: "a"),
            ev("tool.result", seq: 4, t: 3, tool: "skill_view", call: "a", ms: 224),
            ev("tool.call", seq: 5, t: 3, tool: "web_search", preview: "agents IA", call: "b"),
            ev("tool.call", seq: 6, t: 3, tool: "web_search", preview: "A2A", call: "c"),
            ev("tool.result", seq: 7, t: 4, tool: "web_search", call: "b", ms: 1200),
            ev("tool.result", seq: 8, t: 4, tool: "web_search", call: "c", ms: 800, failed: true, error: "timeout"),
            ev("agent.message", seq: 9, t: 5, text: "Voici le point"),
            ev("run.completed", seq: 10, t: 10),
        ]
        let items = ThreadTimeline.build(c, botName: "Nova", botID: "b", botFace: nil, locals: [])
        let t = turns(items).first!
        #expect(t.activity.count == 3)
        #expect(t.activity[0] == .narration("Je charge les skills."))
        guard case .tools(let skill) = t.activity[1], case .tools(let search) = t.activity[2] else { Issue.record("groupes"); return }
        #expect(skill.name == "skill_view" && skill.count == 1 && skill.durationMs == 224)
        #expect(search.count == 2 && search.previews == ["agents IA", "A2A"] && search.failures == 1 && search.firstError == "timeout")
        #expect(t.toolCount == 3 && t.failureCount == 1 && t.totalDurationMs == 2224)
        // Conclu : le message persisté fait foi, même si le flux a perdu des fragments.
        #expect(t.answer == "Voici le point complet." && !t.live && t.authorName == "Nova")
    }

    @Test func aLiveTurnShowsTheStreamAndItsLastStep() {
        var c = Conversation()
        c.messages = [user]
        c.apply(ev("message.admitted", seq: 0, t: 1))
        c.apply(ev("tool.call", seq: 1, t: 2, tool: "terminal", preview: "ls", call: "x"))
        var t = turns(ThreadTimeline.build(c, botName: "Seo", botID: "s", botFace: nil, locals: [])).first!
        #expect(t.live && t.answer.isEmpty && t.lastEventType == "tool.call" && t.lastTool == "terminal")
        #expect(ToolCopy.liveLabel(t, queued: false) == "Utilise terminal…")
        guard case .tools(let g) = t.activity.first else { Issue.record("outil"); return }
        #expect(g.running == 1)
        c.apply(ev("agent.message", seq: 2, t: 3, text: "Trois fichiers."))
        t = turns(ThreadTimeline.build(c, botName: "Seo", botID: "s", botFace: nil, locals: [])).first!
        #expect(t.answer == "Trois fichiers." && ToolCopy.liveLabel(t, queued: false) == "Rédige…")
        #expect(ToolCopy.liveLabel(t, queued: true) == "En attente…")
    }

    @Test func aRunErrorBecomesTheTurnError() {
        var c = Conversation()
        c.messages = [user]
        c.apply(ev("agent.message", seq: 1, text: "Je commence"))
        c.apply(ev("run.error", seq: 2, error: "Le runtime Hermes n’expose pas son inventaire d’outils"))
        let t = turns(ThreadTimeline.build(c, botName: "Nova", botID: "b", botFace: nil, locals: [])).first!
        #expect(!t.live && t.error?.hasPrefix("Le runtime Hermes") == true && t.answer == "Je commence")
    }

    @Test func daysLocalsInboundAndOrphanRunsAreOrdered() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        var c = Conversation()
        c.messages = [
            ConversationMessage(id: "u1", role: .user, text: "Hier", attachments: [], runID: nil, at: at(0)),
            ConversationMessage(id: "i1", role: .user, text: "Je passe le relais", attachments: [], runID: nil, at: at(86_400 + 10),
                                authorBotID: "other", authorName: "Autobot", authorFace: BotFace(palette: "vert", shape: "cercle", eyes: "neutre")),
        ]
        // Une routine sans message dans la page : son tour arrive après, à l'heure de son premier événement.
        c.apply(ev("agent.message", run: "routine", seq: 1, t: 86_400 + 20, text: "Tri terminé."))
        c.apply(ev("run.completed", run: "routine", seq: 2, t: 86_400 + 21))
        let pending = ChatMessage(role: .user, text: "Et maintenant ?", at: at(86_400 + 30))
        let items = ThreadTimeline.build(c, botName: "Nova", botID: "b", botFace: nil, locals: [pending], calendar: cal)
        let kinds = items.map { item -> String in
            switch item { case .day: "day"; case .user: "user"; case .turn: "turn"; case .inbound: "inbound"; case .local: "local" }
        }
        #expect(kinds == ["day", "user", "day", "inbound", "turn", "local"])
        #expect(turns(items).first?.answer == "Tri terminé.")
    }

    @Test func attachmentsRideOnTheirMessages() {
        let image = ConversationAttachment(remoteID: "att-1", name: "code.png", contentType: "image/png", kind: "image", bytes: 68_000)
        let doc = ConversationAttachment(remoteID: nil, name: "note.md", contentType: "text/markdown", kind: "document", bytes: 111)
        var c = Conversation()
        c.messages = [ConversationMessage(id: "m1", role: .user, text: "", attachments: [image, doc], runID: "r1", at: at(0))]
        let items = ThreadTimeline.build(c, botName: "Nova", botID: "b", botFace: nil, locals: [])
        guard case .user(_, let text, let attachments, _, _, _)? = items.dropFirst().first else { Issue.record("message"); return }
        #expect(text.isEmpty && attachments == [image, doc])
        #expect(image.isImage && !doc.isImage && image.id == "att-1" && doc.id == "note.md#111")
    }

    @Test func groupingCollapsesOnlyAdjacentSameNames() {
        let calls = [ev("tool.call", seq: 1, tool: "read_file", call: "1"), ev("tool.call", seq: 2, tool: "read_file", call: "2"),
                     ev("tool.call", seq: 3, tool: "terminal", call: "3"), ev("tool.call", seq: 4, tool: "read_file", call: "4")]
        let groups = ThreadTimeline.groupCalls(calls, results: [:], runLive: false)
        #expect(groups.map(\.name) == ["read_file", "terminal", "read_file"] && groups.map(\.count) == [2, 1, 1])
        #expect(groups.allSatisfy { $0.running == 0 }) // run conclu sans résultat : pas « en cours » pour toujours
    }
}

@Suite(.french)
struct ToolCopyTests {
    @Test func labelsIconsAndDurationsFollowTheConsole() {
        #expect(ToolCopy.label("skill_view") == "Consulte une skill")
        #expect(ToolCopy.label("mcp__github__search_files") == "Cherche dans les fichiers")
        #expect(ToolCopy.label("inconnu") == nil)
        #expect(ToolCopy.symbol("web_extract") == "globe" && ToolCopy.symbol("mcp__x__y") == "powerplug")
        #expect(ToolCopy.duration(145) == "145 ms")
        #expect(ToolCopy.duration(2400) == "2,4 s")
        #expect(ToolCopy.elapsed(12.34) == "12.3s" && ToolCopy.elapsed(185) == "3m05" && ToolCopy.elapsed(-3) == "0.0s")
    }
}

@Suite(.french)
struct ThreadMappingTests {
    @Test func historyMessagesKeepAttachmentsAuthorsAndEvents() throws {
        let json = """
        {"id":"t","messages":[
          {"id":"m1","role":"user","runId":"r1","createdAt":"2026-10-11T17:44:00.000Z","content":[
            {"type":"text","text":"Lis ça"},
            {"type":"attachment","id":"a-1","name":"code.png","contentType":"image/png","kind":"image","bytes":68000}]},
          {"id":"m2","role":"assistant","runId":"r1","createdAt":"2026-10-11T17:44:06.127Z",
           "authorBot":{"id":"b","name":"Nova","face":{"artwork":"astral","palette":"rouge","shape":"galet","eyes":"fier"}},
           "content":[{"type":"text","text":"Le code est 7319."}]}],
         "runs":[{"id":"r1","status":"completed","createdAt":"2026-10-11T17:44:00Z","startedAt":"2026-10-11T17:44:01Z"}],
         "events":[{"organizationId":"o","threadId":"t","runId":"r1","sequence":3,"type":"tool.call",
                    "payload":{"tool":"read_file","preview":"code.png","toolCallId":"tc_0"},"occurredAt":"2026-10-11T17:44:02.000Z"},
                   {"organizationId":"o","threadId":"t","runId":"r1","sequence":4,"type":"tool.result",
                    "payload":{"tool":"read_file","error":false,"durationMs":224,"toolCallId":"tc_0","errorMessage":null,"resultExcerpt":null},
                    "occurredAt":"2026-10-11T17:44:03.000Z"},
                   {"organizationId":"o","threadId":"t","sequence":1,"type":"stream.noise"}]}
        """
        let snap = try OHBotAuthClient.decoder.decode(ThreadSnapshotDto.self, from: Data(json.utf8))
        let c = OHBotMapping.conversation(snap)
        #expect(c.messages.first?.attachments.first == ConversationAttachment(remoteID: "a-1", name: "code.png", contentType: "image/png", kind: "image", bytes: 68000))
        #expect(c.messages.last?.authorFace?.artwork == "astral" && c.messages.last?.authorName == "Nova")
        #expect(c.events.count == 2) // l'événement sans run est écarté
        #expect(c.events.last?.durationMs == 224 && c.events.first?.preview == "code.png")
        #expect(c.runs["r1"]?.status == .completed)
        let t = turns(ThreadTimeline.build(c, botName: "Nova", botID: "b", botFace: nil, locals: [])).first!
        #expect(t.answer == "Le code est 7319." && t.toolCount == 1 && t.authorFace?.artwork == "astral")
    }

    @Test func aLocalLineSurvivesOnlyUntilTheServerHasIt() {
        let sent = ChatMessage(remoteID: "m-9", role: .user, text: "Hello", at: at(5))
        let unsent = ChatMessage(role: .user, text: "En route", at: at(50))
        let old = ChatMessage(role: .system, text: "Refusé", at: at(1))
        #expect(!OHBotFeed.keepLocal(sent, after: at(10), persisted: ["m-9"]))
        #expect(OHBotFeed.keepLocal(sent, after: at(10), persisted: []))
        #expect(OHBotFeed.keepLocal(unsent, after: at(10), persisted: []))
        #expect(!OHBotFeed.keepLocal(old, after: at(10), persisted: []))
    }
}

@MainActor
@Suite(.french)
struct ConsoleAssetTests {
    @Test func seedPicksMatchTheConsole() {
        // Valeurs calculées par `defaultFaceFor` de l'openedbot API pour ces graines.
        let cat = BloubFaces.catalog
        #expect(cat.shapes.count == 8 && cat.expressions.count == 16 && cat.colors.count == 12)
        #expect(BloubFaces.pick(cat.colors, seed: "eb824157-fabe-4c3c-970a-2a67e92efd47", salt: "palette") == "bleu")
        #expect(BloubFaces.pick(cat.shapes, seed: "eb824157-fabe-4c3c-970a-2a67e92efd47", salt: "shape") == "galet")
        #expect(BloubFaces.pick(cat.expressions, seed: "eb824157-fabe-4c3c-970a-2a67e92efd47", salt: "eyes") == "effraye")
        #expect(BloubFaces.pick(cat.colors, seed: "b-ops", salt: "palette") == "ambre")
        #expect(BloubFaces.pick(cat.shapes, seed: "35f693e0-2970-48ab-a89e-8c0aa6012a01", salt: "shape") == "triangle")
        #expect(BloubFaces.pick([], seed: "x", salt: "y") == nil)
    }

    @Test func facesResolveRenderAndFallBack() {
        let seo = BotFace(palette: "encre", shape: "cercle", eyes: "surpris")
        let r = BloubFaces.resolve(seo, seed: "s")
        #expect(r?.shape == "cercle" && r?.eyes == "surpris" && r?.color == "encre")
        #expect(BloubFaces.image(seo, seed: "s") != nil)
        // Un identifiant retiré retombe sur un choix stable, jamais sur rien.
        let legacy = BloubFaces.resolve(BotFace(palette: "chartreuse", shape: "étoile", eyes: "?"), seed: "b-ops")
        #expect(legacy?.color == "ambre" && legacy?.shape == "nuage" && legacy?.eyes == "somnolent")
    }

    @Test func providerMarksComeFromTheConsoleTable() {
        #expect(ProviderMark.label("openai-codex", name: "ChatGPT or Codex Subscription") == "OpenAI Codex")
        #expect(ProviderMark.tint("anthropic") == .orange && ProviderMark.tint("gemini") == .blue && ProviderMark.tint("nvidia") == .green)
        #expect(ProviderMark.image("openai-codex") != nil && ProviderMark.image("opencode-free") != nil)
        // Sans marque connue : le monogramme de la console (« Mixture of Agents » → MO).
        #expect(ProviderMark.image("moa") == nil && ProviderMark.initials("moa", name: "Mixture of Agents") == "MO")
    }
}

@Suite(.french)
struct PreferencesMigrationTests {
    @Test func legacySettingsAreCopiedOnceWithoutOverwriting() {
        let d = TestSupport.defaults("migration")
        d.set("left", forKey: "notch.edge")
        PreferencesMigration.run(into: d, legacy: ["notch.edge": "top", "notch.size": 1.2, "islandAnchor": "dock"])
        #expect(d.string(forKey: "notch.edge") == "left") // un réglage déjà posé gagne
        #expect(d.double(forKey: "notch.size") == 1.2)
        #expect(d.object(forKey: "islandAnchor") == nil) // hors de l'app : pas repris
        PreferencesMigration.run(into: d, legacy: ["notch.alwaysOn": true])
        #expect(d.object(forKey: "notch.alwaysOn") == nil) // une seule fois
    }
}

@Suite(.french)
struct SessionKeychainCommandTests {
    @Test func accountsThatWouldBreakTheCommandAreRefused() {
        #expect((try? SessionKeychain.checked("https://openedbot.app")) == "https://openedbot.app")
        #expect((try? SessionKeychain.checked("https://x\" -w \"y")) == nil)
        #expect((try? SessionKeychain.checked("https://x\nadd")) == nil)
        #expect((try? SessionKeychain.checked("")) == nil)
    }
}

@Suite(.french)
struct ConversationPagingTests {
    @Test func aHistoryPageDropsOldRunsAFirstCompactReadBroughtIn() {
        // Première lecture compacte : tous les runs, dont un vieux run annulé hors de la page suivante.
        var c = Conversation()
        c.runs = ["old": ConversationRun(status: .failed, startedAt: at(0)), "new": ConversationRun(status: .completed, startedAt: at(100))]
        c.events = [ev("agent.message", run: "old", seq: 1, t: 1, text: "Vieille analyse"), ev("run.error", run: "old", seq: 2, t: 2, error: "Run annulé.")]
        // La page `/history` ne contient que le run récent.
        var page = Conversation()
        page.runs = ["new": ConversationRun(status: .completed, startedAt: at(100))]
        page.messages = [ConversationMessage(id: "u", role: .user, text: "Test", attachments: [], runID: "new", at: at(100)),
                         ConversationMessage(id: "a", role: .assistant, text: "Bien reçu.", attachments: [], runID: "new", at: at(103))]
        c.replace(with: page)
        #expect(c.events.isEmpty)
        let ts = turns(ThreadTimeline.build(c, botName: "Seo", botID: "s", botFace: nil, locals: []))
        #expect(ts.count == 1 && ts.first?.answer == "Bien reçu." && ts.first?.error == nil)
    }

    @Test func anOrphanRunTakesItsPlaceInTime() {
        var c = Conversation()
        c.messages = [ConversationMessage(id: "u1", role: .user, text: "Avant", attachments: [], runID: "r1", at: at(0)),
                      ConversationMessage(id: "a1", role: .assistant, text: "Réponse", attachments: [], runID: "r1", at: at(5)),
                      ConversationMessage(id: "u2", role: .user, text: "Après", attachments: [], runID: "r2", at: at(500))]
        c.apply(ev("agent.message", run: "routine", seq: 1, t: 100, text: "Routine du matin"))
        c.apply(ev("run.completed", run: "routine", seq: 2, t: 101))
        let items = ThreadTimeline.build(c, botName: "Seo", botID: "s", botFace: nil, locals: [])
        let order = items.compactMap { item -> String? in
            switch item {
            case .user(let id, _, _, _, _, _): id
            case .turn(let t): t.id
            default: nil
            }
        }
        #expect(order == ["u1", "r1", "routine", "u2"])
    }
}


@Suite(.french)
struct ReactionToggleTests {
    @Test func helpfulAndUnhelpfulExcludeEachOther() {
        let start = [MessageReaction(emoji: "👎", count: 2, mine: true), MessageReaction(emoji: "🎉", count: 1, mine: false)]
        let up = Reactions.toggle("👍", in: start)
        #expect(up.added && up.removed == ["👎"])
        #expect(up.reactions.contains(MessageReaction(emoji: "👎", count: 1, mine: false)))
        #expect(up.reactions.contains(MessageReaction(emoji: "👍", count: 1, mine: true)))
        // Rebasculer retire la sienne ; à zéro la puce disparaît.
        let off = Reactions.toggle("👍", in: up.reactions)
        #expect(!off.added && off.removed == ["👍"] && !off.reactions.contains { $0.emoji == "👍" })
        // Une réaction d'un autre ne se retire pas à sa place.
        let other = Reactions.toggle("🎉", in: start)
        #expect(other.added && other.removed.isEmpty)
        #expect(other.reactions.first { $0.emoji == "🎉" } == MessageReaction(emoji: "🎉", count: 2, mine: true))
    }

    @Test func historyMessagesCarryReactionsAndTheirQuote() throws {
        let json = """
        {"id":"t","messages":[
          {"id":"m2","role":"user","runId":"r2","createdAt":"2026-10-11T19:00:00Z","content":[{"type":"text","text":"Creuse"}],
           "reactions":[{"emoji":"👍","count":2,"reactedByMe":true}],
           "replyTo":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Trois sujets :\\nA2A"}],"authorBot":{"id":"b","name":"Nova"}}}],
         "runs":[], "events":[]}
        """
        let snap = try OHBotAuthClient.decoder.decode(ThreadSnapshotDto.self, from: Data(json.utf8))
        let m = OHBotMapping.conversation(snap).messages[0]
        #expect(m.reactions == [MessageReaction(emoji: "👍", count: 2, mine: true)])
        #expect(m.replyTo == ReplyQuote(messageID: "m1", authorName: "Nova", excerpt: "Trois sujets : A2A"))
    }
}
