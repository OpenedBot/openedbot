import AppKit
import SwiftUI

// Le fil d'un bot comme la console le dessine (`thread-timeline.tsx`, `thread-messages.tsx`,
// `thread-turn-activity.tsx`, `thread-tool-activity.tsx`, `run-activity-dock.tsx`), à l'échelle d'une fenêtre de 400 pt.

enum ThreadCopy {
    static func day(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return tr("Today", "Aujourd’hui") }
        if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: y) { return tr("Yesterday", "Hier") }
        let f = DateFormatter()
        f.locale = Language.current.locale
        f.dateStyle = .medium
        f.timeStyle = .none
        return f.string(from: date)
    }

    static func time(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Language.current.locale
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }

    static func full(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Language.current.locale
        f.dateStyle = .full
        f.timeStyle = .short
        return f.string(from: date)
    }

    /// L'heure complète au survol, comme `toLocaleString()` en français : « 11/10/2026 20:44:33 ».
    static func stamp(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Language.current.locale
        f.dateFormat = tr("M/d/yyyy, h:mm:ss a", "dd/MM/yyyy HH:mm:ss")
        return f.string(from: date)
    }

    /// « 70 ko » en français, « 70 kB » en anglais : la langue de l'app, pas celle du système.
    static func byteCount(_ n: Int) -> String {
        Int64(n).formatted(.byteCount(style: .file).locale(Language.current.locale))
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    static func bytes(_ n: Int?) -> String? {
        n.map { byteCount($0) }
    }
}

/// La puce d'un jour, centrée.
struct DayChip: View {
    let date: Date
    var body: some View {
        Text(ThreadCopy.day(date))
            .font(.system(size: 11.5, weight: .medium)).foregroundStyle(Surface.textSecondary)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(Surface.field))
            .frame(maxWidth: .infinity)
            .padding(.top, 6).padding(.bottom, 2)
    }
}

/// Le visage et le nom de l'auteur d'un tour, et son heure.
struct AuthorChip: View {
    let name: String
    let seed: String
    let face: BotFace?
    let at: Date
    var thinking = false

    var body: some View {
        HStack(spacing: 6) {
            FaceView(seed: seed, name: name, face: face, size: 18)
            if thinking {
                ShimmerText(text: tr("Thinking…", "Réflexion…"))
            } else {
                Text(name).font(.system(size: 12, weight: .medium)).foregroundStyle(Surface.textSecondary).lineLimit(1)
                Text("·").font(.system(size: 12)).foregroundStyle(Surface.textTertiary)
                Text(ThreadCopy.time(at)).font(.system(size: 11.5).monospacedDigit()).foregroundStyle(Surface.textTertiary)
            }
        }
        .help(ThreadCopy.stamp(at))
    }
}

/// Un libellé qui chatoie, comme `.bui-thinking-label` (dégradé qui glisse en 2,6 s).
struct ShimmerText: View {
    let text: String
    var size: CGFloat = 12

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { context in
            let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.6) / 2.6
            Text(text).font(.system(size: size, weight: .medium))
                .foregroundStyle(
                    LinearGradient(stops: [
                        .init(color: Surface.textSecondary.opacity(0.55), location: 0),
                        .init(color: Surface.textPrimary, location: 0.5),
                        .init(color: Surface.textSecondary.opacity(0.55), location: 1),
                    ], startPoint: UnitPoint(x: -1 + 2 * t, y: 0.5), endPoint: UnitPoint(x: 2 * t, y: 0.5))
                )
        }
    }
}

/// Le texte d'un tour en direct : il rattrape le flux caractère par caractère (`useSmoothText`), sans curseur.
struct SmoothMarkdown: View {
    let text: String
    let streaming: Bool
    @State private var shown: Int?

    var body: some View {
        let visible = shown.map { String(text.prefix($0)) } ?? text
        MarkdownText(text: visible)
            .task(id: text) {
                guard streaming || (shown ?? text.count) < text.count else { shown = nil; return }
                var current = shown ?? 0
                while current < text.count {
                    if Task.isCancelled { return }
                    // Rattraper en ~200 ms quel que soit le retard, au moins un caractère par image.
                    current = min(text.count, current + max(1, (text.count - current) / 12))
                    shown = current
                    try? await Task.sleep(for: .milliseconds(16))
                }
                if !streaming { shown = nil }
            }
    }
}

