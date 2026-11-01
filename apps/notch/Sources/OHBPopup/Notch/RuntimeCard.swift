import SwiftUI

extension Liveness {
    var color: Color {
        switch self {
        case .alive: Palette.ample
        case .degraded: Palette.waiting
        case .down: Palette.critical
        case .unknown: Surface.textTertiary
        }
    }
}

/// Le point « en vie » : plein, et un halo qui respire tant que tout est en direct.
struct LivenessDot: View {
    let liveness: Liveness
    var size: CGFloat = 8
    /// Faux quand l'encoche est repliée : pas d'animation qu'on ne voit pas.
    var animating = true

    var body: some View {
        ZStack {
            if liveness == .alive, animating {
                TimelineView(.animation(minimumInterval: 1 / 15)) { context in
                    let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.8) / 1.8
                    Circle().fill(liveness.color)
                        .frame(width: size, height: size)
                        .scaleEffect(1 + 1.4 * t)
                        .opacity(0.55 * (1 - t))
                }
            }
            Circle().fill(liveness.color).frame(width: size, height: size)
        }
        .frame(width: size * 2.6, height: size * 2.6)
        .accessibilityLabel(liveness.word)
    }
}

extension Liveness {
    var word: String {
        switch self {
        case .alive: tr("live", "en direct")
        case .degraded: tr("connecting", "connexion en cours")
        case .down: tr("down", "hors service")
        case .unknown: tr("unknown state", "état inconnu")
        }
    }
}

/// Une bulle avec sa flèche vers l'ancre : la même que la carte d'un bot.
struct TooltipFrame<Content: View>: View {
    let direction: NotchEdge.TooltipDirection
    var tailOffset: CGFloat = 0
    let metrics: NotchMetrics
    @ViewBuilder let content: Content

    var body: some View {
        let tail = TooltipTail.size(for: direction, metrics: metrics)
        switch direction {
        case .leading: HStack(spacing: 0) { content; tailView(tail) }
        case .trailing: HStack(spacing: 0) { tailView(tail); content }
        case .down: VStack(spacing: 0) { tailView(tail); content }
        case .up: VStack(spacing: 0) { content; tailView(tail) }
        }
    }

    private func tailView(_ size: CGSize) -> some View {
        let alongCard = direction == .leading || direction == .trailing
        let limit = max(0, (alongCard ? metrics.cardMaxExtent : metrics.cardWidth) / 2 - metrics.cardCorner - (alongCard ? size.height : size.width) / 2)
        let offset = min(max(tailOffset, -limit), limit)
        return TooltipTail(direction: direction).fill(Palette.card)
            .frame(width: size.width, height: size.height)
            .offset(x: alongCard ? 0 : offset, y: alongCard ? offset : 0)
    }
}

/// La carte de l'orbe : le runtime et le flux en vie, et les dernières lignes du journal qui défilent.
struct RuntimeCard: View {
    let runtime: RuntimeStatus?
    let feedState: NotchModel.FeedState?
    let journal: Journal
    let now: Date
    let direction: NotchEdge.TooltipDirection
    var tailOffset: CGFloat = 0
    let metrics: NotchMetrics
    var animating = true

    private var liveness: Liveness { .of(feed: feedState, runtime: runtime) }

    var body: some View {
        TooltipFrame(direction: direction, tailOffset: tailOffset, metrics: metrics) { card }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: metrics.headerGap) {
                LivenessDot(liveness: liveness, size: 9, animating: animating)
                VStack(alignment: .leading, spacing: 0) {
                    Text(runtime.map { "Runtime \($0.name)" } ?? "Runtime")
                        .font(Typography.cardTitle).foregroundStyle(Palette.textPrimary).lineLimit(1)
                    Text(subtitle).font(Typography.cardBody).foregroundStyle(liveness == .down ? Palette.critical : Palette.textSecondary)
                        .lineLimit(1)
                }
            }
            .padding(.bottom, metrics.headerToBlock)

            SplitRow(leading: tr("openedbot feed", "Flux openedbot"), trailing: feedText, trailingColor: feedColor)
            if let runtime {
                if let version = runtime.version {
                    SplitRow(leading: tr("Connector \(version)", "Connecteur \(version)"),
                             trailing: runtime.outdated ? tr("\(runtime.latestVersion ?? "") available", "\(runtime.latestVersion ?? "") disponible") : tr("up to date", "à jour"),
                             leadingColor: Palette.textSecondary,
                             trailingColor: runtime.outdated ? Palette.waiting : Palette.textSecondary)
                        .padding(.top, metrics.sessionRowGap)
                }
                if let health = runtime.health {
                    SplitRow(leading: tr("Health", "Santé"), trailing: health, leadingColor: Palette.textSecondary,
                             trailingColor: health == "healthy" ? Palette.textSecondary : Palette.waiting)
                        .padding(.top, metrics.sessionRowGap)
                }
                if let model = runtime.model {
                    SplitRow(leading: tr("Model", "Modèle"), trailing: model, leadingColor: Palette.textSecondary)
                        .padding(.top, metrics.sessionRowGap)
                }
            }

            let recent = Array(journal.entries.suffix(5))
            if !recent.isEmpty {
                Rectangle().fill(Palette.ringTrack).frame(height: metrics.hairline).padding(.top, metrics.blockSpacing)
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(recent) { entry in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(ElapsedCopy.text(since: entry.at, now: now))
                                .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(Palette.textSecondary)
                                .frame(width: 38, alignment: .leading)
                            Text(entry.count > 1 ? "\(entry.text) ×\(entry.count)" : entry.text)
                                .font(.system(size: 10.5)).foregroundStyle(color(entry.level))
                                .lineLimit(2).truncationMode(.tail)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .transition(.opacity)
                    }
                }
                .padding(.top, metrics.blockSpacing)
                .animation(.easeOut(duration: 0.2), value: journal.entries.last?.id)
            }
        }
        .padding(metrics.cardPadding)
        .frame(width: metrics.cardWidth, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: metrics.cardCorner, style: .circular).fill(Palette.card))
    }

    private var subtitle: String {
        guard let runtime else { return liveness.word }
        if !runtime.connected { return tr("offline", "hors ligne") }
        if let seen = runtime.lastSeenAt { return tr("online · seen \(ElapsedCopy.text(since: seen, now: now)) ago", "en ligne · vu il y a \(ElapsedCopy.text(since: seen, now: now))") }
        return tr("online", "en ligne")
    }

    private var feedText: String {
        switch feedState {
        case nil: tr("demo", "démo")
        case .connecting: tr("connecting…", "connexion…")
        case .live: tr("live", "en direct")
        case .retrying: tr("reconnecting…", "reconnexion…")
        case .failed(let why): tr("stopped · \(why)", "arrêté · \(why)")
        }
    }

    private var feedColor: Color {
        switch feedState {
        case .live, nil: Palette.textSecondary
        case .connecting, .retrying: Palette.waiting
        case .failed: Palette.critical
        }
    }

    private func color(_ level: JournalEntry.Level) -> Color {
        switch level {
        case .info: Palette.textPrimary.opacity(0.85)
        case .warning: Palette.waiting
        case .error: Palette.critical
        }
    }
}
