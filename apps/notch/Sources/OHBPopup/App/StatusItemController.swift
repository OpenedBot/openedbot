import AppKit
import Observation
import SwiftUI

/// La barre de menus : l'icône, ou — réglage « Afficher l'activité » — ce qui tourne et
/// ce qui vous attend : « ◐ Support · attend │ 2 en cours │ 1 à valider ».
@MainActor
final class StatusItemController {
    let item: NSStatusItem
    private let model: NotchModel
    private let host: NSHostingView<StatusActivityView>
    var menuProvider: () -> NSMenu = { NSMenu() }
    private var lastKey: [String] = []

    init(model: NotchModel) {
        self.model = model
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        host = NSHostingView(rootView: StatusActivityView(bots: [], running: 0, pending: 0))
        host.isHidden = true
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "asterisk", accessibilityDescription: "openedbot notch")
            button.image?.isTemplate = true
            button.target = self
            button.action = #selector(clicked)
            button.addSubview(host)
        }
        observe()
    }

    @objc private func clicked() {
        item.menu = menuProvider()
        item.button?.performClick(nil)
        item.menu = nil
    }

    private func render() {
        guard let button = item.button else { return }
        let shown = model.bots.filter { $0.activity == .waiting || $0.activity == .working }.prefix(2)
        // `bots` change souvent (horloges, tokens) : on ne refait la vue que si son texte change.
        let key = shown.map { "\($0.id)|\($0.activity.word)|\($0.activeRun?.stepText ?? "")" }
            + ["\(model.runningCount)", "\(model.pendingCount)", "\(model.menuBarActivity)", Language.current.rawValue]
        guard key != lastKey else { return }
        lastKey = key
        if !model.menuBarActivity || (shown.isEmpty && model.pendingCount == 0) {
            host.isHidden = true
            button.image = NSImage(systemSymbolName: "asterisk", accessibilityDescription: "openedbot notch")
            button.image?.isTemplate = true
            item.length = NSStatusItem.variableLength
        } else {
            host.rootView = StatusActivityView(bots: Array(shown), running: model.runningCount, pending: model.pendingCount)
            let size = host.fittingSize
            host.frame = NSRect(x: 0, y: 0, width: size.width, height: NSStatusBar.system.thickness)
            host.isHidden = false
            button.image = nil
            item.length = size.width
        }
    }

    private func observe() {
        withObservationTracking {
            _ = model.menuBarActivity
            _ = model.bots
            _ = Language.shared.value
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.render()
                self.observe()
            }
        }
    }
}

struct StatusActivityView: View {
    let bots: [Bot]
    let running: Int
    let pending: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(bots) { b in
                HStack(spacing: 4) {
                    AvatarView(bot: b, size: 13)
                    Text("\(b.name) · \(b.activity == .waiting ? tr("waiting", "attend") : tr("working", "travaille"))\(b.activeRun.map { " \($0.stepText)" } ?? "")")
                        .font(.system(size: 12, weight: .medium)).monospacedDigit()
                }
                Text("|").foregroundStyle(.secondary)
            }
            Text(tr("\(running) running", "\(running) en cours")).font(.system(size: 12, weight: .medium))
            if pending > 0 {
                Text("|").foregroundStyle(.secondary)
                Text(tr("\(pending) to approve", "\(pending) à valider")).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.waiting)
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 6)
        .frame(height: NSStatusBar.system.thickness)
        .fixedSize()
    }
}