/// Une pièce jointe : vignette pour une image (chargée avec la session), puce pour un document.
struct AttachmentTile: View {
    let attachment: ConversationAttachment
    var alignTrailing = false
    private var remote = RemoteImages.shared
    @State private var opening = false

    init(attachment: ConversationAttachment, alignTrailing: Bool = false) {
        self.attachment = attachment
        self.alignTrailing = alignTrailing
    }

    private var path: String? { attachment.remoteID.map { "/api/attachments/\($0)" } }

    var body: some View {
        if attachment.isImage, let path {
            VStack(alignment: alignTrailing ? .trailing : .leading, spacing: 3) {
                Group {
                    if let image = remote.image(path) {
                        Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
                            .frame(maxWidth: 200, maxHeight: 200)
                    } else if remote.failed(path) {
                        Label(tr("Image unavailable", "Image indisponible"), systemImage: "photo.badge.exclamationmark")
                            .font(.system(size: 11)).foregroundStyle(Surface.textSecondary)
                            .frame(width: 160, height: 64)
                    } else {
                        ProgressView().controlSize(.small).frame(width: 160, height: 120)
                    }
                }
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.04)))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 1))
                .onTapGesture { open() }
                .pointer()
                caption
            }
            .task(id: path) { remote.load(path) }
        } else {
            Button(action: open) {
                HStack(spacing: 5) {
                    Image(systemName: opening ? "hourglass" : "paperclip").font(.system(size: 10, weight: .semibold))
                    Text(attachment.name).font(.system(size: 11.5, weight: .medium)).lineLimit(1).truncationMode(.middle)
                    if let size = ThreadCopy.bytes(attachment.bytes) {
                        Text(size).font(.system(size: 10.5)).foregroundStyle(Surface.textSecondary)
                    }
                }
                .foregroundStyle(Surface.textPrimary)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .frame(maxWidth: 220, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(0.06)))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .pointer()
            .disabled(path == nil)
            .help(path == nil ? attachment.name : tr("Open \(attachment.name)", "Ouvrir \(attachment.name)"))
        }
    }

    private var caption: some View {
        HStack(spacing: 4) {
            Text(attachment.name).lineLimit(1).truncationMode(.middle)
            if let size = ThreadCopy.bytes(attachment.bytes) { Text(size).foregroundStyle(Surface.textTertiary) }
        }
        .font(.system(size: 10.5)).foregroundStyle(Surface.textSecondary)
        .frame(maxWidth: 200, alignment: alignTrailing ? .trailing : .leading)
    }

    /// Ouvre la pièce dans l'app par défaut, depuis une copie temporaire.
    private func open() {
        guard let id = attachment.remoteID, let loader = RemoteImages.shared.loader, !opening else { return }
        opening = true
        let name = attachment.name.replacingOccurrences(of: "/", with: "_")
        Task {
            defer { opening = false }
            guard let data = try? await loader("/api/attachments/\(id)") else { return }
            let dir = FileManager.default.temporaryDirectory.appending(path: "ohb-popup-\(id)")
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appending(path: name)
            guard (try? data.write(to: url)) != nil else { return }
            NSWorkspace.shared.open(url)
        }
    }
}

// MARK: - Tree view (BoardUI)

/// Les traits du tree view de BoardUI (`tree-view`) : une verticale depuis le parent qui finit en coude
/// arrondi vers la rangée, et qui continue vers la suivante tant que ce n'est pas la dernière.
struct TreeGuide: Shape {
    /// L'abscisse de la verticale du parent, dans la rangée.
    var x: CGFloat
    /// La hauteur du coude : le milieu de la première ligne de la rangée.
    var elbowY: CGFloat
    var isLast: Bool
    var radius: CGFloat = 6
    var reach: CGFloat = 12

    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: x, y: 0))
        p.addLine(to: CGPoint(x: x, y: elbowY - radius))
        p.addQuadCurve(to: CGPoint(x: x + radius, y: elbowY), control: CGPoint(x: x, y: elbowY))
        p.addLine(to: CGPoint(x: x + reach, y: elbowY))
        if !isLast {
            p.move(to: CGPoint(x: x, y: elbowY - radius))
            p.addLine(to: CGPoint(x: x, y: rect.height))
        }
        return p
    }
}

