import AppKit
import Foundation
import Observation
import SwiftUI

/// L'état de l'encoche et les réglages, observés par la vue et le contrôleur.
@MainActor @Observable
final class NotchModel {
    // Données
    var bots: [Bot] = []
    var sections: [BotSection] = []
    var now = Date()

    // Interaction
    var isExpanded = false
    var isPinned = false
    /// Ce qui est déployé à côté de l'encoche : la carte d'un bot ou le plateau d'une pile.
    var overlay: Overlay?
    /// Index de l'élément auquel l'overlay est accroché.
    var overlayAnchor: Int?
    /// Où la carte ouverte est accrochée : l'orbe pour le runtime, sinon sa cellule.
    var overlayAttachment: NotchGeometry.Anchor? {
        if overlay == .runtime { return .orb }
        return overlayAnchor.map { .cell($0) }
    }
    var overlaySize: CGSize = .zero
    var isHoveringOrb = false
    var settingsSpins = 0
    var announcement: String?
    /// Île : la taille mesurée du panneau déplié, pour savoir où le pointeur le touche.
    var islandSize: CGSize = .zero
    /// Île : le message bref à côté de la caméra (run fini, accord donné), nil sinon.
    var islandFlash: Island.Flash?
    /// Les notifications, lues ou non : la seule source de vérité du badge, des bannières et du panneau.
    var inbox = Inbox()
    /// Île : la bannière qui descend de la caméra, nil sinon.
    var banner: Banner?
    /// Île : la taille mesurée de la bannière, pour savoir où le pointeur la touche.
    var bannerSize: CGSize = .zero
    /// Écran verrouillé, endormi, ou personne au clavier : les bannières attendent le retour.
    var isAway = false
    @ObservationIgnored private var flashToken = 0

