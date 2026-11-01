import SwiftUI

// L'île, à la manière de Vibe Island : invisible sur la caméra au repos, deux ailes quand un bot
// travaille ou attend, un panneau qui descend de la caméra au survol.

/// Le panneau déplié : des oreilles concaves qui rejoignent le haut de l'écran, un bas arrondi.
struct IslandPanelShape: Shape {
    var ear: CGFloat = NotchGeometry.islandEar
    var radius: CGFloat = 22

    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        let r = min(radius, (w - 2 * ear) / 2, h / 2)
        var p = Path()
        p.move(to: CGPoint(x: 0, y: 0))
        p.addQuadCurve(to: CGPoint(x: ear, y: ear), control: CGPoint(x: ear, y: 0))
        p.addLine(to: CGPoint(x: ear, y: h - r))
        p.addQuadCurve(to: CGPoint(x: ear + r, y: h), control: CGPoint(x: ear, y: h))
        p.addLine(to: CGPoint(x: w - ear - r, y: h))
        p.addQuadCurve(to: CGPoint(x: w - ear, y: h - r), control: CGPoint(x: w - ear, y: h))
        p.addLine(to: CGPoint(x: w - ear, y: ear))
        p.addQuadCurve(to: CGPoint(x: w, y: 0), control: CGPoint(x: w - ear, y: 0))
        p.closeSubpath()
        return p
    }
}

/// L'état compact : à gauche de la caméra qui travaille, à droite combien travaillent et attendent ;
/// ou un message bref (run fini, accord donné) pendant quelques secondes.
struct IslandCompactView: View {
    let model: NotchModel
    let geometry: NotchGeometry
    let compact: Island.Compact?
    let flash: Island.Flash?

    var body: some View {
        let g = geometry
        let side = Island.sideWidth(compact: compact, flash: flash, cameraHeight: g.inset)
        let avatar = g.inset * 0.6
        HStack(spacing: 0) {
            Group {
                if let flash {
                    HStack(spacing: 6) {
                        if let bot = model.bot(flash.botID) { AvatarView(bot: bot, size: avatar) }
                        Text(flash.botName).font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
                    }
                } else if let compact {
                    HStack(spacing: -6) {
                        ForEach(compact.botIDs, id: \.self) { id in
                            if let bot = model.bot(id) {
                                AvatarView(bot: bot, size: avatar).overlay(Circle().stroke(Color.black, lineWidth: 1.5))
                            }
                        }
                        if compact.extra > 0 {
                            Text("+\(compact.extra)").font(.system(size: 10.5, weight: .semibold)).monospacedDigit()
                                .foregroundStyle(Palette.textSecondary).lineLimit(1).fixedSize().padding(.leading, 9)
                        }
                    }
                }
            }
            .padding(.leading, 10)
            .frame(width: side, alignment: .leading)

            Color.clear.frame(width: g.restLength ?? 0)

            Group {
                if let flash {
                    HStack(spacing: 5) {
                        Image(systemName: flash.symbol).font(.system(size: 10, weight: .bold)).foregroundStyle(color(flash.kind))
                        Text(flash.text).font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
                    }
                } else if let compact {
                    HStack(spacing: 7) {
                        if compact.idle {
                            // Au repos : la connexion et le nombre de bots suivis.
                            HStack(spacing: 5) {
                                LivenessDot(liveness: model.liveness, size: 6, animating: false)
                                Text(compact.total == 1 ? tr("1 bot", "1 bot") : tr("\(compact.total) bots", "\(compact.total) bots"))
                                    .foregroundStyle(Palette.textSecondary).lineLimit(1).fixedSize()
                            }
                        }
                        if compact.working > 0 {
                            HStack(spacing: 3) {
                                IslandSpinner(size: g.inset * 0.42)
                                if compact.working > 1 || compact.waiting > 0 { Text("\(compact.working)") }
                            }
                        }
                        if compact.waiting > 0 {
                            HStack(spacing: 3) {
                                Circle().fill(Palette.waiting).frame(width: 7, height: 7)
                                if compact.waiting > 1 || compact.working > 0 { Text("\(compact.waiting)") }
                            }
                        }
                        if compact.unread > 0 {
                            HStack(spacing: 3) {
                                Image(systemName: "bell.fill").font(.system(size: 9.5, weight: .semibold))
                                Text("\(compact.unread)")
                            }
                            .accessibilityLabel(tr("\(compact.unread) unread notifications", "\(compact.unread) notifications non lues"))
                        }
                    }
                    .font(.system(size: 11, weight: .semibold)).monospacedDigit()
                    .lineLimit(1).fixedSize()
                }
            }
            .padding(.trailing, 10)
            .frame(width: side, alignment: .trailing)
        }
        .foregroundStyle(Palette.textPrimary)
        .frame(height: g.inset)
        .background(UnevenRoundedRectangle(cornerRadii: RectangleCornerRadii(bottomLeading: min(g.inset / 2, 14), bottomTrailing: min(g.inset / 2, 14)),
                                           style: .continuous).fill(Palette.notch))
        .accessibilityElement(children: .combine)
    }