/// Une rangée d'arbre : retrait de 20 pt par niveau, traits du parent, fond relevé au survol, coins de 10 pt.
struct TreeRow<Content: View>: View {
    var level: Int
    var isLast: Bool
    var rowHeight: CGFloat = 30
    @ViewBuilder var content: () -> Content
    @State private var hovered = false

    private static var indent: CGFloat { 20 }

    var body: some View {
        content()
            .padding(.leading, CGFloat(level) * Self.indent + 6)
            .padding(.trailing, 6)
            .frame(minHeight: rowHeight, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(hovered ? Color.white.opacity(0.06) : .clear))
            .overlay(alignment: .topLeading) {
                if level > 0 {
                    TreeGuide(x: CGFloat(level - 1) * Self.indent + 13, elbowY: rowHeight / 2, isLast: isLast)
                        .stroke(Surface.control, lineWidth: 1)
                        .allowsHitTesting(false)
                }
            }
            .onHover { hovered = $0 }
    }
}

/// Une ligne d'outil (`ToolGroupRow`) dans l'arbre : état, libellé français, nom brut, ×N, durée ;
/// ses aperçus se déplient en rangées filles.
struct ToolRowView: View {
    let group: ToolCallGroup
    var isLast: Bool
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TreeRow(level: 1, isLast: isLast) {
                Button { if !group.previews.isEmpty { open.toggle() } } label: {
                    HStack(spacing: 7) {
                        stateIcon.frame(width: 14)
                        if let label = ToolCopy.label(group.name) {
                            Text(label).font(.system(size: 12)).foregroundStyle(Surface.textPrimary).lineLimit(1)
                        }
                        Text(group.name).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Surface.textSecondary)
                            .lineLimit(1).truncationMode(.middle)
                        if group.count > 1 {
                            Text("×\(group.count)").font(.system(size: 11, weight: .semibold).monospacedDigit()).foregroundStyle(Surface.textSecondary)
                        }
                        Spacer(minLength: 4)
                        if group.durationMs > 0 {
                            Text(ToolCopy.duration(group.durationMs)).font(.system(size: 10.5).monospacedDigit()).foregroundStyle(Surface.textTertiary)
                        }
                        if !group.previews.isEmpty {
                            Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).foregroundStyle(Surface.textTertiary)
                                .rotationEffect(.degrees(open ? 90 : 0))
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointer()
            }
            if let error = group.firstError, !error.isEmpty {
                TreeRow(level: 2, isLast: !open || group.previews.isEmpty, rowHeight: 24) {
                    Text(tr("Error: \(error)", "Erreur : \(error)")).font(.system(size: 11)).foregroundStyle(Surface.error).lineLimit(3)
                }
                .overlay(alignment: .leading) { continuation }
            }
            if open {
                ForEach(Array(group.previews.enumerated()), id: \.offset) { index, preview in
                    TreeRow(level: 2, isLast: index == group.previews.count - 1, rowHeight: 26) {
                        Text(preview).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Surface.textPrimary.opacity(0.85))
                            .textSelection(.enabled).lineLimit(4).padding(.vertical, 5)
                    }
                    .overlay(alignment: .leading) { continuation }
                }
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.16), value: open)
    }

    /// La verticale du niveau 1 qui traverse les rangées filles quand ce groupe n'est pas le dernier.
    @ViewBuilder
    private var continuation: some View {
        if !isLast {
            Rectangle().fill(Surface.control).frame(width: 1).frame(maxHeight: .infinity)
                .padding(.leading, 13).allowsHitTesting(false)
        }
    }

    @ViewBuilder
    private var stateIcon: some View {
        if group.running > 0 {
            ProgressView().controlSize(.mini).scaleEffect(0.7)
        } else if group.failures > 0 && group.failures == group.count {
            Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Surface.error)
        } else if group.failures > 0 {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.waiting)
        } else {
            Image(systemName: ToolCopy.symbol(group.name)).font(.system(size: 10.5)).foregroundStyle(Surface.textSecondary)
        }
    }
}

