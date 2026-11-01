import Testing
import Foundation
@testable import OHBPopup

// Les chemins malheureux et les bornes : ce que les trois suites de base ne couvrent pas.

@Suite(.french)
struct ElapsedCopyTests {
    @Test func boundariesNeverGoNegativeAndSwitchUnits() {
        let now = Date()
        func t(_ s: Double) -> String { ElapsedCopy.text(since: now.addingTimeInterval(-s), now: now) }
        #expect(t(0) == "0 s")
        #expect(t(-10) == "0 s") // horloge dans le futur : jamais de négatif
        #expect(t(59) == "59 s")
        #expect(t(60) == "1 min")
        #expect(t(3599) == "59 min")
        #expect(t(3600) == "1 h 00")
        #expect(t(3660) == "1 h 01")
        #expect(t(2 * 3600 + 18 * 60) == "2 h 18")
    }
}

@MainActor
@Suite(.french)
struct BotModelTests {
    private func run(_ status: RunStatus, used: Int, max: Int) -> BotRun {
        BotRun(id: "r", kind: .dm, title: "t", detail: "", status: status, usedSteps: used, maxSteps: max, tokens: 0, since: Date())
    }

    @Test func progressFollowsTheRunThenFillsOnSuccess() {
        var bot = MockBotFeed.roster(now: Date())[0]
        #expect(bot.progress == 0 && bot.activeRun == nil)
        bot.runs = [run(.completed, used: 2, max: 3)]
        #expect(bot.activity == .success && bot.progress == 1) // plein au terminé, pas 2/3
        bot.runs = [run(.running, used: 5, max: 0)]
        #expect(bot.progress == 0) // maxSteps 0 : pas de division
        bot.runs = [run(.running, used: 9, max: 4)]
        #expect(bot.progress == 1) // plafonné
    }

    @Test func queuedRunIsLiveButNotActive() {
        var growth = MockBotFeed.roster(now: Date()).first { $0.id == "growth" }!
        #expect(growth.runs.first?.status == .queued && growth.runs.first?.isLive == true)
        #expect(growth.activity == .offline)
        growth.runtime.connected = true
        #expect(growth.activity == .idle && growth.activeRun == nil)
    }

    @Test func inboxAloneIsAnAlertWithoutChangingActivity() {
        var bot = MockBotFeed.roster(now: Date())[0]
        bot.inboxCount = 2
        #expect(bot.isAlert && bot.activity == .idle)
    }

    @Test func outdatedConnectorIsDetected() {
        var rt = MockBotFeed.roster(now: Date())[0].runtime
        #expect(!rt.outdated)
        rt.connectorVersion = "1.4.2"
        #expect(rt.outdated)
        rt.latestVersion = nil
        #expect(!rt.outdated) // version inconnue : on ne dit rien
    }

    @Test func anIdleBotShowsAGreenDotButKeepsAGreyRing() {
        #expect(BotActivity.idle.dotColor == Palette.ample)
        #expect(BotActivity.idle.color == Palette.ringTrack)
        #expect(BotActivity.offline.dotColor == Palette.critical)
        #expect(BotActivity.waiting.dotColor == Palette.waiting)
    }
}

@MainActor
@Suite(.french)
struct LayoutRulesEdgeTests {
    private func roster() -> ([Bot], [BotSection]) { (MockBotFeed.roster(now: Date()), MockBotFeed.sections) }

    private func piles(_ items: [NotchItem]) -> [(BotSection, [String])] {
        items.compactMap { if case .pile(let s, let ids) = $0 { return (s, ids) }; return nil }
    }

    @Test func emptyRosterShowsNothingInEveryView() {
        for view in ViewMode.allCases {
            #expect(LayoutRules.items(bots: [], sections: [], view: view).isEmpty)
        }
    }

    @Test func botsWithoutSectionLandInOthersLast() {
        var (bots, sections) = roster()
        bots[9].sectionID = nil          // Notes
        bots[8].sectionID = "disparue"   // Recherche : section qui n'existe plus
        let ordered = LayoutRules.ordered(bots: bots, sections: sections)
        #expect(ordered.suffix(2).map(\.id) == ["recherche", "notes"])
        let p = piles(LayoutRules.items(bots: bots, sections: sections, view: .sections))
        #expect(p.count == 4)
        #expect(p.last?.0.name == "Autres" && p.last?.1 == ["recherche", "notes"])
        #expect(p[2].1 == ["assistant", "veille"])
    }

