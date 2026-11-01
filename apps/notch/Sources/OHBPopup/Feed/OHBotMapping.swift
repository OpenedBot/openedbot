import Foundation

/// Des DTO d'openedbot aux types de l'encoche : des fonctions pures, testées à part.
enum OHBotMapping {
    /// Les artworks par défaut, dans l'ordre du catalogue (openedbot API).
    static let defaultArtworks = ["orbit", "comet", "prism", "bloom", "wave", "ember", "jelly", "pixel", "samurai", "explorer",
                                  "thunder", "cloud", "coral", "lunar", "solar", "ink", "aurora", "butterfly", "mecha", "music",
                                  "ocean", "cactus", "firefly", "wind", "crystal", "retro", "stealth", "confetti", "marshmallow", "volcano"]

    /// `defaultArtworkFor(seed)` de la console : hash 31 sur les unités UTF-16 de `"artwork:" + seed`.
    static func defaultArtwork(for seed: String) -> String {
        var hash: UInt32 = 0
        for unit in ("artwork:" + seed).utf16 { hash = hash &* 31 &+ UInt32(unit) }
        return defaultArtworks[Int(hash % UInt32(defaultArtworks.count))]
    }

    /// L'artwork d'un bot : catalogue tel quel, visage vectoriel ou pièce jointe → rien (initiale).
    static func artwork(face: RosterDto.Face?, botID: String) -> String? {
        guard let face else { return defaultArtwork(for: botID) }
        guard let a = face.artwork, !a.isEmpty, !a.hasPrefix("/") else { return nil }
        return a
    }

    static func runtime(_ dto: RuntimeConfigurationDto?, model: String?, mode: String?, previous: BotRuntime?, now: Date) -> BotRuntime {
        let r = dto?.runtime
        let connected: Bool
        if let link = r?.link { connected = link.connected } else { connected = r?.lastHealthStatus == "healthy" }
        var downSince = previous?.downSince
        if connected { downSince = nil } else if downSince == nil { downSince = r?.link?.lastSeenAt ?? now }
        return BotRuntime(name: r?.name ?? "runtime", model: model ?? r?.selectedModel ?? tr("unknown model", "modèle inconnu"), mode: mode ?? "auto",
                          connected: connected, lastSeenAt: r?.link?.lastSeenAt ?? previous?.lastSeenAt ?? now,
                          connectorVersion: r?.link?.connector?.version ?? "", latestVersion: r?.link?.connector?.latestVersion,
                          downSince: downSince)
    }

    static func status(_ raw: String) -> RunStatus {
        switch raw {
        case "queued", "pending", "starting": .queued
        case "running", "relaying": .running
        case "awaiting_approval": .awaitingApproval
        case "completed": .completed
        default: .failed
        }
    }

    static func kind(_ raw: String?) -> RunKind {
        switch raw { case "group": .group; case "routine": .routine; default: .dm }
    }