/// Le bloc d'activité d'un tour (`TurnActivity`) en tree view : la racine (« 2 outils »), puis les outils
/// et la narration en rangées filles. Déplié en direct, replié une fois fini.
struct TurnActivityView: View {
    let turn: Turn
    @State private var expanded: Bool?

    var body: some View {
        let open = expanded ?? turn.live
        VStack(alignment: .leading, spacing: 0) {
            TreeRow(level: 0, isLast: true) {
                Button { expanded = !open } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "chevron.right").font(.system(size: 8.5, weight: .bold)).foregroundStyle(Surface.textSecondary)
                            .rotationEffect(.degrees(open ? 90 : 0))
                            .frame(width: 14)
                        Group {
                            if turn.live { ProgressView().controlSize(.mini).scaleEffect(0.75) }
                            else { Image(systemName: "wrench.and.screwdriver").font(.system(size: 10.5)).foregroundStyle(Surface.textSecondary) }
                        }
                        .frame(width: 16)
                        if turn.live {
                            ShimmerText(text: liveLabel, size: 12)
                        } else {
                            Text(turn.toolCount > 0 ? tr("\(turn.toolCount) tool\(turn.toolCount > 1 ? "s" : "")", "\(turn.toolCount) outil\(turn.toolCount > 1 ? "s" : "")") : tr("Turn activity", "Activité du tour"))
                                .font(.system(size: 12, weight: .semibold)).foregroundStyle(Surface.textPrimary)
                        }
                        if turn.failureCount > 0 {
                            Text(tr("\(turn.failureCount) of \(turn.toolCount) failed", "\(turn.failureCount) échec\(turn.failureCount > 1 ? "s" : "") sur \(turn.toolCount)"))
                                .font(.system(size: 11.5)).foregroundStyle(Palette.waiting)
                        }
                        if !turn.live, turn.totalDurationMs > 0 {
                            Text(ToolCopy.duration(turn.totalDurationMs)).font(.system(size: 11).monospacedDigit()).foregroundStyle(Surface.textTertiary)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointer()
            }
            if open {
                let steps = turn.activity
                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    let last = index == steps.count - 1
                    switch step {
                    case .narration(let text):
                        TreeRow(level: 1, isLast: last) {
                            MarkdownText(text: text, size: 12, color: Surface.textSecondary).padding(.vertical, 6)
                        }
                    case .tools(let group):
                        ToolRowView(group: group, isLast: last)
                    }
                }
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.25), value: open)
    }

    /// En direct : la première ligne de la dernière narration, sinon « Travail en cours… ».
    private var liveLabel: String {
        for step in turn.activity.reversed() {
            if case .narration(let text) = step, let line = text.split(separator: "\n").first, !line.isEmpty {
                return String(line.prefix(80))
            }
        }
        return tr("Working…", "Travail en cours…")
    }
}

// MARK: - Actions de message (console : `message-interactions.tsx`)

/// Ce qu'un message sait faire depuis le fil : réagir, être cité en réponse.
struct MessageActions {
    var react: (String) -> Void
    var reply: () -> Void
}

/// Un bouton d'action de 22 pt (`ACTION` de la console) : fond tertiaire, icône qui s'éclaire au survol.
struct ActionIcon: View {
    let symbol: String
    let help: String
    var active = false
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(active || hovered ? Surface.textPrimary : Surface.textSecondary)
                .frame(width: 22, height: 22)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Surface.field))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointer()
        .help(help)
        .onHover { hovered = $0 }
    }
}

