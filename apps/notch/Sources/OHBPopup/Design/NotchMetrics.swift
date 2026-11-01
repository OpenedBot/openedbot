import Foundation

/// Les mesures du design, multipliées par la taille choisie dans les réglages.
/// Tout ce qui touche l'écran passe par ici : la vue et le hit-test lisent les mêmes nombres.
struct NotchMetrics: Equatable, Sendable {
    /// Taille choisie dans les réglages (1 = moyenne).
    var scale: CGFloat = 1
    /// Notch layout metrics : le corps de l'encoche est réduit, anneau de 32 pt au lieu de 44.
    static let bodyFactor: CGFloat = 32.0 / 44.0

    /// Mesure du corps : suit la taille choisie.
    private func px(_ pixels: CGFloat) -> CGFloat { Design.px(pixels) * scale * Self.bodyFactor }
    /// Mesure de la carte : du texte, qui ne rétrécit pas avec l'encoche.
    private func cpx(_ pixels: CGFloat) -> CGFloat { Design.px(pixels) }

    // Anneau et cellule
    var ring: CGFloat { px(117) }                 // 44 pt
    var trackStroke: CGFloat { px(15.5) }
    var progressStroke: CGFloat { px(8) }
    var glyph: CGFloat { px(46) }
    var ringLabelGap: CGFloat { px(26.9) }
    /// La ligne du nom sous l'anneau.
    var percentLineHeight: CGFloat { px(32) }
    var cellExtent: CGFloat { ring + ringLabelGap + percentLineHeight }
    var cellSpacing: CGFloat { px(83.5) }
    var activityDiameter: CGFloat { px(72) }
    var activityStroke: CGFloat { px(5.5) }

    // Corps
    var sideDepth: CGFloat { px(186) }            // 70 pt
    var ringMargin: CGFloat { (sideDepth - ring) / 2 }
    var curl: CGFloat { px(103) }                 // la courbe inverse qui rejoint le bord
    var corner: CGFloat { px(78.8) }
    var padTop: CGFloat { px(69.5) }
    var padBottom: CGFloat { px(50.1) }

    // Pastille au repos
    var pillWidth: CGFloat { px(26) }
    var pillLength: CGFloat { px(210) }
    var pillHotZone: CGFloat { px(90) }

    // Orbe des réglages
    var orbDiameter: CGFloat { px(124) }
    var orbStroke: CGFloat { px(18) }
    var orbGap: CGFloat { px(27) }
    var orbGlyph: CGFloat { px(56) }

    // Carte
    var cardWidth: CGFloat { cpx(600) }
    var cardCorner: CGFloat { cpx(49.5) }
    var cardPadding: CGFloat { cpx(32) }
    var tailLength: CGFloat { cpx(75) }
    var tailHeight: CGFloat { cpx(87) }
    var tailGap: CGFloat { cpx(28) }
    var barHeight: CGFloat { cpx(10.5) }
    var headerGap: CGFloat { cpx(17) }
    var headerToBlock: CGFloat { cpx(21) }
    var labelToBar: CGFloat { cpx(16.8) }
    var barToUsed: CGFloat { cpx(17.8) }
    var blockSpacing: CGFloat { cpx(20) }
    var sessionRowGap: CGFloat { cpx(10) }
    var statusDot: CGFloat { cpx(17) }
    var statusDotStroke: CGFloat { cpx(3.4) }
    var hairline: CGFloat { cpx(2.5) }
    /// Hauteur maximale réservée à la carte dans le panneau.
    var cardMaxExtent: CGFloat { cpx(1000) }

    /// Profondeur du corps depuis le bord. Sur un bord horizontal le pourcentage passe
    /// sous l'anneau dans la profondeur, donc la barre est plus épaisse.
    func depth(for edge: NotchEdge) -> CGFloat {
        edge.isVertical ? sideDepth : 2 * ringMargin + cellExtent
    }

    /// Longueur d'une cellule le long du bord.
    func cellLength(for edge: NotchEdge) -> CGFloat {
        edge.isVertical ? cellExtent : ring
    }

    func bodyLength(cells: Int, edge: NotchEdge) -> CGFloat {
        let n = max(cells, 1)
        return padTop + CGFloat(n) * cellLength(for: edge) + CGFloat(n - 1) * cellSpacing + padBottom
    }

    /// Corps plus les deux courbes inverses.
    func shapeLength(cells: Int, edge: NotchEdge) -> CGFloat {
        bodyLength(cells: cells, edge: edge) + 2 * curl
    }

    /// Étendue d'une cellule le long de la forme (origine : début de la forme, courbe comprise).
    func cellRange(index: Int, edge: NotchEdge) -> ClosedRange<CGFloat> {
        let start = curl + padTop + CGFloat(index) * (cellLength(for: edge) + cellSpacing)
        return start...(start + cellLength(for: edge))
    }

    /// Centre de l'anneau d'une cellule, le long de la forme.
    func ringCenterAlong(index: Int, edge: NotchEdge) -> CGFloat {
        cellRange(index: index, edge: edge).lowerBound + ring / 2
    }

    /// Centre de l'anneau, en profondeur depuis le bord.
    func ringCenterAcross(edge: NotchEdge) -> CGFloat {
        edge.isVertical ? sideDepth / 2 : ringMargin + ring / 2
    }
}
