import CryptoKit
import Foundation
import Security

// Le flux natif d'openedbot (openedbot API, `/api/auth/native/*`), le
// même que les apps iOS et bureau d'openedbot : PKCE, un bearer opaque de 15 min, un refresh
// token rotatif de 30 jours. Pas de magic link ni de token d'API côté utilisateur.

/// La session que `/api/auth/native/token` renvoie. Un champ vide fait échouer le décodage.
struct OHBotSession: Codable, Equatable, Sendable {
    let accessToken: String
    let refreshToken: String
    let organizationId: String
    let accessTokenExpiresAt: Date

    init(accessToken: String, refreshToken: String, organizationId: String, accessTokenExpiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.organizationId = organizationId
        self.accessTokenExpiresAt = accessTokenExpiresAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func nonEmpty(_ key: CodingKeys) throws -> String {
            let v = try c.decode(String.self, forKey: key)
            guard !v.isEmpty else { throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "vide") }
            return v
        }
        accessToken = try nonEmpty(.accessToken)
        refreshToken = try nonEmpty(.refreshToken)
        organizationId = try nonEmpty(.organizationId)
        accessTokenExpiresAt = try c.decode(Date.self, forKey: .accessTokenExpiresAt)
    }

    /// Rafraîchir avant d'envoyer : à moins de 30 s de l'expiration, comme le client iOS.
    func expires(within seconds: TimeInterval, now: Date = Date()) -> Bool {
        accessTokenExpiresAt.timeIntervalSince(now) < seconds
    }
}

enum OHBotPasswordLoginOutcome: Equatable, Sendable {
    case signedIn(OHBotSession)
    case codeRequired
}

/// Ce que `GET /api/auth/me` dit de la personne connectée. Tout est optionnel : le DTO
/// peut s'enrichir sans casser l'app.
struct OHBotAccount: Codable, Equatable, Sendable {
    struct User: Codable, Equatable, Sendable {
        var id: String?
        var email: String?
        var name: String?
        var displayName: String?
    }
    struct Organization: Codable, Equatable, Sendable {
        var id: String?
        var name: String?
        var slug: String?
    }
    var user: User?
    var organization: Organization?
    var role: String?

    var label: String {
        let who = user?.displayName ?? user?.name ?? user?.email ?? tr("unknown account", "compte inconnu")
        let org = organization?.name ?? organization?.slug
        return [who, org, role].compactMap { $0 }.joined(separator: " · ")
    }
}

/// `GET /api/auth/providers` : ce que ce serveur accepte.
struct OHBotProviders: Decodable, Equatable, Sendable {
    struct Provider: Decodable, Equatable, Sendable {
        var enabled: Bool
        var reason: String?
    }
    var google: Provider?
    var password: Provider?

    var googleEnabled: Bool { google?.enabled == true }
    var passwordEnabled: Bool { password?.enabled ?? true }
}

enum OHBotAuthError: Error, Equatable, Sendable {
    case invalidOrigin
    /// Réponse hors 2xx, avec le `error.code` de l'API s'il y en a un.
    case http(status: Int, code: String?)
    /// Un 5xx dont le serveur a dit la cause : sa phrase (cause et référence) est gardée telle quelle.
    case server(status: Int, code: String?, message: String)
    case network(String)
    case invalidResponse
    /// Google a fini sur un échec (`AUTH_DENIED`, `AUTH_NOT_A_MEMBER`…).
    case refused(code: String?)
    case unexpectedAuthorizeURL
    case timedOut
    case cancelled
    case keychain(OSStatus)

