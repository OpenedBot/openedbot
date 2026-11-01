import AppKit
import SwiftUI

/// Réglages › Journal : l'état du flux et du runtime, puis les lignes en direct, la plus récente en bas.
struct JournalPage: View {
    let model: NotchModel
    @State private var filter: Filter = .all
    @State private var follows = true

    enum Filter: String, CaseIterable, Hashable {
        case all, problems
        var title: String { self == .all ? tr("All", "Tout") : tr("Warnings and errors", "Alertes et erreurs") }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SettingsCard {
                SettingsRow(tr("openedbot feed", "Flux openedbot"), feedText, descriptionColor: feedColor) {
                    LivenessDot(liveness: model.liveness, size: 8)
                }
                SettingsRow("Runtime \(model.runtimeStatus?.name ?? "")", runtimeText,
                            descriptionColor: model.runtimeStatus?.connected == false ? Palette.critical : Surface.textSecondary) {
                    EmptyView()
                }
            }
            // Une ligne si elle tient, sinon le filtre au-dessus des actions : rien ne sort de la fenêtre.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    filterControl
                    Spacer(minLength: 8)
                    actions
                }
                VStack(alignment: .leading, spacing: 10) {
                    filterControl
                    HStack(spacing: 10) {
                        Spacer(minLength: 0)
                        actions
                    }
                }
            }
            list
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private var filterControl: some View {
        Segmented(selection: $filter, options: Filter.allCases.map { ($0, $0.title) })
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Text(tr("Follow", "Suivre")).font(.system(size: 12)).foregroundStyle(Surface.textSecondary).lineLimit(1)
            Switch(isOn: $follows)
            SecondaryButton(tr("Copy", "Copier"), symbol: "doc.on.doc") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(model.journal.export(), forType: .string)
            }
            SecondaryButton(tr("Clear", "Effacer")) { model.journal.clear() }
        }
        .fixedSize()
    }

    private var entries: [JournalEntry] {
        filter == .all ? model.journal.entries : model.journal.entries.filter { $0.level != .info }
    }

    private var list: some View {
        let rows = entries
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if rows.isEmpty {
                        Text(filter == .all ? tr("Nothing yet. Lines arrive as soon as the feed moves.",
                                                 "Rien pour l'instant. Les lignes arrivent dès que le flux bouge.")
                                            : tr("No warning or error since the app opened.", "Aucune alerte ni erreur depuis l'ouverture."))
                            .font(.system(size: 12)).foregroundStyle(Surface.textSecondary)
                            .padding(12)
                    }
                    ForEach(rows) { JournalRow(entry: $0).id($0.id) }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.vertical, 6)
            }
            // Petit plancher : à la hauteur minimale de la fenêtre, la liste cède la place aux cartes au lieu de déborder.
            .frame(minHeight: 72, maxHeight: .infinity)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Surface.raised))
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: rows.last?.id) { _, _ in if follows { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: rows.last?.count) { _, _ in if follows { proxy.scrollTo("bottom", anchor: .bottom) } }
        }
    }

    private var feedText: String {
        switch model.feedState {
        case nil: tr("Demo: no server, the log shows the simulated sends.", "Démo : pas de serveur, le journal montre les envois simulés.")
        case .connecting: tr("Connecting…", "Connexion en cours…")
        case .live: tr("Live.", "En direct.")
        case .retrying(let why): tr("Cut off, retrying: \(why)", "Coupé, nouvel essai : \(why)")
        case .failed(let why): tr("Stopped: \(why)", "Arrêté : \(why)")
        }
    }

    private var feedColor: Color {
        switch model.feedState {
        case .failed: Palette.critical
        case .retrying, .connecting: Palette.waiting
        default: Surface.textSecondary
        }
    }

    private var runtimeText: String {
        guard let r = model.runtimeStatus else { return tr("No news from the runtime yet.", "Pas encore de nouvelles du runtime.") }
        var parts = [r.connected ? tr("online", "en ligne") : tr("offline", "hors ligne")]
        if let seen = r.lastSeenAt { parts.append(tr("seen \(ElapsedCopy.text(since: seen, now: model.now)) ago", "vu il y a \(ElapsedCopy.text(since: seen, now: model.now))")) }
        if let v = r.version { parts.append(r.outdated ? tr("connector \(v), \(r.latestVersion ?? "") available", "connecteur \(v), \(r.latestVersion ?? "") disponible")
                                     : tr("connector \(v)", "connecteur \(v)")) }
        if let h = r.health { parts.append(tr("health \(h)", "santé \(h)")) }
        return parts.joined(separator: " · ")
    }
}

private struct JournalRow: View {
    let entry: JournalEntry
    private static let time: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(Self.time.string(from: entry.at))
                .font(.system(size: 11, design: .monospaced)).foregroundStyle(Surface.textTertiary)
            Text(entry.topic.label)
                .font(.system(size: 10.5, weight: .medium)).foregroundStyle(Surface.textSecondary)
                .padding(.horizontal, 6).padding(.vertical, 1.5)
                .background(Capsule().fill(Color.white.opacity(0.06)))
                .frame(width: 78, alignment: .leading)
            Text(entry.text)
                .font(.system(size: 12)).foregroundStyle(color)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if entry.count > 1 {
                Text("×\(entry.count)").font(.system(size: 11, design: .monospaced)).foregroundStyle(Surface.textSecondary)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 4)
    }

    private var color: Color {
        switch entry.level {
        case .info: Surface.textPrimary
        case .warning: Palette.waiting
        case .error: Surface.error
        }
    }
}
