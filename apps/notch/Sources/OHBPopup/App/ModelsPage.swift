import AppKit
import SwiftUI

/// Réglages › Modèles : le modèle par défaut du runtime et les accès aux fournisseurs (clé API ou
/// OAuth par code), comme l'écran Modèles de la console. Sans compte, rien à gérer : on renvoie au Compte.
struct ModelsPage: View {
    var account: any TokenSource
    let notch: NotchModel
    let openAccount: () -> Void
    @State private var settings: ModelsSettingsModel
    /// Le fournisseur dont le panneau de connexion est déplié.
    @State private var expanded: String?
    @State private var apiKey = ""

    /// `settings` et `expanded` : un état déjà lu, pour les snapshots.
    init(account: any TokenSource, notch: NotchModel, openAccount: @escaping () -> Void,
         settings: ModelsSettingsModel? = nil, expanded: String? = nil) {
        self.account = account
        self.notch = notch
        self.openAccount = openAccount
        _settings = State(initialValue: settings ?? ModelsSettingsModel(account: account))
        _expanded = State(initialValue: expanded)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !account.isSignedIn {
                Text(tr("Sign in to your openedbot account to choose the models your bots use and connect providers.",
                        "Connectez-vous à votre compte openedbot pour choisir les modèles de vos bots et connecter des fournisseurs."))
                    .font(.system(size: 12)).foregroundStyle(Surface.textSecondary).fixedSize(horizontal: false, vertical: true)
                SecondaryButton(tr("Sign in", "Se connecter"), symbol: "person.crop.circle") { openAccount() }
            } else {
                switch settings.phase {
                case .idle, .loading:
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text(tr("Reading the runtime catalog…", "Lecture du catalogue du runtime…")).font(.system(size: 12)).foregroundStyle(Surface.textSecondary)
                    }
                case .noRuntime:
                    NoteText(tr("No runtime is connected to this organization yet. Add one from the openedbot console.",
                                "Aucun runtime n'est encore relié à cette organisation. Ajoutez-en un depuis la console openedbot."), tone: .warning)
                case .failed(let message):
                    NoteText(message, tone: .error)
                    SecondaryButton(tr("Try again", "Réessayer"), symbol: "arrow.clockwise") { Task { await settings.load() } }
                case .ready:
                    runtimeCard
                    if let notice = settings.notices[""] { NoteText(notice.text, tone: notice.tone) }
                    preference
                    providerAccess
                }
            }
        }
        .task(id: account.isSignedIn) {
            guard account.isSignedIn else { return }
            settings.onCatalog = { [notch] in notch.modelCatalog = $0 }
            await settings.load()
        }
        .onDisappear { settings.cancelOAuth() }
    }

    // MARK: Runtime

    private var runtimeCard: some View {
        SettingsCard {
            HStack(spacing: 12) {
                Image(systemName: "server.rack").font(.system(size: 14)).foregroundStyle(Surface.textSecondary)
                    .frame(width: 32, height: 32).background(Circle().fill(Surface.field))
                VStack(alignment: .leading, spacing: 2) {
                    Text(settings.runtime?.name ?? "runtime").font(.system(size: 13, weight: .medium)).foregroundStyle(Surface.textPrimary).lineLimit(1)
                    HStack(spacing: 6) {
                        Circle().fill(online ? Palette.ample : Surface.error).frame(width: 6, height: 6)
                        Text(runtimeDetail).font(.system(size: 12)).foregroundStyle(Surface.textSecondary).lineLimit(1)
                    }
                }
                Spacer()
                SecondaryButton(tr("Refresh", "Actualiser"), symbol: "arrow.clockwise") { Task { await settings.load() } }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
    }

    private var online: Bool {
        settings.runtime?.link?.connected ?? (settings.runtime?.lastHealthStatus == "healthy")
    }

    private var runtimeDetail: String {
        let via = settings.runtime?.reachability == "direct" ? tr("direct", "direct") : tr("link", "lien")
        let state = online ? tr("online", "en ligne") : tr("offline", "hors ligne")
        let count = settings.connectedProviders.count
        let providers = tr("\(count) provider\(count > 1 ? "s" : "") connected", "\(count) fournisseur\(count > 1 ? "s" : "") connecté\(count > 1 ? "s" : "")")
        return "\(state) · \(via) · \(providers)"
    }

    // MARK: Modèle par défaut

    @ViewBuilder private var preference: some View {
        SectionTitle(tr("Default model", "Modèle par défaut"),
                     tr("Used by every run whose bot has no model of its own.", "Utilisé par chaque run dont le bot n'a pas de modèle propre."))
        if settings.connectedProviders.isEmpty {
            NoteText(tr("No provider is connected: connect one below to choose a model.",
                        "Aucun fournisseur n'est connecté : connectez-en un ci-dessous pour choisir un modèle."), tone: .warning)
        } else {
            SettingsCard {
                SettingsRow(tr("Assignment", "Attribution"),
                            settings.assignmentMode == "global"
                                ? tr("One model for every bot: models chosen per bot are kept but ignored.",
                                     "Un modèle pour tous les bots : ceux choisis par bot sont gardés mais ignorés.")
                                : tr("Each bot can have its own model; the others use the default model.",
                                     "Chaque bot peut avoir son modèle ; les autres prennent le modèle par défaut."),
                            layout: .below) {
                    Segmented(selection: Binding(get: { settings.assignmentMode }, set: { mode in Task { await settings.setAssignmentMode(mode) } }),
                              options: [("per_bot", tr("Per bot", "Par bot")), ("global", tr("Global", "Global"))])
                        .disabled(settings.savingMode)
                }
                SettingsRow(tr("Provider", "Fournisseur"), providerHint) {
                    MenuField(selection: selectedProvider?.name ?? tr("Hermes decides", "Hermes décide"),
                              options: [(nil as String?, tr("Hermes decides", "Hermes décide"))] + settings.connectedProviders.map { ($0.slug as String?, $0.name) }) { slug in
                        guard slug != settings.runtime?.selectedProvider else { return }
                        let first = slug.flatMap { s in settings.connectedProviders.first { $0.slug == s }?.models.first }
                        Task { await settings.select(provider: slug, model: first?.id, effort: first?.reasoning == true ? ReasoningEffort.defaultLevel : nil) }
                    }
                }
                if let provider = selectedProvider {
                    SettingsRow(tr("Model", "Modèle")) {
                        MenuField(selection: settings.runtime?.selectedModel ?? "—", options: provider.models.map { ($0.id as String?, $0.id) }) { id in
                            guard let id, id != settings.runtime?.selectedModel else { return }
                            let reasoning = provider.models.first { $0.id == id }?.reasoning == true
                            let effort = reasoning ? (settings.runtime?.reasoningEffort ?? ReasoningEffort.defaultLevel) : nil
                            Task { await settings.select(provider: provider.slug, model: id, effort: effort) }
                        }
                    }
                    if selectedModel?.reasoning == true, let modelID = selectedModel?.id {
                        SettingsRow(tr("Reasoning effort", "Effort de raisonnement")) {
                            MenuField(selection: ReasoningEffort.label(settings.runtime?.reasoningEffort),
                                      options: ReasoningEffort.levels.map { ($0 as String?, ReasoningEffort.label($0)) }) { effort in
                                guard effort != settings.runtime?.reasoningEffort else { return }
                                Task { await settings.select(provider: provider.slug, model: modelID, effort: effort) }
                            }
                        }
                    }
                }
            }
            .disabled(settings.savingSelection)
            if settings.savingSelection {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(tr("Checking that the model answers…", "Vérification que le modèle répond…")).font(.system(size: 12)).foregroundStyle(Surface.textSecondary)
                }
            }
        }
    }

    private var selectedProvider: RuntimeModelCatalogDto.Provider? {
        settings.runtime?.selectedProvider.flatMap { slug in settings.providers.first { $0.slug == slug } }
    }

    private var selectedModel: RuntimeModelCatalogDto.Model? {
        settings.runtime?.selectedModel.flatMap { id in selectedProvider?.models.first { $0.id == id } }
    }

    private var providerHint: String? {
        guard selectedProvider == nil else { return nil }
        let current = settings.catalog?.currentProvider.flatMap { slug in settings.providers.first { $0.slug == slug }?.name }
        switch (current, settings.catalog?.runtimeDefaultModel) {
        case let (p?, m?): return tr("The runtime serves \(m) (\(p)).", "Le runtime sert \(m) (\(p)).")
        case let (nil, m?): return tr("The runtime serves \(m).", "Le runtime sert \(m).")
        default: return tr("The runtime's own default model.", "Le modèle par défaut du runtime.")
        }
    }

    // MARK: Accès fournisseur

    @ViewBuilder private var providerAccess: some View {
        SectionTitle(tr("Provider access", "Accès aux fournisseurs"),
                     tr("Keys and sessions are stored on the runtime host, never in this app.",
                        "Les clés et sessions sont posées sur l'hôte du runtime, jamais dans cette app."))
        if let profile = settings.catalog?.hermesProfile {
            NoteText(tr("This runtime uses the Hermes profile \(profile): its access is set by hand on the host.",
                        "Ce runtime sert le profil Hermes \(profile) : ses accès se posent à la main sur l'hôte."), tone: .warning)
        } else if settings.runtime?.reachability == "direct" {
            NoteText(tr("This runtime manages its own credentials: run `edge-setup credentials add <provider>` on the host.",
                        "Ce runtime gère ses propres accès : lancez `edge-setup credentials add <fournisseur>` sur l'hôte."), tone: .warning)
        }
        if settings.providers.isEmpty {
            NoteText(tr("The runtime lists no provider.", "Le runtime ne liste aucun fournisseur."), tone: .warning)
        } else {
            SettingsCard {
                ForEach(sortedProviders, id: \.slug) { provider in
                    providerRow(provider)
                }
            }
        }
    }

    /// Les connectés d'abord, puis par nom : ce qui sert déjà se voit sans défiler.
    private var sortedProviders: [RuntimeModelCatalogDto.Provider] {
        settings.providers.sorted { a, b in
            let ca = a.authenticated == true, cb = b.authenticated == true
            return ca != cb ? ca : a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    /// Les accès se posent d'ici seulement sans profil nommé ni runtime direct.
    private var manageable: Bool {
        settings.catalog?.hermesProfile == nil && settings.runtime?.reachability != "direct"
    }

    private func providerRow(_ p: RuntimeModelCatalogDto.Provider) -> some View {
        let open = expanded == p.slug
        let builtIn = p.alwaysAuthenticated == true || p.slug == "opencode-free"
        let connectable = manageable && !builtIn && (p.acceptsApiKey == true || p.acceptsOauth == true)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                ProviderBadge(slug: p.slug, name: p.name, size: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(p.name).font(.system(size: 13)).foregroundStyle(Surface.textPrimary).lineLimit(1)
                    Text(status(p, builtIn: builtIn)).font(.system(size: 12))
                        .foregroundStyle(p.warning != nil ? Palette.waiting : Surface.textSecondary).lineLimit(2)
                }
                Spacer(minLength: 8)
                if p.authenticated == true {
                    Circle().fill(Palette.ample).frame(width: 7, height: 7)
                }
                if connectable {
                    SecondaryButton(open ? tr("Close", "Fermer") : (p.authenticated == true ? tr("Manage", "Gérer") : tr("Connect", "Connecter"))) {
                        if open { settings.cancelOAuth() }
                        apiKey = ""
                        expanded = open ? nil : p.slug
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            if open {
                connectPanel(p)
                    .padding(.horizontal, 12).padding(.bottom, 12)
            }
        }
    }

    private func status(_ p: RuntimeModelCatalogDto.Provider, builtIn: Bool) -> String {
        if let warning = p.warning { return warning }
        if builtIn { return tr("Built into the runtime, nothing to connect", "Intégré au runtime, rien à connecter") }
        guard p.authenticated == true else {
            let ways = [p.acceptsOauth == true ? tr("account", "compte") : nil, p.acceptsApiKey == true ? tr("API key", "clé API") : nil].compactMap { $0 }
            return ways.isEmpty ? tr("Not connected · set up on the host", "Non connecté · à poser sur l'hôte")
                                : tr("Not connected · \(ways.joined(separator: " or "))", "Non connecté · \(ways.joined(separator: " ou "))")
        }
        let n = p.models.count
        return tr("Connected · \(n) model\(n > 1 ? "s" : "")", "Connecté · \(n) modèle\(n > 1 ? "s" : "")")
    }

    @ViewBuilder private func connectPanel(_ p: RuntimeModelCatalogDto.Provider) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if p.acceptsOauth == true {
                if settings.oauthWritable { oauthPanel(p) } else { hostCommand(p, verb: "login") }
            }
            if p.acceptsApiKey == true {
                if settings.credentialsWritable {
                    HStack(spacing: 8) {
                        SettingsField(tr("\(p.name) API key", "Clé API \(p.name)"), text: $apiKey, secure: true, wide: true)
                            .textContentType(.password)
                            .onSubmit { saveKey(p) }
                        PrimaryButton(settings.savingKey == p.slug ? tr("Checking…", "Vérification…")
                                      : p.authenticated == true ? tr("Replace", "Remplacer") : tr("Save", "Enregistrer")) { saveKey(p) }
                            .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || settings.savingKey != nil)
                    }
                } else {
                    hostCommand(p, verb: "add")
                }
            }
            if let notice = settings.notices[p.slug] { NoteText(notice.text, tone: notice.tone) }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Surface.window))
    }

    private func saveKey(_ p: RuntimeModelCatalogDto.Provider) {
        let key = apiKey
        Task {
            // La clé ne reste pas dans le champ, qu'elle soit acceptée ou non : on la recolle au besoin.
            apiKey = ""
            if await settings.saveKey(provider: p.slug, apiKey: key) { expanded = nil }
        }
    }

    @ViewBuilder private func oauthPanel(_ p: RuntimeModelCatalogDto.Provider) -> some View {
        let flow = settings.oauth?.provider == p.slug ? settings.oauth : nil
        if let flow, let error = flow.error {
            NoteText(error, tone: .error)
            SecondaryButton(tr("Try again", "Réessayer"), symbol: "arrow.clockwise") { settings.startOAuth(provider: p.slug) }
        } else if let flow {
            if let session = flow.session, session.status == "pending" {
                VStack(alignment: .leading, spacing: 10) {
                    if let code = session.userCode {
                        Text(tr("Enter this code on the provider's page:", "Saisissez ce code sur la page du fournisseur :"))
                            .font(.system(size: 12)).foregroundStyle(Surface.textSecondary)
                        HStack(spacing: 10) {
                            Text(code).font(.system(size: 22, weight: .semibold, design: .monospaced)).tracking(3)
                                .foregroundStyle(Surface.textPrimary).textSelection(.enabled)
                            SecondaryButton(tr("Copy", "Copier"), symbol: "doc.on.doc") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(code, forType: .string)
                            }
                        }
                    }
                    HStack(spacing: 8) {
                        if session.verificationUri != nil {
                            PrimaryButton(tr("Open the page", "Ouvrir la page")) { settings.openVerification() }
                        }
                        SecondaryButton(tr("Cancel", "Annuler")) { settings.cancelOAuth() }
                    }
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(tr("Waiting for the authorization…", "En attente de l'autorisation…")).font(.system(size: 12)).foregroundStyle(Surface.textSecondary)
                    }
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(tr("Preparing the authorization on the host…", "Préparation de l'autorisation sur l'hôte…")).font(.system(size: 12)).foregroundStyle(Surface.textSecondary)
                }
            }
        } else {
            SecondaryButton(p.authenticated == true ? tr("Reconnect the \(p.name) account", "Reconnecter le compte \(p.name)")
                                                    : tr("Sign in with \(p.name)", "Se connecter avec \(p.name)"), symbol: "person.badge.key") {
                settings.startOAuth(provider: p.slug)
            }
        }
    }

    /// Le geste à jouer sur l'hôte quand openedbot ne peut pas écrire l'accès lui-même.
    private func hostCommand(_ p: RuntimeModelCatalogDto.Provider, verb: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(tr("openedbot cannot write this access on the runtime right now. On the host:", "openedbot ne peut pas poser cet accès sur le runtime pour l'instant. Sur l'hôte :"))
                .font(.system(size: 12)).foregroundStyle(Surface.textSecondary).fixedSize(horizontal: false, vertical: true)
            Text("sudo edge-setup credentials \(verb) \(p.slug) --yes")
                .font(.system(size: 12, design: .monospaced)).foregroundStyle(Surface.textPrimary).textSelection(.enabled)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Surface.field))
        }
    }
}

