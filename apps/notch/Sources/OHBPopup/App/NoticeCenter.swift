import AppKit
import CoreGraphics
import Observation
import UserNotifications

/// Les notifications : reçoit les événements du flux et les réponses des bots, tient la boîte,
/// montre une bannière à la fois dans l'île quand tu es là, garde tout pour ton retour sinon,
/// et, si tu l'as activé, prévient macOS pendant ton absence (écran verrouillé compris).
@MainActor
final class NoticeCenter {
    private let model: NotchModel
    /// L'île est-elle la position choisie ? Bannières, badge et sons de l'île n'existent que là.
    var isIsland: () -> Bool = { false }
    /// La fenêtre du bot est-elle ouverte ? Sa réponse s'y lit déjà : pas de notification.
    var isDialogOpen: (String) -> Bool = { _ in false }

    private var bannerWork: Task<Void, Never>?
    private var readWork: Task<Void, Never>?
    private var hovering = false
    private var knownMessages: [String: Set<String>] = [:]
    private var knownApprovals: [String: UUID] = [:]
    private let startedAt = Date()
    private var locked = false
    private var asleep = false
    private var idleTimer: Timer?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var wasShowingBody = false
    private var wantedSystem = false

    init(model: NotchModel) {
        self.model = model
        snapshot(model.bots)
        wantedSystem = model.systemNotifications
        observe()
        startPresence()
    }

    func stop() {
        idleTimer?.invalidate()
        for (center, token) in observers { center.removeObserver(token) }
        observers = []
        bannerWork?.cancel()
        readWork?.cancel()
    }

    // MARK: Entrées

    /// Une bascule du flux : demande d'accord, run fini ou en échec, runtime tombé ou revenu.
    func transition(_ bot: Bot, _ transition: FeedTransition) {
        let notice: Notice
        switch transition {
        case .waiting:
            guard let approval = bot.pending else { return }
            notice = Notice(kind: .approval, botID: bot.id, botName: bot.name, text: "\(approval.tool) · \(approval.command)",
                            at: Date(), approvalID: approval.id)
        case .finished:
            guard bot.notifyOnFinish else { return }
            notice = Notice(kind: .finished, botID: bot.id, botName: bot.name, text: bot.runs.first?.title ?? "", at: Date())
        case .failed:
            notice = Notice(kind: .failed, botID: bot.id, botName: bot.name, text: bot.runs.first?.title ?? "", at: Date())
        case .offline:
            notice = Notice(kind: .offline, botID: bot.id, botName: bot.name, text: bot.runtime.name, at: Date())
        case .back:
            notice = Notice(kind: .back, botID: bot.id, botName: bot.name, text: bot.runtime.name, at: Date())
        }
        post(notice)
    }

    func post(_ notice: Notice) {
        model.inbox.add(notice)
        if isIsland(), model.plays, !model.isAway, let sound = notice.sound { NSSound(named: NSSound.Name(sound))?.play() }
        if notice.kind == .back, isIsland() {
            model.flash(Island.Flash(botID: notice.botID, botName: notice.botName, kind: .back))
        }
        if model.isAway || model.isHidden { notifySystem(notice) }
        pump()
    }

    // MARK: Bannières

    /// Montre la prochaine bannière si rien ne la retient : île, annonces actives, présent, panneau fermé.
    func pump() {
        guard isIsland(), model.announces, !model.isAway, model.banner == nil, !model.showsBody else { return }
        guard let next = model.inbox.nextBanner() else { return }
        show(.notice(next))
    }

    private func show(_ banner: Banner) {
        model.bannerSize = .zero
        model.banner = banner
        scheduleDismiss(banner)
    }

    private func duration(_ banner: Banner) -> Double? {
        switch banner {
        case .notice(let n): n.bannerSeconds
        case .recap: 10
        }
    }

