import AppKit
import SwiftUI

/// Les visages bloub de la console au repos (`Resources/faces`, exportés depuis la console openedbot
/// avec le vrai moteur) : un SVG par forme × expression, la couleur posée à la volée.
@MainActor
enum BloubFaces {
    struct Catalog: Decodable { var shapes: [String]; var expressions: [String]; var colors: [String] }

    static let catalog: Catalog = load("catalog", as: Catalog.self) ?? Catalog(shapes: [], expressions: [], colors: [])
    static let colors: [String: String] = load("colors", as: [String: String].self) ?? [:]
    private static var cache: [String: NSImage] = [:]

    private static func load<T: Decodable>(_ name: String, as: T.Type) -> T? {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "faces"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    /// `pickBySeed` de la console : un identifiant inconnu retombe sur un choix stable tiré de la graine.
    nonisolated static func pick(_ list: [String], seed: String, salt: String) -> String? {
        guard !list.isEmpty else { return nil }
        var hash: UInt32 = 0
        for unit in "\(salt):\(seed)".utf16 { hash = hash &* 31 &+ UInt32(unit) }
        return list[Int(hash % UInt32(list.count))]
    }

    static func resolve(_ face: BotFace, seed: String) -> (shape: String, eyes: String, color: String)? {
        func find(_ list: [String], _ id: String?, _ salt: String) -> String? {
            if let id, list.contains(id) { return id }
            return pick(list, seed: seed, salt: salt)
        }
        guard let shape = find(catalog.shapes, face.shape, "shape"), let eyes = find(catalog.expressions, face.eyes, "eyes"),
              let color = find(catalog.colors, face.palette, "palette") else { return nil }
        return (shape, eyes, color)
    }

    static func image(_ face: BotFace, seed: String) -> NSImage? {
        guard let r = resolve(face, seed: seed), var hex = colors[r.color] else { return nil }
        // « encre » (#0a0a0c) disparaît sur le noir de l'encoche et des fenêtres : on l'éclaircit en gris clair.
        if r.color == "encre" { hex = "#d4d4d4" }
        let key = "\(r.shape)/\(r.eyes)/\(hex)"
        if let hit = cache[key] { return hit }
        guard let url = Bundle.module.url(forResource: "face-\(r.shape)-\(r.eyes)", withExtension: "svg", subdirectory: "faces"),
              let template = try? String(contentsOf: url, encoding: .utf8),
              let image = NSImage(data: Data(template.replacingOccurrences(of: "#INK", with: hex).utf8)) else { return nil }
        cache[key] = image
        return image
    }
}

/// Les images servies par l'API avec la session (`/api/attachments/:id`) : avatars importés, pièces jointes.
/// Le flux openedbot pose le chargeur ; en démo il n'y en a pas et rien ne se charge.
@MainActor @Observable
final class RemoteImages {
    static let shared = RemoteImages()
    @ObservationIgnored var loader: (@MainActor (String) async throws -> Data)?
    private(set) var images: [String: NSImage] = [:]
    private(set) var failures: Set<String> = []
    @ObservationIgnored private var inflight: Set<String> = []

    func image(_ path: String) -> NSImage? { images[path] }
    func failed(_ path: String) -> Bool { failures.contains(path) }

    func load(_ path: String) {
        guard images[path] == nil, !failures.contains(path), !inflight.contains(path), let loader else { return }
        inflight.insert(path)
        Task {
            defer { inflight.remove(path) }
            do {
                let data = try await loader(path)
                guard let image = NSImage(data: data) else { throw CocoaError(.fileReadCorruptFile) }
                images[path] = image
            } catch {
                failures.insert(path)
            }
        }
    }

    func reset() { images.removeAll(); failures.removeAll() }
}

/// Le visage d'un bot comme `BotFace` dans la console : image importée, illustration du catalogue,
/// visage bloub, illustration tirée de l'identifiant si l'API n'en donne aucun, initiale en dernier recours.
struct FaceView: View {
    let seed: String
    let name: String
    let face: BotFace?
    var size: CGFloat
    private var remote = RemoteImages.shared

    init(seed: String, name: String, face: BotFace?, size: CGFloat) {
        self.seed = seed; self.name = name; self.face = face; self.size = size
    }

    private var catalogArtwork: String? {
        if let a = face?.artwork, !a.isEmpty, !a.hasPrefix("/") { return a }
        return face == nil ? OHBotMapping.defaultArtwork(for: seed) : nil
    }

    var body: some View {
        if let path = face?.artwork, path.hasPrefix("/api/") {
            Group {
                if let image = remote.image(path) {
                    Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fill)
                } else {
                    initial
                }
            }
            .frame(width: size, height: size).clipShape(Circle())
            .task(id: path) { remote.load(path) }
        } else if let artwork = catalogArtwork, let image = Avatars.image(for: artwork) {
            let portrait = Avatars.portraits.contains(artwork)
            Image(nsImage: image).resizable().interpolation(.high)
                .aspectRatio(contentMode: portrait ? .fill : .fit)
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: portrait ? size * 0.3 : 0, style: .continuous))
        } else if let face, let image = BloubFaces.image(face, seed: seed) {
            Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
        } else {
            initial
        }
    }

    private var initial: some View {
        Text(String(name.prefix(1)).uppercased())
            .font(.system(size: size * 0.55, weight: .bold))
            .foregroundStyle(Palette.textPrimary)
            .frame(width: size, height: size)
            .background(Circle().fill(.white.opacity(0.14)))
    }
}
