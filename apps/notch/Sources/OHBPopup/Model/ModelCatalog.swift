import AppKit
import Foundation

/// Le catalogue de modèles du runtime, vu du sélecteur : les fournisseurs authentifiés et
/// leurs modèles, le modèle global, et la façon dont la console résout celui du prochain run.
struct ModelCatalog: Equatable, Sendable {
    struct Model: Equatable, Sendable, Identifiable {
        let id: String
        var reasoning: Bool
    }
    struct Provider: Equatable, Sendable, Identifiable {
        let slug: String
        let name: String
        var models: [Model]
        var id: String { slug }
    }

    var providers: [Provider]
    /// Le modèle que le runtime sert par défaut (réglage global), s'il y en a un.
    var globalModel: String?
    var globalEffort: String?
    /// `global` : le choix par bot ne serait pas honoré ; `per_bot` : il l'est.
    var assignmentMode: String

    var knownIDs: Set<String> { Set(providers.flatMap { $0.models.map(\.id) }) }
    var reasoningIDs: Set<String> { Set(providers.flatMap { $0.models.filter(\.reasoning).map(\.id) }) }
    var modelCount: Int { providers.reduce(0) { $0 + $1.models.count } }

    func provider(of modelID: String) -> Provider? {
        providers.first { $0.models.contains { $0.id == modelID } }
    }

    /// Ce que le prochain run utilisera, et d'où ça vient : miroir de `resolveThreadModel`.
    struct Resolved: Equatable, Sendable {
        enum Source: Sendable { case perBot, global, fallback }
        var model: String
        var effort: String?
        var source: Source
    }

    func resolve(botModel: String?, botEffort: String?) -> Resolved? {
        let perBot = assignmentMode != "global"
        let usable = perBot && botModel.map { knownIDs.contains($0) } == true
        guard let model = usable ? botModel : globalModel, !model.isEmpty else { return nil }
        let stored = (perBot ? botEffort : nil) ?? globalEffort
        let effort = reasoningIDs.contains(model) ? stored.flatMap { ReasoningEffort.levels.contains($0) ? $0 : nil } : nil
        return Resolved(model: model, effort: effort, source: usable ? .perBot : (botModel != nil && perBot ? .fallback : .global))
    }
}

/// Les six niveaux que Hermes comprend (openedbot API).
enum ReasoningEffort {
    static let levels = ["none", "minimal", "low", "medium", "high", "xhigh"]
    static let defaultLevel = "medium"

    static func label(_ raw: String?) -> String {
        switch raw {
        case "none": tr("None", "Aucun")
        case "minimal": tr("Minimal", "Minimal")
        case "low": tr("Low", "Faible")
        case "medium": tr("Medium", "Moyen")
        case "high": tr("High", "Élevé")
        case "xhigh": tr("Very high", "Très élevé")
        default: tr("Default", "Par défaut")
        }
    }
}

/// Le nom lisible d'un fournisseur et la couleur de sa pastille (la table de `provider-icon.tsx`).
enum ProviderMark {
    enum Tint: String, Sendable, Decodable { case neutral, orange, blue, green }

    /// La table des marques de la console openedbot, exportée dans `Resources/brand-marks.json`.
    struct Table: Decodable, Sendable {
        struct Mark: Decodable, Sendable { var title: String; var path: String; var tint: Tint }
        struct Known: Decodable, Sendable { var label: String; var mark: String; var tag: String? }
        var marks: [String: Mark]
        var providers: [String: Known]
    }

    static let table: Table = {
        guard let url = Bundle.module.url(forResource: "brand-marks", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let table = try? JSONDecoder().decode(Table.self, from: data) else {
            // Ressource absente ou illisible : des monogrammes partout plutôt qu'un plantage.
            return Table(marks: [:], providers: [:])
        }
        return table
    }()

    static func label(_ slug: String, name: String?) -> String {
        table.providers[slug]?.label ?? ((name ?? "").trimmingCharacters(in: .whitespaces).isEmpty ? slug : name!)
    }

    static func tint(_ slug: String) -> Tint {
        table.providers[slug].flatMap { table.marks[$0.mark]?.tint } ?? .neutral
    }

    /// Les initiales, comme la console pour un fournisseur sans marque.
    static func initials(_ slug: String, name: String?) -> String {
        let parts = label(slug, name: name).split { $0 == " " || $0 == "-" }
        if parts.count >= 2 { return String(parts[0].prefix(1) + parts[1].prefix(1)).uppercased() }
        return String((parts.first ?? Substring(slug)).prefix(2)).uppercased()
    }

    /// Le tracé simple-icons du fournisseur en image gabarit (teintée par la vue), nil sans marque connue.
    @MainActor static func image(_ slug: String) -> NSImage? {
        guard let key = table.providers[slug]?.mark, let mark = table.marks[key] else { return nil }
        if let hit = images[key] { return hit }
        let svg = ##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="black" d="\##(mark.path)"/></svg>"##
        guard let image = NSImage(data: Data(svg.utf8)) else { return nil }
        image.isTemplate = true
        images[key] = image
        return image
    }

    @MainActor private static var images: [String: NSImage] = [:]
}
