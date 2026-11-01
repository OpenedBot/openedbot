import SwiftUI

/// La puce de l'en-tête, comme celle du composer de la console : la marque du fournisseur,
/// le modèle que le prochain run utilisera, son effort, un chevron.
struct ModelChip: View {
    let bot: Bot
    let catalog: ModelCatalog?
    @Binding var open: Bool
    /// À l'étroit dans l'en-tête : le modèle seul, l'effort reste lisible dans le sélecteur.
    var compact = false

    var body: some View {
        let resolved = catalog?.resolve(botModel: bot.modelID, botEffort: bot.reasoningEffort)
        let modelName = resolved?.model ?? bot.runtime.model
        let provider = resolved.flatMap { catalog?.provider(of: $0.model) }
        Button { open.toggle() } label: {
            HStack(spacing: 5) {
                if let provider { ProviderBadge(slug: provider.slug, name: provider.name, size: 14) }
                // À l'étroit, c'est le nom du modèle qui se tronque au milieu ; l'effort reste entier.
                Text(modelName).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Surface.textPrimary)
                    .lineLimit(1).truncationMode(.middle)
                if !compact, let effort = resolved?.effort {
                    Text("·").foregroundStyle(Surface.textTertiary).font(.system(size: 11.5))
                    Text(ReasoningEffort.label(effort)).font(.system(size: 11.5)).foregroundStyle(Surface.textSecondary).fixedSize()
                }
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(Surface.textSecondary)
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            .padding(.leading, provider == nil ? 8 : 5).padding(.trailing, 7).frame(height: 22)
            .background(Capsule().fill(Surface.field))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .pointer()
        .disabled(catalog == nil)
        .opacity(catalog == nil ? 0.6 : 1)
        .help(tr("Model for the next run", "Modèle du prochain run"))
    }
}

/// La pastille d'un fournisseur, comme `provider-icon.tsx` : sa marque dans sa teinte,
/// ses initiales à défaut.
struct ProviderBadge: View {
    let slug: String
    let name: String?
    var size: CGFloat = 16

    var body: some View {
        let tint = ProviderMark.tint(slug)
        Group {
            if let image = ProviderMark.image(slug) {
                Image(nsImage: image).renderingMode(.template).resizable().interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: size * 0.66, height: size * 0.66)
                    .foregroundStyle(foreground(tint))
            } else {
                Text(ProviderMark.initials(slug, name: name))
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(Surface.textSecondary)
            }
        }
        .frame(width: size, height: size)
        .background(RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
            .fill(ProviderMark.image(slug) == nil ? Color.white.opacity(0.08) : background(tint)))
        .help(ProviderMark.label(slug, name: name))
    }

    private func background(_ t: ProviderMark.Tint) -> Color {
        switch t {
        case .neutral: Color.white.opacity(0.10)
        case .orange: Color(hex: 0xF97316).opacity(0.15)
        case .blue: Color(hex: 0x3B82F6).opacity(0.15)
        case .green: Color(hex: 0x10B981).opacity(0.15)
        }
    }
    private func foreground(_ t: ProviderMark.Tint) -> Color {
        switch t {
        case .neutral: Surface.textPrimary
        case .orange: Color(hex: 0xFDBA74)
        case .blue: Color(hex: 0x93C5FD)
        case .green: Color(hex: 0x6EE7B7)
        }
    }
}

/// Le sélecteur de la console (`composer-model-picker.tsx`), 440 × 280 : un rail de
/// fournisseurs à gauche, « Modèles » et la recherche rapide en haut, une ligne par modèle
/// avec son bouton radio, la puce d'effort sur le modèle choisi.
struct ModelPickerView: View {
    let bot: Bot
    let catalog: ModelCatalog?
    let feed: any BotFeed
    /// La largeur offerte : celle de la fenêtre d'agent moins ses marges, 440 au plus comme la console.
    var width: CGFloat = 440

    @State private var providerTab: String?
    @State private var searching = false
    @State private var query = ""
    @State private var effortOpen = false
    @State private var saving = false
    @State private var error: String?
    @FocusState private var searchFocused: Bool

    var body: some View {
        Group {
            if let catalog, catalog.modelCount > 0 {
                content(catalog)
            } else {
                Text(catalog == nil ? tr("Loading the model catalog…", "Catalogue de modèles en cours de chargement…") : tr("No authenticated provider on this runtime.", "Aucun fournisseur authentifié sur ce runtime."))
                    .font(.system(size: 12)).foregroundStyle(Surface.textSecondary).padding(16)
            }
        }
        .frame(width: min(440, max(300, width)), height: 300)
        .background(Surface.window)
        .preferredColorScheme(.dark)
    }

