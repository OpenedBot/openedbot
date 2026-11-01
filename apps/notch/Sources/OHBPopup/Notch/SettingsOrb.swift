import SwiftUI

/// L'orbe sous l'encoche : la roue crantée, discrète au repos, pleine au survol, un tour par clic.
struct SettingsOrb: View {
    let hovering: Bool
    let spins: Int
    let metrics: NotchMetrics
    /// Le témoin du runtime et du flux, en haut de l'orbe ; survoler l'orbe ouvre sa carte.
    var liveness: Liveness = .unknown
    var animating = true

    var body: some View {
        ZStack {
            Circle().fill(Palette.notch)
            Image(systemName: "gearshape.fill")
                .font(.system(size: metrics.orbGlyph * 1.15, weight: .semibold))
                .foregroundStyle(Palette.textPrimary.opacity(hovering ? 1 : 0.72))
                .rotationEffect(.degrees(Double(spins) * 360))
                .animation(.timingCurve(0.32, 0, 0.14, 1, duration: 0.9), value: spins)
                .accessibilityLabel(tr("Settings", "Réglages"))
        }
        .frame(width: metrics.orbDiameter, height: metrics.orbDiameter)
        .overlay(alignment: .topTrailing) {
            if liveness != .unknown {
                let dot = max(6, metrics.orbDiameter * 0.2)
                LivenessDot(liveness: liveness, size: dot, animating: animating)
                    .background(Circle().fill(Palette.notch).frame(width: dot + 3, height: dot + 3))
                    .offset(x: dot * 0.55, y: -dot * 0.55)
                    .allowsHitTesting(false)
            }
        }
        .animation(.easeOut(duration: 0.18), value: hovering)
    }
}
