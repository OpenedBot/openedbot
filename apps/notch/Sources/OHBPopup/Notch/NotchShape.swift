import SwiftUI

/// Le corps : une pilule soudée au bord, avec aux deux bouts une courbe *inverse* qui
/// repart vers le bord, pour qu'elle se lise comme une partie du cadre et non comme une
/// fenêtre posée dessus. Écrite une fois en espace de pile, projetée sur chaque bord.
struct NotchShape: Shape {
    let geometry: NotchGeometry

    func path(in rect: CGRect) -> Path {
        let m = geometry.metrics
        let g = geometry
        let depth = g.depth
        let fr = m.curl
        // Le coin convexe ne peut pas mordre sur la courbe inverse.
        let cr = min(m.corner, max(4, depth - fr - 1), g.bodyLength / 2)
        let a0 = g.shapeStart                 // début de la forme (sur le bord)
        let aTop = a0 + fr                    // bord haut du corps
        let aBot = aTop + g.bodyLength        // bord bas du corps
        let a1 = aBot + fr                    // fin de la forme

        func P(_ along: CGFloat, _ across: CGFloat) -> CGPoint { g.point(along: along, across: across) }

        var path = Path()
        path.move(to: P(a0, 0))
        // Courbe inverse d'entrée : du bord vers le haut du corps.
        quarter(&path, from: P(a0, 0), to: P(aTop, fr), corner: P(aTop, 0))
        path.addLine(to: P(aTop, depth - cr))
        // Coin convexe haut.
        quarter(&path, from: P(aTop, depth - cr), to: P(aTop + cr, depth), corner: P(aTop, depth))
        path.addLine(to: P(aBot - cr, depth))
        // Coin convexe bas.
        quarter(&path, from: P(aBot - cr, depth), to: P(aBot, depth - cr), corner: P(aBot, depth))
        path.addLine(to: P(aBot, fr))
        // Courbe inverse de sortie, qui retombe sur le bord.
        quarter(&path, from: P(aBot, fr), to: P(a1, 0), corner: P(aBot, 0))
        path.closeSubpath()
        return path
    }

    /// Un quart de cercle approché par une cubique (κ = 0,5523), défini par ses deux
    /// extrémités et le coin qu'il arrondit : indépendant de l'orientation.
    private func quarter(_ path: inout Path, from a: CGPoint, to b: CGPoint, corner k: CGPoint) {
        let kappa: CGFloat = 0.5523
        let c1 = CGPoint(x: a.x + (k.x - a.x) * kappa, y: a.y + (k.y - a.y) * kappa)
        let c2 = CGPoint(x: b.x + (k.x - b.x) * kappa, y: b.y + (k.y - b.y) * kappa)
        path.addCurve(to: b, control1: c1, control2: c2)
    }
}

/// La pastille au repos : un petit demi-galet sur le bord.
struct PillShape: Shape {
    let geometry: NotchGeometry

    func path(in rect: CGRect) -> Path {
        let m = geometry.metrics
        // Île : la forme épouse l'encoche de la caméra, noir sur noir, invisible au repos.
        if geometry.isIsland {
            let r = geometry.rect(along: geometry.pillRange, across: 0...geometry.inset)
            return UnevenRoundedRectangle(cornerRadii: RectangleCornerRadii(topLeading: 0, bottomLeading: 10, bottomTrailing: 10, topTrailing: 0),
                                          style: .continuous).path(in: r)
        }
        let r = geometry.rect(along: geometry.pillRange, across: 0...m.pillWidth)
        let radius = m.pillWidth
        let corners: RectangleCornerRadii
        switch geometry.edge {
        case .right: corners = RectangleCornerRadii(topLeading: radius, bottomLeading: radius, bottomTrailing: 0, topTrailing: 0)
        case .top: corners = RectangleCornerRadii(topLeading: 0, bottomLeading: radius, bottomTrailing: radius, topTrailing: 0)
        case .bottom: corners = RectangleCornerRadii(topLeading: radius, bottomLeading: 0, bottomTrailing: 0, topTrailing: radius)
        }
        return UnevenRoundedRectangle(cornerRadii: corners, style: .continuous).path(in: r)
    }
}