    private func color(_ kind: Island.Flash.Kind) -> Color {
        switch kind {
        case .finished, .allowed, .back: Palette.ample
        case .offline, .denied: Palette.critical
        }
    }
}

/// Un arc qui tourne : un bot au travail.
struct IslandSpinner: View {
    let size: CGFloat
    @State private var spin = false

    var body: some View {
        Circle().trim(from: 0, to: 0.7)
            .stroke(Palette.ample, style: StrokeStyle(lineWidth: max(2, size * 0.16), lineCap: .round))
            .frame(width: size, height: size)
            .rotationEffect(.degrees(spin ? 360 : 0))
            .animation(.linear(duration: 1.1).repeatForever(autoreverses: false), value: spin)
            .onAppear { spin = true }
            .accessibilityLabel(tr("Working", "Au travail"))
    }
}

/// Le panneau déplié : l'état du runtime de part et d'autre de la caméra, les demandes d'accord,
/// puis une ligne par bot. Un clic sur une ligne ouvre la fenêtre du bot.
struct IslandPanelView: View {
    let model: NotchModel
    let geometry: NotchGeometry
    var onOpenDialog: (String) -> Void
    var onSettings: () -> Void
    var onRespond: (Bot, Approval, Bool) -> Void
    var onOpenNotice: (Notice) -> Void = { _ in }
    var onClearNotices: () -> Void = {}

    var body: some View {
        let g = geometry
        let ear = NotchGeometry.islandEar
        // Les demandes d'accord encore ouvertes ont leur carte : pas de doublon dans la liste.
        let pendingIDs = Set(model.bots.compactMap { $0.pending?.id })
        let approvalsShown = Island.approvals(bots: model.bots).count
        let recent = Array(model.inbox.notices.filter { n in n.approvalID.map { !pendingIDs.contains($0) } ?? true }
            .prefix(approvalsShown > 0 ? 3 : Island.noticeLimit))
        let rowLimit = Island.rowLimit(approvals: approvalsShown, notices: recent.count)
        let inner = NotchGeometry.islandWidth - 2 * ear - 24
        let side = max(0, (inner - (g.restLength ?? 0)) / 2)
        let rows = Island.rows(bots: model.bots)
        let approvals = Island.approvals(bots: model.bots)
        VStack(alignment: .leading, spacing: 8) {
            // La bande de la caméra : le runtime à gauche, sa version et les réglages à droite.
            HStack(spacing: 0) {
                HStack(spacing: 6) {
                    LivenessDot(liveness: model.liveness, size: 7)
                    Text(model.runtimeStatus?.name ?? tr("Demo", "Démo"))
                        .font(.system(size: 11.5, weight: .medium)).foregroundStyle(Palette.textSecondary).lineLimit(1)
                }
                .frame(width: side, alignment: .leading)
                Color.clear.frame(width: g.restLength ?? 0)
                HStack(spacing: 8) {
                    if let r = model.runtimeStatus, let v = r.version {
                        Text(r.outdated ? "\(Island.version(v)) → \(Island.version(r.latestVersion ?? ""))" : Island.version(v))
                            .font(.system(size: 11, weight: .medium)).monospacedDigit()
                            .foregroundStyle(r.outdated ? Palette.waiting : Palette.textSecondary).lineLimit(1)
                    }
                    Button(action: onSettings) {
                        Image(systemName: "gearshape.fill").font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(Palette.textSecondary).frame(width: 20, height: 20).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).pointer().help(tr("Settings", "Réglages"))
                }
                .frame(width: side, alignment: .trailing)
            }
            .frame(height: g.inset)

            if !recent.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(tr("Notifications", "Notifications")).font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(Palette.textSecondary)
                        Spacer()
                        Button(tr("Clear", "Effacer"), action: onClearNotices)
                            .buttonStyle(.plain).font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Palette.textSecondary).pointer()
                            .help(tr("Clear the notifications", "Effacer les notifications"))
                    }
                    .padding(.horizontal, 8)
                    ForEach(recent) { notice in
                        IslandNoticeRow(notice: notice) { onOpenNotice(notice) }
                    }
                }
                Rectangle().fill(Palette.ringTrack).frame(height: 1).padding(.horizontal, 8)
            }

            ForEach(approvals, id: \.approval.id) { item in
                IslandApprovalView(bot: item.bot, approval: item.approval, now: model.now) { allow in
                    onRespond(item.bot, item.approval, allow)
                }
            }

            // Tous les bots restent joignables : au-delà de la place disponible, la liste défile.
            ScrollView(.vertical) {
                VStack(spacing: 2) {
                    ForEach(rows) { row in
                        if let bot = model.bot(row.id) {
                            IslandRowView(row: row, bot: bot, now: model.now) { onOpenDialog(row.id) }
                        }
                    }
                }
            }
            .scrollIndicators(rows.count > rowLimit ? .visible : .hidden)
            .frame(height: Island.listHeight(rows: rows, limit: rowLimit))
            VStack(spacing: 2) {
                if rows.count > rowLimit {
                    Text(tr("\(rows.count) bots · scroll for more", "\(rows.count) bots · défile pour voir la suite"))
                        .font(.system(size: 11, weight: .medium)).foregroundStyle(Palette.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8)
                }
                if rows.isEmpty {
                    Text(tr("No bots yet.", "Aucun bot pour l'instant."))
                        .font(.system(size: 12)).foregroundStyle(Palette.textSecondary).padding(8)
                }
            }
        }
        .padding(.horizontal, ear + 12)
        .padding(.bottom, 12)
        .frame(width: NotchGeometry.islandWidth, alignment: .top)
        .background(IslandPanelShape().fill(Palette.notch).shadow(color: .black.opacity(0.45), radius: 16, y: 6))
    }
}

