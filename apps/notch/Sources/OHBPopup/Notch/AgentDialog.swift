import AppKit
import SwiftUI
import os

enum DialogLog { static let log = Logger(subsystem: "app.openedbot.popup", category: "dialog") }

/// La fenêtre d'un agent : ce qu'il vient de faire, l'approbation à trancher, un mot à lui écrire.
/// Grammaire de la console openedbot : le bot dans une bulle grise (markdown rendu), vous dans une bulle
/// ambrée, les outils en une ligne repliée, l'approbation dans une carte qui devient un reçu une fois tranchée.
struct AgentDialogView: View {
    let model: NotchModel
    let botID: String
    let feed: any BotFeed
    let close: () -> Void
    /// Mode hébergé : ouvrir ce bot dans la console d'openedbot. nil en autonome.
    var openInConsole: ((String) -> Void)?

    @State private var draft = ""
    @State private var attachments: [PendingAttachment]
    /// Le dernier refus d'une pièce (trop lourde, format inconnu) ; s'efface au prochain geste.
    @State private var attachmentError: String?
    /// Le message cité par le prochain envoi (`replyToId`), comme la barre « Réponse à … » de la console.
    @State private var replyingTo: ReplyQuote?
    @State private var expandedTools: Set<UUID> = []
    @State private var pickerOpen = false
    @FocusState private var focused: Bool
    /// La largeur réelle de la fenêtre (redimensionnable) : le sélecteur de modèle s'y ajuste.
    @State private var width: CGFloat = AgentDialogView.size.width
    /// Le fil est-il (presque) tout en bas ? Sinon le bouton « aller en bas » apparaît et le
    /// direct ne tire plus la vue vers le bas pendant qu'on lit plus haut.
    @State private var atBottom = true
    /// Incrémenté à chaque envoi : son propre message ramène toujours en bas.
    @State private var sendCount = 0

    /// Taille d'ouverture et plancher du redimensionnement.
    static let size = CGSize(width: 570, height: 650)
    static let minSize = CGSize(width: 340, height: 380)

    init(model: NotchModel, botID: String, feed: any BotFeed, close: @escaping () -> Void, attachments: [PendingAttachment] = [],
         replyingTo: ReplyQuote? = nil, openInConsole: ((String) -> Void)? = nil) {
        self.model = model; self.botID = botID; self.feed = feed; self.close = close; self.openInConsole = openInConsole
        _attachments = State(initialValue: attachments)
        _replyingTo = State(initialValue: replyingTo)
    }