    /// Une phrase pour les réglages, pas un code.
    var userMessage: String {
        switch self {
        case .invalidOrigin: tr("The server address must be an HTTPS origin, for example https://api.openedbot.app.",
                                "L'adresse du serveur doit être une origine HTTPS, par exemple https://api.openedbot.app.")
        case .http(let status, let code): Self.message(forCode: code)
            ?? tr("The server responded \(status)\(code.map { " (\($0))" } ?? "").", "Le serveur a répondu \(status)\(code.map { " (\($0))" } ?? "").")
        case .server(let status, _, let message): tr("The server responded \(status): \(message)", "Le serveur a répondu \(status) : \(message)")
        case .network(let detail): tr("Server unreachable: \(detail)", "Serveur injoignable : \(detail)")
        case .invalidResponse: tr("Unreadable server response.", "Réponse du serveur illisible.")
        case .refused(let code): Self.message(forCode: code)
            ?? tr("Sign-in refused\(code.map { " (\($0))" } ?? "").", "Connexion refusée\(code.map { " (\($0))" } ?? "").")
        case .unexpectedAuthorizeURL: tr("The Google sign-in address returned is not the expected one.",
                                          "L'adresse de connexion Google renvoyée n'est pas celle attendue.")
        case .timedOut: tr("No response from Google within 5 minutes. Try again.", "Pas de réponse de Google dans les 5 minutes. Réessayez.")
        case .cancelled: tr("Sign-in cancelled.", "Connexion annulée.")
        case .keychain(let status): tr("Could not save the session to the Keychain (error \(status)).",
                                        "Impossible d'enregistrer la session dans le trousseau (erreur \(status)).")
        }
    }

    private static func message(forCode code: String?) -> String? {
        switch code {
        case "EMAIL_LOGIN_CODE_INVALID": tr("Invalid or expired code.", "Code invalide ou expiré.")
        case "EMAIL_LOGIN_CODE_COOLDOWN": tr("Wait a minute before requesting another code.", "Patientez une minute avant de demander un nouveau code.")
        case "EMAIL_LOGIN_CODE_UNSENT": tr("The code could not be sent. Try again.", "Le code n’a pas pu être envoyé. Réessayez.")
        case "ALPHA_CLOSED": tr("This server is in closed alpha: your IP address is not allowed.",
                                "Ce serveur est en alpha fermée : votre adresse IP n'est pas autorisée.")
        case "AUTH_NOT_A_MEMBER", "MEMBERSHIP_REQUIRED": tr("This account does not belong to any organization yet.",
                                                            "Ce compte n'appartient encore à aucune organisation.")
        case "AUTH_DENIED": tr("Google refused the sign-in.", "Google a refusé la connexion.")
        case "AUTH_PROVIDER_DISABLED": tr("Google sign-in is not enabled on this server.", "La connexion Google n'est pas activée sur ce serveur.")
        case "REDIRECT_URI_INVALID": tr("This server does not know this native client yet.", "Ce serveur ne connaît pas encore ce client natif.")
        case "REFRESH_TOKEN_INVALID", "SESSION_EXPIRED": tr("The session expired, sign in again.", "La session a expiré, reconnectez-vous.")
        case "TENANT_MISMATCH": tr("The session belongs to another organization.", "La session est liée à une autre organisation.")
        case "RATE_LIMITED": tr("Too many attempts, wait a minute.", "Trop de tentatives, patientez une minute.")
        default: nil
        }
    }
}

enum PKCE {
    /// 32 octets aléatoires en hexadécimal (64 caractères, dans la plage de 43 à 128 caractères).
    static func makeVerifier() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw OHBotAuthError.keychain(status) }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// S256 : SHA-256 en base64url sans padding.
    static func challenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// Ce que le client sait faire d'une requête ; `URLSession` en vrai, un bouchon en test.
protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

extension URLSession: HTTPTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await data(for: request)
        guard let http = response as? HTTPURLResponse else { throw OHBotAuthError.invalidResponse }
        return (data, http)
    }
}

/// Les appels d'auth, sans état : l'origine, le transport, et les deux constantes du client.
struct OHBotAuthClient: Sendable {
    let origin: URL
    let transport: any HTTPTransport
    /// Libre côté API (elle le journalise sans le contrôler) .
    static let clientID = "ohb-notch"
    /// Une des deux valeurs figées dans `platform/config/src/api-config.ts`. Le callback Google
    /// n'y redirige jamais en natif : c'est `claim` qui fait foi, l'app n'a pas à ouvrir `ohb://`.
    static let redirectURI = "ohb://auth/callback"