    @Test func fullyPromotedSectionHasNoPile() {
        var (bots, sections) = roster()
        for i in 0..<3 { bots[i].inboxCount = 1 } // toute la section Clients
        let items = LayoutRules.items(bots: bots, sections: sections, view: .sections)
        #expect(items.prefix(3).compactMap(\.botID) == ["support", "sales", "onboarding"])
        let p = piles(items)
        #expect(p.count == 2 && p.map(\.0.id) == ["interne", "perso"])
    }

    @Test func sixBotsStayRingsEvenWithAnAlert() {
        var (bots, sections) = roster()
        bots[0].inboxCount = 1
        let items = LayoutRules.items(bots: Array(bots.prefix(6)), sections: sections, view: .sections)
        #expect(items.count == 6 && piles(items).isEmpty)
    }

    @Test func activeViewPromotesAlertsAndDropsMoreWhenNobodyIsIdle() {
        var (bots, sections) = roster()
        bots[9].pending = Approval(botID: "notes", runID: "r", tool: "shell", command: "x", expiresAt: Date())
        let items = LayoutRules.items(bots: bots, sections: sections, view: .active)
        #expect(items.first == .bot("notes"))
        for i in bots.indices { bots[i].inboxCount = 1 }
        let all = LayoutRules.items(bots: bots, sections: sections, view: .active)
        #expect(all.count == 10 && all.allSatisfy { $0.botID != nil })
    }

    @Test func allViewKeepsOrphansAtTheEnd() {
        var (bots, sections) = roster()
        bots[0].sectionID = nil
        let ids = LayoutRules.items(bots: bots, sections: sections, view: .all).compactMap(\.botID)
        #expect(ids.last == "support" && ids.count == 10)
    }
}

@MainActor
@Suite(.french)
struct MockFeedEdgeTests {
    private func fresh() -> (NotchModel, MockBotFeed) {
        let model = NotchModel()
        model.sections = MockBotFeed.sections
        model.bots = MockBotFeed.roster(now: Date())
        return (model, MockBotFeed(model: model, timeScale: 0))
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<5000 {
            if condition() { return }
            await Task.yield()
        }
    }

    @Test func denyCompletesTheRunAndKeepsTheBotCalm() {
        let (model, feed) = fresh()
        var seen: [FeedTransition] = []
        feed.onTransition = { _, t in seen.append(t) }
        feed.simulateApproval(botID: "sales") // Sales est au repos : un run DM est inséré
        let waiting = model.bot("sales")!
        #expect(waiting.pending != nil && waiting.inboxCount == 1)
        #expect(waiting.runs.first?.status == .awaitingApproval && waiting.activity == .waiting)
        #expect(seen == [.waiting])

        feed.respond(approvalID: waiting.pending!.id, allow: false)
        let after = model.bot("sales")!
        #expect(after.pending == nil && after.inboxCount == 0)
        #expect(after.runs.first?.status == .completed)
        #expect(after.runs.first?.detail == "Commande refusée, le run continue sans")
        #expect(after.thread.last?.role == .system && after.thread.last?.text.hasPrefix("Refusé") == true)
        #expect(after.activity == .success)
    }

    @Test func unknownOrAlreadyHandledApprovalIsIgnored() {
        let (model, feed) = fresh()
        let before = model.bots
        feed.respond(approvalID: UUID(), allow: true)
        #expect(model.bots == before)

        feed.simulateApproval(botID: "support")
        let id = model.bot("support")!.pending!.id
        feed.respond(approvalID: id, allow: true)
        let once = model.bot("support")!
        feed.respond(approvalID: id, allow: true) // double clic : 409 absorbé
        #expect(model.bot("support") == once)
    }