    var body: some View {
        if let bot = model.bot(botID) {
            // Le fil openedbot (messages + événements) ; en démo, la liste de lignes locale.
            let items = bot.conversation.map {
                ThreadTimeline.build($0, botName: bot.name, botID: bot.id, botFace: bot.face, locals: bot.thread)
            }
            let liveTurn = items?.reversed().lazy.compactMap { item -> Turn? in
                if case .turn(let t) = item, t.live { return t } else { return nil }
            }.first
            VStack(spacing: 0) {
                header(bot)
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            if let items {
                                if items.isEmpty, bot.pending == nil { emptyState(bot) }
                                let latestTurn = items.last { if case .turn(let t) = $0, t.messageID != nil, !t.live { return true } else { return false } }
                                ForEach(items) { item in row(item, bot: bot, latestTurnID: latestTurn.flatMap { if case .turn(let t) = $0 { t.id } else { nil } }) }
                            } else {
                                // Un fil sans parole (rien, ou des lignes système seules) : l'état vide à leur place.
                                let quiet = bot.thread.allSatisfy { $0.role == .system }
                                if quiet { emptyState(bot) }
                                ForEach(quiet ? [] : bot.thread) { m in message(m) }
                                if let live = bot.liveActivity { activityRow(live, bot: bot) }
                            }
                            if let approval = bot.pending { approvalCard(approval, bot: bot) }
                            Color.clear.frame(height: 1).id("end")
                        }
                        // Une gouttière à droite : la barre de défilement ne couvre jamais une bulle.
                        .padding(.leading, 14).padding(.trailing, 18).padding(.top, 10).padding(.bottom, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    // Collé en bas : quand une relecture change la hauteur des messages au-dessus, ou que
                    // la réponse s'écrit, la vue garde le bas du fil au lieu d'une position fixe.
                    .defaultScrollAnchor(.bottom, for: .initialOffset)
                    .defaultScrollAnchor(.bottom, for: .sizeChanges)
                    .onScrollGeometryChange(for: Bool.self) { g in
                        Self.isNearBottom(visibleMaxY: g.visibleRect.maxY, contentHeight: g.contentSize.height)
                    } action: { _, near in
                        if near != atBottom { withAnimation(.easeOut(duration: 0.15)) { atBottom = near } }
                    }
                    .onChange(of: items?.count ?? bot.thread.count) { _, _ in if atBottom { scrollToEnd(proxy) } }
                    .onChange(of: bot.conversation?.events.count) { _, _ in if atBottom { proxy.scrollTo("end", anchor: .bottom) } }
                    .onChange(of: bot.thread.last?.text) { _, _ in if atBottom { proxy.scrollTo("end", anchor: .bottom) } }
                    .onChange(of: bot.liveActivity) { _, _ in if atBottom { withAnimation { proxy.scrollTo("end", anchor: .bottom) } } }
                    // Une approbation demande une réponse : on la montre même si l'on lisait plus haut.
                    .onChange(of: bot.pending?.id) { _, _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
                    .onChange(of: sendCount) { _, _ in scrollToEnd(proxy) }
                    .onAppear { scrollToEnd(proxy) }
                    .overlay(alignment: .bottom) {
                        if !atBottom {
                            ScrollToBottomButton {
                                withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("end", anchor: .bottom) }
                            }
                            .padding(.bottom, 12)
                            .transition(.opacity.combined(with: .scale(scale: 0.85)))
                        }
                    }
                }
                // Le dock du direct, masqué pendant une approbation (comme la console).
                if let turn = liveTurn, bot.pending == nil {
                    let queued = turn.runID.flatMap { bot.conversation?.runs[$0]?.status } == .queued
                    RunActivityDock(botName: bot.name, label: ToolCopy.liveLabel(turn, queued: queued), startedAt: turn.startedAt)
                        .padding(.horizontal, 12).padding(.top, 6)
                        .transition(.opacity)
                }
                composer(bot)
            }
            .animation(.easeOut(duration: 0.2), value: liveTurn?.id)
            .frame(minWidth: Self.minSize.width, maxWidth: .infinity, minHeight: Self.minSize.height, maxHeight: .infinity)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Surface.window))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Surface.ring, lineWidth: 1))
            .preferredColorScheme(.dark)
        }
    }

    /// Assez près du bas pour suivre le direct : 48 pt de marge, comme une ligne et demie.
    nonisolated static func isNearBottom(visibleMaxY: CGFloat, contentHeight: CGFloat, threshold: CGFloat = 48) -> Bool {
        visibleMaxY >= contentHeight - threshold
    }

    /// Tout de suite, puis une fois les textes mis en page (leur hauteur n'est connue qu'après).
    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        proxy.scrollTo("end", anchor: .bottom)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { proxy.scrollTo("end", anchor: .bottom) }
    }

    @ViewBuilder
    private func row(_ item: TimelineItem, bot: Bot, latestTurnID: String?) -> some View {
        switch item {
        case .day(let date):
            DayChip(date: date)
        case .user(let id, let text, let attachments, let at, let reactions, let replyTo):
            UserMessageView(text: text, attachments: attachments, at: at, reactions: reactions, replyTo: replyTo,
                            actions: actions(messageID: id, author: tr("You", "Vous"), text: text, bot: bot))
        case .turn(let turn):
            TurnView(turn: turn,
                     actions: turn.messageID.map { actions(messageID: $0, author: turn.authorName, text: turn.answer, bot: bot) },
                     isLatest: turn.id == latestTurnID)
        case .inbound(_, let name, let face, let authorID, let text, let at):
            InboundMessageView(authorName: name, seed: authorID ?? name, face: face, text: text, at: at)
        case .local(let m):
            if m.role == .user {
                UserMessageView(text: m.text,
                                attachments: m.attachments.map { ConversationAttachment(remoteID: nil, name: $0, contentType: "", kind: "document", bytes: nil) },
                                at: m.at, pending: m.remoteID == nil)
            } else {
                message(m)
            }
        }
    }

    /// Réagir passe par le flux ; répondre prépare la citation et donne le clavier au champ.
    private func actions(messageID: String, author: String, text: String, bot: Bot) -> MessageActions {
        MessageActions(
            react: { emoji in feed.react(botID: bot.id, messageID: messageID, emoji: emoji) },
            reply: {
                let flat = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
                replyingTo = ReplyQuote(messageID: messageID, authorName: author, excerpt: String(flat.prefix(160)))
                focused = true
            }
        )
    }

    // MARK: En-tête

    private func header(_ bot: Bot) -> some View {
        // Une rangée : le nom, la puce de modèle à côté, l'état et la croix. Si les mots ne tiennent pas,
        // la puce perd d'abord l'effort ; si ça ne suffit toujours pas (nom de bot long,
        // « attend ton accord »), elle descend sous le nom, entière.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                avatar(bot)
                name(bot)
                modelChip(bot)
                Spacer(minLength: 0)
                consoleButton(bot)
                closeButton
            }
            HStack(spacing: 8) {
                avatar(bot)
                name(bot)
                modelChip(bot, compact: true)
                Spacer(minLength: 0)
                consoleButton(bot)
                closeButton
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    avatar(bot)
                    name(bot)
                    Spacer(minLength: 0)
                    consoleButton(bot)
                    closeButton
                }
                modelChip(bot).padding(.leading, 36)
            }
        }
        .task { await feed.loadModelCatalog() }
        .onChange(of: pickerOpen) { _, open in model.openPickers += open ? 1 : -1 }
        .onChange(of: model.closePickersTick) { _, _ in pickerOpen = false }
        .padding(.horizontal, 12).padding(.top, 9).padding(.bottom, 9)
        // Ancré au milieu du bas de l'en-tête, pas sur la puce : centré sur la fenêtre et aussi large
        // qu'elle moins ses marges, le sélecteur n'en déborde jamais, quelle que soit sa largeur.
        .popover(isPresented: $pickerOpen, attachmentAnchor: .point(.bottom), arrowEdge: .bottom) {
            ModelPickerView(bot: bot, catalog: model.modelCatalog, feed: feed, width: width - 16)
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Surface.separator).frame(height: 1) }
        .contentShape(Rectangle())
        // L'en-tête est la poignée : on déplace la fenêtre en le tirant.
        .gesture(WindowDragGesture())
    }

    private func avatar(_ bot: Bot) -> some View {
        AvatarView(bot: bot, size: 22)
            .frame(width: 28, height: 28)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Surface.field))
    }

    private func name(_ bot: Bot) -> some View {
        Text(bot.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Surface.textPrimary)
            .lineLimit(1).fixedSize()
    }

    private func modelChip(_ bot: Bot, compact: Bool = false) -> some View {
        ModelChip(bot: bot, catalog: model.modelCatalog, open: $pickerOpen, compact: compact)
    }

    /// Hébergée seulement : le fil du bot dans la console d'openedbot (`/bot/:botId`).
    @ViewBuilder
    private func consoleButton(_ bot: Bot) -> some View {
        if let openInConsole {
            Button { openInConsole(AppDelegate.consolePath(botID: bot.id)) } label: {
                Image(systemName: "arrow.up.forward.app").font(.system(size: 11, weight: .semibold)).foregroundStyle(Surface.textSecondary)
                    .frame(width: 24, height: 24)
                    .background(Circle().fill(Surface.field))
            }
            .buttonStyle(.plain)
            .pointer()
            .help(tr("Open in the console", "Ouvrir dans la console"))
        }
    }

    private var closeButton: some View {
        Button(action: close) {
            Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Surface.textSecondary)
                .frame(width: 24, height: 24)
                .background(Circle().fill(Surface.field))
        }
        .buttonStyle(.plain)
        .pointer()
        .help(tr("Close (Esc)", "Fermer (Échap)"))
    }

    /// Trois points qui respirent et un mot : le bot réfléchit, écrit, utilise un outil.
    private func activityRow(_ live: LiveActivity, bot: Bot) -> some View {
        HStack(spacing: 8) {
            TimelineView(.animation(minimumInterval: 1 / 20)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                HStack(spacing: 3) {
                    ForEach(0..<3, id: \.self) { i in
                        Circle().fill(Surface.textPrimary)
                            .frame(width: 5, height: 5)
                            .opacity(0.25 + 0.75 * max(0, sin((t * 2.4 - Double(i) * 0.55) * .pi)))
                    }
                }
            }
            Text("\(bot.name) \(live.word)…").font(.system(size: 12)).foregroundStyle(Surface.textSecondary)
        }
        .padding(.horizontal, 4).padding(.top, 2)
        .transition(.opacity)
    }

    private func emptyState(_ bot: Bot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(tr("Nothing to review.", "Rien à relire.")).font(.system(size: 13, weight: .medium)).foregroundStyle(Surface.textPrimary)
            Text(bot.routine.map { tr("\(bot.name) will run “\($0.name)” \($0.next). Message it if you’d rather not wait.", "\(bot.name) lancera « \($0.name) » \($0.next). Écrivez-lui si vous n'attendez pas.") }
                 ?? tr("\(bot.name) is waiting for your message.", "\(bot.name) attend que vous lui écriviez."))
                .font(.system(size: 12)).foregroundStyle(Surface.textSecondary)
        }
        .padding(.horizontal, 4).padding(.top, 6)
    }

    // MARK: Messages

    @ViewBuilder
    private func message(_ m: ChatMessage) -> some View {
        switch m.role {
        case .user:
            // Vous : une bulle ambrée à droite, comme dans la console ; les pièces jointes au-dessus du mot.
            HStack { Spacer(minLength: 56)
                VStack(alignment: .trailing, spacing: 6) {
                    if !m.attachments.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(m.attachments.enumerated()), id: \.offset) { _, name in
                                HStack(spacing: 5) {
                                    Image(systemName: "paperclip").font(.system(size: 10, weight: .semibold))
                                    Text(name).font(.system(size: 11.5, weight: .medium)).lineLimit(1).truncationMode(.middle)
                                }
                                .foregroundStyle(Surface.textPrimary.opacity(0.92))
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(Capsule().fill(Color.black.opacity(0.18)))
                            }
                        }
                    }
                    if !m.text.isEmpty {
                        Text(m.text).font(.system(size: 13)).lineSpacing(3).foregroundStyle(Surface.textPrimary)
                            .textSelection(.enabled)
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Surface.bubbleUser))
            }
        case .bot:
            // Le bot : une bulle grise à gauche, sans liseré, le markdown rendu (gras, listes, code).
            HStack {
                MarkdownText(text: m.text)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Surface.bubbleBot))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 20)
            }
        case .tool:
            toolLine(m)
        case .system:
            // Entière et copiable : un refus du serveur porte sa référence, à retrouver dans ses journaux.
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Circle().fill(Surface.textTertiary).frame(width: 3, height: 3)
                Text(m.text).font(.system(size: 11)).foregroundStyle(Surface.textSecondary)
                    .lineLimit(5).fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 4)
        }
    }

    /// Un outil : une ligne discrète, dépliable ; la commande en mono.
    private func toolLine(_ m: ChatMessage) -> some View {
        let open = expandedTools.contains(m.id)
        return Button {
            if open { expandedTools.remove(m.id) } else { expandedTools.insert(m.id) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold))
                    .foregroundStyle(Surface.textTertiary)
                    .rotationEffect(.degrees(open ? 90 : 0))
                Text(m.text).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Surface.textSecondary)
                    .textSelection(.enabled)
                    .lineLimit(open ? nil : 1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 4).padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.16), value: open)
    }

    // MARK: Approbation

    private func approvalCard(_ approval: Approval, bot: Bot) -> some View {
        let minutes = max(1, Int(approval.expiresAt.timeIntervalSince(model.now) / 60))
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "terminal")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.waiting)
                    .frame(width: 32, height: 32)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.waiting.opacity(0.14)))
                VStack(alignment: .leading, spacing: 1) {
                    Text(tr("Command \(approval.tool)", "Commande \(approval.tool)")).font(.system(size: 13, weight: .medium)).foregroundStyle(Surface.textPrimary)
                    Text(tr("\(bot.name) wants to run it on \(bot.runtime.name)", "\(bot.name) veut l'exécuter sur \(bot.runtime.name)")).font(.system(size: 11)).foregroundStyle(Surface.textSecondary)
                }
                Spacer(minLength: 6)
                Text(tr("expires in \(minutes) min", "expire dans \(minutes) min")).font(.system(size: 11)).foregroundStyle(Surface.textTertiary)
            }
            Text(approval.command)
                .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Surface.textPrimary.opacity(0.85))
                .textSelection(.enabled)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.06)))
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                DecisionButton(title: tr("Deny", "Refuser"), hint: "⌘⌫", style: .ghost) { feed.respond(approvalID: approval.id, allow: false) }
                    .keyboardShortcut(.delete, modifiers: .command)
                // ⌘↩ et non ↩ : Entrée seule appartient au champ de saisie, qui envoie le message.
                DecisionButton(title: tr("Allow once", "Autoriser une fois"), hint: "⌘↩", style: .filled(Palette.ample)) { feed.respond(approvalID: approval.id, allow: true) }
                    .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Surface.raised))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Palette.waiting.opacity(0.35), lineWidth: 1))
        .transition(.opacity)
    }

    // MARK: Composer

    /// La pilule de BoardUI : « + » pour joindre, le champ, la flèche ; les pièces en chips au-dessus du champ.
    private func composer(_ bot: Bot) -> some View {
        let emptyText = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let canSend = !emptyText || !attachments.isEmpty
        return VStack(alignment: .leading, spacing: 6) {
            if let attachmentError {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.circle").font(.system(size: 11, weight: .semibold))
                    Text(attachmentError).font(.system(size: 11.5)).lineLimit(2)
                }
                .foregroundStyle(Surface.error)
                .padding(.horizontal, 6)
                .transition(.opacity)
            }
            VStack(alignment: .leading, spacing: 6) {
                if let quote = replyingTo {
                    HStack(spacing: 8) {
                        Image(systemName: "arrowshape.turn.up.left").font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(Surface.textSecondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(tr("Replying to \(quote.authorName)", "Réponse à \(quote.authorName)")).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Surface.textPrimary)
                            Text(quote.excerpt.isEmpty ? "…" : quote.excerpt).font(.system(size: 11)).foregroundStyle(Surface.textSecondary)
                                .lineLimit(1).truncationMode(.tail)
                        }
                        Spacer(minLength: 4)
                        Button { replyingTo = nil } label: {
                            Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).foregroundStyle(Surface.textSecondary)
                                .frame(width: 18, height: 18).background(Circle().fill(Color.white.opacity(0.08)))
                        }
                        .buttonStyle(.plain)
                        .pointer()
                        .help(tr("Cancel reply", "Annuler la réponse"))
                    }
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.05)))
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 1).fill(Color(hex: 0x3B82F6).opacity(0.6)).frame(width: 2).padding(.vertical, 6)
                    }
                    .transition(.opacity)
                }
                if !attachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) { ForEach(attachments) { attachmentChip($0) } }
                            .padding(.horizontal, 2)
                    }
                    .padding(.top, 2)
                }
                HStack(alignment: .bottom, spacing: 8) {
                    Button(action: pickAttachments) {
                        Image(systemName: "plus").font(.system(size: 13, weight: .semibold)).foregroundStyle(Surface.textPrimary)
                            .frame(width: 32, height: 32)
                            .background(Circle().fill(Color.white.opacity(0.08)))
                    }
                    .buttonStyle(.plain)
                    .pointer()
                    .help(tr("Attach an image, a PDF or a text file (up to 5, 1 MB each)", "Joindre une image, un PDF ou un texte (5 pièces, 1 Mo chacune)"))
                    TextField(tr("Write to \(bot.name)…", "Écrire à \(bot.name)…"), text: $draft, axis: .vertical)
                        .lineLimit(1...5)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13))
                        .foregroundStyle(Surface.textPrimary)
                        .padding(.vertical, 7)
                        .focused($focused)
                        .onSubmit(send)
                    Button(action: send) {
                        Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold)).foregroundStyle(Surface.window)
                            .frame(width: 32, height: 32).background(Circle().fill(Surface.textPrimary))
                    }
                    .buttonStyle(.plain)
                    .pointer()
                    .disabled(!canSend)
                    .opacity(canSend ? 1 : 0.4)
                    .help(tr("Send (↩)", "Envoyer (↩)"))
                }
            }
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Surface.field))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(focused ? Color.white.opacity(0.22) : .clear, lineWidth: 1))
            // Glisser des fichiers sur la pilule les joint aussi.
            .dropDestination(for: URL.self) { urls, _ in attach(urls) ; return true }
        }
        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 12)
        .animation(.easeOut(duration: 0.16), value: attachments.count)
        .animation(.easeOut(duration: 0.16), value: attachmentError)
        .animation(.easeOut(duration: 0.16), value: replyingTo)
    }

    private func attachmentChip(_ item: PendingAttachment) -> some View {
        HStack(spacing: 6) {
            Image(systemName: item.kind == .image ? "photo" : "doc.text").font(.system(size: 11, weight: .medium))
                .foregroundStyle(Surface.textSecondary)
            Text(item.name).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Surface.textPrimary)
                .lineLimit(1).truncationMode(.middle).frame(maxWidth: 150)
            Button { attachments.removeAll { $0.id == item.id }; attachmentError = nil } label: {
                Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).foregroundStyle(Surface.textSecondary)
                    .frame(width: 16, height: 16).background(Circle().fill(Color.white.opacity(0.08)))
            }
            .buttonStyle(.plain)
            .pointer()
            .help(tr("Remove", "Retirer"))
        }
        .padding(.leading, 9).padding(.trailing, 5).frame(height: 26)
        .background(Capsule().fill(Color.white.opacity(0.07)))
        .help("\(item.name) · \(ThreadCopy.byteCount(item.bytes))")
    }

    /// Le sélecteur de fichiers : images et textes, plusieurs à la fois. En feuille sur la fenêtre d'agent :
    /// elle a déjà le clavier sans activer l'app, alors qu'un sélecteur libre s'ouvrirait derrière l'app
    /// au premier plan, sans clavier (macOS refuse qu'une app inactive se donne le premier plan).
    private func pickAttachments() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image, .pdf, .text, .json]
        panel.message = tr("Images, PDFs and text files, up to 5, 1 MB each.", "Images, PDF et textes, 5 pièces au plus, 1 Mo chacune.")
        panel.prompt = tr("Attach", "Joindre")
        guard let host = NSApp.windows.first(where: { $0 is DialogPanel && $0.isVisible && ($0.isKeyWindow || $0.title == botID) }) else {
            if panel.runModal() == .OK { attach(panel.urls) }
            return
        }
        panel.beginSheetModal(for: host) { response in
            guard response == .OK else { return }
            attach(panel.urls)
        }
        DialogLog.log.notice("sélecteur de fichiers ouvert en feuille ; fenêtre clé : \(NSApp.keyWindow.map { String(describing: type(of: $0)) } ?? "aucune", privacy: .public), app active : \(NSApp.isActive)")
    }

    /// Lit, borne et ajoute chaque fichier ; le premier refus s'affiche, les autres fichiers passent quand même.
    private func attach(_ urls: [URL]) {
        var firstError: String?
        for url in urls {
            do {
                let item = try AttachmentRules.load(url)
                try AttachmentRules.check(adding: item, to: attachments)
                attachments.append(item)
            } catch {
                if firstError == nil { firstError = error.message }
            }
        }
        attachmentError = firstError
        focused = true
    }

    private func send() {
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else { return }
        let items = attachments
        let reply = replyingTo?.messageID
        draft = ""
        attachments = []
        attachmentError = nil
        replyingTo = nil
        feed.send(text, attachments: items, replyTo: reply, to: botID)
        sendCount += 1
    }
}

