import AppKit
import Foundation
import Observation
import os

/// La page Réglages › Modèles : le runtime de l'organisation, son catalogue, le modèle par défaut,
/// le mode d'attribution, et les accès fournisseur (clé API ou OAuth par code), comme l'écran
/// `settings/installation/models` de la console. Les clés partent vers l'hôte et n'en reviennent pas.
@MainActor @Observable
final class ModelsSettingsModel {
    enum Phase: Equatable { case idle, loading, ready, noRuntime, failed(String) }
    enum Tone: Equatable { case success, warning, error }
    struct Notice: Equatable { var tone: Tone; var text: String }

    /// L'autorisation OAuth en cours : un fournisseur à la fois, comme le dialogue de la console.
    struct OAuth: Equatable {
        var provider: String
        var session: RuntimeProviderOauthDto?
        var error: String?
    }

    private(set) var phase: Phase = .idle
    private(set) var runtime: RuntimeConfigurationDto.Runtime?
    /// `global` ou `per_bot` ; un serveur qui ne l'envoie pas se comporte en `per_bot`.
    private(set) var assignmentMode = "per_bot"
    private(set) var catalog: RuntimeModelCatalogDto?
    private(set) var savingSelection = false
    private(set) var savingMode = false
    /// Le fournisseur dont la clé est en route vers l'hôte.
    private(set) var savingKey: String?
    private(set) var oauth: OAuth?
    /// Le dernier résultat d'une écriture, par fournisseur (`""` : la préférence ou le mode).
    private(set) var notices: [String: Notice] = [:]
    /// Le catalogue tel que la puce de la fenêtre d'agent le lit, à chaque relecture.
    @ObservationIgnored var onCatalog: ((ModelCatalog) -> Void)?

    @ObservationIgnored private let api: OHBotAPI
    @ObservationIgnored private let openURL: @MainActor (URL) -> Void
    @ObservationIgnored private let pollInterval: Duration
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    private static let log = Logger(subsystem: "app.openedbot.popup", category: "models")

    init(account: any TokenSource, transport: any HTTPTransport = URLSession.shared, pollInterval: Duration = .seconds(1),
         openURL: @escaping @MainActor (URL) -> Void = { NSWorkspace.shared.open($0) }) {
        api = OHBotAPI(account: account, transport: transport)
        self.pollInterval = pollInterval
        self.openURL = openURL
    }

    var providers: [RuntimeModelCatalogDto.Provider] { catalog?.providers ?? [] }
    var connectedProviders: [RuntimeModelCatalogDto.Provider] { providers.filter { $0.authenticated == true && !$0.models.isEmpty } }
    /// Le serveur n'écrit les accès que par l'opérateur de l'hôte (`management.kind == host`).
    var credentialsWritable: Bool { runtime?.management?.credentialsWritable ?? false }
    var oauthWritable: Bool { runtime?.management?.oauthWritable ?? false }

    // MARK: Lecture

    /// Le runtime puis son catalogue ; une relecture garde l'écran en place et ne dit que l'échec.
    func load() async {
        if catalog == nil { phase = .loading }
        do {
            let config: RuntimeConfigurationDto = try await api.get("/api/runtime")
            runtime = config.runtime
            assignmentMode = config.modelAssignmentMode ?? "per_bot"
            guard let id = config.runtime?.id else {
                catalog = nil
                phase = .noRuntime
                return
            }
            catalog = try await api.get("/api/runtimes/\(id)/models")
            phase = .ready
            publish()
        } catch OHBotAuthError.cancelled {
        } catch {
            let text = Self.message(error)
            Self.log.error("models: \(text, privacy: .public)")
            if catalog == nil { phase = .failed(text) } else { notices[""] = Notice(tone: .error, text: text) }
        }
    }

    private func reloadCatalog() async throws {
        guard let id = runtime?.id else { return }
        catalog = try await api.get("/api/runtimes/\(id)/models")
        publish()
    }

    private func publish() {
        guard let catalog else { return }
        onCatalog?(OHBotMapping.catalog(catalog, runtime: RuntimeConfigurationDto(runtime: runtime, modelAssignmentMode: assignmentMode)))
    }

    // MARK: Préférence et mode

