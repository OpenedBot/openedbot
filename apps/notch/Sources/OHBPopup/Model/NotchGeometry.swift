import Foundation

/// Le panneau et tout ce qu'il contient, raisonnés en **espace de pile** : `along` court le
/// long du bord, `across` s'en éloigne. Seul `point(along:across:)` retombe en coordonnées
/// réelles, ce qui évite d'écrire quatre géométries.
struct NotchGeometry: Equatable, Sendable {
    let edge: NotchEdge
    let metrics: NotchMetrics
    let cellCount: Int
    /// Cadre de l'écran en coordonnées AppKit.
    let screen: CGRect
    /// Décalage choisi par l'utilisateur le long du bord (positif = vers le bas / la droite).
    let alongOffset: CGFloat
    /// Bande du bord où rien ne s'affiche : l'encoche de la caméra pour l'île. Le corps la
    /// recouvre (noir sur noir), les anneaux et l'orbe commencent au-delà.
    var inset: CGFloat = 0
    /// Île : la largeur de l'encoche de la caméra. Au repos, la forme l'épouse exactement.
    var restLength: CGFloat?
    /// Île : le corps déplié est toujours plus large que la caméra, cellules centrées.
    var minBodyLength: CGFloat = 0
    /// Où le panneau s'accroche le long du bord : au milieu, ou au bout (à droite, à côté du Dock).
    var anchor: AlongAnchor = .center

    enum AlongAnchor: Equatable, Sendable { case center, end }

    var isIsland: Bool { restLength != nil }
    /// L'île reste sur la caméra : pas de glissement le long du bord.
    var isDraggable: Bool { !isIsland }

    /// Où vit le panneau pour une position donnée.
    struct Placement: Equatable, Sendable {
        var screen: CGRect
        var inset: CGFloat = 0
        var restLength: CGFloat?
        var minBodyLength: CGFloat = 0
        var anchor: AlongAnchor = .center
    }

    /// Largeur d'une aile de l'île (avatar à gauche, état à droite de la caméra).
    static func islandWing(cameraHeight: CGFloat) -> CGFloat { cameraHeight + 10 }

    /// Le panneau déplié de l'île : largeur, hauteur maximale, oreilles qui rejoignent le haut de l'écran.
    static let islandWidth: CGFloat = 480
    static let islandMaxHeight: CGFloat = 560
    static let islandEar: CGFloat = 12
    /// Marge du panneau autour de l'île, pour son ombre.
    static let islandPad: CGFloat = 28

    /// - Droite : l'écran entier, centré sur le bord.
    /// - Dock : soudée au bas de l'écran, au bout droit, à côté du Dock : jamais sur ses icônes ni
    ///   sur leurs bulles (macOS ne donne pas la largeur du Dock sans permission d'accessibilité).
    /// - Île : sur l'encoche de la caméra (`camera`, en coordonnées d'écran). Sans encoche (écran
    ///   externe), une encoche virtuelle de 180 pt de la hauteur de la barre des menus.
    static func placement(edge: NotchEdge, screenFrame: CGRect, visibleFrame: CGRect, camera: CGRect?) -> Placement {
        switch edge {
        case .right:
            return Placement(screen: screenFrame)
        case .bottom:
            return Placement(screen: screenFrame, anchor: .end)
        case .top:
            let menuBar = max(0, screenFrame.maxY - visibleFrame.maxY)
            let cam = camera ?? CGRect(x: screenFrame.midX - 90, y: screenFrame.maxY - menuBar, width: 180, height: menuBar)
            let height = max(cam.height, 1)
            return Placement(screen: CGRect(x: cam.midX - screenFrame.width / 2, y: screenFrame.minY,
                                            width: screenFrame.width, height: screenFrame.height),
                             inset: height, restLength: cam.width,
                             minBodyLength: cam.width + 2 * islandWing(cameraHeight: height))
        }
    }

    // MARK: Dimensions

    /// Profondeur du corps visible, sans la bande du bord.
    var bodyDepth: CGFloat { metrics.depth(for: edge) }
    var depth: CGFloat { inset + bodyDepth }
    /// Le corps : la longueur naturelle des cellules, ou plus large que la caméra pour l'île.
    var bodyLength: CGFloat { max(metrics.bodyLength(cells: cellCount, edge: edge), minBodyLength) }
    var shapeLength: CGFloat { bodyLength + 2 * metrics.curl }
    /// Décalage des cellules quand le corps est élargi (île) : leur rangée est centrée dans le corps,
    /// donc sous la caméra, malgré des marges d'entrée et de sortie inégales.
    var cellShift: CGFloat {
        guard minBodyLength > 0 else { return 0 }
        let n = CGFloat(max(cellCount, 1))
        let span = n * metrics.cellLength(for: edge) + (n - 1) * metrics.cellSpacing
        return (bodyLength - span) / 2 - metrics.padTop
    }