/// Une ligne de bot : avatar et état, ce qu'il fait, son dernier geste, depuis quand.
struct IslandRowView: View {
    let row: Island.Row
    let bot: Bot
    let now: Date
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            HStack(alignment: .center, spacing: 10) {
                AvatarView(bot: bot, size: 26)
                    .overlay(alignment: .bottomTrailing) {
                        // Le liseré reprend le fond de la ligne, survolée ou non, pour détacher le point sans le cerner.
                        Circle().fill(row.activity.dotColor).frame(width: 8, height: 8)
                            .overlay(Circle().stroke(Color(white: hovering ? 0.07 : 0), lineWidth: 2))
                    }
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.textPrimary).lineLimit(1)
                    Text(row.status).font(.system(size: 11.5))
                        .foregroundStyle(row.activity == .waiting ? Palette.waiting : Palette.textSecondary).lineLimit(1)
                    if let detail = row.detail {
                        Text("↳ \(detail)").font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Palette.textSecondary.opacity(0.8)).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if let since = row.since, row.activity == .working || row.activity == .waiting {
                    Text(ElapsedCopy.text(since: since, now: now))
                        .font(.system(size: 11, weight: .medium)).monospacedDigit().foregroundStyle(Palette.textSecondary)
                } else if row.activity == .success {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.ample)
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(white: hovering ? 0.07 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .pointer()
        .help(tr("Open \(bot.name)", "Ouvrir \(bot.name)"))
    }
}

/// Une demande d'accord dans l'île : l'outil, la commande, refuser ou autoriser une fois.
struct IslandApprovalView: View {
    let bot: Bot
    let approval: Approval
    let now: Date
    let respond: (Bool) -> Void

    var body: some View {
        let minutes = max(1, Int(approval.expiresAt.timeIntervalSince(now) / 60))
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(Palette.waiting)
                Text(tr("\(bot.name) asks: \(approval.tool)", "\(bot.name) demande : \(approval.tool)"))
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Palette.textPrimary).lineLimit(1)
                Spacer(minLength: 6)
                Text(tr("expires in \(minutes) min", "expire dans \(minutes) min"))
                    .font(.system(size: 11)).foregroundStyle(Palette.textSecondary).lineLimit(1)
            }
            Text(approval.command)
                .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Palette.textPrimary)
                .lineLimit(3)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.08)))
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                PillButton(title: tr("Deny", "Refuser"), tint: Palette.critical) { respond(false) }.frame(width: 110)
                PillButton(title: tr("Allow once", "Autoriser une fois"), tint: Palette.ample, prominent: true) { respond(true) }.frame(width: 150)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.waiting.opacity(0.35), lineWidth: 1))
    }
}

extension Notice.Kind {
    /// La couleur de l'icône : orange pour un accord, rouge pour une panne, vert pour une fin.
    var tint: Color {
        switch self {
        case .approval: Palette.waiting
        case .failed, .offline: Palette.critical
        case .message: Palette.textPrimary
        case .finished, .back: Palette.ample
        }
    }
}

