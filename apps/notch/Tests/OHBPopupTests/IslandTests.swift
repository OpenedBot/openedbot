import Foundation
import Testing
@testable import OHBPopup

/// L'île : état compact, ordre des lignes, demandes d'accord, messages brefs.
@Suite(.french)
@MainActor
struct IslandTests {
    let now = Date()

    private func bot(_ id: String, connected: Bool = true, run: RunStatus? = nil, pending: Bool = false) -> Bot {
        var b = Bot(id: id, name: id.capitalized,
                    runtime: BotRuntime(name: "gpu-box", model: "m", mode: "auto", connected: connected,
                                        lastSeenAt: now, connectorVersion: "0.5.7"))
        if let run {
            b.runs = [BotRun(id: "\(id)-run", kind: .dm, title: "Commande 4821", detail: "", status: run,
                             usedSteps: 3, maxSteps: 8, tokens: 0, since: now.addingTimeInterval(-120))]
        }
        if pending {
            b.pending = Approval(botID: id, runID: "\(id)-run", tool: "payments.refund", command: "refund 49,00 €",
                                 expiresAt: now.addingTimeInterval(600))
        }
        return b
    }

    @Test func idleRosterStillShowsTheBotsAtRest() {
        let c = Island.compact(bots: [bot("a"), bot("b", run: .completed), bot("c"), bot("d")])
        #expect(c?.idle == true && c?.botIDs == ["a", "b", "c"] && c?.extra == 1 && c?.total == 4)
        // « 10 bots » et « +7 » tiennent sur une ligne : l'aile s'élargit avec les chiffres.
        let ten = Island.compact(bots: (0..<10).map { bot("b\($0)") })
        let two = Island.compact(bots: [bot("a"), bot("b")])
        #expect(Island.sideWidth(compact: ten, flash: nil, cameraHeight: 32) > Island.sideWidth(compact: two, flash: nil, cameraHeight: 32))
        // Aucun bot encore connu (connexion en cours) : rien à montrer.
        #expect(Island.compact(bots: []) == nil)
    }

    @Test func compactShowsWaitingBotsFirstAndCountsTheRest() {
        let bots = [bot("w1", run: .running), bot("w2", run: .running), bot("w3", run: .running),
                    bot("p", run: .awaitingApproval, pending: true), bot("idle")]
        let c = Island.compact(bots: bots)
        #expect(c?.botIDs == ["p", "w1", "w2"])
        #expect(c?.extra == 1 && c?.working == 3 && c?.waiting == 1)
    }

    @Test func wingsGrowForACrowdOrAMessage() {
        let one = Island.compact(bots: [bot("a", run: .running)])
        let many = Island.compact(bots: [bot("a", run: .running), bot("b", run: .running)])
        #expect(Island.sideWidth(compact: one, flash: nil, cameraHeight: 32) == 42)
        #expect(Island.sideWidth(compact: many, flash: nil, cameraHeight: 32) > 42)
        let crowd = Island.Compact(botIDs: ["a", "b", "c"], extra: 7, working: 5, waiting: 2, unread: 3, total: 10)
        #expect(Island.sideWidth(compact: crowd, flash: nil, cameraHeight: 32) > Island.sideWidth(compact: many, flash: nil, cameraHeight: 32))
        let flash = Island.Flash(botID: "a", botName: "Support", kind: .finished)
        #expect(Island.sideWidth(compact: one, flash: flash, cameraHeight: 32) == 132)
    }

    @Test func rowsPutWaitingThenWorkingThenDoneThenOfflineThenIdle() {
        let bots = [bot("idle"), bot("off", connected: false), bot("done", run: .completed),
                    bot("work", run: .running), bot("wait", run: .awaitingApproval, pending: true)]
        #expect(Island.rows(bots: bots).map(\.id) == ["wait", "work", "done", "off", "idle"])
    }

    @Test func rowSaysWhatTheBotDoes() {
        let waiting = Island.row(for: bot("s", run: .awaitingApproval, pending: true))
        #expect(waiting.status == "Attend ton accord : payments.refund")
        var working = bot("w", run: .running)
        working.liveActivity = .tool("shopify.get_order")
        let row = Island.row(for: working)
        #expect(row.status == "Commande 4821 · étape 3/8")
        #expect(row.detail == "utilise shopify.get_order")
        #expect(row.since == now.addingTimeInterval(-120))
        #expect(Island.row(for: bot("d", run: .completed)).status == "Terminé · cliquer pour ouvrir")
    }

    @Test func panelGivesRoomToApprovalsAndNotices() {
        #expect(Island.rowLimit(approvals: 0, notices: 0) == 6)
        #expect(Island.rowLimit(approvals: 1, notices: 2) == 3)
        #expect(Island.rowLimit(approvals: 2, notices: 3) == 2)
    }

    @Test func listShowsAtMostTheLimitAndScrollsTheRest() {
        let rows = (0..<10).map { Island.row(for: bot("b\($0)")) }
        #expect(abs(Island.listHeight(rows: rows, limit: 6) - 288) < 0.001)
        #expect(abs(Island.listHeight(rows: Array(rows.prefix(2)), limit: 6) - 96) < 0.001)
    }

    @Test func versionGetsASingleV() {
        #expect(Island.version("0.5.7") == "v0.5.7")
        #expect(Island.version("v0.5.8") == "v0.5.8")
        #expect(Island.version("") == "")
    }

    @Test func atMostTwoApprovalsAreShown() {
        let bots = (1...3).map { bot("p\($0)", run: .awaitingApproval, pending: true) }
        #expect(Island.approvals(bots: bots).map(\.bot.id) == ["p1", "p2"])
    }

    @Test func aNewerFlashSurvivesTheOlderTimer() async throws {
        let model = NotchModel()
        model.flash(Island.Flash(botID: "a", botName: "A", kind: .finished), for: 0.05)
        model.flash(Island.Flash(botID: "b", botName: "B", kind: .allowed), for: 0.4)
        try await Task.sleep(for: .milliseconds(150))
        #expect(model.islandFlash?.botID == "b")
        // Le minuteur du second message finit par l'effacer ; la suite parallèle peut ralentir le fil principal.
        for _ in 0..<60 where model.islandFlash != nil { try await Task.sleep(for: .milliseconds(50)) }
        #expect(model.islandFlash == nil)
    }
}
