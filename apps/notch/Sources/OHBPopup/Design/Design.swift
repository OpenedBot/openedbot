import AppKit
import SwiftUI

/// Notch layout metrics : les mesures sont relevées sur une planche de référence de
/// 2000 × 2000 px. L'anneau fait 44 pt pour 117 px : ce ratio fixe l'échelle de tout le reste.
enum Design {
    static let scale: CGFloat = 44.0 / 117.0
    static func px(_ pixels: CGFloat) -> CGFloat { pixels * scale }
    /// Hauteur de capitale (SF Pro) → taille de police.
    private static let capRatio: CGFloat = 0.714
    static func fontSize(capPixels pixels: CGFloat) -> CGFloat { px(pixels) / capRatio }
}

/// Valeurs échantillonnées sur le frame sombre.
enum Palette {
    static let notch = Color.black
    static let card = Color.black
    static let ringTrack = Color.white.opacity(0.188)   // #303030 sur noir
    static let barTrack = Color.white.opacity(0.176)    // #2D2D2D sur noir
    static let ample = Color(hex: 0x00FF88)
    static let watch = Color(hex: 0xF2FF00)
    static let critical = Color(hex: 0xFF3F00)
    /// L'anneau ambre qui pulse quand une session attend l'utilisateur.
    static let waiting = Color(hex: 0xF2A93B)
    static let textPrimary = Color.white
    static let textSecondary = Color(hex: 0x808080)
}

/// Les surfaces des fenêtres (agent, réglages) : des paliers de gris, pas des bordures.
/// Mêmes valeurs que les composants agentiques de BoardUI ; les couleurs d'état restent celles de l'encoche.
enum Surface {
    static let window = Color(hex: 0x121212)
    static let raised = Color(hex: 0x171717)
    static let field = Color(hex: 0x262626)
    static let control = Color(hex: 0x404040)
    static let separator = Color(hex: 0x262626)
    static let textPrimary = Color(hex: 0xFAFAFA)
    static let textSecondary = Color(hex: 0x737373)
    static let textTertiary = Color(hex: 0x525252)
    static let error = Color(hex: 0xFF6467)
    static let ring = Color.white.opacity(0.10)
    /// Les bulles du fil, comme la console : le bot en gris, vous dans l'ambre openedbot.
    static let bubbleBot = Color(hex: 0x2A2A2A)
    static let bubbleUser = Color(hex: 0xC48A35)
}

enum Typography {
    /// Le pourcentage sous chaque anneau (cap 27 px).
    static let percent = Font.system(size: Design.fontSize(capPixels: 27), weight: .semibold)
    /// « Claude Usage » (cap 26 px).
    static let cardTitle = Font.system(size: Design.fontSize(capPixels: 26), weight: .semibold)
    /// « Current session », « 73% Used » (cap 18 px).
    static let cardBody = Font.system(size: Design.fontSize(capPixels: 18), weight: .regular)
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: 1)
    }
}
