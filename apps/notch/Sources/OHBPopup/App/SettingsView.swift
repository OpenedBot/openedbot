import SwiftUI

/// Les réglages : un rail à gauche, une page à la fois, des cartes de rangées.
/// Même grammaire que la fenêtre d'agent : paliers de gris, un seul accent par état.
struct SettingsView: View {
    @Bindable var model: NotchModel
    let feed: MockBotFeed
    var account: AccountModel
    /// Mode hébergé : la session est celle d'openedbot. nil en autonome.
    var host: HostTokenSource?
    @State private var page: Page

    init(model: NotchModel, feed: MockBotFeed, account: AccountModel, host: HostTokenSource? = nil, page: Page = .general) {
        self.model = model
        self.feed = feed
        self.account = account
        self.host = host
        _page = State(initialValue: page)
    }

    /// Les jetons des réglages : ceux d'openedbot en hébergé, le compte local sinon.
    private var tokens: any TokenSource { host ?? account }
    /// Hébergée : pas de démo (sans session, l'encoche invite à se connecter dans openedbot).
    private var pages: [Page] { host == nil ? Page.allCases : Page.allCases.filter { $0 != .demo } }

    enum Page: String, CaseIterable, Identifiable {
        case general, account, models, journal, notch, menuBar, announcements, demo
        var id: String { rawValue }
        var title: String {
            switch self {
            case .general: tr("General", "Général")
            case .account: tr("Account", "Compte")
            case .models: tr("Models", "Modèles")
            case .journal: tr("Log", "Journal")
            case .notch: tr("Notch", "Encoche")
            case .menuBar: tr("Menu bar", "Barre de menus")
            case .announcements: tr("Announcements", "Annonces")
            case .demo: tr("Demo", "Démo")
            }
        }
        var symbol: String {
            switch self {
            case .general: "gearshape"
            case .account: "person.crop.circle"
            case .models: "cpu"
            case .journal: "list.bullet.rectangle"
            case .notch: "rectangle.righthalf.inset.filled"
            case .menuBar: "menubar.rectangle"
            case .announcements: "bell"
            case .demo: "play.circle"
            }
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            rail
            if page == .journal {
                // Le journal suit la fenêtre dans les deux sens : sa liste prend toute la hauteur restante.
                VStack(alignment: .leading, spacing: 18) {
                    title
                    JournalPage(model: model)
                }
                .padding(.horizontal, 28).padding(.bottom, 28)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        title
                        switch page {
                        case .general: generalPage
                        case .account:
                            if let host { HostedAccountPage(host: host, feedState: model.feedState) } else { AccountPage(account: account, feedState: model.feedState) }
                        case .models: ModelsPage(account: tokens, notch: model, openAccount: { page = .account })
                        case .journal: EmptyView()
                        case .notch: notchPage
                        case .menuBar: menuBarPage
                        case .announcements: announcementsPage
                        case .demo: demoPage
                        }
                    }
                    .padding(.horizontal, 28).padding(.bottom, 28)
                    // Les cartes suivent la largeur, jusqu'à une ligne lisible.
                    .frame(maxWidth: 960, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(minWidth: 680, maxWidth: .infinity, minHeight: 500, maxHeight: .infinity, alignment: .top)
        .background(Surface.window)
        // La barre de titre est fondue : la vue passe dessous, le rail garde ses 40 pt pour les feux.
        .ignoresSafeArea()
        .preferredColorScheme(.dark)
    }

    /// Même ligne de départ que le libellé « Réglages » du rail, sous les feux.
    private var title: some View {
        Text(page.title).font(.system(size: 18, weight: .medium)).foregroundStyle(Surface.textPrimary)
            .padding(.top, 34)
    }

    private var rail: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(tr("Settings", "Réglages")).font(.system(size: 11, weight: .medium)).foregroundStyle(Surface.textSecondary)
                .padding(.horizontal, 10).padding(.top, 40).padding(.bottom, 8)
            ForEach(pages) { p in
                Button { page = p } label: {
                    HStack(spacing: 8) {
                        Image(systemName: p.symbol).font(.system(size: 13)).frame(width: 18)
                            .foregroundStyle(page == p ? Surface.textPrimary : Surface.textSecondary)
                        Text(p.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                            .foregroundStyle(page == p ? Surface.textPrimary : Color(hex: 0xA1A1A1))
                        Spacer(minLength: 0)
                    }
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(page == p ? Surface.field : .clear))
                    .contentShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .pointer()
            }
            Spacer()
        }
        .padding(10)
        .frame(width: 172)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Surface.raised)
        .overlay(alignment: .trailing) { Rectangle().fill(Surface.separator).frame(width: 1) }
    }