    @Test func aSecondRequestReplacesTheFirstWithoutDoublingTheBadge() {
        let (model, feed) = fresh()
        feed.simulateApproval(botID: "support")
        let first = model.bot("support")!.pending!.id
        feed.simulateApproval(botID: "support")
        let bot = model.bot("support")!
        #expect(bot.pending?.id != first && bot.inboxCount == 1 && bot.runs.count == 1)
    }

    @Test func aRequestOnAnotherRunReleasesTheRunOfTheFirst() {
        let (model, feed) = fresh()
        feed.simulateApproval(botID: "support") // run DM « Léa » inséré, approbation dessus
        model.update("support") { bot in
            bot.runs.insert(BotRun(id: "rt-tri", kind: .routine, title: "Tri", detail: "", status: .running, usedSteps: 3, maxSteps: 8, tokens: 0, since: Date()), at: 0)
        }
        feed.simulateApproval(botID: "support") // vise rt-tri : le run actif en tête
        let bot = model.bot("support")!
        #expect(bot.pending?.runID == "rt-tri")
        #expect(bot.runs.first { $0.id == "rt-tri" }?.status == .awaitingApproval)
        #expect(bot.runs.first { $0.id == "dm-lea" }?.status == .running) // plus « attend » sans rien à valider
        #expect(bot.inboxCount == 1)
    }

    @Test func blankMessagesAndUnknownBotsAreDropped() async {
        let (model, feed) = fresh()
        let before = model.bots
        feed.send("   \n\t", to: "notes")
        feed.send("Bonjour", to: "inconnu")
        for _ in 0..<50 { await Task.yield() }
        feed.stop()
        #expect(model.bots == before)
    }

    @Test func sendingDuringARunDoesNotOpenASecondRun() async {
        let (model, feed) = fresh()
        model.update("onboarding") { bot in
            bot.runs = [BotRun(id: "rt-j1", kind: .routine, title: "Bienvenue", detail: "", status: .running, usedSteps: 1, maxSteps: 4, tokens: 0, since: Date())]
        }
        feed.send("Ajoute Léa", to: "onboarding")
        let bot = model.bot("onboarding")!
        #expect(bot.runs.count == 1 && bot.runs.first?.id == "rt-j1")
        #expect(bot.thread.last?.role == .user && bot.thread.last?.text == "Ajoute Léa")
        feed.stop()
    }

    @Test func finishClearsPendingAndCompletesEveryLiveRun() {
        let (model, feed) = fresh()
        var seen: [FeedTransition] = []
        feed.onTransition = { _, t in seen.append(t) }
        feed.simulateApproval(botID: "support")
        feed.simulateFinish(botID: "support")
        let bot = model.bot("support")!
        #expect(bot.pending == nil)
        #expect(bot.runs.allSatisfy { $0.status == .completed && $0.usedSteps == $0.maxSteps })
        #expect(bot.activity == .success && bot.progress == 1)
        #expect(seen == [.waiting, .finished])
    }

    @Test func toggleOfflineFlipsTheRuntimeBothWays() {
        let (model, feed) = fresh()
        var seen: [FeedTransition] = []
        feed.onTransition = { _, t in seen.append(t) }
        #expect(model.bot("growth")?.activity == .offline)
        feed.toggleOffline(botID: "growth")
        let back = model.bot("growth")!
        #expect(back.runtime.connected && back.runtime.downSince == nil && back.activity != .offline)
        feed.toggleOffline(botID: "growth")
        let down = model.bot("growth")!
        #expect(!down.runtime.connected && down.runtime.downSince != nil && down.activity == .offline)
        #expect(seen == [.back, .offline])
    }

    @Test func scriptedRoutinesDoNotClobberADirectMessageRun() async {
        let model = NotchModel()
        let feed = MockBotFeed(model: model, timeScale: 0)
        feed.start()
        feed.send("Ajoute Léa", to: "onboarding")
        feed.send("Vérifie le disque", to: "ops")
        await waitUntil {
            model.bot("onboarding")?.runs.contains { $0.kind == .dm && $0.status == .completed } == true
                && model.bot("ops")?.runs.contains { $0.kind == .dm && $0.status == .completed } == true
        }
        feed.stop()
        for id in ["onboarding", "ops"] {
            let bot = model.bot(id)!
            #expect(bot.runs.contains { $0.kind == .dm && $0.status == .completed }, "\(id) : le DM a été écrasé par la routine")
            #expect(bot.thread.last?.text == "C'est fait. Récapitulatif posté dans le fil.", "\(id)")
        }
    }

