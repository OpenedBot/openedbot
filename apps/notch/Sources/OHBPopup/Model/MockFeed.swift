import Foundation

/// Ce qu'une source de bots sait faire. `MockBotFeed` aujourd'hui ; `OHBotFeed` demain
/// (REST `/api/bots`, `/api/inbox`, `/api/workflows`, SSE `/api/events`).
@MainActor
protocol BotFeed: AnyObject {
    /// Ce que l'encoche annonce : un run fini, un bot qui attend, un runtime tombé ou revenu.
    var onTransition: ((Bot, FeedTransition) -> Void)? { get set }
    func start()
    func stop()
    /// `POST /api/approvals/:id/respond` avec `choice: once | deny`.
    func respond(approvalID: UUID, allow: Bool)
    /// `POST /api/threads/:threadId/messages`.
    /// `replyTo` : l'identifiant du message cité (`replyToId`), nil sans citation.
    func send(_ text: String, attachments: [PendingAttachment], replyTo: String?, to botID: String)
    /// `PUT` / `DELETE /api/threads/:threadId/messages/:id/reactions` ; 👍 et 👎 s'excluent.
    func react(botID: String, messageID: String, emoji: String)
    /// `GET /api/runtime/:id/models`, dans `model.modelCatalog`.
    func loadModelCatalog() async
    /// `PATCH /api/bots/:id { model, provider, reasoningEffort }` ; nil = revenir au global.
    func setModel(botID: String, model: String?, effort: String?) async throws
}

extension BotFeed {
    func send(_ text: String, to botID: String) { send(text, attachments: [], replyTo: nil, to: botID) }
    func send(_ text: String, attachments: [PendingAttachment], to botID: String) { send(text, attachments: attachments, replyTo: nil, to: botID) }
}

enum FeedTransition: Sendable, Equatable { case finished, failed, waiting, offline, back }

/// Dix bots en trois sections, deux runs scriptés qui bouclent, un runtime qui tombe.
@MainActor
final class MockBotFeed: BotFeed {
    private let model: NotchModel
    private let timeScale: Double
    private var tasks: [Task<Void, Never>] = []
    /// Les suites d'un `send` : une entrée par message, libérée quand elle a fini.
    private var transient: [UUID: Task<Void, Never>] = [:]
    private var approvalWaiters: [UUID: CheckedContinuation<Bool, Never>] = [:]
    var onTransition: ((Bot, FeedTransition) -> Void)?

    init(model: NotchModel, timeScale: Double = 1) {
        self.model = model
        self.timeScale = timeScale
    }

    /// Une bascule de démo : au journal (réglages, carte du runtime), puis aux annonces.
    private func announce(_ bot: Bot, _ transition: FeedTransition) {
        let word = switch transition {
        case .finished: tr("is done", "a fini")
        case .failed: tr("run failed", "run en échec")
        case .waiting: tr("needs your approval", "attend ton accord")
        case .offline: tr("runtime \(bot.runtime.name) offline", "runtime \(bot.runtime.name) hors ligne")
        case .back: tr("runtime \(bot.runtime.name) back online", "runtime \(bot.runtime.name) de nouveau en ligne")
        }
        let level: JournalEntry.Level = transition == .offline ? .error : transition == .waiting ? .warning : .info
        model.record(level, .demo, "\(bot.name) \(word)")
        onTransition?(bot, transition)
    }

    // MARK: BotFeed

    func start() {
        stop()
        model.sections = Self.sections
        model.bots = Self.roster(now: Date())
        tasks.append(Task { [weak self] in await self?.runSupport() })
        tasks.append(Task { [weak self] in await self?.runOnboarding() })
        tasks.append(Task { [weak self] in await self?.runOps() })
        tasks.append(Task { [weak self] in await self?.tick() })
    }

    func stop() {
        for (_, c) in approvalWaiters { c.resume(returning: false) }
        approvalWaiters = [:]
        for t in tasks { t.cancel() }
        tasks = []
        for (_, t) in transient { t.cancel() }
        transient = [:]
    }

