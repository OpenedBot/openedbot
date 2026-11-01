import Foundation
import Testing
@testable import OHBPopup

/// La boîte de notifications : priorités, file des bannières, lecture, absence, nouveaux messages.
@Suite(.french)
@MainActor
struct InboxTests {
    let now = Date()

    private func notice(_ kind: Notice.Kind, _ bot: String = "seo", at offset: TimeInterval = 0, approval: UUID? = nil) -> Notice {
        Notice(kind: kind, botID: bot, botName: bot.capitalized, text: "détail", at: now.addingTimeInterval(offset), approvalID: approval)
    }

    @Test func bannersComeMostUrgentFirstThenOldest() {
        var inbox = Inbox()
        inbox.add(notice(.finished, "a", at: 0))
        inbox.add(notice(.message, "b", at: 1))
        inbox.add(notice(.failed, "c", at: 2))
        inbox.add(notice(.approval, "d", at: 3, approval: UUID()))
        #expect(inbox.nextBanner()?.botID == "c")
        #expect(inbox.nextBanner()?.botID == "d")
        #expect(inbox.nextBanner()?.botID == "a")
        #expect(inbox.nextBanner()?.botID == "b")
        #expect(inbox.nextBanner() == nil)
        // Les bannières passées, tout reste non lu.
        #expect(inbox.unreadCount == 4)
    }

    @Test func runtimeBackIsRecordedReadWithoutBanner() {
        var inbox = Inbox()
        inbox.add(notice(.back))
        #expect(inbox.unreadCount == 0 && inbox.notices.count == 1 && inbox.nextBanner() == nil)
    }

    @Test func sameApprovalIsNotDoubled() {
        var inbox = Inbox()
        let id = UUID()
        inbox.add(notice(.approval, approval: id))
        inbox.add(notice(.approval, approval: id))
        #expect(inbox.notices.count == 1)
    }

    @Test func answeredApprovalIsReadAndLeavesTheQueue() {
        var inbox = Inbox()
        let id = UUID()
        inbox.add(notice(.approval, approval: id))
        inbox.resolveApproval(id)
        #expect(inbox.unreadCount == 0 && inbox.nextBanner() == nil)
    }

    @Test func boxKeepsTheFiftyMostRecent() {
        var inbox = Inbox()
        for i in 0..<60 { inbox.add(notice(.message, "b\(i)", at: Double(i))) }
        #expect(inbox.notices.count == Inbox.capacity)
        #expect(inbox.notices.first?.botID == "b59" && inbox.notices.last?.botID == "b10")
        #expect(inbox.queue.count == Inbox.capacity)
    }

    @Test func markAllReadClearsBadgeAndQueue() {
        var inbox = Inbox()
        inbox.add(notice(.message))
        inbox.add(notice(.finished))
        inbox.markAllRead()
        #expect(inbox.unreadCount == 0 && inbox.queue.isEmpty)
    }

    @Test func readNoticesGoAwayButOpenApprovalsStay() {
        var inbox = Inbox()
        let open = UUID()
        inbox.add(notice(.approval, "a", approval: open))
        inbox.add(notice(.message, "b"))
        inbox.add(notice(.message, "c"))
        inbox.add(notice(.back, "d"))
        inbox.markRead(inbox.notices.first { $0.botID == "a" }!.id)
        inbox.markRead(inbox.notices.first { $0.botID == "b" }!.id)
        inbox.removeRead(keepingApprovals: [open])
        // Le message lu et le retour du runtime (lu d'office) partent ; le message non lu et la
        // demande encore ouverte, même lue, restent.
        #expect(inbox.notices.map(\.botID) == ["c", "a"])
        #expect(Set(inbox.queue) == Set(inbox.notices.map(\.id)))
    }

    @Test func clearEmptiesTheListExceptOpenApprovals() {
        var inbox = Inbox()
        let open = UUID()
        inbox.add(notice(.approval, "a", approval: open))
        inbox.add(notice(.approval, "b", approval: UUID()))
        inbox.add(notice(.failed, "c"))
        inbox.clear(keepingApprovals: [open])
        #expect(inbox.notices.map(\.botID) == ["a"] && inbox.queue == inbox.notices.map(\.id))
        // La demande restée n'est pas doublée si le flux la renvoie.
        inbox.add(notice(.approval, "a", approval: open))
        #expect(inbox.notices.count == 1)
    }

    // MARK: Absence

    @Test func awayWhenLockedAsleepOrIdle() {
        #expect(Presence.isAway(locked: true, asleep: false, idleSeconds: 0))
        #expect(Presence.isAway(locked: false, asleep: true, idleSeconds: 0))
        #expect(Presence.isAway(locked: false, asleep: false, idleSeconds: 121))
        #expect(!Presence.isAway(locked: false, asleep: false, idleSeconds: 30))
    }

