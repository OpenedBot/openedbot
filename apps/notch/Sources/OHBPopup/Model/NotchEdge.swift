import Foundation

/// Où l'encoche vit : au bord droit (colonne), posée sur le Dock (rangée), ou en île sous la
/// caméra (rangée). Les valeurs brutes `bottom` et `top` restent celles déjà enregistrées ; un
/// ancien réglage `left` ne se lit plus et revient au bord droit.
enum NotchEdge: String, CaseIterable, Identifiable, Sendable {
    case right, bottom, top

    var id: String { rawValue }
    var isVertical: Bool { self == .right }

    var title: String {
        switch self {
        case .right: tr("Right", "Droite")
        case .bottom: "Dock"
        case .top: "Island"
        }
    }

    /// Où part la carte : toujours à l'opposé du bord.
    enum TooltipDirection: Equatable, Sendable { case leading, trailing, up, down }

    var tooltipDirection: TooltipDirection {
        switch self {
        case .right: .leading
        case .top: .down
        case .bottom: .up
        }
    }
}