    // MARK: Pages

    private var generalPage: some View {
        SettingsCard {
            SettingsRow(tr("Language", "Langue"), tr("Applies at once to the notch, chat windows and menus",
                                                      "S'applique aussitôt à l'encoche, aux fenêtres de chat et aux menus"), layout: .below) {
                Segmented(selection: Binding(get: { Language.shared.value }, set: { Language.shared.value = $0 }),
                          options: AppLanguage.allCases.map { ($0, $0.nativeName) })
            }
        }
    }

    private var notchPage: some View {
        VStack(alignment: .leading, spacing: 16) {
            SettingsCard {
                SettingsRow(tr("Position", "Position"), tr("On the right edge, on top of the Dock, or as an island under the camera",
                                                          "Au bord droit, posée sur le Dock, ou en île sous la caméra"), layout: .below) {
                    Segmented(selection: $model.edge, options: NotchEdge.allCases.map { ($0, $0.title) })
                }
                SettingsRow(tr("Size", "Taille")) {
                    Segmented(selection: $model.sizeScale, options: [(0.85, tr("Small", "Petite")), (1, tr("Medium", "Moyenne")), (1.2, tr("Large", "Grande"))])
                }
                SettingsRow(tr("Display", "Affichage"), tr("By section folds each section into a stack beyond six bots", "Par section replie chaque section en une pile au-delà de six bots"), layout: .below) {
                    Segmented(selection: $model.viewMode, options: ViewMode.allCases.map { ($0, $0.title) })
                }
                SettingsRow(tr("Recenter", "Recentrer"), tr("Undoes the ⌥-drag of the notch", "Annule le glissement fait avec ⌥ sur l'encoche")) {
                    SecondaryButton(tr("Recenter", "Recentrer")) { model.alongOffset = 0 }
                }
            }
            SettingsCard {
                SettingsRow(tr("Always show", "Toujours afficher"), tr("The notch stays unfolded, no hover needed", "L'encoche reste dépliée, sans survol")) { Switch(isOn: $model.alwaysOn) }
                SettingsRow(tr("Hide the notch", "Masquer l'encoche"), tr("The menu bar icon remains", "Il reste l'icône de la barre de menus")) { Switch(isOn: $model.isHidden) }
            }
        }
    }

    private var menuBarPage: some View {
        SettingsCard {
            SettingsRow(tr("Show activity", "Afficher l'activité"), tr("Who is working, who is waiting, how many runs and approvals", "Qui travaille, qui attend, combien de runs et d'approbations")) { Switch(isOn: $model.menuBarActivity) }
        }
    }

    private var announcementsPage: some View {
        SettingsCard {
            SettingsRow(tr("Open the notch", "Ouvrir l'encoche"), tr("When a run finishes or a bot needs your approval", "Quand un run finit ou qu'un bot attend votre accord")) { Switch(isOn: $model.announces) }
            SettingsRow(tr("Play a sound", "Jouer un son")) { Switch(isOn: $model.plays).disabled(!model.announces) }
            SettingsRow(tr("macOS notifications while away", "Notifications macOS en ton absence"),
                        tr("On the lock screen or when you are away from the keyboard. macOS asks for permission once.",
                           "Sur l'écran verrouillé ou loin du clavier. macOS demande l'autorisation une fois.")) {
                Switch(isOn: $model.systemNotifications)
            }
        }
    }