/// Les sept réactions de la console dans une bulle ; celles déjà posées sont surlignées.
struct ReactionPicker: View {
    let reactions: [MessageReaction]
    let pick: (String) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Reactions.all, id: \.self) { emoji in
                let mine = reactions.contains { $0.emoji == emoji && $0.mine }
                Button { pick(emoji) } label: {
                    Text(emoji).font(.system(size: 17))
                        .frame(width: 30, height: 30)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(mine ? Color.white.opacity(0.14) : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointer()
                .help(mine ? tr("Remove reaction \(emoji)", "Retirer la réaction \(emoji)") : tr("React \(emoji)", "Réagir \(emoji)"))
            }
        }
        .padding(5)
        .background(Surface.raised)
        .preferredColorScheme(.dark)
    }
}

/// Les réactions posées sous une bulle : émoji et compte, la vôtre surlignée ; un clic la bascule.
struct ReactionsRow: View {
    let reactions: [MessageReaction]
    let toggle: (String) -> Void

    var body: some View {
        if !reactions.isEmpty {
            HStack(spacing: 4) {
                ForEach(reactions, id: \.emoji) { r in
                    Button { toggle(r.emoji) } label: {
                        HStack(spacing: 3) {
                            Text(r.emoji).font(.system(size: 12))
                            Text("\(r.count)").font(.system(size: 11, weight: .medium).monospacedDigit())
                                .foregroundStyle(r.mine ? Surface.textPrimary : Surface.textSecondary)
                        }
                        .padding(.horizontal, 7).frame(height: 22)
                        .background(Capsule().fill(r.mine ? Color(hex: 0x3B82F6).opacity(0.22) : Surface.field))
                        .overlay(Capsule().stroke(r.mine ? Color(hex: 0x3B82F6).opacity(0.6) : .clear, lineWidth: 1))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .pointer()
                    .help(r.mine ? tr("Remove reaction \(r.emoji)", "Retirer la réaction \(r.emoji)") : tr("React \(r.emoji)", "Réagir \(r.emoji)"))
                }
            }
        }
    }
}

/// La citation au-dessus d'une réponse (`ReplyQuote`) : un filet à gauche, l'auteur, l'extrait sur une ligne.
struct ReplyQuoteView: View {
    let quote: ReplyQuote

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(quote.authorName).font(.system(size: 11, weight: .medium)).foregroundStyle(Surface.textPrimary.opacity(0.8))
            Text(quote.excerpt.isEmpty ? "…" : quote.excerpt).font(.system(size: 11)).foregroundStyle(Surface.textSecondary)
                .lineLimit(1).truncationMode(.tail)
        }
        .padding(.leading, 9).padding(.trailing, 10).padding(.vertical, 6)
        .frame(maxWidth: 300, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(0.05)))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1).fill(Color(hex: 0x3B82F6).opacity(0.5)).frame(width: 2).padding(.vertical, 4)
        }
        .help(tr("Reply to \(quote.authorName)", "Réponse à \(quote.authorName)"))
    }
}

/// Le menu « … » de la console : les réactions sur une ligne en tête (`role="group"`), puis répondre et copier.
/// Une bulle plutôt qu'un menu système, qui empilerait les émojis en colonne.
struct MoreMenu: View {
    let reactions: [MessageReaction]
    let actions: MessageActions
    let copyText: String
    @State private var open = false

    var body: some View {
        ActionIcon(symbol: "ellipsis", help: tr("More", "Plus"), active: open) { open.toggle() }
            .popover(isPresented: $open, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    ReactionPicker(reactions: reactions) { emoji in open = false; actions.react(emoji) }
                        .padding(-5)
                        .padding(.horizontal, 2)
                    Rectangle().fill(Surface.separator).frame(height: 1).padding(.vertical, 2)
                    MenuRow(title: tr("Reply", "Répondre"), symbol: "arrowshape.turn.up.left") { open = false; actions.reply() }
                    MenuRow(title: tr("Copy", "Copier"), symbol: "doc.on.doc") { open = false; ThreadCopy.copy(copyText) }
                }
                .padding(6)
                .frame(minWidth: 198, alignment: .leading)
                .background(Surface.raised)
                .preferredColorScheme(.dark)
            }
    }
}

