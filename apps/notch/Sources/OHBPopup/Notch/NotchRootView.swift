import SwiftUI

/// Tout ce que le panneau dessine : la pastille, le corps avec ses anneaux, l'orbe, l'overlay.
struct NotchRootView: View {
    let model: NotchModel
    let geometry: NotchGeometry
    let feed: any BotFeed
    var onOrb: () -> Void = {}
    var onBodyClick: () -> Void = {}
    var onOpenDialog: (String) -> Void = { _ in }

    var onRespond: (Bot, Approval, Bool) -> Void = { _, _, _ in }
    var onOpenNotice: (Notice) -> Void = { _ in }
    var onLater: () -> Void = {}
    var onShowAll: () -> Void = {}
    var onClearNotices: () -> Void = {}

    var body: some View {
        if geometry.isIsland { island } else { standard }
    }

    /// L'île : invisible sur la caméra, ses ailes quand un bot est actif, son panneau au survol.
    private var island: some View {
        let g = geometry
        let open = model.showsBody
        let compact = Island.compact(bots: model.bots, unread: model.inbox.unreadCount,
                                     latestUnreadBotID: model.inbox.unread.first?.botID)
        let flash = model.islandFlash
        let banner = model.banner
        return ZStack(alignment: .topLeading) {
            Color.clear
            PillShape(geometry: g).fill(Palette.notch).opacity(open || model.isHidden ? 0 : 1)
            if !open, !model.isHidden, banner == nil, compact != nil || flash != nil {
                IslandCompactView(model: model, geometry: g, compact: compact, flash: flash)
                    .position(x: g.restMid, y: g.inset / 2)
                    .transition(.opacity)
            }
            if !open, !model.isHidden, let banner {
                IslandBannerView(model: model, geometry: g, banner: banner, onOpen: onOpenNotice, onLater: onLater,
                                 onShowAll: onShowAll, onRespond: onRespond)
                    .onGeometryChange(for: CGSize.self) { $0.size } action: { model.bannerSize = $0 }
                    .offset(x: g.restMid - NotchGeometry.islandWidth / 2)
                    .transition(.scale(scale: 0.5, anchor: .top).combined(with: .opacity))
            }
            if open {
                IslandPanelView(model: model, geometry: g, onOpenDialog: onOpenDialog,
                                onSettings: { model.settingsSpins += 1; onOrb() }, onRespond: onRespond,
                                onOpenNotice: onOpenNotice, onClearNotices: onClearNotices)
                    .onGeometryChange(for: CGSize.self) { $0.size } action: { model.islandSize = $0 }
                    .offset(x: g.restMid - NotchGeometry.islandWidth / 2)
                    .transition(.scale(scale: 0.4, anchor: .top).combined(with: .opacity))
            }
        }
        .frame(width: g.panelSize.width, height: g.panelSize.height, alignment: .topLeading)
        .animation(.spring(response: 0.38, dampingFraction: 0.8), value: open)
        .animation(.easeOut(duration: 0.2), value: flash)
        .animation(.easeOut(duration: 0.2), value: compact)
        .animation(.spring(response: 0.36, dampingFraction: 0.82), value: banner)
        .preferredColorScheme(.dark)
    }

    @ViewBuilder private var standard: some View {
        let g = geometry
        let m = g.metrics
        let open = model.showsBody
        let slide = outward(g.edge, by: open ? 0 : g.depth + 12)
        let items = model.items

        ZStack(alignment: .topLeading) {
            Color.clear

            PillShape(geometry: g).fill(Palette.notch).opacity(open || model.isHidden ? 0 : 1)

            ZStack(alignment: .topLeading) {
                NotchShape(geometry: g).fill(Palette.notch)
                    .contentShape(NotchShape(geometry: g))
                    .onTapGesture { onBodyClick() }
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    cell(item, metrics: m, animating: open)
                        .position(g.cellCenter(index: i))
                        .onTapGesture { if let id = item.botID { onOpenDialog(id) } }
                }
                // En vue « tous », un filet entre deux sections.
                if model.viewMode == .all {
                    ForEach(separators(items), id: \.self) { i in
                        separator(between: i, geometry: g)
                    }
                }
                orb(g)
            }
            .offset(x: slide.x, y: slide.y)
            .opacity(open ? 1 : 0)

            if open, let overlay = model.overlay, let anchor = model.overlayAttachment {
                overlayView(overlay, anchor: anchor, geometry: g)
            }
        }
        .frame(width: g.panelSize.width, height: g.panelSize.height)
        .animation(.spring(response: 0.42, dampingFraction: 0.82), value: open)
        .animation(.easeOut(duration: 0.16), value: model.overlay)
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private func cell(_ item: NotchItem, metrics m: NotchMetrics, animating: Bool) -> some View {
        switch item {
        case .bot(let id):
            if let bot = model.bot(id) { BotCell(bot: bot, metrics: m, animating: animating).pointer() }
        case .pile(let section, let ids):
            PileCell(section: section, members: ids.compactMap(model.bot), metrics: m, animating: animating)
        case .more(let ids):
            MoreCell(count: ids.count, metrics: m)
        }
    }