    /// Les runs qui comptent : vivants, ou finis depuis moins de dix minutes. Les plus récents d'abord.
    static func runs(_ runs: [RunDto], workflows: [WorkflowDto], botName: String, now: Date) -> [BotRun] {
        let byID = Dictionary(workflows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return runs
            .filter { run in
                let s = status(run.status)
                if s == .completed || s == .failed { return (run.endedAt ?? run.createdAt) > now.addingTimeInterval(-10 * 60) }
                return true
            }
            .sorted { ($0.startedAt ?? $0.createdAt) > ($1.startedAt ?? $1.createdAt) }
            .prefix(6)
            .map { run in
                let wf = run.workflowId.flatMap { byID[$0] }
                let s = status(run.status)
                let input = (run.input ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let title = input.isEmpty ? botName : String(input.prefix(40)) + (input.count > 40 ? "…" : "")
                let detail: String
                if let err = run.error ?? wf?.errorMessage, s == .failed { detail = err }
                else if let out = run.output, !out.isEmpty { detail = String(out.prefix(80)) }
                else { detail = s == .running ? tr("running", "en cours") : s.word }
                return BotRun(id: run.id, kind: kind(wf?.kind), title: title, detail: detail, status: s,
                              usedSteps: wf?.usedSteps ?? (s == .completed ? 1 : 0), maxSteps: wf?.maxSteps ?? (s == .completed ? 1 : 0),
                              tokens: wf?.usedTokens ?? run.usage?.totalTokens ?? 0, since: run.startedAt ?? run.createdAt)
            }
    }

    /// Le fil : `user`, `assistant`, et un `tool` par appel d'outil dans un message.
    /// Le fil tel que la console le tient : messages persistés, événements, état des runs.
    static func conversation(_ snap: ThreadSnapshotDto) -> Conversation {
        var c = Conversation()
        c.messages = snap.messages.map(message)
        for run in snap.runs {
            c.runs[run.id] = ConversationRun(status: status(run.status), startedAt: run.startedAt ?? run.createdAt)
        }
        for dto in snap.events ?? [] {
            guard let e = event(dto) else { continue }
            // Les runs du snapshot font foi : l'événement ne remet pas « en cours » un run conclu.
            if !c.events.contains(where: { $0.key == e.key }) { c.events.append(e) }
        }
        return c
    }

    static func message(_ m: ThreadMessageDto) -> ConversationMessage {
        var text: [String] = []
        var attachments: [ConversationAttachment] = []
        for part in m.content {
            switch part.type {
            case "text": text.append(part.text ?? "")
            case "attachment":
                attachments.append(ConversationAttachment(remoteID: part.id, name: part.name ?? tr("file", "fichier"),
                                                          contentType: part.contentType ?? "application/octet-stream",
                                                          kind: part.kind ?? "document", bytes: part.bytes))
            default: break // reasoning, tool-call : la console ne les rend pas depuis le message
            }
        }
        return ConversationMessage(id: m.id, role: m.role == "assistant" ? .assistant : .user,
                                   text: text.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines),
                                   attachments: attachments, runID: m.runId, at: m.createdAt,
                                   authorBotID: m.authorBot?.id, authorName: m.authorBot?.name, authorFace: m.authorBot?.face?.model,
                                   reactions: (m.reactions ?? []).map { MessageReaction(emoji: $0.emoji, count: $0.count, mine: $0.reactedByMe == true) },
                                   replyTo: m.replyTo.map(replyQuote))
    }

    /// L'extrait d'un message cité, comme `ReplyQuote` de la console : l'auteur, puis le texte sur une ligne.
    static func replyQuote(_ r: ThreadMessageDto.ReplyTo) -> ReplyQuote {
        let text = (r.content ?? []).compactMap { $0.type == "text" ? $0.text : nil }.joined(separator: " ")
        let flat = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        let attachments = (r.content ?? []).filter { $0.type == "attachment" }.compactMap(\.name)
        let excerpt = flat.isEmpty ? attachments.joined(separator: ", ") : String(flat.prefix(160))
        let author = r.authorBot?.name ?? (r.role == "assistant" ? tr("The bot", "Le bot") : tr("You", "Vous"))
        return ReplyQuote(messageID: r.id, authorName: author, excerpt: excerpt)
    }

    /// Un événement de run réduit à ce que le fil affiche ; nil sans run ni séquence.
    static func event(_ dto: OrganizationEventDto, now: Date = Date()) -> ConversationEvent? {
        guard let run = dto.runId, let seq = dto.sequence else { return nil }
        let p = dto.payload
        return ConversationEvent(runID: run, sequence: seq, type: dto.type, at: dto.occurredAt ?? now,
                                 text: dto.type == "run.error" ? nil : p?.text, tool: p?.tool, preview: p?.preview,
                                 toolCallID: p?.toolCallId, durationMs: p?.durationMs, failed: p?.error == true,
                                 errorMessage: dto.type == "run.error" ? (p?.message ?? p?.errorMessage) : p?.errorMessage,
                                 resultExcerpt: p?.resultExcerpt)
    }

    static func messages(_ dtos: [ThreadMessageDto]) -> [ChatMessage] {
        var out: [ChatMessage] = []
        for m in dtos {
            let role: MessageRole = m.role == "user" && m.authorBot == nil ? .user : .bot
            let fromOtherBot = m.role == "user" && m.authorBot != nil
            var buffer: [String] = []
            var textIndex = 0
            func flush() {
                let text = buffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                buffer = []
                guard !text.isEmpty else { return }
                let prefixed = fromOtherBot ? tr("\(m.authorBot?.name ?? "a bot"): \(text)", "\(m.authorBot?.name ?? "un bot") : \(text)") : text
                out.append(ChatMessage(remoteID: textIndex == 0 ? m.id : "\(m.id)+\(textIndex)", role: role, text: prefixed, at: m.createdAt))
                textIndex += 1
            }
            // Dans l'ordre du message : un appel d'outil coupe le texte là où il a eu lieu.
            for (i, part) in m.content.enumerated() {
                switch part.type {
                case "text": buffer.append(part.text ?? "")
                case "tool-call":
                    flush()
                    out.append(ChatMessage(remoteID: "\(m.id)#\(i)", role: .tool, text: part.toolName ?? tr("tool", "outil"), at: m.createdAt))
                case "attachment":
                    flush()
                    out.append(ChatMessage(remoteID: "\(m.id)@\(i)", role: .system, text: tr("attachment: \(part.name ?? "file")", "pièce jointe : \(part.name ?? "fichier")"), at: m.createdAt))
                default: break // reasoning : pas montré
                }
            }
            flush()
        }
        return out
    }

    /// L'approbation d'un bot : l'inbox donne l'échéance, le snapshot du fil la commande.
    static func approval(item: InboxDto.Item, botID: String, request: ApprovalRequestDto?) -> Approval {
        Approval(remoteID: item.approvalId ?? item.id, botID: botID, runID: item.runId ?? request?.runId ?? "",
                 tool: request?.kind ?? "shell",
                 command: request?.action ?? item.summary ?? tr("command awaiting your approval", "commande en attente de votre accord"),
                 expiresAt: item.expiresAt ?? (item.occurredAt ?? Date()).addingTimeInterval(10 * 60))
    }

    /// Le catalogue vu du sélecteur : fournisseurs authentifiés avec au moins un modèle, sans doublon d'identifiant.
    static func catalog(_ dto: RuntimeModelCatalogDto, runtime: RuntimeConfigurationDto?) -> ModelCatalog {
        var seen: Set<String> = []
        let providers: [ModelCatalog.Provider] = dto.providers
            .filter { $0.authenticated != false && !$0.models.isEmpty }
            .map { p in
                ModelCatalog.Provider(slug: p.slug, name: p.name, models: p.models.compactMap { m in
                    guard !seen.contains(m.id) else { return nil }
                    seen.insert(m.id)
                    return ModelCatalog.Model(id: m.id, reasoning: m.reasoning ?? false)
                })
            }
            .filter { !$0.models.isEmpty }
        let r = runtime?.runtime
        let global = r?.selectedModel ?? (r?.selectedProvider == nil ? dto.runtimeDefaultModel : nil)
        return ModelCatalog(providers: providers, globalModel: global, globalEffort: r?.reasoningEffort,
                            assignmentMode: runtime?.modelAssignmentMode ?? "per_bot")
    }

    static func routine(_ dtos: [RoutinesDto.Routine], now: Date) -> BotRoutine? {
        let next = dtos.filter(\.enabled).sorted { ($0.nextRunAt ?? .distantFuture) < ($1.nextRunAt ?? .distantFuture) }.first
        guard let next else { return nil }
        let when = next.nextRunAt.map { $0 > now ? tr("in \(ElapsedCopy.text(since: now, now: $0))", "dans \(ElapsedCopy.text(since: now, now: $0))")
                                                  : tr("imminent", "imminente") } ?? tr("not scheduled", "non planifiée")
        return BotRoutine(name: next.name, next: when)
    }
}