/// Une ligne de menu BoardUI : icône, libellé, fond relevé au survol.
struct MenuRow: View {
    let title: String
    let symbol: String
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(Surface.textSecondary).frame(width: 18)
                Text(title).font(.system(size: 13)).foregroundStyle(Surface.textPrimary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(hovered ? Color.white.opacity(0.08) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointer()
        .onHover { hovered = $0 }
    }
}

/// Un tour d'un bot : en-tête d'auteur et bloc d'activité s'il a travaillé, puis sa réponse, ses réactions,
/// et la barre d'actions de la console (👍 👎 copier …) sous la bulle, visible au survol ou sur la dernière réponse.
struct TurnView: View {
    let turn: Turn
    var actions: MessageActions?
    /// La dernière réponse du fil : ses actions restent visibles, comme `persistentActions`.
    var isLatest = false
    @State private var hovered = false
    @State private var copied = false

    var body: some View {
        let seed = turn.authorID ?? turn.authorName
        let interactive = actions != nil && turn.messageID != nil && !turn.live
        VStack(alignment: .leading, spacing: 6) {
            if let quote = turn.replyTo { ReplyQuoteView(quote: quote) }
            if !turn.activity.isEmpty {
                AuthorChip(name: turn.authorName, seed: seed, face: turn.authorFace, at: turn.at)
                TurnActivityView(turn: turn)
            }
            if !turn.answer.isEmpty {
                SmoothMarkdown(text: turn.answer, streaming: turn.live)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Surface.bubbleBot))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.trailing, 20)
                    .help(ThreadCopy.stamp(turn.at))
            }
            if let error = turn.error {
                Text(error).font(.system(size: 12.5, weight: .medium)).foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 6, bottomTrailingRadius: 16,
                                                       topTrailingRadius: 16, style: .continuous).fill(Color(hex: 0xC2362F)))
                    .textSelection(.enabled)
                    .padding(.trailing, 20)
            }
            if !turn.attachments.isEmpty {
                VStack(alignment: .leading, spacing: 6) { ForEach(turn.attachments) { AttachmentTile(attachment: $0) } }
            }
            if let actions, interactive { ReactionsRow(reactions: turn.reactions, toggle: actions.react) }
            // La barre sous la bulle : l'auteur à gauche (quand il n'est pas déjà en tête), les actions à droite.
            if turn.activity.isEmpty ? (!turn.answer.isEmpty || turn.live) : interactive {
                HStack(spacing: 6) {
                    if turn.activity.isEmpty {
                        AuthorChip(name: turn.authorName, seed: seed, face: turn.authorFace, at: turn.at, thinking: turn.live)
                    }
                    Spacer(minLength: 8)
                    if let actions, interactive {
                        footerActions(actions).opacity(isLatest || hovered ? 1 : 0)
                    }
                }
                .padding(.leading, 6).padding(.trailing, 26)
            }
        }
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .animation(.easeOut(duration: 0.15), value: hovered)
    }

    private func footerActions(_ actions: MessageActions) -> some View {
        let mine = Set(turn.reactions.filter(\.mine).map(\.emoji))
        return HStack(spacing: 4) {
            ActionIcon(symbol: mine.contains(Reactions.helpful) ? "hand.thumbsup.fill" : "hand.thumbsup", help: tr("Good response", "Réponse utile"),
                       active: mine.contains(Reactions.helpful)) { actions.react(Reactions.helpful) }
            ActionIcon(symbol: mine.contains(Reactions.unhelpful) ? "hand.thumbsdown.fill" : "hand.thumbsdown", help: tr("Bad response", "Réponse inutile"),
                       active: mine.contains(Reactions.unhelpful)) { actions.react(Reactions.unhelpful) }
            ActionIcon(symbol: copied ? "checkmark" : "doc.on.doc", help: copied ? tr("Copied", "Copié") : tr("Copy response", "Copier la réponse")) {
                ThreadCopy.copy(turn.answer)
                copied = true
                Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
            }
            MoreMenu(reactions: turn.reactions, actions: actions, copyText: turn.answer)
        }
    }
}