    private var demoPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            if account.isSignedIn {
                Text(tr("Signed in: the notch follows your openedbot bots. Sign out to go back to the demo bots.", "Compte connecté : l'encoche suit vos bots openedbot. Déconnectez-vous pour revenir aux bots de démonstration."))
                    .font(.system(size: 12)).foregroundStyle(Surface.textSecondary)
            } else {
                Text(tr("Without an account, the notch shows ten demo bots. Sign in to follow yours.", "Sans compte, l'encoche montre dix bots de démonstration. Connectez-vous pour suivre les vôtres."))
                    .font(.system(size: 12)).foregroundStyle(Surface.textSecondary)
            }
            SettingsCard {
                SettingsRow(tr("Support is waiting", "Support attend"), tr("A payment approval on the current run", "Une approbation de paiement sur le run en cours")) { SecondaryButton(tr("Run", "Lancer")) { feed.simulateApproval() } }
                SettingsRow(tr("Support is done", "Support a fini"), tr("The run ends and the notch announces it", "Le run se termine, l'encoche l'annonce")) { SecondaryButton(tr("Run", "Lancer")) { feed.simulateFinish() } }
                SettingsRow(tr("gpu-box goes down or comes back", "gpu-box tombe ou revient"), tr("Growth's runtime changes state", "Le runtime de Growth change d'état")) { SecondaryButton(tr("Toggle", "Basculer")) { feed.toggleOffline() } }
                SettingsRow(tr("Replay the demo", "Rejouer la démo"), tr("Resets the ten bots to their starting state", "Remet les dix bots à leur état de départ")) { SecondaryButton(tr("Replay", "Rejouer")) { feed.start() } }
            }
            .disabled(account.isSignedIn)
            .opacity(account.isSignedIn ? 0.5 : 1)
        }
    }
}

// MARK: - Compte

/// Le compte openedbot : l'adresse du serveur, puis Google ou identifiants, puis qui est connecté.
struct AccountPage: View {
    @Bindable var account: AccountModel
    var feedState: NotchModel.FeedState?
    @State private var email = ""
    @State private var password = ""
    @State private var emailCode = ""
    @State private var organizationSlug = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SettingsCard {
                SettingsRow(tr("Server", "Serveur"), account.origin == nil ? OHBotAuthError.invalidOrigin.userMessage : nil, descriptionColor: Surface.error) {
                    SettingsField("https://api.openedbot.app", text: $account.originText)
                        .disabled(account.isSignedIn)
                        .onSubmit { Task { await account.checkProviders() } }
                }
            }

            switch account.phase {
            case .signedIn:
                SettingsCard {
                    HStack(spacing: 12) {
                        Text(String((account.account?.user?.email ?? "?").prefix(1)).uppercased())
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(Surface.textPrimary)
                            .frame(width: 32, height: 32).background(Circle().fill(Surface.field))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(account.account?.user?.displayName ?? account.account?.user?.name ?? account.account?.user?.email ?? tr("Saved session", "Session enregistrée"))
                                .font(.system(size: 13, weight: .medium)).foregroundStyle(Surface.textPrimary).lineLimit(1)
                            Text(signedInDetail).font(.system(size: 12)).foregroundStyle(Surface.textSecondary).lineLimit(1)
                        }
                        Spacer()
                        SecondaryButton(tr("Sign out", "Se déconnecter")) { Task { await account.signOut() } }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    if let feedState {
                        SettingsRow(tr("openedbot feed", "Flux openedbot"), feedState.text, descriptionColor: feedStateColor(feedState)) {
                            Circle().fill(feedStateColor(feedState)).frame(width: 8, height: 8)
                        }
                    }
                }
            case .busy(let what):
                SettingsCard {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text(what).font(.system(size: 13)).foregroundStyle(Surface.textPrimary)
                        Spacer()
                        SecondaryButton(tr("Cancel", "Annuler")) { account.cancelGoogle() }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                }
            case .signedOut:
                passwordSignInForm(codeRequired: false)
            case .codeRequired:
                passwordSignInForm(codeRequired: true)
            }