    @Test func notifyOnFinishIsPartOfTheBot() {
        var bot = MockBotFeed.roster(now: Date())[0]
        #expect(bot.notifyOnFinish)
        bot.notifyOnFinish = false
        #expect(!bot.notifyOnFinish)
    }

    @Test func unansweredApprovalTimesOutAndTheRunFinishes() async {
        let model = NotchModel()
        let feed = MockBotFeed(model: model, timeScale: 0)
        var finishedSupport = false
        feed.onTransition = { bot, t in if bot.id == "support", t == .finished { finishedSupport = true } }
        feed.start()
        await waitUntil { finishedSupport }
        feed.stop()
        #expect(finishedSupport) // la démo n'attend pas éternellement : le délai de 40 s autorise
    }

    @Test func stopThenRestartResetsTheRosterAndSurvivesALateAnswer() async {
        let model = NotchModel()
        let feed = MockBotFeed(model: model, timeScale: 0)
        feed.start()
        await waitUntil { model.bot("support")?.pending != nil }
        let late = model.bot("support")?.pending?.id
        feed.stop()
        feed.start()
        #expect(model.bot("support")?.pending == nil)
        #expect(model.bots.count == 10)
        if let late { feed.respond(approvalID: late, allow: true) } // réponse à une demande d'avant : ignorée
        #expect(model.bot("support")?.pending == nil)
        feed.stop()
    }

    @Test func countsFeedTheMenuBar() {
        let (model, feed) = fresh()
        #expect(model.pendingCount == 0 && model.runningCount == 0)
        feed.simulateApproval(botID: "support")
        model.update("onboarding") { bot in
            bot.runs = [BotRun(id: "x", kind: .routine, title: "t", detail: "", status: .running, usedSteps: 1, maxSteps: 4, tokens: 0, since: Date())]
        }
        #expect(model.pendingCount == 1 && model.runningCount == 1)
    }
}

@MainActor
@Suite(.french)
struct NotchModelTests {
    @Test func showsBodyRules() {
        let m = NotchModel()
        #expect(!m.showsBody)
        m.isExpanded = true
        #expect(m.showsBody)
        m.isExpanded = false
        m.announcement = "Support"
        #expect(m.showsBody)
        m.announcement = nil
        m.alwaysOn = true
        #expect(m.showsBody)
        m.isHidden = true
        #expect(!m.showsBody) // masquée : rien, même « toujours afficher »
    }

    @Test func updateOnUnknownBotIsANoOp() {
        let m = NotchModel()
        m.bots = MockBotFeed.roster(now: Date())
        var called = false
        m.update("inconnu") { _ in called = true }
        #expect(!called && m.bot("inconnu") == nil)
    }

    @Test func alongOffsetIsRememberedPerEdge() {
        let m = NotchModel()
        m.edge = .right
        m.alongOffset = 40
        m.edge = .top
        #expect(m.alongOffset == 0)
        m.alongOffset = -12
        m.edge = .right
        #expect(m.alongOffset == 40 && m.alongOffsets[.top] == -12)
    }

    @Test func nothingIsPersistedBeforeLoad() {
        let d = UserDefaults.standard
        let before = d.string(forKey: "notch.edge")
        let m = NotchModel()
        m.edge = m.edge == .top ? .bottom : .top
        #expect(d.string(forKey: "notch.edge") == before)
    }
}

@Suite(.french)
struct GeometryEdgeTests {
    let screen = CGRect(x: 0, y: 0, width: 1728, height: 1117)
    let card = CGSize(width: 226 + 28, height: 320)

    private func g(_ edge: NotchEdge, cells: Int = 10, offset: CGFloat = 0) -> NotchGeometry {
        NotchGeometry(edge: edge, metrics: NotchMetrics(), cellCount: cells, screen: screen, alongOffset: offset)
    }

