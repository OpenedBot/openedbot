import SwiftUI

/// La flèche de la bulle, pointe vers l'anneau survolé.
struct TooltipTail: Shape {
    let direction: NotchEdge.TooltipDirection

    func path(in rect: CGRect) -> Path {
        let (tip, a, b, aShoulder, aTip, bTip, bShoulder): (CGPoint, CGPoint, CGPoint, CGPoint, CGPoint, CGPoint, CGPoint)
        switch direction {
        case .leading:
            tip = CGPoint(x: rect.maxX, y: rect.midY)
            (a, b) = (CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.minX, y: rect.maxY))
            aShoulder = CGPoint(x: rect.minX, y: rect.minY + rect.height * 0.25)
            aTip = CGPoint(x: rect.maxX - rect.width * 0.42, y: rect.midY - rect.height * 0.12)
            bTip = CGPoint(x: rect.maxX - rect.width * 0.42, y: rect.midY + rect.height * 0.12)
            bShoulder = CGPoint(x: rect.minX, y: rect.maxY - rect.height * 0.25)
        case .trailing:
            tip = CGPoint(x: rect.minX, y: rect.midY)
            (a, b) = (CGPoint(x: rect.maxX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.maxY))
            aShoulder = CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.25)
            aTip = CGPoint(x: rect.minX + rect.width * 0.42, y: rect.midY - rect.height * 0.12)
            bTip = CGPoint(x: rect.minX + rect.width * 0.42, y: rect.midY + rect.height * 0.12)
            bShoulder = CGPoint(x: rect.maxX, y: rect.maxY - rect.height * 0.25)
        case .down:
            tip = CGPoint(x: rect.midX, y: rect.minY)
            (a, b) = (CGPoint(x: rect.minX, y: rect.maxY), CGPoint(x: rect.maxX, y: rect.maxY))
            aShoulder = CGPoint(x: rect.minX + rect.width * 0.25, y: rect.maxY)
            aTip = CGPoint(x: rect.midX - rect.width * 0.12, y: rect.minY + rect.height * 0.42)
            bTip = CGPoint(x: rect.midX + rect.width * 0.12, y: rect.minY + rect.height * 0.42)
            bShoulder = CGPoint(x: rect.maxX - rect.width * 0.25, y: rect.maxY)
        case .up:
            tip = CGPoint(x: rect.midX, y: rect.maxY)
            (a, b) = (CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.minY))
            aShoulder = CGPoint(x: rect.minX + rect.width * 0.25, y: rect.minY)
            aTip = CGPoint(x: rect.midX - rect.width * 0.12, y: rect.maxY - rect.height * 0.42)
            bTip = CGPoint(x: rect.midX + rect.width * 0.12, y: rect.maxY - rect.height * 0.42)
            bShoulder = CGPoint(x: rect.maxX - rect.width * 0.25, y: rect.minY)
        }
        var path = Path()
        path.move(to: a)
        path.addCurve(to: tip, control1: aShoulder, control2: aTip)
        path.addCurve(to: b, control1: bTip, control2: bShoulder)
        path.closeSubpath()
        return path
    }

    static func size(for direction: NotchEdge.TooltipDirection, metrics: NotchMetrics) -> CGSize {
        switch direction {
        case .leading, .trailing: CGSize(width: metrics.tailLength, height: metrics.tailHeight)
        case .up, .down: CGSize(width: metrics.tailHeight, height: metrics.tailLength)
        }
    }
}

/// Libellé à gauche, valeur plus discrète à droite.
struct SplitRow<Accessory: View>: View {
    let leading: String
    let trailing: String
    var leadingColor: Color = Palette.textPrimary
    var trailingColor: Color = Palette.textSecondary
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        HStack(spacing: Design.px(20)) {
            Text(leading).foregroundStyle(leadingColor)
            Spacer(minLength: 0)
            HStack(spacing: Design.px(11)) {
                accessory()
                Text(trailing).foregroundStyle(trailingColor)
            }
        }
        .font(Typography.cardBody)
        .lineLimit(1)
    }
}

