import Foundation

// Les DTO d'openedbot (openedbot API), réduits aux champs
// que l'encoche lit. Tout ce qui peut manquer sur un serveur plus ancien est optionnel.

struct RosterDto: Decodable, Sendable {
    struct Section: Decodable, Sendable { var id: String; var name: String; var position: Int? }
    struct Face: Decodable, Sendable {
        var artwork: String?
        var palette: String?
        var shape: String?
        var eyes: String?

        var model: BotFace { BotFace(artwork: artwork, palette: palette, shape: shape, eyes: eyes) }
    }
    struct Bot: Decodable, Sendable {
        var id: String
        var threadId: String
        var name: String
        var sectionId: String?
        var model: String?
        var reasoningEffort: String?
        var face: Face?
        var permissionMode: String?
        var notifyOnFinish: Bool?
        var awaitingApproval: Bool?
        var running: Bool?
        var unread: Bool?
        var hidden: Bool?
        var archivedAt: String?
    }
    var sections: [Section]
    var bots: [Bot]
    var cursor: Int?
}

struct RuntimeConfigurationDto: Decodable, Sendable {
    struct Connector: Decodable, Sendable { var version: String?; var latestVersion: String? }
    struct Link: Decodable, Sendable { var connector: Connector?; var connected: Bool; var lastSeenAt: Date? }
    struct Runtime: Decodable, Sendable {
        var id: String?
        var name: String?
        var reachability: String?
        var link: Link?
        var selectedProvider: String?
        var selectedModel: String?
        var reasoningEffort: String?
        var lastHealthStatus: String?
        var management: Management?
    }
    /// Le canal d'écriture des accès fournisseur : `host` (opérateur edge-setup, par le lien),
    /// `hermes_dashboard` ou `manual` (rien ne s'écrit d'ici).
    struct Management: Decodable, Sendable { var kind: String?; var credentialsWritable: Bool?; var oauthWritable: Bool? }
    var runtime: Runtime?
    /// `global` ou `per_bot` ; absent sur un serveur plus ancien (= per_bot).
    var modelAssignmentMode: String?
}

/// `GET /api/runtimes/:id/models` : `RuntimeModelCatalogDto`.
struct RuntimeModelCatalogDto: Decodable, Sendable {
    struct Model: Decodable, Sendable { var id: String; var reasoning: Bool?; var isRuntimeDefault: Bool? }
    struct Provider: Decodable, Sendable {
        var slug: String
        var name: String
        var authenticated: Bool?
        var models: [Model]
        /// Servi sans credential (intégré au runtime) : rien à connecter.
        var alwaysAuthenticated: Bool?
        var acceptsApiKey: Bool?
        var acceptsOauth: Bool?
        var warning: String?
    }
    var runtimeDefaultModel: String?
    var providers: [Provider]
    /// Le fournisseur que Hermes sert quand openedbot ne choisit rien.
    var currentProvider: String?
    /// Un profil Hermes nommé : ses accès se posent à la main sur l'hôte.
    var hermesProfile: String?
}

/// `POST /api/runtimes/:id/providers/:slug/credentials` : le verdict de l'hôte sur la clé.
struct RuntimeProviderCredentialDto: Decodable, Sendable {
    var provider: String
    var verification: String
    var detail: String?
}

/// `POST|GET /api/runtimes/:id/providers/:slug/auth` : une autorisation OAuth par code, tenue par l'hôte.
struct RuntimeProviderOauthDto: Decodable, Sendable, Equatable {
    var sessionId: String
    var provider: String
    var status: String
    var verificationUri: String?
    var userCode: String?
    var error: String?
    var expiresAt: Date?

    var isOpen: Bool { status == "starting" || status == "pending" }
}

struct InboxDto: Decodable, Sendable {
    struct Item: Decodable, Sendable {
        var kind: String
        var id: String
        var botId: String?
        var threadId: String?
        var approvalId: String?
        var runId: String?
        var summary: String?
        var expiresAt: Date?
        var occurredAt: Date?
    }
    var items: [Item]
}

struct ApprovalRequestDto: Decodable, Sendable {
    var id: String
    var runId: String
    var kind: String?
    var action: String
    var detail: String?
    var status: String
    var requestedAt: Date?
}

struct RunDto: Decodable, Sendable {
    struct Usage: Decodable, Sendable { var totalTokens: Int? }
    var id: String
    var status: String
    var input: String?
    var output: String?
    var usage: Usage?
    var error: String?
    var createdAt: Date
    var startedAt: Date?
    var endedAt: Date?
    var workflowId: String?
}

struct WorkflowDto: Decodable, Sendable {
    var id: String
    var kind: String
    var status: String
    var rootRunId: String?
    var usedSteps: Int?
    var maxSteps: Int?
    var usedTokens: Int?
    var errorMessage: String?
}

struct ThreadMessageDto: Decodable, Sendable {
    struct Part: Decodable, Sendable {
        var type: String
        var text: String?
        var toolName: String?
        var name: String?
        /// Une pièce jointe (`displayContent`) : son identifiant pour `GET /api/attachments/:id`.
        var id: String?
        var contentType: String?
        var kind: String?
        var bytes: Int?
    }
    struct Author: Decodable, Sendable { var id: String; var name: String?; var face: RosterDto.Face? }
    struct Reaction: Decodable, Sendable { var emoji: String; var count: Int; var reactedByMe: Bool? }
    /// Le message cité (`replyTo`), avec son contenu pour l'extrait.
    struct ReplyTo: Decodable, Sendable { var id: String; var role: String; var content: [Part]?; var authorBot: Author? }
    var id: String
    var role: String
    var content: [Part]
    var runId: String?
    var createdAt: Date
    var authorBot: Author?
    var reactions: [Reaction]?
    var replyTo: ReplyTo?
}

struct ThreadSnapshotDto: Decodable, Sendable {
    var id: String
    var messages: [ThreadMessageDto]
    var runs: [RunDto]
    var workflows: [WorkflowDto]?
    /// Construit par la route, hors du type TypeScript : les approbations en attente du fil.
    var approvals: [ApprovalRequestDto]?
    var cursor: Int?
    /// Les événements des runs du fil : outils, deltas, erreurs (complets via `/history`).
    var events: [OrganizationEventDto]?
}

struct RoutinesDto: Decodable, Sendable {
    struct Routine: Decodable, Sendable { var id: String; var name: String; var enabled: Bool; var nextRunAt: Date? }
    var routines: [Routine]
}

struct SendMessageAcceptedDto: Decodable, Sendable {
    var runId: String
    var status: String?
}

/// Une trame du flux `GET /api/events` : l'enveloppe `OrganizationEvent` et les champs de
/// charge utile qu'on applique en direct (`hermes-events.ts`), tous optionnels.
struct OrganizationEventDto: Decodable, Sendable {
    struct Payload: Decodable, Sendable {
        var text: String?
        var messageId: String?
        var toolCallId: String?
        var tool: String?
        var preview: String?
        var durationMs: Double?
        var error: Bool?
        var errorMessage: String?
        var message: String?
        var kind: String?
        var status: String?
        var resultExcerpt: String?
        var errorCode: String?
    }
    var cursor: Int?
    var organizationId: String
    var threadId: String?
    var runId: String?
    var botId: String?
    var sequence: Int?
    var type: String
    var payload: Payload?
    var occurredAt: Date?
}