    func respond(approvalID: UUID, allow: Bool) {
        guard let i = model.bots.firstIndex(where: { $0.pending?.id == approvalID }) else { return }
        var bot = model.bots[i]
        let approval = bot.pending!
        bot.pending = nil
        bot.inboxCount = max(0, bot.inboxCount - 1)
        if let r = bot.runs.firstIndex(where: { $0.id == approval.runID }) {
            bot.runs[r].status = allow ? .running : .completed
            if !allow { bot.runs[r].detail = tr("Command denied, the run goes on without it", "Commande refusée, le run continue sans") }
        }
        bot.thread.append(ChatMessage(role: .system, text: allow
            ? tr("Allowed once · POST /api/approvals/…/respond {choice:\"once\"}", "Autorisé une fois · POST /api/approvals/…/respond {choice:\"once\"}")
            : tr("Denied · {choice:\"deny\"}", "Refusé · {choice:\"deny\"}")))
        if allow { bot.thread.append(ChatMessage(role: .tool, text: "\(approval.tool) \(approval.command) → succeeded")) }
        bot.trimHistory()
        model.bots[i] = bot
        approvalWaiters.removeValue(forKey: approvalID)?.resume(returning: allow)
    }

    /// La démo n'a pas de fil serveur : ni citation ni réaction, le message part tel quel.
    func react(botID: String, messageID: String, emoji: String) {}

    func send(_ text: String, attachments: [PendingAttachment], replyTo: String?, to botID: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        if let bot = model.bot(botID) {
            model.record(.info, .demo, tr("\(bot.name): simulated message\(attachments.isEmpty ? "" : " with \(attachments.count) attachment(s)")",
                                          "\(bot.name) : message simulé\(attachments.isEmpty ? "" : " avec \(attachments.count) pièce(s)")"))
        }
        model.update(botID) { bot in
            bot.thread.append(ChatMessage(role: .user, text: trimmed, attachments: attachments.map(\.name)))
            if bot.activeRun == nil {
                bot.runs.insert(BotRun(id: "dm-\(UUID().uuidString.prefix(6))", kind: .dm, title: tr("you", "toi"),
                                       detail: trimmed.isEmpty ? tr("\(attachments.count) attachment(s)", "\(attachments.count) pièce(s) jointe(s)") : trimmed, status: .running, usedSteps: 1, maxSteps: 4,
                                       tokens: 0, since: Date()), at: 0)
            }
        }
        let id = UUID()
        transient[id] = Task { [weak self] in
            do {
                try await self?.sleep(1.4)
                self?.model.update(botID) { bot in
                    bot.thread.append(ChatMessage(role: .bot, text: tr("Got it, I’m on it.", "Bien reçu, je m'en occupe.")))
                    if let r = bot.runs.firstIndex(where: { $0.kind == .dm && $0.status == .running }) {
                        bot.runs[r].usedSteps = min(bot.runs[r].maxSteps, bot.runs[r].usedSteps + 1)
                    }
                }
                try await self?.sleep(4)
                self?.model.update(botID) { bot in
                    if let r = bot.runs.firstIndex(where: { $0.kind == .dm && $0.status == .running }) {
                        bot.runs[r].usedSteps = bot.runs[r].maxSteps
                        bot.runs[r].status = .completed
                        bot.thread.append(ChatMessage(role: .bot, text: tr("Done. Summary posted in the thread.", "C'est fait. Récapitulatif posté dans le fil.")))
                    }
                }
                if let self, let bot = self.model.bot(botID) { self.announce(bot, .finished) }
            } catch {}
            self?.transient[id] = nil
        }
    }

    /// Pour les tests : combien de suites de `send` sont encore vivantes.
    var pendingSendCount: Int { transient.count }

    func loadModelCatalog() async {
        model.modelCatalog = ModelCatalog(providers: [
            .init(slug: "anthropic", name: "Anthropic", models: [.init(id: "claude-sonnet-5-5", reasoning: true), .init(id: "claude-opus-5-5", reasoning: true), .init(id: "claude-haiku-5-5", reasoning: false)]),
            .init(slug: "openai-codex", name: "OpenAI Codex", models: [.init(id: "gpt-5-codex", reasoning: true), .init(id: "GPT-5.6 Luna", reasoning: true)]),
            .init(slug: "ollama-cloud", name: "Ollama Cloud", models: [.init(id: "gemma-4 (local)", reasoning: false)]),
        ], globalModel: "claude-sonnet-5-5", globalEffort: "medium", assignmentMode: "per_bot")
    }