    /// Une origine seulement : HTTPS, sans chemin ; HTTP toléré sur localhost pour le dev.
    static func origin(from raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let c = URLComponents(string: trimmed), let scheme = c.scheme?.lowercased(), let host = c.host, !host.isEmpty,
              c.path.isEmpty || c.path == "/", c.query == nil, c.user == nil else { return nil }
        let local = host == "localhost" || host == "127.0.0.1"
        guard scheme == "https" || (scheme == "http" && local) else { return nil }
        var out = URLComponents()
        out.scheme = scheme; out.host = host; out.port = c.port
        return out.url
    }

    // MARK: Appels

    func providers() async throws -> OHBotProviders {
        try await decode(OHBotProviders.self, from: request("GET", "/api/auth/providers"))
    }

    func me(_ session: OHBotSession) async throws -> OHBotAccount {
        try await decode(OHBotAccount.self, from: request("GET", "/api/auth/me", bearer: session))
    }

    /// Mode identifiants : `authorize` donne un code à usage unique (5 min), `token` l'échange.
    func login(email: String, password: String, organizationSlug: String?, emailCode: String?, verifier: String) async throws -> OHBotPasswordLoginOutcome {
        struct Body: Encodable { var email: String; var password: String; var emailCode: String?; var codeChallenge: String; var redirectUri: String; var clientId: String; var organizationSlug: String? }
        struct Reply: Decodable { var code: String }
        struct StatusReply: Decodable { var status: String }
        let body = Body(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password,
                        emailCode: emailCode?.isEmpty == true ? nil : emailCode,
                        codeChallenge: PKCE.challenge(for: verifier), redirectUri: Self.redirectURI, clientId: Self.clientID,
                        organizationSlug: organizationSlug?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty)
        let (data, response) = try await performWithResponse(request("POST", "/api/auth/native/authorize", json: body))
        switch response.statusCode {
        case 202:
            let status = try decode(StatusReply.self, from: data)
            guard status.status == "code_required" else { throw OHBotAuthError.invalidResponse }
            return .codeRequired
        case 200:
            let reply = try decode(Reply.self, from: data)
            return .signedIn(try await exchange(code: reply.code, verifier: verifier))
        default:
            throw OHBotAuthError.invalidResponse
        }
    }

    struct GoogleAttempt: Equatable, Sendable { let id: String; let authorizeURL: URL }

    /// Mode SSO : une tentative (10 min) et l'URL Google à ouvrir dans le navigateur.
    func startGoogle(verifier: String) async throws -> GoogleAttempt {
        struct Body: Encodable { var codeChallenge: String; var redirectUri: String; var clientId: String }
        struct Reply: Decodable { var attemptId: String?; var authorizeUrl: String? }
        let reply = try await decode(Reply.self, from: request("POST", "/api/auth/native/google/start",
            json: Body(codeChallenge: PKCE.challenge(for: verifier), redirectUri: Self.redirectURI, clientId: Self.clientID)))
        guard let id = reply.attemptId, !id.isEmpty, let raw = reply.authorizeUrl else { throw OHBotAuthError.invalidResponse }
        guard let url = Self.validAuthorizeURL(raw, origin: origin) else { throw OHBotAuthError.unexpectedAuthorizeURL }
        return GoogleAttempt(id: id, authorizeURL: url)
    }

    enum Claim: Equatable, Sendable { case pending, done(code: String), failed(code: String?) }