    /// Le modèle des runs sans modèle propre ; `provider == nil` laisse Hermes décider.
    /// Le serveur prouve le couple par une inférence : plusieurs secondes, et un refus explicite.
    func select(provider: String?, model: String?, effort: String?) async {
        guard let id = runtime?.id, !savingSelection else { return }
        struct Body: Encodable {
            var provider: String?, model: String?, reasoningEffort: String?
            // `null` explicite : effacer la préférence n'est pas « ne rien envoyer ».
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(provider, forKey: .provider)
                try c.encode(model, forKey: .model)
                try c.encode(reasoningEffort, forKey: .reasoningEffort)
            }
            enum CodingKeys: String, CodingKey { case provider, model, reasoningEffort }
        }
        savingSelection = true
        defer { savingSelection = false }
        notices[""] = nil
        do {
            let saved: RuntimeConfigurationDto.Runtime = try await api.post("/api/runtimes/\(id)/model-selection",
                                                                            json: Body(provider: provider, model: model, reasoningEffort: effort), method: "PUT")
            // La réponse est le runtime public ; un champ qu'elle omettrait garde sa valeur lue.
            var merged = saved
            merged.id = saved.id ?? runtime?.id
            merged.name = saved.name ?? runtime?.name
            merged.link = saved.link ?? runtime?.link
            merged.management = saved.management ?? runtime?.management
            runtime = merged
            notices[""] = Notice(tone: .success, text: tr("Default model saved.", "Modèle par défaut enregistré."))
            publish()
        } catch {
            notices[""] = Notice(tone: .error, text: Self.message(error))
        }
    }

    func setAssignmentMode(_ mode: String) async {
        guard mode != assignmentMode, !savingMode else { return }
        struct Body: Encodable { var mode: String }
        struct Saved: Decodable { var modelAssignmentMode: String }
        savingMode = true
        defer { savingMode = false }
        notices[""] = nil
        do {
            let saved: Saved = try await api.post("/api/runtimes/assignment-mode", json: Body(mode: mode), method: "PUT")
            assignmentMode = saved.modelAssignmentMode
            publish()
        } catch {
            notices[""] = Notice(tone: .error, text: Self.message(error))
        }
    }

    // MARK: Accès fournisseur

    /// La clé part vers l'hôte, qui la vérifie sur son propre catalogue ; elle ne reste nulle part ici.
    /// Vrai si l'hôte l'a confirmée.
    @discardableResult
    func saveKey(provider slug: String, apiKey: String) async -> Bool {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let id = runtime?.id, !key.isEmpty, savingKey == nil, Self.isSlug(slug) else { return false }
        struct Body: Encodable { var apiKey: String }
        savingKey = slug
        defer { savingKey = nil }
        notices[slug] = nil
        do {
            let verdict: RuntimeProviderCredentialDto = try await api.post("/api/runtimes/\(id)/providers/\(slug)/credentials",
                                                                           json: Body(apiKey: key))
            switch verdict.verification {
            case "confirmed":
                notices[slug] = Notice(tone: .success, text: tr("Key saved on the runtime host.", "Clé enregistrée sur l'hôte du runtime."))
                await connected(slug)
                return true
            case "unverified":
                notices[slug] = Notice(tone: .warning, text: verdict.detail ?? tr("Key saved, but the host could not verify it.",
                                                                                   "Clé enregistrée, mais l'hôte n'a pas pu la vérifier."))
                try? await reloadCatalog()
            default:
                notices[slug] = Notice(tone: .error, text: verdict.detail ?? tr("The provider refused this key.", "Le fournisseur a refusé cette clé."))
            }
        } catch {
            notices[slug] = Notice(tone: .error, text: Self.message(error))
        }
        return false
    }

    /// Ouvre une autorisation sur l'hôte, puis la sonde chaque seconde jusqu'à son issue.
    /// Une session déjà ouverte pour ce fournisseur est rendue par le serveur (409 absorbé).
    func startOAuth(provider slug: String) {
        cancelOAuth()
        guard let id = runtime?.id, Self.isSlug(slug) else { return }
        notices[slug] = nil
        oauth = OAuth(provider: slug)
        pollTask = Task { [weak self] in await self?.runOAuth(runtimeID: id, provider: slug) }
    }

    private func runOAuth(runtimeID id: String, provider slug: String) async {
        let path = "/api/runtimes/\(id)/providers/\(slug)/auth"
        do {
            var session: RuntimeProviderOauthDto = try await api.post(path, json: [String: String]())
            // Fermé pendant l'ouverture : la session que l'hôte vient de créer ne doit pas attendre pour rien.
            if Task.isCancelled {
                if session.isOpen { cancelRemote(path, session.sessionId) }
                return
            }
            update(slug, session)
            while session.isOpen {
                try await Task.sleep(for: pollInterval)
                // L'hôte clôt une session expirée ; on ne sonde pas au-delà s'il ne le fait pas.
                if let expires = session.expiresAt, Date() > expires.addingTimeInterval(5) {
                    return fail(slug, tr("The authorization expired. Start again.", "L'autorisation a expiré. Recommencez."))
                }
                do {
                    session = try await api.get(path, query: ["sessionId": session.sessionId])
                } catch OHBotAuthError.cancelled {
                    return
                } catch {
                    // Une session perdue (hôte redémarré, 404) ne se sonde plus.
                    return fail(slug, tr("The authorization session was lost: \(Self.message(error))",
                                         "La session d'autorisation est perdue : \(Self.message(error))"))
                }
                guard !Task.isCancelled else { return }
                update(slug, session)
            }
            switch session.status {
            case "connected":
                notices[slug] = Notice(tone: .success, text: tr("Provider connected.", "Fournisseur connecté."))
                await connected(slug)
                if !Task.isCancelled, oauth?.provider == slug { oauth = nil }
            case "cancelled":
                fail(slug, tr("Authorization cancelled.", "Autorisation annulée."))
            default:
                fail(slug, session.error ?? tr("The authorization failed.", "L'autorisation a échoué."))
            }
        } catch is CancellationError {
        } catch OHBotAuthError.cancelled {
        } catch {
            fail(slug, Self.message(error))
        }
    }

    /// Une sonde annulée (autre fournisseur, page fermée) n'écrit plus rien.
    private func update(_ slug: String, _ session: RuntimeProviderOauthDto) {
        guard !Task.isCancelled, oauth?.provider == slug else { return }
        oauth?.session = session
    }

    private func fail(_ slug: String, _ text: String) {
        guard !Task.isCancelled, oauth?.provider == slug else { return }
        oauth?.error = text
    }

    /// Ferme la sonde et, si l'hôte attend encore, annule la session là-bas.
    func cancelOAuth() {
        pollTask?.cancel()
        pollTask = nil
        guard let current = oauth else { return }
        oauth = nil
        guard let id = runtime?.id, let session = current.session, session.isOpen else { return }
        cancelRemote("/api/runtimes/\(id)/providers/\(current.provider)/auth", session.sessionId)
    }

    private func cancelRemote(_ path: String, _ sessionID: String) {
        Task { [api] in
            do {
                try await api.delete(path, query: ["sessionId": sessionID])
            } catch {
                // Sans annulation, la session s'éteint seule à son échéance sur l'hôte.
                Self.log.notice("oauth cancel: \(Self.message(error), privacy: .public)")
            }
        }
    }

    func openVerification() {
        guard let raw = oauth?.session?.verificationUri, let url = URL(string: raw), url.scheme == "https" else { return }
        openURL(url)
    }

    /// Après une connexion : le catalogue relu, et le fournisseur tout juste relié devient la
    /// préférence si celle enregistrée est vide ou inutilisable (la règle de la console).
    private func connected(_ slug: String) async {
        do { try await reloadCatalog() } catch {
            notices[slug] = Notice(tone: .warning, text: tr("Connected, but the catalog could not be reread: \(Self.message(error))",
                                                            "Connecté, mais le catalogue n'a pas pu être relu : \(Self.message(error))"))
            return
        }
        guard let fresh = providers.first(where: { $0.slug == slug }), fresh.authenticated == true, let first = fresh.models.first else { return }
        let stored = runtime?.selectedProvider
        let storedUsable = stored.map { s in providers.contains { $0.slug == s && $0.authenticated == true } } ?? false
        guard !storedUsable else { return }
        await select(provider: slug, model: first.id, effort: first.reasoning == true ? ReasoningEffort.defaultLevel : nil)
    }

    // MARK: Erreurs

    /// Le slug va tel quel dans le chemin (`URL.appending(path:)` encode le reste) : il vient du
    /// serveur, `[a-z0-9][a-z0-9_-]*`, et rien d'autre n'y entre, surtout pas un `/`.
    static func isSlug(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 64 && s.unicodeScalars.allSatisfy { CharacterSet.lowercaseLetters.contains($0) && $0.isASCII
            || CharacterSet.decimalDigits.contains($0) && $0.isASCII || $0 == "_" || $0 == "-" }
    }

    static func message(_ error: Error) -> String {
        guard let e = error as? OHBotAuthError else { return error.localizedDescription }
        if case .http(_, let code?) = e {
            switch code {
            case "ROLE_REQUIRED": return tr("Your role does not allow changing models: an operator or owner is required.",
                                            "Votre rôle ne permet pas de modifier les modèles : il faut être opérateur ou propriétaire.")
            case "RUNTIME_ADMIN_DISABLED": return tr("openedbot cannot manage provider access on this runtime. Use edge-setup on the host.",
                                                     "openedbot ne peut pas gérer les accès fournisseur de ce runtime. Utilisez edge-setup sur l'hôte.")
            case "RUNTIME_LINK_UNAVAILABLE": return tr("The runtime host is not reachable through the link.", "L'hôte du runtime n'est pas joignable par le lien.")
            case "CREDENTIAL_IN_PROGRESS": return tr("Another key is being saved on the host. Try again in a moment.",
                                                     "Une autre clé est en cours d'enregistrement sur l'hôte. Réessayez dans un instant.")
            case "RUNTIME_PROVIDER_KEY_INVALID": return tr("This key is not valid.", "Cette clé n'est pas valide.")
            case "RUNTIME_NOT_FOUND": return tr("Runtime not found.", "Runtime introuvable.")
            case "RUNTIME_PROVIDER_WRITE_FAILED": return tr("The host did not apply the provider operation.", "L'hôte n'a pas appliqué l'opération fournisseur.")
            default: break
            }
        }
        return e.userMessage
    }
}
