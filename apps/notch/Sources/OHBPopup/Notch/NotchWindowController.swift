import AppKit
import Observation
import SwiftUI

/// Possède le panneau de l'encoche et les fenêtres d'agents : placement, survol, repli,
/// annonces, menu contextuel, ⌥-glisser, ouverture d'un dialogue au clic sur un anneau.
@MainActor
final class NotchWindowController {
    let panel: NotchPanel
    let model: NotchModel
    /// Le flux du moment : démo ou openedbot. Changer de flux ferme les fenêtres d'agents, qui le tenaient.
    var feed: any BotFeed {
        didSet {
            for (id, _) in dialogs { closeDialog(botID: id) }
            rebuild()
        }
    }
    private(set) var geometry: NotchGeometry
    private let host: NSHostingView<NotchRootView>
    private var monitors: [Any] = []
    private var pollTimer: Timer?
    private var lastPointer = CGPoint(x: -1, y: -1)
    private var foldWork: DispatchWorkItem?
    private var announceWork: DispatchWorkItem?
    private var lastHit: NotchGeometry.Hit = .none
    private var dialogs: [String: AgentDialogController] = [:]
    /// Où chaque fenêtre d'agent a été laissée (déplacée à la main) : on la rouvre là.
    private var dialogFrames: [String: NSRect] = [:]
    private var layoutKey: LayoutKey?

    /// Ce qui oblige à refaire la géométrie : le bord, la taille, le décalage, la liste des éléments.
    private struct LayoutKey: Equatable {
        var edge: NotchEdge
        var scale: CGFloat
        var offsets: [NotchEdge: CGFloat]
        var hidden: Bool
        var items: [NotchItem]
    }

    var onOpenSettings: () -> Void = {}
    /// Mode hébergé : montrer openedbot sur ce chemin de la console. nil en autonome (pas de console à ouvrir).
    var onOpenConsole: ((String) -> Void)?
    /// Les notifications : bannières, badge et lecture, en mode île.
    var notices: NoticeCenter?
    var isIsland: Bool { geometry.isIsland }
    func hasDialog(_ botID: String) -> Bool { dialogs[botID] != nil }
    private var screenObserver: NSObjectProtocol?