            if let error = account.error {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.circle").font(.system(size: 11))
                    Text(error).font(.system(size: 12))
                }
                .foregroundStyle(Surface.error)
            }
        }
        .task { await account.checkProviders() }
        .onChange(of: emailCode) { _, value in
            let digits = String(value.filter { "0123456789".contains($0) }.prefix(6))
            if digits != value { emailCode = digits }
        }
        // The pending code challenge lives with this page's credentials: leaving
        // the page drops it, so coming back never shows an empty, locked form.
        .onDisappear { account.cancelCodeSignIn() }
    }

    @ViewBuilder
    private func passwordSignInForm(codeRequired: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if !codeRequired {
                if let p = account.providers, !p.googleEnabled {
                    Text(tr("Google sign-in is unavailable on this server\(p.google?.reason.map { ": \($0)" } ?? "").", "Connexion Google indisponible sur ce serveur\(p.google?.reason.map { " : \($0)" } ?? "")."))
                        .font(.system(size: 12)).foregroundStyle(Surface.textSecondary)
                } else {
                    SecondaryButton(tr("Continue with Google", "Continuer avec Google"), symbol: "globe", wide: true) { account.signInWithGoogle() }
                        .disabled(account.origin == nil)
                }
                HStack(spacing: 10) {
                    Rectangle().fill(Surface.separator).frame(height: 1)
                    Text(tr("or with a password", "ou avec un mot de passe")).font(.system(size: 11)).foregroundStyle(Surface.textTertiary)
                    Rectangle().fill(Surface.separator).frame(height: 1)
                }
            }
            VStack(spacing: 8) {
                SettingsField(tr("Email", "E-mail"), text: $email, wide: true).textContentType(.username)
                    .disabled(codeRequired)
                SettingsField(tr("Password", "Mot de passe"), text: $password, secure: true, wide: true).textContentType(.password)
                    .onSubmit { Task { await signIn() } }
                    .disabled(codeRequired)
                SettingsField(tr("Organization (optional)", "Organisation (facultatif)"), text: $organizationSlug, wide: true)
                    .disabled(codeRequired)
                if codeRequired {
                    SettingsField(tr("Code received by email", "Code reçu par email"), text: $emailCode, wide: true)
                        .onSubmit { Task { await signIn() } }
                }
            }
            if codeRequired {
                Button(tr("Back", "Retour")) { cancelCodeSignIn() }
                    .buttonStyle(.plain)
                    .foregroundStyle(Surface.textSecondary)
            }
            PrimaryButton(
                codeRequired ? tr("Verify code", "Vérifier le code") : tr("Sign in", "Se connecter"),
                wide: true
            ) { Task { await signIn() } }
                .keyboardShortcut(.defaultAction)
                .disabled(account.origin == nil || email.isEmpty || password.isEmpty || (codeRequired && emailCode.count != 6))
        }
    }

    private func feedStateColor(_ s: NotchModel.FeedState) -> Color {
        switch s {
        case .live: Palette.ample
        case .connecting: Surface.textSecondary
        case .retrying: Palette.waiting
        case .failed: Surface.error
        }
    }

    private var signedInDetail: String {
        let org = account.account?.organization?.name ?? account.account?.organization?.slug
        let role = account.account?.role
        switch (org, role) {
        case let (o?, r?): return tr("\(o), \(r) role", "\(o), rôle \(r)")
        case let (o?, nil): return o
        case let (nil, r?): return tr("\(r) role", "rôle \(r)")
        default: return account.account == nil ? tr("account not verified, server unreachable", "compte non vérifié, serveur injoignable") : account.originText
        }
    }

    private func signIn() async {
        let verificationCode: String?
        if case .codeRequired = account.phase {
            verificationCode = emailCode.isEmpty ? nil : emailCode
        } else {
            verificationCode = nil
        }
        await account.signIn(
            email: email,
            password: password,
            organizationSlug: organizationSlug,
            emailCode: verificationCode
        )
        if account.isSignedIn {
            password = ""
            emailCode = ""
        } else if case .signedOut = account.phase {
            emailCode = ""
        }
    }

    private func cancelCodeSignIn() {
        account.cancelCodeSignIn()
        email = ""
        password = ""
        emailCode = ""
        organizationSlug = ""
    }
}