    private func scheduleDismiss(_ banner: Banner, after seconds: Double? = nil) {
        bannerWork?.cancel()
        guard let wait = seconds ?? duration(banner) else { return }
        bannerWork = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard let self, !Task.isCancelled, !self.hovering, self.model.banner?.id == banner.id else { return }
            self.dismissBanner()
        }
    }

    /// « Plus tard » ou fin du délai : la notification reste non lue, la suivante passe.
    func dismissBanner() {
        bannerWork?.cancel()
        model.banner = nil
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            self?.pump()
        }
    }

    /// Le pointeur sur la bannière la retient ; en partant, elle se referme trois secondes plus tard.
    func setHovering(_ value: Bool) {
        guard value != hovering else { return }
        hovering = value
        if value { bannerWork?.cancel() } else if let b = model.banner, duration(b) != nil { scheduleDismiss(b, after: 3) }
    }

    /// Une notification ouverte (bannière ou panneau) est lue.
    func opened(_ notice: Notice) {
        model.inbox.markRead(notice.id)
        if model.banner?.id == notice.id { dismissBanner() }
    }

    /// « Effacer » dans le panneau : la liste se vide, les demandes d'accord ouvertes gardent leur carte.
    func clear() {
        model.inbox.clear(keepingApprovals: openApprovals)
        if model.banner != nil { dismissBanner() }
    }

    private var openApprovals: Set<UUID> { Set(knownApprovals.values) }

    // MARK: Observation du roster

    private func observe() {
        withObservationTracking {
            _ = model.bots
            _ = model.showsBody
            _ = model.systemNotifications
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.rosterChanged()
                self.observe()
            }
        }
    }

    private func rosterChanged() {
        let bots = model.bots
        // Les réponses des bots, une par bot, sauf si sa fenêtre est ouverte.
        for reply in MessageDiff.replies(previous: knownMessages, bots: bots, since: startedAt) where !isDialogOpen(reply.botID) {
            let more = reply.count > 1 ? tr(" (+\(reply.count - 1))", " (+\(reply.count - 1))") : ""
            post(Notice(kind: .message, botID: reply.botID, botName: reply.botName, text: reply.text + more, at: reply.at))
        }
        // Une demande d'accord répondue ailleurs (fenêtre, console) : plus de bannière ni de badge.
        for bot in bots {
            if let old = knownApprovals[bot.id], bot.pending?.id != old { resolve(old) }
        }
        snapshot(bots)

        // Le panneau ouvert depuis un instant : ce qu'il montre est lu. Refermé : ce qui a été lu
        // s'efface, et la file reprend.
        let showing = model.showsBody
        if showing != wasShowingBody {
            wasShowingBody = showing
            readWork?.cancel()
            if showing, isIsland() {
                readWork = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(1.2))
                    guard let self, !Task.isCancelled, self.model.showsBody else { return }
                    self.model.inbox.markAllRead()
                }
            } else if !showing {
                model.inbox.removeRead(keepingApprovals: openApprovals)
                pump()
            }
        }
        if model.systemNotifications != wantedSystem {
            wantedSystem = model.systemNotifications
            if wantedSystem { requestSystemPermission() }
        }
    }

    private func resolve(_ approvalID: UUID) {
        model.inbox.resolveApproval(approvalID)
        if case .notice(let n) = model.banner, n.approvalID == approvalID { dismissBanner() }
    }

    private func snapshot(_ bots: [Bot]) {
        knownMessages = Dictionary(uniqueKeysWithValues: bots.map { ($0.id, MessageDiff.botMessageIDs($0)) })
        knownApprovals = Dictionary(uniqueKeysWithValues: bots.compactMap { b in b.pending.map { (b.id, $0.id) } })
    }

    // MARK: Présence

    private func startPresence() {
        let distributed = DistributedNotificationCenter.default()
        observers.append((distributed, distributed.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.locked = true; self?.updatePresence() }
        }))
        observers.append((distributed, distributed.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.locked = false; self?.updatePresence() }
        }))
        let workspace = NSWorkspace.shared.notificationCenter
        observers.append((workspace, workspace.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.asleep = true; self?.updatePresence() }
        }))
        observers.append((workspace, workspace.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.asleep = false; self?.updatePresence() }
        }))
        idleTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.updatePresence() }
        }
    }

    /// Depuis combien de secondes ni clavier ni souris n'ont bougé.
    private var idleSeconds: TimeInterval {
        guard let anyInput = CGEventType(rawValue: ~0) else { return 0 }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
    }

    private func updatePresence() {
        let away = Presence.isAway(locked: locked, asleep: asleep, idleSeconds: idleSeconds)
        guard away != model.isAway else { return }
        model.isAway = away
        guard !away else { return }
        // De retour : une seule bannière pour tout ce qui s'est passé.
        let waiting = model.inbox.drainQueue()
        guard isIsland(), model.announces, let banner = Presence.returnBanner(waiting) else { pump(); return }
        // Les autres restent non lues : le badge et le panneau les gardent.
        if model.banner != nil { model.banner = nil }
        show(banner)
    }

    // MARK: macOS

    /// Le centre de notifications de macOS n'existe que pour une app en bundle (pas `swift run`).
    private var systemAvailable: Bool {
        Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil
    }

    private func requestSystemPermission() {
        guard systemAvailable else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            Task { @MainActor [weak self] in
                guard let self, !granted else { return }
                self.model.systemNotifications = false
                self.wantedSystem = false
                let why = error.map { $0.localizedDescription } ?? tr("permission denied", "autorisation refusée")
                self.model.record(.warning, .send, tr("macOS notifications off: \(why)", "notifications macOS désactivées : \(why)"))
            }
        }
    }

    private func notifySystem(_ notice: Notice) {
        guard model.systemNotifications, systemAvailable, notice.priority != .low else { return }
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.text
        if notice.sound != nil { content.sound = .default }
        let request = UNNotificationRequest(identifier: notice.id.uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in
                self?.model.record(.warning, .send, tr("macOS notification not shown: \(error.localizedDescription)",
                                                       "notification macOS non affichée : \(error.localizedDescription)"))
            }
        }
    }
}
