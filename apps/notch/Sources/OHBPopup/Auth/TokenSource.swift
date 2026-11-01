import Foundation

/// Un jeton d'accès prêt à porter dans une requête : jamais le refresh token, qui reste chez
/// celui qui tient la session (`AccountModel` en autonome, openedbot en mode hébergé).
struct BearerToken: Equatable, Sendable {
    let accessToken: String
    /// Envoyée en `X-OHB-Organization` ; filtre aussi les événements du flux.
    let organizationId: String
    let expiresAt: Date

    /// Rafraîchir avant d'envoyer : à moins de `seconds` de l'expiration.
    func expires(within seconds: TimeInterval, now: Date = Date()) -> Bool {
        expiresAt.timeIntervalSince(now) < seconds
    }
}

extension OHBotSession {
    var bearer: BearerToken { BearerToken(accessToken: accessToken, organizationId: organizationId, expiresAt: accessTokenExpiresAt) }
}

/// D'où viennent les jetons du flux et des réglages. Deux sources : `AccountModel` (connexion,
/// trousseau, refresh en vol unique) quand l'encoche tourne seule ; `HostTokenSource` quand openedbot
/// l'a lancée avec `--hosted` et garde la session. `OHBotAPI` et `OHBotFeed` ne voient que ceci.
@MainActor
protocol TokenSource: AnyObject {
    /// L'origine de l'API ; nil tant qu'elle est invalide (autonome) ou pas encore donnée (hébergé).
    var origin: URL? { get }
    var isSignedIn: Bool { get }
    /// L'organisation de la session en cours, nil sans session.
    var organizationId: String? { get }
    /// Un bearer valide, rafraîchi s'il expire sous 30 s. Sans session : `http(401, AUTH_REQUIRED)`.
    func validToken() async throws -> BearerToken
    /// Après un 401 sur un jeton qu'on croyait bon : un jeton neuf, une fois.
    func refreshedToken() async throws -> BearerToken
}
