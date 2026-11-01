import AppKit
import SwiftUI

/// Survol fiable dans un panneau non activant, où `onHover` de SwiftUI ne répond pas : une
/// zone de suivi `activeAlways`, le curseur main sur ce qui se clique, et la flèche qui
/// revient même si la vue disparaît sous le pointeur (pile repliée, plateau fermé).
extension View {
    func pointer(onHover: @escaping (Bool) -> Void = { _ in }) -> some View {
        background(HoverTracker(onChange: onHover))
    }
}

private struct HoverTracker: NSViewRepresentable {
    let onChange: (Bool) -> Void

    func makeNSView(context: Context) -> TrackerView { TrackerView() }
    func updateNSView(_ view: TrackerView, context: Context) { view.onChange = onChange }
}

final class TrackerView: NSView {
    var onChange: (Bool) -> Void = { _ in }
    private var inside = false

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect, .cursorUpdate],
                                       owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { set(true) }
    override func mouseExited(with event: NSEvent) { set(false) }
    override func cursorUpdate(with event: NSEvent) { NSCursor.pointingHand.set() }
    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow == nil { set(false) }
    }
    /// Les clics passent à la vue SwiftUI au-dessus.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func set(_ value: Bool) {
        guard value != inside else { return }
        inside = value
        if value { NSCursor.pointingHand.set() } else { NSCursor.arrow.set() }
        onChange(value)
    }
}
