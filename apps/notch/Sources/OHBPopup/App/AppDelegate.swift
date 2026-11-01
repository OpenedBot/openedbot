import AppKit
import Observation
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = NotchModel()
    /// Lancée par openedbot avec `--hosted` : la session est la sienne, on lui demande les jetons.
    let isHosted = LaunchMode.isHosted()
    private var preferences: UserDefaults = .standard
    /// Le compte local. En mode hébergé, il reste inerte : jamais restauré, jamais connecté,
    /// donc aucune lecture ni écriture dans le trousseau.
    private(set) var account: AccountModel!
    /// Les jetons d'openedbot, en mode hébergé seulement.
    private(set) var host: HostTokenSource?
    private var channel: HostChannel?
    /// Ce que le flux et les réglages utilisent : openedbot en hébergé, le compte local sinon.
    private var tokens: any TokenSource { host ?? account }
    /// La démo, toujours prête ; le flux openedbot, créé quand un compte est connecté.
    private(set) var feed: MockBotFeed!
    private var live: OHBotFeed?
    private(set) var notch: NotchWindowController!
    private var status: StatusItemController!
    private var settingsWindow: NSWindow?
    private var notices: NoticeCenter!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if isHosted {
            // Le canal d'abord : il met stdout de côté avant que quoi que ce soit n'y écrive.
            guard let channel = HostChannel.standardStreams() else { exit(3) }
            self.channel = channel
            if LaunchMode.otherInstance() != nil {
                channel.send(.fatal(code: "STANDALONE_RUNNING"))
                exit(3)
            }
        }
        preferences = LaunchMode.preferences(hosted: isHosted)
        if !isHosted { PreferencesMigration.run() }
        Language.shared.load(from: preferences)
        if !isHosted, LaunchMode.otherInstance() != nil {
            refuseSecondInstance()
            return
        }
        model.load(from: preferences)
        account = AccountModel(defaults: preferences)
        feed = MockBotFeed(model: model)
        notch = NotchWindowController(model: model, feed: feed)
        notch.onOpenSettings = { [weak self] in self?.openSettings() }
        notices = NoticeCenter(model: model)
        notices.isIsland = { [weak self] in self?.notch.isIsland ?? false }
        notices.isDialogOpen = { [weak self] id in self?.notch.hasDialog(id) ?? false }
        notch.notices = notices
        feed.onTransition = { [weak self] bot, transition in self?.handle(bot, transition) }
        status = StatusItemController(model: model)
        status.menuProvider = { [weak self] in self?.statusMenu() ?? NSMenu() }
        if let channel {
            startHosted(channel)
        } else {
            feed.start()
            Task { await account.restore() }
        }
        observeAccount()
        NotificationCenter.default.addObserver(forName: .languageDidChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.languageChanged() }
        }
        // Lancement avec `-demoApproval 1` : une approbation sur Support après trois secondes.
        if !isHosted, UserDefaults.standard.bool(forKey: "demoApproval") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.feed.simulateApproval() }
        }
    }

    /// Mode hébergé : openedbot répond à `ready` par `hello` (origine), puis `signedIn` ou `signedOut`.
    /// Fin de stdin : openedbot est parti ou nous arrête, on quitte proprement.
    private func startHosted(_ channel: HostChannel) {
        let host = HostTokenSource(send: { [channel] in channel.send($0) })
        host.onFatal = { [channel] code in
            channel.send(.fatal(code: code))
            exit(3)
        }
        self.host = host
        notch.onOpenConsole = { [weak host] path in host?.openConsole(path: path) }
        channel.start(onLine: { [weak host] line in host?.receive(line: line) },
                      onEOF: { [weak host] in
                          host?.hostClosed()
                          NSApp.terminate(nil)
                      })
        channel.send(.ready(protocol: HostProtocol.version, version: LaunchMode.version))
        syncFeed()
    }

    /// Une autre encoche tourne déjà (peut-être dans openedbot) : deux au même bord se recouvriraient.
    private func refuseSecondInstance() {
        let alert = NSAlert()
        alert.messageText = tr("openedbot notch is already running", "openedbot notch tourne déjà")
        alert.informativeText = tr("Another openedbot notch is open, possibly inside openedbot (popup mode). Quit it before opening this one.",
                                   "Une autre openedbot notch est ouverte, peut-être dans openedbot (mode popup). Quittez-la avant d'ouvrir celle-ci.")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
        NSApp.terminate(nil)
    }

    /// Une bascule du flux : à la boîte de notifications (toutes positions), et aux annonces de l'encoche.
    private func handle(_ bot: Bot, _ transition: FeedTransition) {
        notices.transition(bot, transition)
        notch.announce(bot, transition)
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Optionnels : un refus de seconde instance quitte avant que tout soit construit.
        notices?.stop()
        feed?.stop()
        live?.stop()
        notch?.shutdown()
    }

    /// Les vues SwiftUI suivent seules ; restent le titre des réglages et la démo, dont les textes
    /// sont écrits à sa création : on la rejoue dans la nouvelle langue.
    private func languageChanged() {
        settingsWindow?.title = tr("openedbot notch Settings", "Réglages openedbot notch")
        if live == nil {
            if isHosted { showHostedSignedOut() } else { feed.start() }
        }
    }

    // MARK: Démo ou openedbot

    /// Connecté : les vrais bots ; déconnecté : la démo (ou, hébergée, l'invitation à se connecter
    /// dans openedbot). Le changement ferme les fenêtres d'agents.
    private func observeAccount() {
        withObservationTracking {
            _ = tokens.isSignedIn
            _ = host?.isReady
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.syncFeed()
                self.observeAccount()
            }
        }
    }

    private func syncFeed() {
        if tokens.isSignedIn, live == nil {
            feed.stop()
            let f = OHBotFeed(model: model, account: tokens)
            f.onTransition = { [weak self] bot, transition in self?.handle(bot, transition) }
            live = f
            notch.feed = f
            f.start()
        } else if !tokens.isSignedIn {
            if let f = live {
                f.stop()
                live = nil
                notch.feed = feed
                if !isHosted { feed.start() }
            }
            if isHosted { showHostedSignedOut() }
        }
    }

    /// Hébergée et sans session : pas de démo, l'encoche dit où se connecter.
    private func showHostedSignedOut() {
        feed.stop()
        model.bots = []
        model.sections = []
        model.runtime = nil
        model.feedState = host?.isReady == true ? .failed(tr("sign in to openedbot", "connectez-vous dans openedbot")) : .connecting
    }

    // MARK: Menu de la barre

    private func statusMenu() -> NSMenu {
        let menu = NSMenu()
        let bots = LayoutRules.ordered(bots: model.bots, sections: model.sections)
        for bot in bots {
            let line = "\(bot.name) · \(bot.activity.word)" + (bot.activeRun.map { " · \($0.name) \($0.stepText)" } ?? "")
            let mi = NSMenuItem(title: line, action: #selector(openBot(_:)), keyEquivalent: "")
            mi.target = self
            mi.representedObject = bot.id
            mi.image = Self.menuIcon(for: bot)
            menu.addItem(mi)
        }
        if host != nil, live != nil, !bots.isEmpty {
            // Hébergée : le même bot, mais dans la console d'openedbot (`/bot/:botId`).
            let consoleMenu = NSMenu()
            for bot in bots {
                let mi = NSMenuItem(title: bot.name, action: #selector(openBotInConsole(_:)), keyEquivalent: "")
                mi.target = self
                mi.representedObject = bot.id
                mi.image = Self.menuIcon(for: bot)
                consoleMenu.addItem(mi)
            }
            let item = NSMenuItem(title: tr("Open in the console", "Ouvrir dans la console"), action: nil, keyEquivalent: "")
            item.submenu = consoleMenu
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let keep = NSMenuItem(title: tr("Keep open", "Garder ouverte"), action: #selector(keepOpen), keyEquivalent: "")
        keep.target = self
        keep.state = model.isPinned ? .on : .off
        menu.addItem(keep)
        if live == nil, !isHosted {
            for (title, sel) in [(tr("Demo: Support is waiting", "Démo : Support attend"), #selector(demoWaiting)), (tr("Demo: Support is done", "Démo : Support a fini"), #selector(demoDone)),
                                 (tr("Demo: gpu-box goes down / comes back", "Démo : gpu-box tombe / revient"), #selector(demoOffline)), (tr("Replay the demo", "Rejouer la démo"), #selector(replay))] {
                let mi = NSMenuItem(title: title, action: sel, keyEquivalent: "")
                mi.target = self
                menu.addItem(mi)
            }
        } else if let state = model.feedState {
            let mi = NSMenuItem(title: tr("openedbot: \(state.text)", "openedbot : \(state.text)"), action: nil, keyEquivalent: "")
            mi.isEnabled = false
            menu.addItem(mi)
        }
        menu.addItem(.separator())
        if host != nil {
            let open = NSMenuItem(title: tr("Open openedbot", "Ouvrir openedbot"), action: #selector(openOHBot), keyEquivalent: "o")
            open.target = self
            menu.addItem(open)
        }
        let settings = NSMenuItem(title: tr("Settings…", "Réglages…"), action: #selector(openSettingsAction), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)
        menu.addItem(withTitle: tr("Quit openedbot notch", "Quitter openedbot notch"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        return menu
    }

    private static func menuIcon(for bot: Bot) -> NSImage? {
        guard let image = Avatars.image(for: bot.artwork) else { return nil }
        let icon = image.copy() as! NSImage
        icon.size = NSSize(width: 16, height: 16)
        return icon
    }

    /// Le chemin de la console pour un bot : son fil unique, `/bot/:botId` (`route-tree.tsx`).
    nonisolated static func consolePath(botID: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        return "/bot/" + (botID.addingPercentEncoding(withAllowedCharacters: allowed) ?? botID)
    }

    @objc private func openBot(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        notch.openDialog(botID: id)
    }
    @objc private func openBotInConsole(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        host?.openConsole(path: Self.consolePath(botID: id))
    }
    @objc private func openOHBot() { host?.openConsole(path: "/") }
    @objc private func keepOpen() { notch.togglePin() }
    @objc private func demoWaiting() { feed.simulateApproval() }
    @objc private func demoDone() { feed.simulateFinish() }
    @objc private func demoOffline() { feed.toggleOffline() }
    @objc private func replay() { feed.start() }
    @objc private func openSettingsAction() { openSettings() }

    // MARK: Réglages

    static let settingsDefaultSize = NSSize(width: 880, height: 640)
    static let settingsMinSize = NSSize(width: 680, height: 500)
    static let settingsAutosaveName = "SettingsWindow"

    /// Au moins la taille minimale, au plus l'écran visible (un petit écran garde une fenêtre entière).
    static func clamped(_ frame: NSRect, min: NSSize, in screen: NSRect?) -> NSRect {
        var f = frame
        f.size.width = Swift.max(f.width, min.width)
        f.size.height = Swift.max(f.height, min.height)
        if let screen {
            f.size.width = Swift.min(f.width, screen.width)
            f.size.height = Swift.min(f.height, screen.height)
            f.origin.x = Swift.min(Swift.max(f.minX, screen.minX), screen.maxX - f.width)
            f.origin.y = Swift.min(Swift.max(f.minY, screen.minY), screen.maxY - f.height)
        }
        return f
    }

    private func openSettings() {
        if let w = settingsWindow {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let win = NSWindow(contentRect: NSRect(origin: .zero, size: Self.settingsDefaultSize),
                           styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        win.title = tr("openedbot notch Settings", "Réglages openedbot notch")
        win.minSize = Self.settingsMinSize
        // La barre de titre se fond dans le rail : seuls les feux restent.
        win.titlebarAppearsTransparent = true
        win.titleVisibility = .hidden
        win.backgroundColor = NSColor(red: 0x12 / 255, green: 0x12 / 255, blue: 0x12 / 255, alpha: 1)
        win.appearance = NSAppearance(named: .darkAqua)
        win.contentView = NSHostingView(rootView: SettingsView(model: model, feed: feed, account: account, host: host))
        win.isReleasedWhenClosed = false
        if isHosted {
            // Le cadre retenu vit dans le domaine de l'app, celui de l'autonome : l'hébergée ne l'écrit pas.
            win.setFrame(Self.clamped(win.frame, min: Self.settingsMinSize, in: NSScreen.main?.visibleFrame), display: false)
            win.center()
            settingsWindow = win
            win.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        // L'ancien cadre (« Réglages ») pouvait être resté à l'ancien minimum, trop étroit : on repart
        // de la taille par défaut sous un nouveau nom, puis on retient les retouches de l'utilisateur.
        UserDefaults.standard.removeObject(forKey: "NSWindow Frame Réglages")
        if win.setFrameUsingName(Self.settingsAutosaveName) {
            win.setFrame(Self.clamped(win.frame, min: Self.settingsMinSize, in: win.screen?.visibleFrame), display: false)
        } else {
            win.setFrame(Self.clamped(win.frame, min: Self.settingsMinSize, in: NSScreen.main?.visibleFrame), display: false)
            win.center()
        }
        win.setFrameAutosaveName(Self.settingsAutosaveName)
        settingsWindow = win
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
