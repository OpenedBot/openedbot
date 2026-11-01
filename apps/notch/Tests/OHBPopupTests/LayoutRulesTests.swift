import Testing
import Foundation
@testable import OHBPopup

@MainActor
struct LayoutRulesTests {
    private func roster() -> ([Bot], [BotSection]) {
        (MockBotFeed.roster(now: Date()), MockBotFeed.sections)
    }

    @Test func tenBotsFoldIntoPilesWithAlertsPromoted() {
        var (bots, sections) = roster()
        #expect(bots.count == 10)
        bots[0].pending = Approval(botID: "support", runID: "r", tool: "shell", command: "x", expiresAt: Date())
        bots[0].inboxCount = 1
        let items = LayoutRules.items(bots: bots, sections: sections, view: .sections)
        #expect(items.first == .bot("support"))
        let piles = items.compactMap { item -> [String]? in if case .pile(_, let ids) = item { return ids }; return nil }
        #expect(piles.count == 3)
        #expect(piles[0] == ["sales", "onboarding"]) // Support promu, plus dans sa pile
        #expect(piles[2].count == 4)
    }

    @Test func fewBotsAreAllRings() {
        let (bots, sections) = roster()
        let items = LayoutRules.items(bots: Array(bots.prefix(5)), sections: sections, view: .sections)
        #expect(items.count == 5)
        #expect(items.allSatisfy { $0.botID != nil })
    }

    @Test func activeViewHidesIdleBotsBehindMore() {
        let (bots, sections) = roster()
        let items = LayoutRules.items(bots: bots, sections: sections, view: .active)
        guard case .more(let rest)? = items.last else { Issue.record("pas de « +N »"); return }
        // Sales, Ops, Growth (hors ligne) et Veille sont actifs ; les six autres non.
        #expect(rest.count == 6)
        #expect(items.count == 5)
    }

    @Test func allViewKeepsRosterOrder() {
        let (bots, sections) = roster()
        let ids = LayoutRules.items(bots: bots, sections: sections, view: .all).compactMap(\.botID)
        #expect(ids.first == "support" && ids.last == "notes")
    }

    @Test func activityPriority() {
        var bot = MockBotFeed.roster(now: Date())[0]
        #expect(bot.activity == .idle)
        bot.runs = [BotRun(id: "a", kind: .dm, title: "t", detail: "", status: .running, usedSteps: 2, maxSteps: 8, tokens: 0, since: Date())]
        #expect(bot.activity == .working && bot.progress == 0.25)
        bot.pending = Approval(botID: bot.id, runID: "a", tool: "shell", command: "x", expiresAt: Date())
        #expect(bot.activity == .waiting && bot.isAlert)
        bot.runtime.connected = false
        #expect(bot.activity == .offline)
    }
}