    func setModel(botID: String, model modelID: String?, effort: String?) async throws {
        try await sleep(0.3)
        model.update(botID) { bot in
            bot.modelID = modelID
            bot.reasoningEffort = effort
            if let modelID { bot.runtime.model = modelID }
            else if let global = self.model.modelCatalog?.globalModel { bot.runtime.model = global }
        }
    }

    // MARK: Boutons de démo

    func simulateApproval(botID: String = "support") {
        model.update(botID) { bot in
            if bot.activeRun == nil {
                bot.runs.insert(BotRun(id: "dm-lea", kind: .dm, title: tr("Léa (customer #4821)", "Léa (client #4821)"), detail: tr("Refund order 4821?", "Rembourser la commande 4821 ?"),
                                       status: .running, usedSteps: 2, maxSteps: 5, tokens: 1_800, since: Date()), at: 0)
            }
            Self.askApproval(&bot)
        }
        if let bot = model.bot(botID) { announce(bot, .waiting) }
    }

    func simulateFinish(botID: String = "support") {
        model.update(botID) { bot in
            bot.pending = nil
            for i in bot.runs.indices where bot.runs[i].isLive {
                bot.runs[i].status = .completed
                bot.runs[i].usedSteps = bot.runs[i].maxSteps
            }
            bot.thread.append(ChatMessage(role: .bot, text: tr("Done: 8 tickets sorted, 2 escalated to the billing team.", "Terminé : 8 tickets triés, 2 escaladés à l'équipe facturation.")))
        }
        if let bot = model.bot(botID) { announce(bot, .finished) }
    }

    func toggleOffline(botID: String = "growth") {
        model.update(botID) { bot in
            bot.runtime.connected.toggle()
            bot.runtime.downSince = bot.runtime.connected ? nil : Date().addingTimeInterval(-4 * 60)
            bot.runtime.lastSeenAt = Date()
        }
        if let bot = model.bot(botID) { announce(bot, bot.runtime.connected ? .back : .offline) }
    }

    // MARK: Scénarios