    /// À interroger toutes les 1,5 s tant que c'est `pending`.
    func claimGoogle(attemptID: String, verifier: String) async throws -> Claim {
        struct Body: Encodable { var attemptId: String; var codeVerifier: String; var redirectUri: String }
        struct Reply: Decodable { var status: String; var code: String? }
        let reply = try await decode(Reply.self, from: request("POST", "/api/auth/native/google/claim",
            json: Body(attemptId: attemptID, codeVerifier: verifier, redirectUri: Self.redirectURI)))
        switch reply.status {
        case "done":
            guard let code = reply.code, !code.isEmpty else { throw OHBotAuthError.invalidResponse }
            return .done(code: code)
        case "failed": return .failed(code: reply.code)
        default: return .pending
        }
    }

    func exchange(code: String, verifier: String) async throws -> OHBotSession {
        struct Body: Encodable { var grantType = "authorization_code"; var code: String; var codeVerifier: String; var redirectUri: String }
        return try await decode(OHBotSession.self, from: request("POST", "/api/auth/native/token",
            json: Body(code: code, codeVerifier: verifier, redirectUri: Self.redirectURI)))
    }

    /// Rotatif : l'ancien refresh token est révoqué par le serveur, il faut sauver le nouveau.
    func refresh(_ session: OHBotSession) async throws -> OHBotSession {
        struct Body: Encodable { var grantType = "refresh_token"; var refreshToken: String }
        return try await decode(OHBotSession.self, from: request("POST", "/api/auth/native/token", json: Body(refreshToken: session.refreshToken)))
    }

    func logout(_ session: OHBotSession) async throws {
        _ = try await perform(request("POST", "/api/auth/logout", bearer: session))
    }

    /// L'URL Google doit viser `accounts.google.com` ou l'API elle-même, rien d'autre.
    static func validAuthorizeURL(_ raw: String, origin: URL) -> URL? {
        guard let c = URLComponents(string: raw), c.user == nil, c.password == nil,
              let scheme = c.scheme?.lowercased(), let host = c.host?.lowercased(), let url = c.url else { return nil }
        let isAPI = host == origin.host?.lowercased() && c.port == origin.port
        switch scheme {
        case "https": return (host == "accounts.google.com" && c.port == nil) || isAPI ? url : nil
        case "http": return origin.scheme == "http" && isAPI ? url : nil
        default: return nil
        }
    }

    // MARK: Plomberie

    private func request(_ method: String, _ path: String, bearer: OHBotSession? = nil) -> URLRequest {
        var r = URLRequest(url: origin.appending(path: path))
        r.httpMethod = method
        r.timeoutInterval = 20
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearer {
            r.setValue("Bearer \(bearer.accessToken)", forHTTPHeaderField: "Authorization")
            r.setValue(bearer.organizationId, forHTTPHeaderField: "X-OHB-Organization")
        }
        return r
    }

    private func request(_ method: String, _ path: String, json body: some Encodable) throws -> URLRequest {
        var r = request(method, path)
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONEncoder().encode(body)
        return r
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        try await performWithResponse(request).0
    }

    private func performWithResponse(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let http: HTTPURLResponse
        do {
            (data, http) = try await transport.send(request)
        } catch let e as OHBotAuthError {
            throw e
        } catch let e as URLError where e.code == .cancelled {
            throw OHBotAuthError.cancelled
        } catch {
            throw OHBotAuthError.network(error.localizedDescription)
        }
        guard (200..<300).contains(http.statusCode) else {
            struct Envelope: Decodable { struct Inner: Decodable { var code: String? }; var error: Inner? }
            let code = (try? JSONDecoder().decode(Envelope.self, from: data))?.error?.code
            throw OHBotAuthError.http(status: http.statusCode, code: code)
        }
        return (data, http)
    }

    private func decode<T: Decodable>(_ type: T.Type, from request: URLRequest) async throws -> T {
        let data = try await perform(request)
        return try decode(type, from: data)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try Self.decoder.decode(T.self, from: data) } catch { throw OHBotAuthError.invalidResponse }
    }

    /// Les dates de l'API sont ISO 8601 avec fractions de seconde.
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            if let date = (try? Date(s, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
                ?? (try? Date(s, strategy: Date.ISO8601FormatStyle())) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "date ISO 8601 attendue : \(s)"))
        }
        return d
    }()
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