    /// Place laissée à la carte au-delà du corps.
    var cardSpace: CGFloat {
        let cardAcross = edge.isVertical ? metrics.cardWidth : metrics.cardMaxExtent
        return metrics.tailGap + metrics.tailLength + cardAcross + 24
    }
    /// Marge le long du bord, pour une carte plus longue que l'encoche et pour l'orbe.
    var margin: CGFloat { edge.isVertical ? metrics.cardMaxExtent / 2 : metrics.cardWidth / 2 }

    var acrossTotal: CGFloat { depth + cardSpace }
    var alongTotal: CGFloat { shapeLength + metrics.orbGap + metrics.orbDiameter + 2 * margin }
    /// Où commence la forme (sa première courbe) le long du panneau.
    var shapeStart: CGFloat { margin }

    /// Taille du panneau en points.
    var panelSize: CGSize {
        if isIsland {
            return CGSize(width: Self.islandWidth + 2 * Self.islandPad, height: inset + Self.islandMaxHeight + Self.islandPad)
        }
        return edge.isVertical ? CGSize(width: acrossTotal, height: alongTotal)
                        : CGSize(width: alongTotal, height: acrossTotal)
    }

    /// Cadre du panneau en coordonnées AppKit (origine en bas à gauche).
    var panelFrame: CGRect {
        let size = panelSize
        let offset = min(max(alongOffset, alongOffsetRange.lowerBound), alongOffsetRange.upperBound)
        switch edge {
        case .right:
            return CGRect(x: screen.maxX - size.width, y: screen.midY - size.height / 2 - offset,
                          width: size.width, height: size.height)
        case .top:
            // L'île est centrée sur la caméra ; son panneau aussi (ni orbe ni cellules sur le côté).
            let x = screen.midX - size.width / 2
            return CGRect(x: x + offset, y: screen.maxY - size.height, width: size.width, height: size.height)
        case .bottom:
            let x = anchor == .end ? screen.maxX - size.width : screen.midX - size.width / 2
            return CGRect(x: x + offset, y: screen.minY, width: size.width, height: size.height)
        }
    }

    /// Jusqu'où l'⌥-glisser peut emmener le panneau sans qu'il quitte l'écran.
    var alongOffsetRange: ClosedRange<CGFloat> {
        guard isDraggable else { return 0...0 }
        let span = edge.isVertical ? screen.height : screen.width
        let size = edge.isVertical ? panelSize.height : panelSize.width
        switch anchor {
        case .end: return -max(0, span - size)...0
        case .center:
            let limit = max(0, span / 2 - shapeLength / 2)
            return -limit...limit
        }
    }

    // MARK: Correspondance espace de pile ↔ panneau (SwiftUI, y vers le bas)

    func point(along: CGFloat, across: CGFloat) -> CGPoint {
        let size = panelSize
        switch edge {
        case .right: return CGPoint(x: size.width - across, y: along)
        case .top: return CGPoint(x: along, y: across)
        case .bottom: return CGPoint(x: along, y: size.height - across)
        }
    }

    func stack(from p: CGPoint) -> (along: CGFloat, across: CGFloat) {
        let size = panelSize
        switch edge {
        case .right: return (p.y, size.width - p.x)
        case .top: return (p.x, p.y)
        case .bottom: return (p.x, size.height - p.y)
        }
    }

    /// Un rect de pile → rect du panneau.
    func rect(along: ClosedRange<CGFloat>, across: ClosedRange<CGFloat>) -> CGRect {
        let a = point(along: along.lowerBound, across: across.lowerBound)
        let b = point(along: along.upperBound, across: across.upperBound)
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }

    // MARK: Régions

    var shapeRange: ClosedRange<CGFloat> { shapeStart...(shapeStart + shapeLength) }
    var bodyRange: ClosedRange<CGFloat> { (shapeStart + metrics.curl)...(shapeStart + metrics.curl + bodyLength) }

    /// La pastille au repos, centrée sur le corps.
    /// Le milieu de la forme au repos : la caméra pour l'île, le corps ailleurs.
    var restMid: CGFloat { isIsland ? panelSize.width / 2 : shapeStart + shapeLength / 2 }

    var pillRange: ClosedRange<CGFloat> {
        let mid = restMid
        let length = restLength ?? metrics.pillLength
        return (mid - length / 2)...(mid + length / 2)
    }

    /// Île : la caméra et ses deux ailes (`side` de chaque côté), quand un bot travaille ou attend.
    func wingsRange(side: CGFloat) -> ClosedRange<CGFloat> {
        (pillRange.lowerBound - side)...(pillRange.upperBound + side)
    }

    /// Île : l'étendue du panneau déplié le long du bord, centrée sur la caméra.
    var islandRange: ClosedRange<CGFloat> {
        (restMid - Self.islandWidth / 2)...(restMid + Self.islandWidth / 2)
    }

    func ringCenter(index: Int) -> (along: CGFloat, across: CGFloat) {
        (shapeStart + cellShift + metrics.ringCenterAlong(index: index, edge: edge), inset + metrics.ringCenterAcross(edge: edge))
    }