/// Le compte quand openedbot tient la session : rien à saisir ici, pas de déconnexion locale. Se
/// déconnecter le demande à openedbot, qui déconnecte la fenêtre et la popup ensemble.
struct HostedAccountPage: View {
    var host: HostTokenSource
    var feedState: NotchModel.FeedState?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SettingsCard {
                SettingsRow(tr("Server", "Serveur"), tr("Set by openedbot", "Défini par openedbot")) {
                    SettingsField("https://api.openedbot.app", text: .constant(host.origin?.absoluteString ?? ""))
                        .disabled(true)
                }
            }
            SettingsCard {
                HStack(spacing: 12) {
                    Image(systemName: "macwindow").font(.system(size: 14)).foregroundStyle(Surface.textPrimary)
                        .frame(width: 32, height: 32).background(Circle().fill(Surface.field))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(tr("Session managed by openedbot", "Session gérée par openedbot"))
                            .font(.system(size: 13, weight: .medium)).foregroundStyle(Surface.textPrimary).lineLimit(1)
                        Text(host.isSignedIn ? tr("Signed in through the openedbot app.", "Connectée par l'application openedbot.")
                                             : tr("Sign in to openedbot to see your bots here.", "Connectez-vous dans openedbot pour voir vos bots ici."))
                            .font(.system(size: 12)).foregroundStyle(Surface.textSecondary).lineLimit(2)
                    }
                    Spacer()
                    SecondaryButton(tr("Open openedbot", "Ouvrir openedbot"), symbol: "arrow.up.forward.app") { host.openConsole(path: "/") }
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                if host.isSignedIn {
                    SettingsRow(tr("Sign out", "Se déconnecter"), tr("Signs out of openedbot: its window and this popup.",
                                                                    "Déconnecte openedbot : sa fenêtre et cette popup.")) {
                        SecondaryButton(tr("Sign out", "Se déconnecter")) { host.signOut() }
                    }
                }
                if let feedState {
                    SettingsRow(tr("openedbot feed", "Flux openedbot"), feedState.text) {
                        Circle().fill(feedState == .live ? Palette.ample : Surface.textSecondary).frame(width: 8, height: 8)
                    }
                }
            }
        }
    }
}

// MARK: - Briques

/// Une carte de rangées : fond relevé, séparateurs qui s'arrêtent avant le bord gauche.
struct SettingsCard<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        _VariadicView.Tree(CardRows()) { content() }
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Surface.raised))
    }
}

private struct CardRows: _VariadicView_MultiViewRoot {
    @ViewBuilder func body(children: _VariadicView.Children) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(children.enumerated()), id: \.element.id) { i, child in
                child
                if i < children.count - 1 {
                    Rectangle().fill(Surface.separator).frame(height: 1).padding(.leading, 12)
                }
            }
        }
    }
}

struct SettingsRow<Control: View>: View {
    enum Layout { case trailing, below }
    let title: String
    var description: String?
    var descriptionColor: Color = Surface.textSecondary
    var layout: Layout = .trailing
    @ViewBuilder var control: () -> Control

    init(_ title: String, _ description: String? = nil, descriptionColor: Color = Surface.textSecondary,
         layout: Layout = .trailing, @ViewBuilder control: @escaping () -> Control) {
        self.title = title
        self.description = description
        self.descriptionColor = descriptionColor
        self.layout = layout
        self.control = control
    }