/// Une notification dans le panneau : icône, titre, détail, heure, point si non lue.
struct IslandNoticeRow: View {
    let notice: Notice
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: notice.symbol).font(.system(size: 11, weight: .semibold)).foregroundStyle(notice.kind.tint)
                VStack(alignment: .leading, spacing: 1) {
                    Text(notice.title).font(.system(size: 12, weight: notice.read ? .medium : .semibold))
                        .foregroundStyle(notice.read ? Palette.textSecondary : Palette.textPrimary).lineLimit(1)
                    if !notice.text.isEmpty {
                        Text(notice.text).font(.system(size: 11)).foregroundStyle(Palette.textSecondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                Text(ThreadCopy.time(notice.at)).font(.system(size: 10.5)).monospacedDigit().foregroundStyle(Palette.textSecondary)
                Circle().fill(notice.read ? Color.clear : Palette.waiting).frame(width: 6, height: 6)
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(hovering ? 0.07 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .pointer()
    }
}

/// La bannière : elle descend de la caméra le temps de lire, puis remonte. Une demande d'accord
/// reste jusqu'à la réponse ; le récapitulatif d'une absence ouvre la liste.
struct IslandBannerView: View {
    let model: NotchModel
    let geometry: NotchGeometry
    let banner: Banner
    var onOpen: (Notice) -> Void
    var onLater: () -> Void
    var onShowAll: () -> Void
    var onRespond: (Bot, Approval, Bool) -> Void

    var body: some View {
        let g = geometry
        let ear = NotchGeometry.islandEar
        let inner = NotchGeometry.islandWidth - 2 * ear - 24
        let side = max(0, (inner - (g.restLength ?? 0)) / 2)
        let notice: Notice = switch banner { case .notice(let n): n; case .recap(_, let latest): latest }
        VStack(alignment: .leading, spacing: 10) {
            // La bande de la caméra : le bot à gauche, l'heure à droite.
            HStack(spacing: 0) {
                HStack(spacing: 6) {
                    if case .notice = banner, let bot = model.bot(notice.botID) { AvatarView(bot: bot, size: 18) }
                    Text(bannerOwner).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.textPrimary).lineLimit(1)
                }
                .frame(width: side, alignment: .leading)
                Color.clear.frame(width: g.restLength ?? 0)
                Text(ThreadCopy.time(notice.at)).font(.system(size: 11)).monospacedDigit().foregroundStyle(Palette.textSecondary)
                    .frame(width: side, alignment: .trailing)
            }
            .frame(height: g.inset)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: bannerSymbol).font(.system(size: 12, weight: .semibold)).foregroundStyle(bannerTint)
                VStack(alignment: .leading, spacing: 3) {
                    Text(bannerTitle).font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.textPrimary).lineLimit(2)
                    Text(bannerText).font(.system(size: 12)).foregroundStyle(Palette.textSecondary).lineLimit(3)
                }
            }
            .padding(.horizontal, 4)

            HStack(spacing: 8) {
                Spacer(minLength: 0)
                actions(notice)
            }
        }
        .padding(.horizontal, ear + 12)
        .padding(.bottom, 12)
        .frame(width: NotchGeometry.islandWidth, alignment: .top)
        .background(IslandPanelShape().fill(Palette.notch).shadow(color: .black.opacity(0.45), radius: 16, y: 6))
    }

    @ViewBuilder
    private func actions(_ notice: Notice) -> some View {
        switch banner {
        case .recap:
            PillButton(title: tr("Later", "Plus tard"), action: onLater).frame(width: 110)
            PillButton(title: tr("Show all", "Tout voir"), tint: Palette.textPrimary, prominent: true, action: onShowAll).frame(width: 130)
        case .notice(let n):
            if n.kind == .approval, let bot = model.bot(n.botID), let approval = bot.pending, approval.id == n.approvalID {
                PillButton(title: tr("Deny", "Refuser"), tint: Palette.critical) { onRespond(bot, approval, false) }.frame(width: 110)
                PillButton(title: tr("Allow once", "Autoriser une fois"), tint: Palette.ample, prominent: true) {
                    onRespond(bot, approval, true)
                }
                .frame(width: 150)
            } else {
                PillButton(title: tr("Later", "Plus tard"), action: onLater).frame(width: 110)
                PillButton(title: tr("Open", "Ouvrir"), tint: Palette.textPrimary, prominent: true) { onOpen(n) }.frame(width: 110)
            }
        }
    }

    private var bannerOwner: String {
        switch banner {
        case .notice(let n): n.botName
        case .recap: "openedbot"
        }
    }

    private var bannerSymbol: String {
        switch banner {
        case .notice(let n): n.symbol
        case .recap: "bell.badge.fill"
        }
    }

    private var bannerTint: Color {
        switch banner {
        case .notice(let n): n.kind.tint
        case .recap: Palette.waiting
        }
    }

    private var bannerTitle: String {
        switch banner {
        case .notice(let n): n.title
        case .recap(let count, _): tr("\(count) notifications while you were away", "\(count) notifications pendant ton absence")
        }
    }

    private var bannerText: String {
        switch banner {
        case .notice(let n): n.text
        case .recap(_, let latest): tr("Latest: \(latest.title)", "Dernière : \(latest.title)")
        }
    }
}