extension SplitRow where Accessory == EmptyView {
    init(leading: String, trailing: String, leadingColor: Color = Palette.textPrimary, trailingColor: Color = Palette.textSecondary) {
        self.init(leading: leading, trailing: trailing, leadingColor: leadingColor, trailingColor: trailingColor, accessory: { EmptyView() })
    }
}

private struct StatusRing: View {
    let status: RunStatus
    let color: Color
    let metrics: NotchMetrics

    var body: some View {
        Group {
            switch status {
            case .running:
                TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                    ring(trim: 0.75).rotationEffect(.degrees((context.date.timeIntervalSinceReferenceDate / 1.4).truncatingRemainder(dividingBy: 1) * 360))
                }
            case .awaitingApproval: ring(trim: 0.5)
            case .queued: ring(trim: 0.25)
            case .completed, .failed: ring(trim: 1)
            }
        }
        .frame(width: metrics.statusDot, height: metrics.statusDot)
    }

    private func ring(trim: CGFloat) -> some View {
        Circle().trim(from: 0, to: trim)
            .stroke(color, style: StrokeStyle(lineWidth: metrics.statusDotStroke, lineCap: .round))
            .rotationEffect(.degrees(-90))
    }
}

private func statusColor(_ s: RunStatus) -> Color {
    switch s {
    case .running: Palette.textPrimary
    case .awaitingApproval: Palette.waiting
    case .completed: Palette.ample
    case .failed: Palette.critical
    case .queued: Palette.textSecondary
    }
}

/// La carte au survol : bot, runtime, routine, runs, approbation.
struct BotCard: View {
    let bot: Bot
    let now: Date
    let direction: NotchEdge.TooltipDirection
    var tailOffset: CGFloat = 0
    let metrics: NotchMetrics
    let respond: (UUID, Bool) -> Void

    var body: some View {
        TooltipFrame(direction: direction, tailOffset: tailOffset, metrics: metrics) { card }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: metrics.headerGap) {
                AvatarView(bot: bot, size: 24)
                VStack(alignment: .leading, spacing: 0) {
                    Text(bot.activeRun?.title ?? bot.name)
                        .font(Typography.cardTitle).foregroundStyle(Palette.textPrimary).lineLimit(1)
                    Text(bot.subtitle).font(Typography.cardBody).foregroundStyle(Palette.textSecondary).lineLimit(1)
                }
            }
            .padding(.bottom, metrics.headerToBlock)

            SplitRow(leading: "Runtime \(bot.runtime.name)",
                     trailing: bot.runtime.connected
                        ? tr("connected · seen \(ElapsedCopy.text(since: bot.runtime.lastSeenAt, now: now)) ago", "connecté · vu il y a \(ElapsedCopy.text(since: bot.runtime.lastSeenAt, now: now))")
                        : tr("offline for \(ElapsedCopy.text(since: bot.runtime.downSince ?? now, now: now))", "hors ligne depuis \(ElapsedCopy.text(since: bot.runtime.downSince ?? now, now: now))"),
                     trailingColor: bot.runtime.connected ? Palette.textSecondary : Palette.critical)
            if bot.runtime.outdated, let latest = bot.runtime.latestVersion {
                SplitRow(leading: tr("Connector \(bot.runtime.connectorVersion)", "Connecteur \(bot.runtime.connectorVersion)"), trailing: tr("\(latest) available", "\(latest) disponible"), leadingColor: Palette.textSecondary)
                    .padding(.top, metrics.sessionRowGap)
            }
            if let routine = bot.routine {
                SplitRow(leading: "Routine · \(routine.name)", trailing: routine.next, leadingColor: Palette.textSecondary)
                    .padding(.top, metrics.sessionRowGap)
            }