    @Test func cardNeverLeavesThePanelOnAnyEdge() {
        for edge in NotchEdge.allCases {
            let geo = g(edge)
            for index in [0, 4, 9] {
                let r = geo.cardRect(forCell: index, cardSize: card)
                #expect(r.along.lowerBound >= 8, "\(edge) #\(index)")
                #expect(r.along.upperBound <= geo.alongTotal - 8, "\(edge) #\(index)")
                #expect(abs(r.across.lowerBound - (geo.depth + geo.metrics.tailGap)) < 0.001)
            }
        }
    }

    @Test func tailStillAimsAtTheRingWhenTheCardIsHeldBack() {
        let geo = g(.right)
        let tall = CGSize(width: 254, height: 2 * geo.alongTotal) // plus longue que le panneau : retenue à 8 pt
        let r = geo.cardRect(forCell: 0, cardSize: tall)
        #expect(r.along.lowerBound == 8)
        let ring = geo.ringCenter(index: 0).along
        let mid = (r.along.lowerBound + r.along.upperBound) / 2
        #expect(abs(geo.tailOffset(forCell: 0, cardSize: tall) - (ring - mid)) < 0.001)
        // Cellule du milieu, carte courte : la flèche n'a pas à glisser.
        let short = CGSize(width: 254, height: 40)
        #expect(abs(geo.tailOffset(forCell: 4, cardSize: short)) < 0.001)
    }

    @Test func hitPrefersCardAndSeesGapsAsBody() {
        let geo = g(.right)
        let r = geo.cardRect(forCell: 1, cardSize: card)
        let inside = ((r.along.lowerBound + r.along.upperBound) / 2, (r.across.lowerBound + r.across.upperBound) / 2)
        #expect(geo.hit(along: inside.0, across: inside.1, expanded: true, card: r) == .card)
        // Dans l'espace de la flèche, juste avant la carte : encore la carte, sinon elle se ferme en y allant.
        #expect(geo.hit(along: inside.0, across: r.across.lowerBound - geo.metrics.tailGap / 2, expanded: true, card: r) == .card)
        // Sans carte, le même point n'est rien.
        #expect(geo.hit(along: inside.0, across: inside.1, expanded: true, card: nil) == .none)
        // Entre deux cellules : le corps.
        let gap = geo.shapeStart + geo.metrics.cellRange(index: 0, edge: .right).upperBound + geo.metrics.cellSpacing / 2
        #expect(geo.hit(along: gap, across: geo.depth / 2, expanded: true, card: nil) == .body)
        // Repliée : un anneau n'est pas cliquable.
        let ring = geo.ringCenter(index: 1)
        #expect(geo.hit(along: ring.along, across: ring.across, expanded: false, card: nil) == .none)
        #expect(geo.cellIndex(atAlong: -10) == nil && geo.cellIndex(atAlong: geo.alongTotal + 10) == nil)
    }

    @Test func alongOffsetSlidesThePanelInTheUserDirection() {
        #expect(abs(g(.right, offset: 100).panelFrame.midY - (g(.right).panelFrame.midY - 100)) < 0.001)
        #expect(abs(g(.right, offset: -50).panelFrame.midY - (g(.right).panelFrame.midY + 50)) < 0.001)
        #expect(abs(g(.top, offset: 100).panelFrame.midX - (g(.top).panelFrame.midX + 100)) < 0.001)
        #expect(abs(g(.bottom, offset: -30).panelFrame.midX - (g(.bottom).panelFrame.midX - 30)) < 0.001)
    }

    @Test func horizontalEdgesAreDeeperToHoldTheName() {
        let m = NotchMetrics()
        #expect(m.depth(for: .top) > m.depth(for: .right))
        #expect(m.depth(for: .top) == m.depth(for: .bottom))
        #expect(m.cellLength(for: .top) == m.ring && m.cellLength(for: .right) == m.cellExtent)
        #expect(g(.top).panelFrame.width <= screen.width)
    }

    @Test func zeroCellsStillGiveAValidShape() {
        let geo = g(.right, cells: 0)
        #expect(geo.shapeLength > 0 && geo.cellIndex(atAlong: geo.shapeStart + geo.shapeLength / 2) == nil)
    }
}