    private func runSupport() async {
        do {
            while !Task.isCancelled {
                try await sleep(3)
                model.update("support") { bot in
                    bot.runs.removeAll { $0.kind == .routine }
                    bot.runs.insert(BotRun(id: "rt-tri", kind: .routine, title: tr("Ticket triage", "Tri des tickets"), detail: tr("14 open tickets", "14 tickets ouverts"),
                                           status: .running, usedSteps: 1, maxSteps: 8, tokens: 900, since: Date()), at: 0)
                    bot.thread.append(ChatMessage(role: .system, text: tr("Routine “Ticket triage” started", "Routine « Tri des tickets » lancée")))
                }
                for step in 2...3 {
                    try await sleep(1.6)
                    model.update("support") { bot in
                        if let r = bot.runs.firstIndex(where: { $0.id == "rt-tri" }) {
                            bot.runs[r].usedSteps = step
                            bot.runs[r].tokens += 1_100
                            bot.runs[r].detail = step == 2 ? tr("zendesk.list_tickets · 14 results", "zendesk.list_tickets · 14 résultats") : "#4821 → tag:refund"
                        }
                    }
                }
                // Étape 4 : une commande qui demande l'accord de l'opérateur.
                var approvalID: UUID?
                model.update("support") { bot in
                    bot.thread.append(ChatMessage(role: .bot, text: tr("I’m starting the €49.00 refund for order 4821. I need your approval for the payment command.", "Je lance le remboursement de 49,00 € pour la commande 4821. Il me faut ton accord pour la commande de paiement.")))
                    Self.askApproval(&bot, runID: "rt-tri")
                    approvalID = bot.pending?.id
                }
                if let bot = model.bot("support") { announce(bot, .waiting) }
                if let approvalID {
                    _ = await withTaskCancellationHandler {
                        await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
                            approvalWaiters[approvalID] = c
                            // Sans réponse, la démo n'attend pas éternellement.
                            Task { [weak self] in
                                try? await self?.sleep(40)
                                self?.approvalWaiters.removeValue(forKey: approvalID)?.resume(returning: true)
                                self?.model.update("support") { bot in
                                    if bot.pending?.id == approvalID { bot.pending = nil; bot.inboxCount = max(0, bot.inboxCount - 1) }
                                }
                            }
                        }
                    } onCancel: {
                        Task { @MainActor [weak self] in self?.approvalWaiters.removeValue(forKey: approvalID)?.resume(returning: false) }
                    }
                }
                try Task.checkCancellation()
                for step in 4...8 {
                    try await sleep(1.2)
                    model.update("support") { bot in
                        if let r = bot.runs.firstIndex(where: { $0.id == "rt-tri" }) {
                            bot.runs[r].usedSteps = step
                            bot.runs[r].status = .running
                            bot.runs[r].tokens += 700
                        }
                    }
                }
                model.update("support") { bot in
                    if let r = bot.runs.firstIndex(where: { $0.id == "rt-tri" }) {
                        bot.runs[r].status = .completed
                        bot.runs[r].detail = tr("8 tickets sorted, 2 escalated", "8 tickets triés, 2 escaladés")
                    }
                    bot.thread.append(ChatMessage(role: .bot, text: tr("Done: 8 tickets sorted, 2 escalated to the billing team.", "Terminé : 8 tickets triés, 2 escaladés à l'équipe facturation.")))
                }
                if let bot = model.bot("support") { announce(bot, .finished) }
                try await sleep(12)
                model.update("support") { bot in bot.runs.removeAll { $0.status == .completed } }
                try await sleep(20)
            }
        } catch {}
    }

    private func runOnboarding() async {
        do {
            try await sleep(1)
            while !Task.isCancelled {
                for step in 1...4 {
                    // On ne touche qu'au run de la routine : un DM envoyé depuis la fenêtre doit survivre.
                    model.update("onboarding") { bot in
                        let since = bot.runs.first { $0.id == "rt-j1" }?.since ?? Date()
                        bot.runs.removeAll { $0.id == "rt-j1" }
                        bot.runs.insert(BotRun(id: "rt-j1", kind: .routine, title: tr("Welcome D+1", "Bienvenue J+1"), detail: tr("Welcome e-mail", "E-mail de bienvenue"),
                                               status: step == 4 ? .completed : .running, usedSteps: step, maxSteps: 4,
                                               tokens: step * 600, since: since), at: 0)
                    }
                    if step == 4, let bot = model.bot("onboarding") { announce(bot, .finished) }
                    try await sleep(step == 4 ? 15 : 5)
                }
                model.update("onboarding") { bot in bot.runs.removeAll { $0.id == "rt-j1" } }
                try await sleep(30)
            }
        } catch {}
    }

    private func runOps() async {
        do {
            try await sleep(45)
            while !Task.isCancelled {
                model.update("ops") { bot in
                    bot.runs.removeAll { $0.id == "rt-veille" }
                    bot.runs.insert(BotRun(id: "rt-veille", kind: .routine, title: tr("Infra watch", "Veille infra"), detail: "df -h / && uptime",
                                           status: .running, usedSteps: 1, maxSteps: 3, tokens: 400, since: Date()), at: 0)
                }
                for step in 2...3 {
                    try await sleep(3)
                    model.update("ops") { bot in
                        if let r = bot.runs.firstIndex(where: { $0.id == "rt-veille" }) {
                            bot.runs[r].usedSteps = step
                            if step == 3 { bot.runs[r].status = .completed; bot.runs[r].detail = tr("All clear", "Rien à signaler") }
                        }
                    }
                }
                if let bot = model.bot("ops") { announce(bot, .finished) }
                try await sleep(60)
                model.update("ops") { bot in bot.runs.removeAll { $0.id == "rt-veille" } }
                try await sleep(60)
            }
        } catch {}
    }

    private func tick() async {
        do {
            var beat = 0
            while !Task.isCancelled {
                try await sleep(1)
                model.now = Date()
                beat += 1
                // Le « vu il y a » des runtimes connectés bouge toutes les 15 s, pas à chaque
                // seconde : chaque écriture dans `bots` réveille toutes les vues et la barre.
                guard beat % 15 == 0 else { continue }
                for i in model.bots.indices where model.bots[i].runtime.connected {
                    model.bots[i].runtime.lastSeenAt = Date()
                }
            }
        } catch {}
    }

    /// Une seule approbation en attente par bot : une nouvelle demande remplace l'ancienne,
    /// et le run de l'ancienne reprend, sinon il resterait « attend » sans rien à valider.
    private static func askApproval(_ bot: inout Bot, runID: String? = nil) {
        let run = runID ?? bot.activeRun?.id ?? "run"
        if let old = bot.pending, old.runID != run,
           let r = bot.runs.firstIndex(where: { $0.id == old.runID && $0.status == .awaitingApproval }) {
            bot.runs[r].status = .running
        }
        if bot.pending == nil { bot.inboxCount += 1 }
        bot.pending = Approval(botID: bot.id, runID: run, tool: "shell",
                               command: "payments refunds create --charge ch_demo… --amount 4900",
                               expiresAt: Date().addingTimeInterval(9 * 60))
        if let r = bot.runs.firstIndex(where: { $0.id == run }) { bot.runs[r].status = .awaitingApproval }
    }

    private func sleep(_ seconds: Double) async throws {
        let scaled = seconds * timeScale
        guard scaled > 0 else { await Task.yield(); try Task.checkCancellation(); return }
        try await Task.sleep(for: .milliseconds(Int(scaled * 1000)))
    }

    // MARK: Roster

    static var sections: [BotSection] {
        [BotSection(id: "clients", name: tr("Customers", "Clients")), BotSection(id: "interne", name: tr("Internal", "Interne")),
         BotSection(id: "perso", name: tr("Personal", "Perso"))]
    }

    static func roster(now: Date) -> [Bot] {
        func rt(_ name: String, _ model: String, _ mode: String, connected: Bool = true) -> BotRuntime {
            BotRuntime(name: name, model: model, mode: mode, connected: connected, lastSeenAt: now,
                       connectorVersion: connected ? "1.5.0" : "1.4.2", latestVersion: "1.5.0",
                       downSince: connected ? nil : now.addingTimeInterval(-4 * 60))
        }
        let paris = rt("vps-paris", "claude-sonnet-5-5", "manual")
        let home = rt("homelab-01", "gpt-5-codex", "auto")
        let mac = rt("mac-studio", "gemma-4 (local)", "auto")
        let idleThread = [ChatMessage(role: .system, text: tr("No recent conversation.", "Aucune conversation récente."))]
        return [
            Bot(id: "support", name: "Support", sectionID: "clients", artwork: "explorer", runtime: paris,
                routine: BotRoutine(name: tr("Ticket triage", "Tri des tickets"), next: tr("every 30 min", "toutes les 30 min")),
                thread: [
                    ChatMessage(role: .tool, text: tr("zendesk.list_tickets status=open · 14 results", "zendesk.list_tickets status=open · 14 résultats"), at: now.addingTimeInterval(-300)),
                    ChatMessage(role: .bot, text: tr("Sorting the 14 open tickets. Two are about refunds, I’m handling them first.", "Je trie les 14 tickets ouverts. Deux concernent des remboursements, je les traite en priorité."), at: now.addingTimeInterval(-290)),
                    ChatMessage(role: .user, text: tr("For #4821, first check that the order really was delivered late.", "Pour #4821, vérifie d'abord que la commande a bien été livrée en retard."), at: now.addingTimeInterval(-200)),
                    ChatMessage(role: .bot, text: tr("Due on the 3rd, received on the 9th: six days late, so the refund is justified under the “delay > 5 days” policy.", "Livraison prévue le 3, reçue le 9 : six jours de retard, le remboursement est justifié selon la politique « retard > 5 j »."), at: now.addingTimeInterval(-180)),
                ]),
            Bot(id: "sales", name: "Sales", sectionID: "clients", artwork: "samurai", runtime: paris,
                runs: [BotRun(id: "dm-acme", kind: .dm, title: tr("Acme quote", "Devis Acme"), detail: tr("Follow-up sent", "Relance envoyée"), status: .completed, usedSteps: 3, maxSteps: 3, tokens: 2_100, since: now.addingTimeInterval(-18 * 60))],
                thread: idleThread),
            Bot(id: "onboarding", name: "Onboarding", sectionID: "clients", artwork: "halo", runtime: paris,
                routine: BotRoutine(name: tr("Welcome D+1", "Bienvenue J+1"), next: tr("every day 09:00", "chaque jour 09:00")), thread: idleThread),
            Bot(id: "ops", name: "Ops", sectionID: "interne", artwork: "mecha", runtime: home,
                routine: BotRoutine(name: tr("Infra watch", "Veille infra"), next: tr("in 2 h 18", "dans 2 h 18")),
                runs: [BotRun(id: "rt-veille", kind: .routine, title: tr("Infra watch", "Veille infra"), detail: tr("All clear", "Rien à signaler"), status: .completed, usedSteps: 3, maxSteps: 3, tokens: 1_200, since: now.addingTimeInterval(-4 * 60))],
                thread: [
                    ChatMessage(role: .system, text: tr("Routine “Infra watch” · 13:38 pass", "Routine « Veille infra » · passage de 13:38"), at: now.addingTimeInterval(-240)),
                    ChatMessage(role: .tool, text: "ssh.run homelab-01 · df -h / && uptime", at: now.addingTimeInterval(-238)),
                    ChatMessage(role: .bot, text: tr("All clear: disk at 61%, load 0.42, no service failing.", "Rien à signaler : disque à 61 %, charge 0,42, aucun service en erreur."), at: now.addingTimeInterval(-230)),
                ]),
            Bot(id: "growth", name: "Growth", sectionID: "interne", artwork: "comet", runtime: rt("gpu-box", "gemma-4 (local)", "plan", connected: false),
                runs: [BotRun(id: "grp-news", kind: .group, title: "Newsletter", detail: tr("Waiting for the runtime", "En attente du runtime"), status: .queued, usedSteps: 0, maxSteps: 6, tokens: 0, since: now.addingTimeInterval(-38 * 60))],
                thread: [
                    ChatMessage(role: .user, text: tr("Draft the October newsletter from the last 3 changelogs.", "Prépare la newsletter d'octobre à partir des 3 derniers changelogs."), at: now.addingTimeInterval(-2400)),
                    ChatMessage(role: .bot, text: tr("Draft ready (412 words, 3 sections). Shared in the “Newsletter” group, waiting for Léa’s review.", "Brouillon prêt (412 mots, 3 sections). Partagé dans le groupe « Newsletter », en attente de la relecture de Léa."), at: now.addingTimeInterval(-1900)),
                ]),
            Bot(id: "data", name: "Data", sectionID: "interne", artwork: "orbit", runtime: home, thread: idleThread),
            Bot(id: "assistant", name: "Assistant", sectionID: "perso", artwork: "bloom", runtime: mac, thread: idleThread),
            Bot(id: "veille", name: "Veille", sectionID: "perso", artwork: "stealth", runtime: mac,
                routine: BotRoutine(name: tr("HN review", "Revue HN"), next: tr("in 51 min", "dans 51 min")),
                runs: [BotRun(id: "rt-hn", kind: .routine, title: tr("HN review", "Revue HN"), detail: tr("6 links kept", "6 liens retenus"), status: .completed, usedSteps: 2, maxSteps: 2, tokens: 800, since: now.addingTimeInterval(-9 * 60))],
                thread: idleThread),
            Bot(id: "recherche", name: "Recherche", sectionID: "perso", artwork: "astral", runtime: mac, thread: idleThread),
            Bot(id: "notes", name: "Notes", sectionID: "perso", artwork: "cloud", runtime: mac, thread: idleThread),
        ]
    }
}
