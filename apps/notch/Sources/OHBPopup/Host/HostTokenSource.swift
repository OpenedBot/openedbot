import Foundation
import Observation
import os

/// Les jetons quand openedbot tient la session (`--hosted`) : on les lui demande par le canal, on ne
/// se connecte pas, on ne rafraîchit rien soi-même et on ne touche jamais au trousseau.
///
/// Une demande à la fois par sorte (normale ou forcée) : les appels concurrents du flux et des
/// réglages attendent la même réponse. Les réponses sont rapprochées par leur `id`, quel que soit
/// leur ordre d'arrivée.
@MainActor @Observable
final class HostTokenSource: TokenSource {
    private static let log = Logger(subsystem: "app.openedbot.popup", category: "host")

    /// Imposée par `hello` ; nil avant.
    private(set) var origin: URL?
    private(set) var consoleURL: URL?
    private(set) var isSignedIn = false
    /// `hello` reçu et valide.
    private(set) var isReady = false
    @ObservationIgnored private var current: BearerToken?
    var organizationId: String? { current?.organizationId }

    @ObservationIgnored private let send: (HostProtocol.Outgoing) -> Bool
    @ObservationIgnored private let timeout: Duration
    @ObservationIgnored private var nextID = 0
    @ObservationIgnored private var pending: [String: CheckedContinuation<HostProtocol.TokenReply, Error>] = [:]
    @ObservationIgnored private var flights: [Bool: Task<BearerToken, Error>] = [:]
    @ObservationIgnored private var closed = false

    /// `hello` invalide ou d'une autre version : la popup doit s'arrêter avec ce code.
    @ObservationIgnored var onFatal: (String) -> Void = { _ in }

    init(send: @escaping (HostProtocol.Outgoing) -> Bool, timeout: Duration = .seconds(20)) {
        self.send = send
        self.timeout = timeout
    }

    // MARK: Messages de l'hôte

    func receive(line: String) {
        switch HostProtocol.parse(line) {
        case .success(let message): receive(message)
        case .failure(let reason): Self.log.error("ligne de l'hôte ignorée : \(String(describing: reason), privacy: .public)")
        }
    }

    func receive(_ message: HostProtocol.Incoming) {
        switch message {
        case .hello(let version, let api, let console):
            guard version == HostProtocol.version else {
                Self.log.error("protocole de l'hôte inconnu : \(version)")
                onFatal("PROTOCOL_UNSUPPORTED")
                return
            }
            guard let o = HostProtocol.origin(from: api), let c = HostProtocol.consoleURL(from: console) else {
                Self.log.error("hello refusé : origine invalide")
                onFatal("BAD_HELLO")
                return
            }
            origin = o
            consoleURL = c
            isReady = true
        case .token(let reply):
            guard let continuation = pending.removeValue(forKey: reply.id) else {
                Self.log.error("réponse de l'hôte sans requête (id \(reply.id, privacy: .public)) ignorée")
                return
            }
            continuation.resume(returning: reply)
        case .signedOut:
            dropSession()
        case .signedIn:
            isSignedIn = true
        }
    }

    /// stdin fermé : l'hôte est parti. Les demandes en cours échouent, rien d'autre ne partira.
    func hostClosed() {
        closed = true
        failPending(OHBotAuthError.cancelled)
    }

    // MARK: TokenSource

    func validToken() async throws -> BearerToken {
        guard isSignedIn else { throw Self.signedOutError }
        if let current, !current.expires(within: 30) { return current }
        return try await fetch(force: false)
    }

    func refreshedToken() async throws -> BearerToken {
        guard isSignedIn else { throw Self.signedOutError }
        return try await fetch(force: true)
    }

    // MARK: Gestes vers l'hôte

    func openConsole(path: String) {
        if !send(.openConsole(path: path)) { Self.log.error("ouverture de la console non transmise : hôte injoignable") }
    }

    /// La déconnexion appartient à openedbot : on la lui demande, il répondra `signedOut`.
    func signOut() {
        if !send(.signOut) { Self.log.error("déconnexion non transmise : hôte injoignable") }
    }

    // MARK: Interne

    private static let signedOutError = OHBotAuthError.http(status: 401, code: "AUTH_REQUIRED")

    private func fetch(force: Bool) async throws -> BearerToken {
        if let flight = flights[force] { return try await flight.value }
        let task = Task { try await self.request(force: force) }
        flights[force] = task
        defer { if flights[force] == task { flights[force] = nil } }
        return try await task.value
    }

    private func request(force: Bool) async throws -> BearerToken {
        guard !closed else { throw OHBotAuthError.cancelled }
        nextID += 1
        let id = String(nextID)
        let reply = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<HostProtocol.TokenReply, Error>) in
            pending[id] = continuation
            guard send(.token(id: id, force: force)) else {
                pending[id] = nil
                continuation.resume(throwing: OHBotAuthError.network(tr("openedbot is not answering", "openedbot ne répond pas")))
                return
            }
            let timeout = self.timeout
            Task { [weak self] in
                try? await Task.sleep(for: timeout)
                self?.expire(id)
            }
        }
        return try adopt(reply)
    }

    private func adopt(_ reply: HostProtocol.TokenReply) throws -> BearerToken {
        if let access = reply.accessToken, let raw = reply.expiresAt, let org = reply.organizationId {
            guard let expiresAt = Self.date(raw) else { throw OHBotAuthError.invalidResponse }
            let token = BearerToken(accessToken: access, organizationId: org, expiresAt: expiresAt)
            current = token
            isSignedIn = true
            return token
        }
        if reply.unavailable {
            // La session vit chez l'hôte : on garde l'état, le flux réessaiera.
            throw OHBotAuthError.network(tr("openedbot could not renew the session right now", "openedbot n'a pas pu renouveler la session pour l'instant"))
        }
        dropSession()
        throw Self.signedOutError
    }

    private func expire(_ id: String) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        Self.log.error("pas de réponse de l'hôte à la demande \(id, privacy: .public)")
        continuation.resume(throwing: OHBotAuthError.network(tr("openedbot is not answering", "openedbot ne répond pas")))
    }

    private func dropSession() {
        current = nil
        isSignedIn = false
        failPending(Self.signedOutError)
    }

    private func failPending(_ error: Error) {
        let waiting = pending
        pending = [:]
        for (_, continuation) in waiting { continuation.resume(throwing: error) }
    }

    private static func date(_ raw: String) -> Date? {
        (try? Date(raw, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))) ?? (try? Date(raw, strategy: Date.ISO8601FormatStyle()))
    }
}