    /// Les index après lesquels la section change.
    private func separators(_ items: [NotchItem]) -> [Int] {
        var result: [Int] = []
        for i in 0..<(max(0, items.count - 1)) {
            let a = items[i].botID.flatMap(model.bot)?.sectionID
            let b = items[i + 1].botID.flatMap(model.bot)?.sectionID
            if a != b { result.append(i) }
        }
        return result
    }

    private func separator(between i: Int, geometry g: NotchGeometry) -> some View {
        let m = g.metrics
        let along = g.shapeStart + g.cellShift + m.cellRange(index: i, edge: g.edge).upperBound + m.cellSpacing / 2
        let across = g.inset + (g.edge.isVertical ? g.bodyDepth / 2 : m.ringMargin + m.ring / 2)
        let size = g.edge.isVertical ? CGSize(width: m.ring * 0.7, height: 1) : CGSize(width: 1, height: m.ring * 0.7)
        return Rectangle().fill(Palette.ringTrack).frame(width: size.width, height: size.height)
            .position(g.point(along: along, across: across))
    }

    private func orb(_ g: NotchGeometry) -> some View {
        let c = g.orbCenter
        return SettingsOrb(hovering: model.isHoveringOrb, spins: model.settingsSpins, metrics: g.metrics,
                           liveness: model.liveness, animating: model.showsBody)
            .pointer()
            .position(g.point(along: c.along, across: c.across))
            .onTapGesture { model.settingsSpins += 1; onOrb() }
    }

    @ViewBuilder
    private func overlayView(_ overlay: NotchModel.Overlay, anchor: NotchGeometry.Anchor, geometry g: NotchGeometry) -> some View {
        let r = g.cardRect(anchor: anchor, cardSize: model.overlaySize)
        let frame = g.rect(along: r.along, across: r.across)
        Group {
            switch overlay {
            case .card(let id):
                if let bot = model.bot(id) {
                    BotCard(bot: bot, now: model.now, direction: g.edge.tooltipDirection,
                            tailOffset: g.tailOffset(anchor: anchor, cardSize: model.overlaySize),
                            metrics: g.metrics) { approvalID, allow in feed.respond(approvalID: approvalID, allow: allow) }
                }
            case .tray(let title, let members):
                TrayView(title: title, members: members.compactMap(model.bot), metrics: g.metrics) { id in onOpenDialog(id) }
                    .padding(g.edge.isVertical ? .horizontal : .vertical, g.metrics.tailLength / 2)
            case .runtime:
                RuntimeCard(runtime: model.runtimeStatus, feedState: model.feedState, journal: model.journal, now: model.now,
                            direction: g.edge.tooltipDirection,
                            tailOffset: g.tailOffset(anchor: anchor, cardSize: model.overlaySize), metrics: g.metrics)
            }
        }
        .fixedSize()
        .onGeometryChange(for: CGSize.self) { $0.size } action: { model.overlaySize = $0 }
        // Une mesure neuve par overlay : sinon deux plateaux de même taille (deux piles de trois
        // bots) ne déclenchent pas `onGeometryChange`, la taille reste à zéro et rien ne s'affiche.
        .id(overlay)
        .position(x: frame.midX, y: frame.midY)
        .opacity(model.overlaySize == .zero ? 0 : 1)
        .transition(.opacity)
    }

    private func outward(_ edge: NotchEdge, by d: CGFloat) -> CGPoint {
        switch edge {
        case .right: CGPoint(x: d, y: 0)
        case .top: CGPoint(x: 0, y: -d)
        case .bottom: CGPoint(x: 0, y: d)
        }
    }
}

