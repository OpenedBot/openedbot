import Testing
import Foundation
@testable import OHBPopup

@MainActor
@Suite(.french)
struct MockFeedTests {
    private func waitUntil(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<5000 {
            if condition() { return }
            await Task.yield()
        }
    }

    @Test func approvalFlowAllow() async {
        let model = NotchModel()
        let feed = MockBotFeed(model: model, timeScale: 0)
        feed.start()
        await waitUntil { model.bot("support")?.pending != nil }
        feed.stop()
        let approval = model.bot("support")!.pending!
        #expect(model.bot("support")?.activity == .waiting)
        feed.respond(approvalID: approval.id, allow: true)
        let bot = model.bot("support")!
        #expect(bot.pending == nil)
        #expect(bot.runs.first?.status == .running)
        #expect(bot.thread.last?.role == .tool)
    }

    @Test func sendCreatesARunAndAReply() async {
        let model = NotchModel()
        let feed = MockBotFeed(model: model, timeScale: 0)
        model.sections = MockBotFeed.sections
        model.bots = MockBotFeed.roster(now: Date())
        feed.send("Ajoute un bouton de tri", to: "notes")
        #expect(model.bot("notes")?.activity == .working)
        await waitUntil { model.bot("notes")?.runs.first?.status == .completed }
        feed.stop()
        let bot = model.bot("notes")!
        #expect(bot.thread.contains { $0.role == .user && $0.text == "Ajoute un bouton de tri" })
        #expect(bot.activity == .success)
    }

    @Test func transitionsAreReported() async {
        let model = NotchModel()
        let feed = MockBotFeed(model: model, timeScale: 0)
        var seen: [FeedTransition] = []
        feed.onTransition = { _, t in seen.append(t) }
        feed.start()
        await waitUntil { seen.contains(.waiting) }
        feed.toggleOffline() // gpu-box démarre hors ligne : il revient
        feed.toggleOffline() // puis retombe
        feed.stop()
        #expect(seen.contains(.waiting) && seen.contains(.back) && seen.contains(.offline))
    }
}