@MainActor
@Suite(.french)
struct AvatarTests {
    @Test func everyRosterArtworkIsBundled() {
        for bot in MockBotFeed.roster(now: Date()) {
            #expect(bot.artwork != nil, "\(bot.name) sans artwork")
            #expect(Avatars.image(for: bot.artwork) != nil, "artwork manquant pour \(bot.name)")
        }
    }

    @Test func missingArtworkGivesNoImage() {
        #expect(Avatars.image(for: nil) == nil)
        #expect(Avatars.image(for: "inexistant") == nil)
    }
}

// Ce que l'app garde en mémoire : bornes d'historique, vignettes, tâches libérées.
@MainActor
@Suite(.french)
struct MemoryTests {
    private func run(_ id: String, _ status: RunStatus) -> BotRun {
        BotRun(id: id, kind: .dm, title: id, detail: "", status: status, usedSteps: 1, maxSteps: 2, tokens: 0, since: Date())
    }

    @Test func threadAndFinishedRunsAreCapped() {
        var bot = MockBotFeed.roster(now: Date())[0]
        bot.thread = (0..<(Bot.threadCap + 50)).map { ChatMessage(role: .bot, text: "m\($0)") }
        bot.runs = [run("live", .running)] + (0..<10).map { run("done-\($0)", .completed) } + [run("queued", .queued)]
        bot.trimHistory()
        #expect(bot.thread.count == Bot.threadCap)
        #expect(bot.thread.first?.text == "m50") // on jette les plus anciens
        #expect(bot.runs.filter(\.isLive).count == 2) // les runs vivants restent
        #expect(bot.runs.filter { !$0.isLive }.count == Bot.completedRunsCap)
        #expect(bot.runs.contains { $0.id == "done-0" } && !bot.runs.contains { $0.id == "done-9" }) // les plus récents (en tête) restent
    }

    @Test func modelUpdateAppliesTheCap() {
        let model = NotchModel()
        model.bots = MockBotFeed.roster(now: Date())
        model.update("support") { bot in
            for i in 0..<(Bot.threadCap + 10) { bot.thread.append(ChatMessage(role: .bot, text: "\(i)")) }
        }
        #expect(model.bot("support")!.thread.count == Bot.threadCap)
    }

    @Test func avatarsAreDecodedAsSmallThumbnails() {
        let image = Avatars.image(for: "explorer")
        #expect(image != nil)
        let rep = image?.representations.first
        // ImageIO réduit le WebP par puissances de deux : 1024 → 256 pour une consigne de 128.
        #expect((rep?.pixelsWide ?? 9999) <= 2 * Avatars.thumbnailPixels)
        #expect((rep?.pixelsHigh ?? 9999) <= 2 * Avatars.thumbnailPixels)
        #expect(Avatars.image(for: "inconnu") == nil)
        #expect(Avatars.image(for: nil) == nil)
    }

    @Test func sendFollowUpsReleaseThemselves() async {
        let model = NotchModel()
        let feed = MockBotFeed(model: model, timeScale: 0)
        model.sections = MockBotFeed.sections
        model.bots = MockBotFeed.roster(now: Date())
        feed.send("Salut", to: "notes")
        #expect(feed.pendingSendCount == 1)
        for _ in 0..<50 where feed.pendingSendCount > 0 { await Task.yield() }
        #expect(feed.pendingSendCount == 0)
        #expect(model.bot("notes")!.thread.contains { $0.text.hasPrefix("C'est fait") })
    }

    @Test func stopCancelsSendFollowUps() async {
        let model = NotchModel()
        let feed = MockBotFeed(model: model, timeScale: 1)
        model.sections = MockBotFeed.sections
        model.bots = MockBotFeed.roster(now: Date())
        feed.send("Salut", to: "notes")
        feed.stop()
        for _ in 0..<50 where feed.pendingSendCount > 0 { await Task.yield() }
        #expect(feed.pendingSendCount == 0)
        #expect(!model.bot("notes")!.thread.contains { $0.text.hasPrefix("Bien reçu") }) // annulé : pas de suite
    }
}