    @Test func returningShowsOneBanner() {
        #expect(Presence.returnBanner([]) == nil)
        let one = notice(.message)
        #expect(Presence.returnBanner([one]) == .notice(one))
        let a = notice(.message, at: 0), b = notice(.finished, at: 5)
        #expect(Presence.returnBanner([a, b]) == .recap(count: 2, latest: b))
        let ask = notice(.approval, at: 1, approval: UUID())
        #expect(Presence.returnBanner([a, ask, b]) == .notice(ask))
    }

    // MARK: Nouveaux messages

    private func bot(_ id: String, replies: [ChatMessage]) -> Bot {
        var b = Bot(id: id, name: id.capitalized,
                    runtime: BotRuntime(name: "r", model: "m", mode: "auto", connected: true, lastSeenAt: now, connectorVersion: "1"))
        b.thread = replies
        return b
    }

    @Test func aNewBotReplyIsNoticedOncePerBot() {
        let old = ChatMessage(role: .bot, text: "Ancien", at: now.addingTimeInterval(-10))
        let before = bot("seo", replies: [old])
        let previous = ["seo": MessageDiff.botMessageIDs(before)]
        let r1 = ChatMessage(role: .bot, text: "Premier", at: now.addingTimeInterval(1))
        let r2 = ChatMessage(role: .bot, text: "**Second**\nligne", at: now.addingTimeInterval(2))
        let user = ChatMessage(role: .user, text: "Moi", at: now.addingTimeInterval(3))
        let replies = MessageDiff.replies(previous: previous, bots: [bot("seo", replies: [old, r1, r2, user])], since: now)
        #expect(replies.count == 1)
        #expect(replies.first?.text == "Second ligne" && replies.first?.count == 2)
    }

    @Test func historyLoadedLaterIsNotNews() {
        let previous = ["seo": Set<String>()]
        let past = ChatMessage(role: .bot, text: "D'hier", at: now.addingTimeInterval(-86_400))
        #expect(MessageDiff.replies(previous: previous, bots: [bot("seo", replies: [past])], since: now).isEmpty)
    }

    @Test func aBotSeenForTheFirstTimeIsNotNews() {
        let fresh = ChatMessage(role: .bot, text: "Bonjour", at: now.addingTimeInterval(1))
        #expect(MessageDiff.replies(previous: [:], bots: [bot("seo", replies: [fresh])], since: now).isEmpty)
    }

    @Test func longRepliesAreCut() {
        let text = String(repeating: "a", count: 300)
        #expect(MessageDiff.excerpt(text).count == 160 && MessageDiff.excerpt(text).hasSuffix("…"))
    }

    // MARK: Île

    @Test func unreadNoticesKeepTheIslandVisibleWithoutActiveBots() {
        let c = Island.compact(bots: [], unread: 3, latestUnreadBotID: "seo")
        #expect(c?.botIDs == ["seo"] && c?.unread == 3)
        #expect(Island.compact(bots: [], unread: 0) == nil)
    }

    @Test func noticeCenterQueuesBannersOnlyInTheIsland() async {
        let model = NotchModel()
        let center = NoticeCenter(model: model)
        defer { center.stop() }
        model.plays = false
        center.post(notice(.finished, "a"))
        #expect(model.banner == nil && model.inbox.unreadCount == 1)
        center.isIsland = { true }
        center.post(notice(.message, "b"))
        // L'île choisie : la plus ancienne de même priorité passe d'abord.
        if case .notice(let n) = model.banner { #expect(n.botID == "a") } else { Issue.record("pas de bannière") }
        center.dismissBanner()
        // La suivante passe après une courte pause ; la suite parallèle peut ralentir le fil principal.
        for _ in 0..<60 where model.banner == nil { try? await Task.sleep(for: .milliseconds(50)) }
        if case .notice(let n) = model.banner { #expect(n.botID == "b") } else { Issue.record("pas de seconde bannière") }
    }

    @Test func closingThePanelErasesWhatWasRead() async {
        let model = NotchModel()
        let center = NoticeCenter(model: model)
        defer { center.stop() }
        model.plays = false
        center.post(notice(.back, "a"))
        center.post(notice(.failed, "b"))
        model.isExpanded = true
        for _ in 0..<20 { await Task.yield() }
        model.isExpanded = false
        for _ in 0..<60 where model.inbox.notices.count != 1 { try? await Task.sleep(for: .milliseconds(50)) }
        // Le retour du runtime, enregistré lu, part ; la panne, non lue, reste.
        #expect(model.inbox.notices.map(\.botID) == ["b"])
    }

    @Test func clearButtonEmptiesTheBox() {
        let model = NotchModel()
        let center = NoticeCenter(model: model)
        defer { center.stop() }
        model.plays = false
        center.post(notice(.failed, "a"))
        center.post(notice(.message, "b"))
        center.clear()
        #expect(model.inbox.notices.isEmpty && model.inbox.unreadCount == 0)
    }

    @Test func awayKeepsBannersForLater() {
        let model = NotchModel()
        let center = NoticeCenter(model: model)
        defer { center.stop() }
        center.isIsland = { true }
        model.plays = false
        model.isAway = true
        center.post(notice(.message))
        #expect(model.banner == nil && model.inbox.queue.count == 1)
    }
}
