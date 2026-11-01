import AppKit

/// Panneau sans bordure, non activant, au-dessus de tout, barre de menus comprise.
/// Non activant : jeter un œil à son usage ne doit jamais voler le focus.
final class NotchPanel: NSPanel {
    var contextMenuProvider: (() -> NSMenu?)?
    /// ⌥-glisser : delta brut du pointeur depuis le dernier événement.
    var onDragStart: (() -> Void)?
    var onDrag: ((CGFloat, CGFloat) -> Void)?
    var onDragEnd: (() -> Void)?

    init(contentRect: NSRect) {
        super.init(contentRect: contentRect, styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isMovable = false
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// `sendEvent` voit tout avant les vues SwiftUI : c'est là que vivent le menu contextuel
    /// et le ⌥-glisser, le reste descend normalement.
    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .rightMouseDown:
            guard let menu = contextMenuProvider?(), let view = contentView else { break }
            NSMenu.popUpContextMenu(menu, with: event, for: view)
            return
        case .leftMouseDown where event.modifierFlags.contains(.option) && onDrag != nil:
            onDragStart?()
            trackDrag()
            return
        default:
            break
        }
        super.sendEvent(event)
    }

    private func trackDrag() {
        while let event = nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            switch event.type {
            case .leftMouseDragged: onDrag?(event.deltaX, event.deltaY)
            case .leftMouseUp: onDragEnd?(); return
            default: return
            }
        }
    }
}