    var body: some View {
        Group {
            switch layout {
            case .trailing:
                HStack(alignment: .center, spacing: 16) {
                    labels
                    Spacer(minLength: 8)
                    control()
                }
            case .below:
                VStack(alignment: .leading, spacing: 10) {
                    labels
                    control()
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }

    private var labels: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 13)).foregroundStyle(Surface.textPrimary)
            if let description {
                Text(description).font(.system(size: 12)).foregroundStyle(descriptionColor).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Le contrôle segmenté de BoardUI : piste sombre, pouce gris qui glisse, pas d'accent.
struct Segmented<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(Value, String)]
    @Namespace private var thumb

    var body: some View {
        // Trop étroit pour la piste (fenêtre au minimum, libellés longs) : un menu compact.
        ViewThatFits(in: .horizontal) {
            track
            compact
        }
    }

    private var compact: some View {
        Menu {
            ForEach(options, id: \.0) { value, title in
                Button { selection = value } label: {
                    if selection == value { Label(title, systemImage: "checkmark") } else { Text(title) }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(options.first { $0.0 == selection }?.1 ?? "").font(.system(size: 12.5, weight: .medium)).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold))
            }
            .foregroundStyle(Surface.textPrimary)
            .padding(.horizontal, 10).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Surface.field))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .pointer()
    }

    private var track: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { value, title in
                Button { withAnimation(.easeOut(duration: 0.2)) { selection = value } } label: {
                    Text(title).font(.system(size: 12.5, weight: selection == value ? .medium : .regular))
                        .lineLimit(1).fixedSize()
                        .foregroundStyle(selection == value ? Surface.textPrimary : Surface.textSecondary)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background {
                            if selection == value {
                                RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Surface.field)
                                    .shadow(color: .black.opacity(0.16), radius: 0, y: 1)
                                    .matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .pointer()
            }
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Surface.window))
        .fixedSize()
    }
}

struct Switch: View {
    @Binding var isOn: Bool
    var body: some View {
        Toggle("", isOn: $isOn).labelsHidden().toggleStyle(.switch).tint(Palette.ample).controlSize(.small)
    }
}

struct SettingsField: View {
    let placeholder: String
    @Binding var text: String
    var secure = false
    var wide = false
    @FocusState private var focused: Bool

    init(_ placeholder: String, text: Binding<String>, secure: Bool = false, wide: Bool = false) {
        self.placeholder = placeholder
        _text = text
        self.secure = secure
        self.wide = wide
    }

    var body: some View {
        Group {
            if secure { SecureField(placeholder, text: $text) } else { TextField(placeholder, text: $text) }
        }
        .textFieldStyle(.plain)
        .font(.system(size: 13))
        .foregroundStyle(Surface.textPrimary)
        .focused($focused)
        .padding(.horizontal, 10).frame(height: 32)
        .frame(maxWidth: wide ? .infinity : 240)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Surface.field))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(focused ? Color(hex: 0x737373) : .clear, lineWidth: 1))
    }
}

/// Bouton secondaire BoardUI : fond gris, bordure fine.
struct SecondaryButton: View {
    let title: String
    var symbol: String?
    var wide = false
    let action: () -> Void

    init(_ title: String, symbol: String? = nil, wide: Bool = false, action: @escaping () -> Void) {
        self.title = title; self.symbol = symbol; self.wide = wide; self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let symbol { Image(systemName: symbol).font(.system(size: 12, weight: .medium)) }
                Text(title).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
            }
            .fixedSize(horizontal: !wide, vertical: false)
            .foregroundStyle(Surface.textPrimary)
            .padding(.horizontal, 12).frame(height: 32)
            .frame(maxWidth: wide ? .infinity : nil)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Surface.field))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Surface.control, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .pointer()
    }
}

/// Bouton principal : blanc encre sur fond sombre, comme assistant-ui.
struct PrimaryButton: View {
    let title: String
    var wide = false
    let action: () -> Void
    @Environment(\.isEnabled) private var enabled

    init(_ title: String, wide: Bool = false, action: @escaping () -> Void) { self.title = title; self.wide = wide; self.action = action }

    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
                .foregroundStyle(enabled ? Surface.window : Surface.textSecondary)
                .padding(.horizontal, 14).frame(height: 32)
                .frame(maxWidth: wide ? .infinity : nil)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(enabled ? Surface.textPrimary : Surface.control))
                .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .pointer()
    }
}