    /// Montre un message bref à côté de la caméra, puis revient à l'état compact. Un message plus
    /// récent n'est pas effacé par le minuteur du précédent.
    func flash(_ flash: Island.Flash, for seconds: Double = 4) {
        flashToken += 1
        let token = flashToken
        islandFlash = flash
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, self.flashToken == token else { return }
            self.islandFlash = nil
        }
    }
    /// Ce que le flux openedbot fait en ce moment ; nil en démo.
    var feedState: FeedState?
    /// Le runtime de l'organisation (`GET /api/runtime`) ; nil en démo, où l'on lit celui des bots.
    var runtime: RuntimeStatus?
    /// Le journal en direct : réglages › Journal et la carte du runtime le lisent.
    var journal = Journal()
    /// Le catalogue de modèles du runtime, pour la puce de la fenêtre d'agent.
    var modelCatalog: ModelCatalog?
    /// Combien de sélecteurs de modèle sont ouverts : Échap les ferme avant de fermer une fenêtre.
    var openPickers = 0
    /// Incrémenté par le contrôleur quand Échap doit fermer les sélecteurs ouverts.
    var closePickersTick = 0

    enum FeedState: Equatable, Sendable {
        case connecting
        case live
        /// Coupé, on réessaie ; la phrase dit pourquoi.
        case retrying(String)
        /// Arrêté pour de bon (accès révoqué, session morte) ; la phrase dit quoi faire.
        case failed(String)

        var text: String {
            switch self {
            case .connecting: tr("connecting to the stream…", "connexion au flux…")
            case .live: tr("stream live", "flux en direct")
            case .retrying(let why): tr("stream cut, retrying: \(why)", "flux coupé, nouvel essai : \(why)")
            case .failed(let why): tr("stream stopped: \(why)", "flux arrêté : \(why)")
            }
        }
    }

    enum Overlay: Hashable, Sendable {
        case card(String)
        case tray(title: String, members: [String])
        /// La carte du runtime, accrochée à l'orbe : état du flux, du runtime, dernières lignes du journal.
        case runtime
    }

    // Réglages
    var edge: NotchEdge = .right { didSet { save(edge.rawValue, "edge") } }
    var alongOffsets: [NotchEdge: CGFloat] = [:] {
        didSet { save(alongOffsets.map { "\($0.key.rawValue):\($0.value)" }.joined(separator: ","), "offsets") }
    }
    var sizeScale: CGFloat = 1 { didSet { save(Double(sizeScale), "size") } }
    var viewMode: ViewMode = .sections { didSet { save(viewMode.rawValue, "view") } }
    var alwaysOn = false { didSet { save(alwaysOn, "alwaysOn") } }
    var isHidden = false { didSet { save(isHidden, "hidden") } }
    var announces = true { didSet { save(announces, "announces") } }
    var plays = true { didSet { save(plays, "plays") } }
    var menuBarActivity = true { didSet { save(menuBarActivity, "menuBarActivity") } }
    /// Notifications macOS pendant une absence (écran verrouillé, loin du clavier) ; demande l'autorisation à l'activation.
    var systemNotifications = false { didSet { save(systemNotifications, "systemNotifications") } }

    var metrics: NotchMetrics { NotchMetrics(scale: sizeScale) }
    var alongOffset: CGFloat {
        get { alongOffsets[edge] ?? 0 }
        set { alongOffsets[edge] = newValue }
    }
    var showsBody: Bool { !isHidden && (isExpanded || isPinned || alwaysOn || announcement != nil) }

    var items: [NotchItem] { LayoutRules.items(bots: bots, sections: sections, view: viewMode) }

    func bot(_ id: String) -> Bot? { bots.first { $0.id == id } }

    /// Le runtime à montrer : celui du serveur, sinon celui que portent les bots (démo).
    var runtimeStatus: RuntimeStatus? { runtime ?? bots.first.map { RuntimeStatus($0.runtime) } }
    var liveness: Liveness { Liveness.of(feed: feedState, runtime: runtimeStatus) }

    func record(_ level: JournalEntry.Level, _ topic: JournalEntry.Topic, _ text: String, key: String? = nil) {
        journal.record(level, topic, text, key: key)
    }

    func update(_ id: String, _ body: (inout Bot) -> Void) {
        guard let i = bots.firstIndex(where: { $0.id == id }) else { return }
        body(&bots[i])
        bots[i].trimHistory()
    }

    var pendingCount: Int { bots.reduce(0) { $0 + ($1.pending != nil ? 1 : 0) } }
    var runningCount: Int { bots.filter { $0.activity == .working }.count }

    // MARK: Persistance

    @ObservationIgnored private var loaded = false
    /// Où les réglages vivent : le domaine de l'app en autonome, une suite à part en mode hébergé.
    @ObservationIgnored private var defaults: UserDefaults = .standard

    func load(from d: UserDefaults = .standard) {
        defaults = d
        if let raw = d.string(forKey: key("edge")), let e = NotchEdge(rawValue: raw) { edge = e }
        if let raw = d.string(forKey: key("offsets")) {
            var map: [NotchEdge: CGFloat] = [:]
            for pair in raw.split(separator: ",") {
                let kv = pair.split(separator: ":")
                if kv.count == 2, let e = NotchEdge(rawValue: String(kv[0])), let v = Double(kv[1]) { map[e] = v }
            }
            alongOffsets = map
        }
        let size = d.double(forKey: key("size"))
        if size > 0 { sizeScale = size }
        if let raw = d.string(forKey: key("view")), let v = ViewMode(rawValue: raw) { viewMode = v }
        alwaysOn = d.bool(forKey: key("alwaysOn"))
        isHidden = d.bool(forKey: key("hidden"))
        if d.object(forKey: key("announces")) != nil { announces = d.bool(forKey: key("announces")) }
        if d.object(forKey: key("plays")) != nil { plays = d.bool(forKey: key("plays")) }
        if d.object(forKey: key("menuBarActivity")) != nil { menuBarActivity = d.bool(forKey: key("menuBarActivity")) }
        systemNotifications = d.bool(forKey: key("systemNotifications"))
        loaded = true
    }

    private func key(_ name: String) -> String { "notch.\(name)" }

    private func save(_ value: Any, _ name: String) {
        guard loaded else { return }
        defaults.set(value, forKey: key(name))
    }
}
