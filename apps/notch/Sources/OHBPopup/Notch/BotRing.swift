import SwiftUI

/// L'anneau d'un bot : piste, arc d'avancement du run dans la couleur de l'état, avatar au
/// centre, arc intérieur qui tourne pendant le travail, badge d'inbox. Le nom dessous.
struct BotCell: View {
    let bot: Bot
    let metrics: NotchMetrics
    /// Faux quand l'encoche est repliée : l'arc ne tourne pas pour personne.
    var animating = true

    var body: some View {
        VStack(spacing: metrics.ringLabelGap) {
            ZStack {
                RingShapeView(progress: bot.progress, color: bot.activity.color, dashed: bot.activity == .offline, metrics: metrics)
                    .opacity(bot.activity == .offline ? 0.55 : 1)
                AvatarView(bot: bot, size: metrics.ring * 0.62)
                    .opacity(bot.activity == .offline ? 0.5 : 1)
                // Pas d'arc du tout quand l'encoche est repliée : même en pause, un TimelineView
                // garde le display link actif et l'app rend à 120 Hz pour une vue invisible.
                if animating, bot.activity == .working || bot.activity == .waiting {
                    ActivityArc(activity: bot.activity, metrics: metrics)
                }
                if bot.isAlert {
                    Badge(text: "\(max(1, bot.inboxCount))")
                        .offset(x: metrics.ring * 0.38, y: -metrics.ring * 0.38)
                }
            }
            .frame(width: metrics.ring, height: metrics.ring)
            NameLabel(text: bot.name, metrics: metrics)
        }
        .frame(width: metrics.ring + 10, height: metrics.cellExtent)
        .contentShape(Rectangle())
    }
}

/// Une section repliée : avatars empilés, le pire avancement, l'état le plus pressant,
/// le badge cumulé et le nombre de bots.
struct PileCell: View {
    let section: BotSection
    let members: [Bot]
    let metrics: NotchMetrics
    var animating = true

    private var activity: BotActivity {
        if members.contains(where: { $0.activity == .waiting }) { return .waiting }
        if members.contains(where: { $0.activity == .working }) { return .working }
        if members.contains(where: { $0.activity == .offline }) { return .offline }
        if members.contains(where: { $0.activity == .success }) { return .success }
        return .idle
    }

    var body: some View {
        let alerts = members.reduce(0) { $0 + ($1.isAlert ? max(1, $1.inboxCount) : 0) }
        VStack(spacing: metrics.ringLabelGap) {
            ZStack {
                RingShapeView(progress: members.map(\.progress).max() ?? 0, color: activity.color,
                              dashed: activity == .offline, metrics: metrics)
                ZStack {
                    ForEach(Array(members.prefix(3).enumerated()), id: \.element.id) { i, b in
                        AvatarView(bot: b, size: metrics.ring * 0.42)
                            .background(Circle().fill(Color(white: 0.11)))
                            .overlay(Circle().stroke(.black, lineWidth: 1))
                            .offset(x: [-4, 3, -1][i] * metrics.ring / 32, y: [-4, 1, 5][i] * metrics.ring / 32)
                    }
                }
                if animating, activity == .working || activity == .waiting {
                    ActivityArc(activity: activity, metrics: metrics)
                }
                if alerts > 0 {
                    Badge(text: "\(alerts)").offset(x: metrics.ring * 0.38, y: -metrics.ring * 0.38)
                }
                Text("\(members.count)")
                    .font(.system(size: 7.5 * metrics.scale, weight: .bold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 3).frame(minWidth: 12, minHeight: 12)
                    .background(Capsule().fill(.white))
                    .offset(x: metrics.ring * 0.4, y: metrics.ring * 0.4)
            }
            .frame(width: metrics.ring, height: metrics.ring)
            NameLabel(text: section.name.uppercased(), metrics: metrics, tracking: 0.6)
        }
        .frame(width: metrics.ring + 10, height: metrics.cellExtent)
        .contentShape(Rectangle())
    }
}

/// « +N » : les bots inactifs, derrière un cercle en pointillés.
struct MoreCell: View {
    let count: Int
    let metrics: NotchMetrics

    var body: some View {
        VStack(spacing: metrics.ringLabelGap) {
            Circle()
                .stroke(Palette.ringTrack, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                .frame(width: metrics.ring, height: metrics.ring)
                .overlay(Text("+\(count)").font(.system(size: 10 * metrics.scale, weight: .semibold)).foregroundStyle(Color(white: 0.8)))
            NameLabel(text: tr("INACTIVE", "INACTIFS"), metrics: metrics, tracking: 0.6)
        }
        .frame(width: metrics.ring + 10, height: metrics.cellExtent)
        .contentShape(Rectangle())
    }
}

struct RingShapeView: View {
    let progress: Double
    let color: Color
    var dashed = false
    let metrics: NotchMetrics

    var body: some View {
        ZStack {
            Circle().strokeBorder(Palette.ringTrack, lineWidth: metrics.trackStroke)
            Circle()
                .inset(by: metrics.trackStroke / 2)
                .trim(from: 0, to: CGFloat(min(max(progress, 0), 1)))
                .stroke(color, style: StrokeStyle(lineWidth: metrics.progressStroke, lineCap: .round,
                                                  dash: dashed ? [3, 4] : []))
                .rotationEffect(.degrees(-90))
                .animation(.spring(response: 0.5, dampingFraction: 0.85), value: progress)
        }
    }
}

/// L'arc intérieur : un quart de cercle qui tourne, ou un anneau ambre qui pulse.
struct ActivityArc: View {
    let activity: BotActivity
    let metrics: NotchMetrics

    var body: some View {
        let inset = (metrics.ring - metrics.activityDiameter) / 2 - 1
        // 30 images/s suffisent à un arc de 20 pt ; à 120 Hz l'app rend quatre fois plus pour rien.
        TimelineView(.animation(minimumInterval: 1 / 30)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            if activity == .working {
                Circle().inset(by: inset).trim(from: 0, to: 0.25)
                    .stroke(.white, style: StrokeStyle(lineWidth: metrics.activityStroke, lineCap: .round))
                    .rotationEffect(.degrees(t.truncatingRemainder(dividingBy: 1.1) / 1.1 * 360))
            } else {
                Circle().inset(by: inset)
                    .stroke(Palette.waiting, lineWidth: metrics.activityStroke)
                    .opacity(0.3 + 0.7 * (sin(t * 3.5) + 1) / 2)
            }
        }
    }
}

struct Badge: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 8.5, weight: .bold))
            .foregroundStyle(.black)
            .padding(.horizontal, 3).frame(minWidth: 13, minHeight: 13)
            .background(Capsule().fill(Palette.waiting))
    }
}

struct NameLabel: View {
    let text: String
    let metrics: NotchMetrics
    var tracking: CGFloat = 0
    var body: some View {
        Text(text)
            .font(.system(size: 8.5 * metrics.scale, weight: .semibold))
            .tracking(tracking)
            .foregroundStyle(Color(white: 0.82))
            .lineLimit(1)
            .frame(width: metrics.ring + 14, height: metrics.percentLineHeight)
    }
}