            if !bot.runs.isEmpty {
                Rectangle().fill(Palette.ringTrack).frame(height: metrics.hairline).padding(.top, metrics.blockSpacing)
                ForEach(bot.runs.prefix(4)) { run in
                    VStack(alignment: .leading, spacing: 0) {
                        SplitRow(leading: run.name, trailing: run.status.word, trailingColor: statusColor(run.status)) {
                            StatusRing(status: run.status, color: statusColor(run.status), metrics: metrics)
                        }
                        SplitRow(leading: run.detail,
                                 trailing: "\(run.isLive ? run.stepText + " · " : "")\(ElapsedCopy.text(since: run.since, now: now))",
                                 leadingColor: Palette.textSecondary)
                            .padding(.top, metrics.sessionRowGap)
                    }
                    .padding(.top, metrics.blockSpacing)
                }
            }

            if let approval = bot.pending {
                Rectangle().fill(Palette.ringTrack).frame(height: metrics.hairline).padding(.top, metrics.blockSpacing)
                SplitRow(leading: approval.tool, trailing: tr("expires in \(max(1, Int(approval.expiresAt.timeIntervalSince(now) / 60))) min", "expire dans \(max(1, Int(approval.expiresAt.timeIntervalSince(now) / 60))) min"))
                    .padding(.top, metrics.blockSpacing)
                Text(approval.command)
                    .font(.system(size: Design.fontSize(capPixels: 17), design: .monospaced))
                    .foregroundStyle(Palette.textPrimary)
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 7).fill(.white.opacity(0.08)))
                    .padding(.top, metrics.sessionRowGap)
                HStack(spacing: 6) {
                    PillButton(title: tr("Deny", "Refuser"), tint: Palette.critical) { respond(approval.id, false) }
                    PillButton(title: tr("Allow once", "Autoriser une fois"), tint: Palette.ample, prominent: true) { respond(approval.id, true) }
                }
                .padding(.top, metrics.blockSpacing)
            }
        }
        .padding(metrics.cardPadding)
        .frame(width: metrics.cardWidth, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: metrics.cardCorner, style: .circular).fill(Palette.card))
    }
}

struct PillButton: View {
    let title: String
    var tint: Color = .white
    var prominent = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(prominent ? .black : tint)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(Capsule().fill(prominent ? tint : tint.opacity(0.12)))
                .overlay(Capsule().stroke(tint.opacity(prominent ? 0 : 0.4), lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .pointer()
    }
}

/// Le plateau d'une pile : une ligne par bot, clic → sa fenêtre.
struct TrayView: View {
    let title: String
    let members: [Bot]
    let metrics: NotchMetrics
    let open: (String) -> Void
    @State private var hovered: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.system(size: 8.5, weight: .semibold)).tracking(0.8)
                .foregroundStyle(Palette.textSecondary)
                .padding(.bottom, 2)
            ForEach(members) { bot in
                HStack(spacing: 8) {
                    ZStack {
                        RingShapeView(progress: bot.progress, color: bot.activity.color, dashed: bot.activity == .offline, metrics: NotchMetrics(scale: 0.8))
                        AvatarView(bot: bot, size: 15)
                    }
                    .frame(width: 24, height: 24)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(bot.name).font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.textPrimary)
                        Text(bot.activity.word).font(.system(size: 9)).foregroundStyle(bot.activity == .idle ? Palette.textSecondary : bot.activity.color)
                    }
                    Spacer(minLength: 8)
                    if let run = bot.activeRun {
                        Text(run.stepText).font(.system(size: 10).monospacedDigit()).foregroundStyle(Color(white: 0.85))
                    }
                }
                .padding(.horizontal, 6).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(hovered == bot.id ? 0.1 : 0)))
                .contentShape(RoundedRectangle(cornerRadius: 8))
                .pointer { inside in
                    if inside { hovered = bot.id } else if hovered == bot.id { hovered = nil }
                }
                .onTapGesture { open(bot.id) }
            }
        }
        .padding(10)
        .frame(width: 170, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.card))
    }
}
