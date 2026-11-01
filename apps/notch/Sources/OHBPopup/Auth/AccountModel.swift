import AppKit
import Foundation
import Observation

/// Le compte openedbot vu des réglages : l'origine du serveur, la session dans le trousseau,
/// les deux façons de se connecter, et un jeton valide pour le flux réel de demain.
@MainActor @Observable
final class AccountModel: TokenSource {
    /// L'hôte API des clients natifs (`/api/*` seulement, depuis le 2026-10-17) ;
    /// `https://openedbot.app` reste servi pour une origine déjà enregistrée.
    static let defaultOrigin = "https://api.openedbot.app"

    /// Le rythme du sondage Google ; les tests l'accélèrent.
    struct Timing: Sendable {
        var pollInterval: Duration = .milliseconds(1_500)
        var timeout: Duration = .seconds(5 * 60)
        var maxPollFailures = 5
        var sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    }

    enum Phase: Equatable, Sendable {
        case signedOut
        case codeRequired(email: String)
        /// Une connexion en cours, avec ce qu'on attend (« Google dans le navigateur… »).
        case busy(String)
        case signedIn
    }

    // État observé
    var originText: String { didSet { if loaded { defaults.set(originText, forKey: "notch.apiOrigin") } } }
    private(set) var session: OHBotSession?
    private(set) var account: OHBotAccount?
    private(set) var providers: OHBotProviders?
    private(set) var phase: Phase = .signedOut
    /// Le dernier échec, en français, effacé à la prochaine tentative.
    var error: String?

    // Plomberie, hors observation
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let keychain: SessionKeychain
    @ObservationIgnored private let transport: any HTTPTransport
    @ObservationIgnored private let timing: Timing
    @ObservationIgnored private let openURL: @MainActor (URL) -> Void
    @ObservationIgnored private var googleTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<OHBotSession, Error>?
    @ObservationIgnored private var loaded = false

    init(defaults: UserDefaults = .standard,
         keychain: SessionKeychain = SessionKeychain(),
         transport: any HTTPTransport = URLSession.shared,
         timing: Timing = Timing(),
         openURL: @escaping @MainActor (URL) -> Void = { NSWorkspace.shared.open($0) }) {
        self.defaults = defaults
        self.keychain = keychain
        self.transport = transport
        self.timing = timing
        self.openURL = openURL
        originText = defaults.string(forKey: "notch.apiOrigin") ?? Self.defaultOrigin
        loaded = true
    }

    var origin: URL? { OHBotAuthClient.origin(from: originText) }
    var isSignedIn: Bool { session != nil }
    var organizationId: String? { session?.organizationId }

    private func client() throws -> OHBotAuthClient {
        guard let origin else { throw OHBotAuthError.invalidOrigin }
        return OHBotAuthClient(origin: origin, transport: transport)
    }

    // MARK: Au lancement

    /// Reprend la session du trousseau pour cette origine, puis vérifie qu'elle vit encore.
    /// Serveur injoignable : on garde la session et on le dit ; refresh refusé : on la jette.
    func restore() async {
        error = nil
        guard let origin else { return }
        // Pour tester contre un faux serveur local sans toucher au trousseau :
        // `-notch.apiOrigin http://127.0.0.1:8787 -notch.sessionFile /chemin/session.json`.
        if let path = defaults.string(forKey: "notch.sessionFile"), origin.host == "127.0.0.1" || origin.host == "localhost",
           let data = FileManager.default.contents(atPath: path),
           let s = try? OHBotAuthClient.decoder.decode(OHBotSession.self, from: data) {
            session = s
            phase = .signedIn
            await loadAccount()
            return
        }
        // Hors du thread principal : si macOS demande l'accès au trousseau (binaire resigné,
        // signature ad hoc), l'alerte ne doit pas geler l'encoche en attendant la réponse.
        let keychain = self.keychain
        do {
            session = try await Task.detached { try keychain.load(origin: origin) }.value
        } catch let e as OHBotAuthError {
            error = e.userMessage
            return
        } catch { return }
        guard session != nil else { phase = .signedOut; return }
        phase = .signedIn
        await loadAccount()
    }

    /// `GET /api/auth/providers` : si Google est possible ici.
    func checkProviders() async {
        do { providers = try await client().providers() } catch { providers = nil }
    }

    // MARK: Connexion

    func signIn(email: String, password: String, organizationSlug: String, emailCode: String?) async {
        guard !isBusy else { return }
        error = nil
        guard !email.trimmingCharacters(in: .whitespaces).isEmpty, !password.isEmpty else {
            error = tr("Email and password are required.", "E-mail et mot de passe sont requis.")
            return
        }
        let verificationCode = emailCode?.isEmpty == true ? nil : emailCode
        phase = .busy(tr("Signing in…", "Connexion…"))
        do {
            let c = try client()
            let verifier = try PKCE.makeVerifier()
            let outcome = try await c.login(
                email: email,
                password: password,
                organizationSlug: organizationSlug,
                emailCode: verificationCode,
                verifier: verifier
            )
            guard case .signedIn(let s) = outcome else {
                phase = .codeRequired(email: email.trimmingCharacters(in: .whitespacesAndNewlines))
                return
            }
            try await adopt(s, origin: c.origin)
            await loadAccount()
        } catch {
            if verificationCode != nil,
               let authError = error as? OHBotAuthError,
               shouldKeepCodeStep(after: authError) {
                self.error = authError.userMessage
                phase = .codeRequired(email: email.trimmingCharacters(in: .whitespacesAndNewlines))
            } else {
                fail(error)
            }
        }
    }