// MARK: - Briques de la page

private struct SectionTitle: View {
    let title: String
    let detail: String?
    init(_ title: String, _ detail: String? = nil) { self.title = title; self.detail = detail }
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(Surface.textPrimary)
            if let detail { Text(detail).font(.system(size: 12)).foregroundStyle(Surface.textSecondary).fixedSize(horizontal: false, vertical: true) }
        }
        .padding(.top, 6)
    }
}

private struct NoteText: View {
    let text: String
    let tone: ModelsSettingsModel.Tone
    init(_ text: String, tone: ModelsSettingsModel.Tone) { self.text = text; self.tone = tone }
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: tone == .success ? "checkmark.circle" : "exclamationmark.circle").font(.system(size: 11))
            Text(text).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
        .foregroundStyle(tone == .success ? Palette.ample : tone == .warning ? Palette.waiting : Surface.error)
    }
}

/// Un menu compact, même dessin que le repli du contrôle segmenté.
private struct MenuField: View {
    let selection: String
    let options: [(String?, String)]
    let choose: (String?) -> Void

    var body: some View {
        Menu {
            ForEach(options.indices, id: \.self) { i in
                Button(options[i].1) { choose(options[i].0) }
            }
        } label: {
            HStack(spacing: 6) {
                Text(selection).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
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
}