/// « Aller en bas », comme `ThreadPrimitive.ScrollToBottom` de la console : un rond de 32 pt,
/// centré au-dessus du composer, visible seulement quand on a quitté le bas du fil.
struct ScrollToBottomButton: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.down")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Surface.textPrimary)
                .frame(width: 32, height: 32)
                .background(Circle().fill(hovering ? Surface.field : Surface.raised))
                .overlay(Circle().stroke(Surface.control, lineWidth: 1))
                .shadow(color: .black.opacity(0.35), radius: 6, y: 2)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .pointer()
        .help(tr("Scroll to bottom", "Aller en bas"))
        .accessibilityLabel(tr("Scroll to bottom", "Aller en bas"))
    }
}

/// Une touche, comme BoardUI la dessine : pilule grise, légende semi-grasse.
struct Kbd: View {
    let key: String
    /// Sur un bouton plein, la touche s'assombrit au lieu de rester grise.
    var onFilled = false
    init(_ key: String, onFilled: Bool = false) { self.key = key; self.onFilled = onFilled }
    var body: some View {
        Text(key).font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(onFilled ? Color.black.opacity(0.7) : Color(hex: 0xA1A1A1))
            .padding(.horizontal, 5).padding(.vertical, 1.5)
            .background(Capsule().fill(onFilled ? Color.black.opacity(0.14) : Surface.control))
    }
}