    private func shouldKeepCodeStep(after error: OHBotAuthError) -> Bool {
        switch error {
        case .http(status: 401, code: "EMAIL_LOGIN_CODE_INVALID"),
             .http(status: 429, code: "EMAIL_LOGIN_CODE_COOLDOWN"):
            true
        default:
            false
        }
    }

    func cancelCodeSignIn() {
        guard case .codeRequired = phase else { return }
        phase = .signedOut
        error = nil
    }

    /// Google : la tentative, le navigateur, puis `claim` en boucle jusqu'au code.
    func signInWithGoogle() {
        guard !isBusy else { return }
        error = nil
        phase = .busy(tr("Google sign-in in the browser…", "Connexion Google dans le navigateur…"))
        googleTask = Task { [weak self] in
            guard let self else { return }
            do {
                let c = try client()
                let verifier = try PKCE.makeVerifier()
                let attempt = try await c.startGoogle(verifier: verifier)
                openURL(attempt.authorizeURL)
                let code = try await pollClaim(c, attemptID: attempt.id, verifier: verifier)
                try Task.checkCancellation()
                let s = try await c.exchange(code: code, verifier: verifier)
                try await adopt(s, origin: c.origin)
                await loadAccount()
            } catch is CancellationError {
                fail(OHBotAuthError.cancelled)
            } catch {
                fail(error)
            }
            googleTask = nil
        }
    }

    func cancelGoogle() {
        googleTask?.cancel()
    }

    private func pollClaim(_ c: OHBotAuthClient, attemptID: String, verifier: String) async throws -> String {
        let deadline = ContinuousClock.now.advanced(by: timing.timeout)
        var failures = 0
        while true {
            try Task.checkCancellation()
            guard ContinuousClock.now < deadline else { throw OHBotAuthError.timedOut }
            try await timing.sleep(timing.pollInterval)
            let claim: OHBotAuthClient.Claim
            do {
                claim = try await c.claimGoogle(attemptID: attemptID, verifier: verifier)
                failures = 0
            } catch OHBotAuthError.http(let status, let code) where (400..<500).contains(status) {
                throw OHBotAuthError.http(status: status, code: code) // ne guérira pas tout seul
            } catch OHBotAuthError.cancelled {
                throw CancellationError()
            } catch {
                failures += 1
                if failures > timing.maxPollFailures { throw error }
                continue
            }
            switch claim {
            case .done(let code): return code
            case .failed(let code): throw OHBotAuthError.refused(code: code)
            case .pending: continue
            }
        }
    }

    // MARK: Déconnexion

    /// Révoque côté serveur si possible, efface le trousseau dans tous les cas.
    func signOut() async {
        cancelGoogle()
        error = nil
        if let session, let c = try? client() {
            try? await c.logout(session)
        }
        if let origin { await forget(origin) }
        session = nil
        account = nil
        phase = .signedOut
    }

    // MARK: Jeton pour le flux

    /// Un bearer valide, rafraîchi en vol unique s'il expire sous 30 s. Un refresh refusé
    /// déconnecte : la session rotative est morte, il faut se reconnecter.
    func validToken() async throws -> BearerToken {
        try await validSession(force: false).bearer
    }

    /// Après un 401 sur un jeton qu'on croyait bon : on le rafraîchit quand même, une fois.
    func refreshedToken() async throws -> BearerToken {
        try await validSession(force: true).bearer
    }

    private func validSession(force: Bool) async throws -> OHBotSession {
        guard let session else { throw OHBotAuthError.http(status: 401, code: "AUTH_REQUIRED") }
        guard force || session.expires(within: 30) else { return session }
        if let refreshTask { return try await refreshTask.value }
        let c = try client()
        let task = Task<OHBotSession, Error> { try await c.refresh(session) }
        refreshTask = task
        defer { refreshTask = nil }
        do {
            let fresh = try await task.value
            try await adopt(fresh, origin: c.origin)
            return fresh
        } catch OHBotAuthError.http(let status, let code) where status == 401 || status == 403 {
            await forget(c.origin)
            self.session = nil
            account = nil
            phase = .signedOut
            error = OHBotAuthError.http(status: status, code: code).userMessage
            throw OHBotAuthError.http(status: status, code: code)
        }
    }

    // MARK: Interne

    private var isBusy: Bool { if case .busy = phase { return true } else { return false } }

    private func adopt(_ s: OHBotSession, origin: URL) async throws {
        let keychain = self.keychain
        try await Task.detached { try keychain.save(s, origin: origin) }.value
        session = s
        phase = .signedIn
    }

    private func forget(_ origin: URL) async {
        let keychain = self.keychain
        _ = try? await Task.detached { try keychain.delete(origin: origin) }.value
    }

    private func loadAccount() async {
        do {
            let s = try await validSession(force: false)
            account = try await client().me(s)
        } catch OHBotAuthError.http(let status, let code) where status == 401 || status == 403 {
            // Session refusée par `me` : elle ne vaut plus rien.
            if let origin { await forget(origin) }
            session = nil
            account = nil
            phase = .signedOut
            error = OHBotAuthError.http(status: status, code: code).userMessage
        } catch let e as OHBotAuthError {
            // Réseau ou serveur en vrac : la session reste, on le dit.
            error = e.userMessage
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func fail(_ error: Error) {
        self.error = (error as? OHBotAuthError)?.userMessage ?? error.localizedDescription
        phase = session == nil ? .signedOut : .signedIn
    }
}