/// Votre message : la citation et les pièces au-dessus, la bulle ambrée à droite, l'heure au survol ;
/// à sa gauche au survol, réagir, répondre et « … » (`data-message-actions-placement="side"`), collés à la bulle.
struct UserMessageView: View {
    let text: String
    let attachments: [ConversationAttachment]
    let at: Date
    var pending = false
    var reactions: [MessageReaction] = []
    var replyTo: ReplyQuote? = nil
    var actions: MessageActions? = nil
    @State private var hovered = false
    @State private var picking = false

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if let replyTo { ReplyQuoteView(quote: replyTo) }
            if !attachments.isEmpty {
                VStack(alignment: .trailing, spacing: 6) {
                    ForEach(attachments) { AttachmentTile(attachment: $0, alignTrailing: true) }
                }
            }
            HStack(alignment: .bottom, spacing: 6) {
                Spacer(minLength: 0)
                if let actions {
                    sideActions(actions).opacity(hovered || picking ? 1 : 0)
                }
                if !text.isEmpty {
                    Text(text).font(.system(size: 13)).lineSpacing(3).foregroundStyle(Surface.textPrimary)
                        .textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Surface.bubbleUser))
                        .opacity(pending ? 0.75 : 1)
                        .help(ThreadCopy.stamp(at))
                        // La bulle se cale sur son texte : les actions restent collées à elle, jamais à l'autre bord.
                        .fixedSize(horizontal: false, vertical: true)
                        .layoutPriority(1)
                }
            }
            if let actions { ReactionsRow(reactions: reactions, toggle: actions.react) }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 40)
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .animation(.easeOut(duration: 0.15), value: hovered)
    }

    private func sideActions(_ actions: MessageActions) -> some View {
        HStack(spacing: 4) {
            ActionIcon(symbol: "face.smiling", help: tr("React", "Réagir"), active: picking) { picking.toggle() }
                .popover(isPresented: $picking, arrowEdge: .top) {
                    ReactionPicker(reactions: reactions) { emoji in picking = false; actions.react(emoji) }
                }
            ActionIcon(symbol: "arrowshape.turn.up.left", help: tr("Reply", "Répondre")) { actions.reply() }
            MoreMenu(reactions: reactions, actions: actions, copyText: text)
        }
        .padding(.bottom, 4)
    }
}

/// Un message écrit dans ce fil par un autre bot (`BotInboundMessage`).
struct InboundMessageView: View {
    let authorName: String
    let seed: String
    let face: BotFace?
    let text: String
    let at: Date

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            FaceView(seed: seed, name: authorName, face: face, size: 22).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(authorName).font(.system(size: 11)).foregroundStyle(Surface.textSecondary)
                MarkdownText(text: text)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 6, bottomTrailingRadius: 16,
                                                       topTrailingRadius: 16, style: .continuous).fill(Surface.bubbleBot.opacity(0.75)))
            }
            Spacer(minLength: 20)
        }
        .help(ThreadCopy.stamp(at))
    }
}

/// Le dock au-dessus du champ (`RunActivityDock`) : la grille qui ondule, « Nova : Rédige… », le chrono.
struct RunActivityDock: View {
    let botName: String
    let label: String
    let startedAt: Date

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 20)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 8) {
                // 3 × 3 points de 4 pt, une vague en diagonale.
                VStack(spacing: 2) {
                    ForEach(0..<3, id: \.self) { row in
                        HStack(spacing: 2) {
                            ForEach(0..<3, id: \.self) { col in
                                let phase = t * 2.2 - Double(row + col) * 0.35
                                Circle().fill(Surface.textPrimary)
                                    .frame(width: 4, height: 4)
                                    .opacity(0.25 + 0.75 * max(0, sin(phase * .pi)))
                            }
                        }
                    }
                }
                ShimmerText(text: tr("\(botName): \(label)", "\(botName) : \(label)"), size: 12)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(ToolCopy.elapsed(context.date.timeIntervalSince(startedAt)))
                    .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Surface.textSecondary)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Surface.raised))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.white.opacity(0.06), lineWidth: 1))
    }
}