/// Les deux boutons d'une décision : fantôme pour refuser, plein pour autoriser.
struct DecisionButton: View {
    enum Style { case ghost, filled(Color) }
    let title: String
    var hint: String? = nil
    let style: Style
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title).font(.system(size: 12, weight: .medium))
                if let hint { Kbd(hint, onFilled: { if case .filled = style { true } else { false } }()) }
            }
            .padding(.horizontal, 12).frame(height: 30)
            .foregroundStyle(foreground)
            .background(Capsule().fill(background))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .pointer()
    }

    private var foreground: Color {
        switch style { case .ghost: Surface.textPrimary; case .filled: Color.black }
    }
    private var background: Color {
        switch style { case .ghost: Color.white.opacity(0.06); case .filled(let c): c }
    }
}

/// Un panneau par agent ouvert, posé à côté de l'encoche. Devient key quand on y tape.
@MainActor
final class AgentDialogController {
    let botID: String
    let panel: NSPanel

    init(botID: String, model: NotchModel, feed: any BotFeed, frame: NSRect, openInConsole: ((String) -> Void)? = nil,
         close: @escaping () -> Void) {
        self.botID = botID
        panel = DialogPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
        panel.minSize = AgentDialogView.minSize
        panel.title = botID
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // Déplaçable à la souris : par l'en-tête (geste), ou par tout fond sans contrôle.
        panel.isMovable = true
        panel.isMovableByWindowBackground = true
        panel.contentView = NSHostingView(rootView: AgentDialogView(model: model, botID: botID, feed: feed, close: close,
                                                                    openInConsole: openInConsole))
        // Key sans activer l'app (panneau non activant) : Échap et ↩ / ⌘⌫ marchent dès l'ouverture,
        // qu'elle vienne de l'anneau, du plateau ou du menu de la barre.
        panel.makeKeyAndOrderFront(nil)
    }

    func close() { panel.orderOut(nil) }
}

final class DialogPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