    private func content(_ catalog: ModelCatalog) -> some View {
        let selected = bot.modelID
        let effective = catalog.resolve(botModel: bot.modelID, botEffort: bot.reasoningEffort)
        let active = providerTab ?? catalog.provider(of: selected ?? effective?.model ?? "")?.slug ?? catalog.providers.first?.slug
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let visible: [ModelCatalog.Provider] = needle.isEmpty
            ? catalog.providers.filter { $0.slug == active }
            : catalog.providers.compactMap { p in
                let models = p.models.filter { $0.id.lowercased().contains(needle) }
                return models.isEmpty ? nil : ModelCatalog.Provider(slug: p.slug, name: p.name, models: models)
            }
        return HStack(alignment: .top, spacing: 0) {
            // Le rail : une pastille par fournisseur, celle de l'onglet actif sur fond relevé.
            VStack(spacing: 6) {
                ForEach(catalog.providers) { p in
                    Button { query = ""; searching = false; providerTab = p.slug } label: {
                        ProviderBadge(slug: p.slug, name: p.name, size: 20)
                            .frame(width: 36, height: 30)
                            .background(RoundedRectangle(cornerRadius: 15, style: .continuous).fill(needle.isEmpty && p.slug == active ? Surface.control : .clear))
                            .contentShape(RoundedRectangle(cornerRadius: 15))
                    }
                    .buttonStyle(.plain)
                    .pointer()
                    .help(ProviderMark.label(p.slug, name: p.name))
                }
                Spacer(minLength: 0)
            }
            .padding(3)
            .frame(width: 42)
            .background(RoundedRectangle(cornerRadius: 17, style: .continuous).fill(Surface.raised))
            .padding(2)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    if searching {
                        TextField(tr("Quick search", "Recherche rapide"), text: $query)
                            .textFieldStyle(.plain).font(.system(size: 13)).foregroundStyle(Surface.textPrimary)
                            .focused($searchFocused)
                            .onExitCommand { searching = false; query = "" }
                    } else {
                        Text(tr("\(catalog.modelCount) models", "\(catalog.modelCount) modèles")).font(.system(size: 13)).foregroundStyle(Surface.textTertiary)
                    }
                    Spacer(minLength: 0)
                    Button { searching.toggle(); query = ""; if searching { searchFocused = true } } label: {
                        HStack(spacing: 5) {
                            if !searching { Text(tr("Quick search", "Recherche rapide")).font(.system(size: 13)).foregroundStyle(Surface.textSecondary) }
                            Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Surface.textSecondary)
                        }
                        .opacity(0.6)
                    }
                    .buttonStyle(.plain)
                    .pointer()
                }
                .frame(height: 20).padding(.horizontal, 2)

                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        if needle.isEmpty {
                            row(label: tr("Global model", "Modèle global"), detail: catalog.globalModel ?? tr("unavailable", "indisponible"), provider: nil,
                                checked: selected == nil, effort: effective?.effort, catalog: catalog) { choose(nil, catalog: catalog) }
                        }
                        ForEach(visible) { p in
                            Text(ProviderMark.label(p.slug, name: p.name)).font(.system(size: 11)).foregroundStyle(Surface.textTertiary)
                                .padding(.horizontal, 8).padding(.top, 4)
                            ForEach(p.models) { m in
                                row(label: m.id, detail: nil, provider: p, checked: selected == m.id,
                                    effort: selected == m.id ? effective?.effort : nil, catalog: catalog) { choose(m.id, catalog: catalog) }
                            }
                        }
                        if !needle.isEmpty, visible.isEmpty {
                            Text(tr("No matching model.", "Aucun modèle ne correspond.")).font(.system(size: 12, weight: .medium)).foregroundStyle(Surface.textTertiary).padding(8)
                        }
                        if let error { Text(error).font(.system(size: 11)).foregroundStyle(Surface.error).padding(.horizontal, 8) }
                        if saving { Text(tr("Saving…", "Enregistrement…")).font(.system(size: 11)).foregroundStyle(Surface.textTertiary).padding(.horizontal, 8) }
                    }
                    // Une gouttière pour la barre de défilement : elle ne doit jamais couvrir les boutons radio.
                    .padding(.trailing, 14)
                    .padding(.bottom, 6)
                }
            }
            .padding(.leading, 8).padding(.trailing, 4).padding(.top, 8)
        }
    }

    /// Une ligne radio de 36 pt : marque, nom, détail, et sur la ligne cochée la puce d'effort.
    private func row(label: String, detail: String?, provider: ModelCatalog.Provider?, checked: Bool, effort: String?,
                     catalog: ModelCatalog, select: @escaping () -> Void) -> some View {
        let reasons = catalog.reasoningIDs.contains(label) || (provider == nil && catalog.globalModel.map { catalog.reasoningIDs.contains($0) } == true)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                HStack(spacing: 6) {
                    if let provider { ProviderBadge(slug: provider.slug, name: provider.name, size: 16) }
                    Text(label).font(.system(size: 13, weight: .medium)).foregroundStyle(Surface.textPrimary).lineLimit(1)
                        .truncationMode(.middle).layoutPriority(1)
                    if let detail { Text(detail).font(.system(size: 13)).foregroundStyle(Surface.textTertiary).lineLimit(1).truncationMode(.tail) }
                    Spacer(minLength: 0)
                    if checked {
                        Button { effortOpen.toggle() } label: {
                            HStack(spacing: 2) {
                                Text(reasons ? ReasoningEffort.label(effort) : tr("No effort", "Sans effort")).font(.system(size: 12, weight: .medium)).foregroundStyle(Surface.textSecondary)
                                Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(Surface.textSecondary)
                                    .rotationEffect(.degrees(effortOpen ? 90 : 0))
                            }
                            .padding(.leading, 8).padding(.trailing, 5).padding(.vertical, 4)
                            .background(Capsule().fill(Surface.control))
                        }
                        .buttonStyle(.plain)
                        .pointer()
                        .disabled(!reasons)
                    }
                }
                Radio(checked: checked)
            }
            .padding(.horizontal, 8).frame(height: 36)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(checked ? Color(hex: 0x404040).opacity(0.6) : .clear))
            .contentShape(RoundedRectangle(cornerRadius: 10))
            .onTapGesture(perform: select)
            .pointer()
            if checked, effortOpen, reasons {
                effortPicker(current: effort, catalog: catalog)
            }
        }
    }

    /// Les six crans d'Hermes, du plus rapide au plus réfléchi.
    private func effortPicker(current: String?, catalog: ModelCatalog) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(tr("Faster", "Plus rapide")).font(.system(size: 11, weight: .medium)).foregroundStyle(Surface.textSecondary)
                Spacer()
                Text(tr("More thorough", "Plus réfléchi")).font(.system(size: 11, weight: .medium)).foregroundStyle(Surface.textSecondary)
            }
            HStack(spacing: 2) {
                ForEach(ReasoningEffort.levels, id: \.self) { level in
                    let on = (current ?? ReasoningEffort.defaultLevel) == level
                    Button { commitEffort(level, catalog: catalog) } label: {
                        Text(ReasoningEffort.label(level)).font(.system(size: 11.5, weight: on ? .medium : .regular))
                            .foregroundStyle(on ? Surface.textPrimary : Surface.textSecondary).lineLimit(1)
                            .padding(.horizontal, 6).padding(.vertical, 4).frame(maxWidth: .infinity)
                            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(on ? Surface.field : .clear))
                            .contentShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                    .pointer()
                }
            }
            .padding(4)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Surface.window))
            Text(tr("The effort applies to \(bot.name)’s next runs.", "L'effort vaut pour les prochains runs de \(bot.name).")).font(.system(size: 11)).foregroundStyle(Surface.textTertiary)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }

    private func choose(_ modelID: String?, catalog: ModelCatalog) {
        guard !saving, modelID != bot.modelID else { return }
        // Un modèle qui ne raisonne pas n'accepte aucun effort : on l'efface, comme la console.
        let keeps = (modelID ?? catalog.globalModel).map { catalog.reasoningIDs.contains($0) } == true
        save(model: modelID, effort: keeps ? bot.reasoningEffort : nil)
    }

    private func commitEffort(_ level: String, catalog: ModelCatalog) {
        guard !saving, level != bot.reasoningEffort else { return }
        save(model: bot.modelID, effort: level)
    }

    private func save(model: String?, effort: String?) {
        saving = true
        error = nil
        Task {
            do { try await feed.setModel(botID: bot.id, model: model, effort: effort) }
            catch { self.error = (error as? OHBotAuthError)?.userMessage ?? error.localizedDescription }
            saving = false
        }
    }
}

/// Le bouton radio de BoardUI : cercle gris vide, plein dans l'accent avec un point au centre.
struct Radio: View {
    let checked: Bool
    var body: some View {
        ZStack {
            Circle().stroke(Color(hex: 0x737373), lineWidth: 0.9).fill(Surface.field).opacity(checked ? 0 : 1)
            Circle().fill(Palette.ample).opacity(checked ? 1 : 0)
            Circle().fill(Color.black).frame(width: 5, height: 5).scaleEffect(checked ? 1 : 0)
        }
        .frame(width: 14, height: 14)
        .animation(.easeOut(duration: 0.2), value: checked)
    }
}