    init(model: NotchModel, feed: any BotFeed) {
        self.model = model
        self.feed = feed
        geometry = Self.makeGeometry(model: model)
        panel = NotchPanel(contentRect: NSRect(origin: .zero, size: geometry.panelSize))
        host = NSHostingView(rootView: NotchRootView(model: model, geometry: geometry, feed: feed))
        panel.contentView = host
        panel.ignoresMouseEvents = true
        panel.acceptsMouseMovedEvents = true

        panel.contextMenuProvider = { [weak self] in self?.contextMenu() }
        panel.onDrag = { [weak self] dx, dy in self?.drag(dx: dx, dy: dy) }
        panel.onDragEnd = { [weak self] in self?.rebuild() }

        rebuild()
        panel.orderFrontRegardless()
        installMonitors()
        observeModel()
        // Écran branché, résolution, Dock agrandi ou déplacé : le Dock et la caméra bougent, on se replace.
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                                object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.rebuild() }
        }
    }

    private func currentLayoutKey() -> LayoutKey {
        LayoutKey(edge: model.edge, scale: model.sizeScale, offsets: model.alongOffsets, hidden: model.isHidden, items: model.items)
    }

    func shutdown() {
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        screenObserver = nil
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors = []
        pollTimer?.invalidate()
        pollTimer = nil
        for (_, d) in dialogs { d.close() }
        dialogs = [:]
        panel.orderOut(nil)
    }

    // MARK: Géométrie

    private static func makeGeometry(model: NotchModel) -> NotchGeometry {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        // L'encoche de la caméra : entre les deux zones libres du haut (nil sans encoche).
        let camera: CGRect? = {
            guard let l = screen.auxiliaryTopLeftArea, let r = screen.auxiliaryTopRightArea, r.minX > l.maxX,
                  screen.safeAreaInsets.top > 0 else { return nil }
            return CGRect(x: l.maxX, y: screen.frame.maxY - screen.safeAreaInsets.top,
                          width: r.minX - l.maxX, height: screen.safeAreaInsets.top)
        }()
        let place = NotchGeometry.placement(edge: model.edge, screenFrame: screen.frame, visibleFrame: screen.visibleFrame, camera: camera)
        return NotchGeometry(edge: model.edge, metrics: model.metrics, cellCount: max(model.items.count, 1),
                             screen: place.screen, alongOffset: model.alongOffset, inset: place.inset,
                             restLength: place.restLength, minBodyLength: place.minBodyLength, anchor: place.anchor)
    }

    func rebuild() {
        geometry = Self.makeGeometry(model: model)
        host.rootView = NotchRootView(model: model, geometry: geometry, feed: feed,
                                      onOrb: { [weak self] in self?.onOpenSettings() },
                                      onBodyClick: { [weak self] in self?.togglePin() },
                                      onOpenDialog: { [weak self] id in self?.toggleDialog(botID: id) },
                                      onRespond: { [weak self] bot, approval, allow in self?.respond(bot, approval, allow) },
                                      onOpenNotice: { [weak self] notice in self?.openNotice(notice) },
                                      onLater: { [weak self] in self?.notices?.dismissBanner() },
                                      onShowAll: { [weak self] in self?.showAllNotices() },
                                      onClearNotices: { [weak self] in self?.notices?.clear() })
        panel.setFrame(geometry.panelFrame, display: true)
    }

    /// Une notification ouverte : la fenêtre de son bot, et la voilà lue.
    private func openNotice(_ notice: Notice) {
        openDialog(botID: notice.botID)
        notices?.opened(notice)
    }

    /// Le récapitulatif d'absence : on déplie l'île sur la liste des notifications.
    private func showAllNotices() {
        notices?.dismissBanner()
        model.isExpanded = true
    }

    /// Une réponse donnée depuis l'île : envoyée au flux, puis rappelée à côté de la caméra.
    private func respond(_ bot: Bot, _ approval: Approval, _ allow: Bool) {
        feed.respond(approvalID: approval.id, allow: allow)
        model.flash(Island.Flash(botID: bot.id, botName: bot.name, kind: allow ? .allowed : .denied))
    }

    /// `items` lit `bots`, qui change à chaque pas de run : on ne reconstruit que si la
    /// disposition a vraiment changé, et on resynchronise alors l'overlay avec le pointeur.
    private func observeModel() {
        withObservationTracking {
            layoutKey = currentLayoutKey()
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                let key = self.currentLayoutKey()
                if key != self.layoutKey {
                    self.layoutKey = key
                    self.rebuild()
                    self.resyncHover()
                }
                self.observeModel()
            }
        }
    }

    /// La liste a changé sous le pointeur (bot promu, pile repliée) : l'overlay accroché à
    /// l'index i décrivait l'ancien élément. On repart de zéro, comme si le pointeur arrivait.
    private func resyncHover() {
        guard model.overlay != nil || lastHit != .none else { return }
        lastHit = .none
        updateHover()
    }

    // MARK: Souris

    private func installMonitors() {
        let moved: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
        if let m = NSEvent.addGlobalMonitorForEvents(matching: moved, handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.updateHover() }
        }) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: moved, handler: { [weak self] event in
            MainActor.assumeIsolated { self?.updateHover() }
            return event
        }) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] event in
            let code = event.keyCode
            let consumed = MainActor.assumeIsolated { self?.handleKey(code: code) ?? false }
            return consumed ? nil : event
        }) { monitors.append(m) }
        // Le Dock et la barre de menus ne relaient pas toujours `mouseMoved`.
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.125, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let p = NSEvent.mouseLocation
                guard p != self.lastPointer else { return }
                self.lastPointer = p
                self.updateHover()
            }
        }
    }

    private func currentHit() -> NotchGeometry.Hit {
        let p = NSEvent.mouseLocation
        let frame = panel.frame
        let local = CGPoint(x: p.x - frame.minX, y: frame.maxY - p.y)
        let s = geometry.stack(from: local)
        let card = model.overlayAttachment.map { geometry.cardRect(anchor: $0, cardSize: model.overlaySize) }
        // Île repliée : ses ailes ouvrent aussi le panneau quand elles sont affichées.
        var wingsSide: CGFloat?
        if geometry.isIsland, !model.showsBody {
            let compact = Island.compact(bots: model.bots, unread: model.inbox.unreadCount,
                                         latestUnreadBotID: model.inbox.unread.first?.botID)
            if compact != nil || model.islandFlash != nil {
                wingsSide = Island.sideWidth(compact: compact, flash: model.islandFlash, cameraHeight: geometry.inset)
            }
        }
        let bannerHeight = geometry.isIsland && !model.showsBody && model.banner != nil ? model.bannerSize.height : nil
        return geometry.hit(along: s.along, across: s.across, expanded: model.showsBody, card: card,
                            islandHeight: model.islandSize.height, wingsSide: wingsSide, bannerHeight: bannerHeight)
    }

    private func updateHover() {
        guard !model.isHidden else { return }
        let hit = currentHit()
        panel.ignoresMouseEvents = hit == .none
        // Même cellule qu'avant, mais l'overlay a disparu (la liste a changé sous le pointeur) : réarmer.
        if case .cell = hit, model.overlay == nil { lastHit = .none }
        notices?.setHovering(hit == .banner)
        guard hit != lastHit else { return }
        lastHit = hit

        switch hit {
        case .pill:
            foldWork?.cancel()
            model.isExpanded = true
        case .cell(let i):
            foldWork?.cancel()
            model.isHoveringOrb = false
            showOverlay(forItem: i)
        case .body, .card, .banner:
            foldWork?.cancel()
            model.isHoveringOrb = false
        case .orb:
            foldWork?.cancel()
            model.isHoveringOrb = true
            // L'orbe montre la carte du runtime ; un clic ouvre toujours les réglages.
            if model.overlay != .runtime { model.overlaySize = .zero }
            model.overlay = .runtime
            model.overlayAnchor = nil
        case .none:
            model.isHoveringOrb = false
            clearOverlay()
            scheduleFold()
        }
    }

    private func showOverlay(forItem i: Int) {
        guard model.items.indices.contains(i) else { return }
        let overlay: NotchModel.Overlay
        switch model.items[i] {
        case .bot(let id):
            if dialogs[id] != nil { clearOverlay(); return } // sa fenêtre est ouverte : la carte ferait doublon
            overlay = .card(id)
        case .pile(let section, let ids): overlay = .tray(title: section.name, members: ids)
        case .more(let ids): overlay = .tray(title: tr("\(ids.count) inactive bots", "\(ids.count) bots inactifs"), members: ids)
        }
        if model.overlay != overlay { model.overlaySize = .zero }
        model.overlay = overlay
        model.overlayAnchor = i
    }

    private func clearOverlay() {
        model.overlay = nil
        model.overlayAnchor = nil
    }

    private func scheduleFold() {
        foldWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.currentHit() == .none else { return }
            self.model.isExpanded = false
        }
        foldWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    func togglePin() {
        model.isPinned.toggle()
        if !model.isPinned { scheduleFold() }
    }

    /// Échap ferme d'abord un sélecteur ouvert, sinon la fenêtre d'agent qui a le clavier.
    private func handleKey(code: UInt16) -> Bool {
        guard code == 53 else { return false }
        if model.openPickers > 0 { model.closePickersTick += 1; return true }
        guard let open = dialogs.values.first(where: { $0.panel.isKeyWindow }) else { return false }
        closeDialog(botID: open.botID)
        return true
    }

    // MARK: Fenêtres d'agents

    func toggleDialog(botID: String) {
        if dialogs[botID] != nil { closeDialog(botID: botID) } else { openDialog(botID: botID) }
    }

    /// Au bord, l'encoche reste ouverte pendant un chat : l'anneau du bot montre à quelle fenêtre on parle.
    /// L'île, elle, se referme sur la caméra : la fenêtre du bot prend le relais, l'île ne doit pas la doubler.
    nonisolated static func pinsWhileDialogOpen(island: Bool) -> Bool { !island }

    func openDialog(botID: String) {
        guard dialogs[botID] == nil else { dialogs[botID]?.panel.orderFrontRegardless(); return }
        clearOverlay()
        let size = AgentDialogView.size
        let frame = dialogFrames[botID] ?? dialogFrame(botID: botID, size: size)
        let controller = AgentDialogController(botID: botID, model: model, feed: feed, frame: frame,
                                               openInConsole: onOpenConsole) { [weak self] in
            self?.closeDialog(botID: botID)
        }
        dialogs[botID] = controller
        if Self.pinsWhileDialogOpen(island: geometry.isIsland) {
            model.isPinned = true
        } else {
            model.isExpanded = false
            model.overlay = nil
        }
        syncOpenThreads()
    }

    /// Le flux openedbot relit les fils ouverts à chaque rafraîchissement.
    private func syncOpenThreads() {
        guard let live = feed as? OHBotFeed else { return }
        live.openThreads = Set(dialogs.keys.compactMap { model.bot($0)?.threadID })
        if !dialogs.isEmpty { Task { await live.refresh(threads: live.openThreads) } }
    }

    func closeDialog(botID: String) {
        if let open = dialogs[botID] { dialogFrames[botID] = open.panel.frame }
        dialogs.removeValue(forKey: botID)?.close()
        syncOpenThreads()
        if dialogs.isEmpty {
            model.isPinned = false
            scheduleFold()
        }
    }

    /// Au milieu de l'écran, chaque fenêtre ouverte en plus décalée de 28 pt vers le bas et la droite.
    private func dialogFrame(botID: String, size: CGSize) -> NSRect {
        let screen = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        let step = CGFloat(dialogs.count) * 28
        var frame = NSRect(x: screen.midX - size.width / 2 + step, y: screen.midY - size.height / 2 - step,
                           width: size.width, height: size.height)
        frame.origin.x = min(max(frame.minX, screen.minX + 8), screen.maxX - frame.width - 8)
        frame.origin.y = min(max(frame.minY, screen.minY + 8), screen.maxY - frame.height - 8)
        return frame
    }

    // MARK: Annonces

    func announce(_ bot: Bot, _ transition: FeedTransition) {
        // L'île a ses bannières et sa boîte (NoticeCenter) : elle ne se déplie plus d'elle-même.
        guard model.announces, !geometry.isIsland else { return }
        if transition == .finished, !bot.notifyOnFinish { return }
        announceWork?.cancel()
        model.announcement = bot.name
        playSound(for: transition)
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.model.announcement = nil
            if self.currentHit() == .none, self.dialogs.isEmpty { self.model.isExpanded = false }
        }
        announceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
    }

    private func playSound(for transition: FeedTransition) {
        if model.plays {
            let name: String
            switch transition {
            case .waiting: name = "Funk"
            case .offline, .failed: name = "Basso"
            default: name = "Glass"
            }
            NSSound(named: NSSound.Name(name))?.play()
        }
    }

    // MARK: Menu contextuel et ⌥-glisser

    private func contextMenu() -> NSMenu {
        let menu = NSMenu()
        let keep = NSMenuItem(title: tr("Keep open", "Garder ouverte"), action: #selector(keepOpen), keyEquivalent: "")
        keep.target = self
        keep.state = model.isPinned ? .on : .off
        keep.isEnabled = !model.alwaysOn
        menu.addItem(keep)
        menu.addItem(.separator())
        let views = NSMenu()
        for v in ViewMode.allCases {
            let mi = NSMenuItem(title: v.title, action: #selector(selectView(_:)), keyEquivalent: "")
            mi.target = self
            mi.representedObject = v.rawValue
            mi.state = v == model.viewMode ? .on : .off
            views.addItem(mi)
        }
        let viewItem = NSMenuItem(title: tr("View", "Affichage"), action: nil, keyEquivalent: "")
        viewItem.submenu = views
        menu.addItem(viewItem)
        let edges = NSMenu()
        for e in NotchEdge.allCases {
            let mi = NSMenuItem(title: e.title, action: #selector(selectEdge(_:)), keyEquivalent: "")
            mi.target = self
            mi.representedObject = e.rawValue
            mi.state = e == model.edge ? .on : .off
            edges.addItem(mi)
        }
        let edgeItem = NSMenuItem(title: tr("Position", "Position"), action: nil, keyEquivalent: "")
        edgeItem.submenu = edges
        menu.addItem(edgeItem)
        if onOpenConsole != nil {
            let open = NSMenuItem(title: tr("Open openedbot", "Ouvrir openedbot"), action: #selector(openConsole), keyEquivalent: "")
            open.target = self
            menu.addItem(open)
        }
        let settings = NSMenuItem(title: tr("Settings…", "Réglages…"), action: #selector(openSettings), keyEquivalent: "")
        settings.target = self
        menu.addItem(settings)
        menu.addItem(.separator())
        menu.addItem(withTitle: tr("Quit openedbot notch", "Quitter openedbot notch"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        return menu
    }

    @objc private func keepOpen() { togglePin() }
    @objc private func openSettings() { onOpenSettings() }
    @objc private func openConsole() { onOpenConsole?("/") }
    @objc private func selectEdge(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let e = NotchEdge(rawValue: raw) else { return }
        model.edge = e
    }
    @objc private func selectView(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let v = ViewMode(rawValue: raw) else { return }
        model.viewMode = v
    }

    private func drag(dx: CGFloat, dy: CGFloat) {
        guard geometry.isDraggable else { return }
        let delta = model.edge.isVertical ? dy : dx
        let range = geometry.alongOffsetRange
        let current = min(max(model.alongOffset, range.lowerBound), range.upperBound)
        model.alongOffset = min(max(current + delta, range.lowerBound), range.upperBound)
    }
}