    /// Centre de la cellule (anneau + pourcentage) pour positionner la vue.
    func cellCenter(index: Int) -> CGPoint {
        let range = metrics.cellRange(index: index, edge: edge)
        let along = shapeStart + cellShift + (range.lowerBound + range.upperBound) / 2
        let across = inset + (edge.isVertical ? bodyDepth / 2 : metrics.ringMargin + metrics.cellExtent / 2)
        return point(along: along, across: across)
    }

    func cellIndex(atAlong along: CGFloat) -> Int? {
        for i in 0..<cellCount where metrics.cellRange(index: i, edge: edge).contains(along - shapeStart - cellShift) {
            return i
        }
        return nil
    }

    var orbCenter: (along: CGFloat, across: CGFloat) {
        (shapeStart + shapeLength + metrics.orbGap + metrics.orbDiameter / 2, inset + bodyDepth / 2)
    }

    /// Ce à quoi une carte est accrochée : un anneau, ou l'orbe (la carte du runtime).
    enum Anchor: Equatable, Sendable { case cell(Int), orb }

    func anchorAlong(_ anchor: Anchor) -> CGFloat {
        switch anchor {
        case .cell(let i): ringCenter(index: i).along
        case .orb: orbCenter.along
        }
    }

    /// Carte (flèche comprise) accrochée à une cellule : rect de pile (along × across).
    /// `cardSize` est la taille mesurée de la vue, flèche incluse.
    func cardRect(forCell index: Int, cardSize: CGSize) -> (along: ClosedRange<CGFloat>, across: ClosedRange<CGFloat>) {
        cardRect(anchor: .cell(index), cardSize: cardSize)
    }

    func cardRect(anchor: Anchor, cardSize: CGSize) -> (along: ClosedRange<CGFloat>, across: ClosedRange<CGFloat>) {
        let center = anchorAlong(anchor)
        let alongExtent = edge.isVertical ? cardSize.height : cardSize.width
        let acrossExtent = edge.isVertical ? cardSize.width : cardSize.height
        let start = min(max(center - alongExtent / 2, 8), max(8, alongTotal - alongExtent - 8))
        let acrossStart = depth + metrics.tailGap
        return (start...(start + alongExtent), acrossStart...(acrossStart + acrossExtent))
    }

    /// De combien la flèche doit glisser le long de la carte pour viser encore l'anneau
    /// quand la carte a été retenue au bord du panneau.
    func tailOffset(forCell index: Int, cardSize: CGSize) -> CGFloat {
        tailOffset(anchor: .cell(index), cardSize: cardSize)
    }

    func tailOffset(anchor: Anchor, cardSize: CGSize) -> CGFloat {
        let r = cardRect(anchor: anchor, cardSize: cardSize)
        let mid = (r.along.lowerBound + r.along.upperBound) / 2
        return anchorAlong(anchor) - mid
    }

    /// Ce que le pointeur peut toucher, en espace de pile.
    enum Hit: Equatable, Sendable { case pill, cell(Int), body, orb, card, banner, none }

    /// `islandHeight` : la hauteur mesurée du panneau déplié de l'île ; `wingsSide` : la largeur de
    /// chaque aile quand l'état compact est affiché (nil sinon).
    func hit(along: CGFloat, across: CGFloat, expanded: Bool, card: (along: ClosedRange<CGFloat>, across: ClosedRange<CGFloat>)?,
             islandHeight: CGFloat? = nil, wingsSide: CGFloat? = nil, bannerHeight: CGFloat? = nil) -> Hit {
        let slack: CGFloat = 6
        if isIsland {
            // L'île s'ouvre au survol de la caméra ou de ses ailes (la barre des menus à côté reste libre) ;
            // dépliée, tout son panneau la garde ouverte.
            if !expanded {
                // Une bannière descendue : elle se garde au survol et ses boutons se cliquent.
                if let bannerHeight, islandRange.contains(along), across <= max(bannerHeight, inset) + slack { return .banner }
                let range = wingsSide.map { wingsRange(side: $0) } ?? pillRange
                return range.contains(along) && across <= inset + 4 ? .pill : .none
            }
            if islandRange.contains(along), across <= max(islandHeight ?? 0, inset) + slack { return .body }
            return .none
        }
        if !expanded {
            if pillRange.contains(along), across <= metrics.pillHotZone { return .pill }
            return .none
        }
        if let card, card.along.contains(along), (card.across.lowerBound - metrics.tailGap)...card.across.upperBound ~= across {
            return .card
        }
        let orb = orbCenter
        if hypot(along - orb.along, across - orb.across) <= metrics.orbDiameter / 2 + slack { return .orb }
        if shapeRange.contains(along), across <= depth + slack, across >= -slack {
            if let i = cellIndex(atAlong: along) { return .cell(i) }
            return .body
        }
        return .none
    }
}
