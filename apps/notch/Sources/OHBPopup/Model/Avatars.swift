import AppKit
import ImageIO
import SwiftUI

/// Les artworks WEBP d'openedbot (console openedbot), embarqués dans `Resources/bots`.
/// Ils font 1024 px et l'encoche les montre entre 13 et 34 pt : décodés en entier, dix
/// avatars pèsent 40 Mo ; en vignettes (256 px au plus, ImageIO réduit par deux), 2,5 Mo.
@MainActor
enum Avatars {
    static let thumbnailPixels = 128
    /// Les portraits du catalogue (`artworks.ts`) : recadrés, coins arrondis ; les autres tiennent dans le cadre.
    static let portraits: Set<String> = ["astral", "halo", "selene"]
    private static var cache: [String: NSImage] = [:]

    static func image(for artwork: String?) -> NSImage? {
        guard let artwork else { return nil }
        if let hit = cache[artwork] { return hit }
        guard let url = Bundle.module.url(forResource: "bot-\(artwork)", withExtension: "webp", subdirectory: "bots"),
              let image = thumbnail(at: url) else { return nil }
        cache[artwork] = image
        return image
    }

    /// Décode l'image directement à la taille voulue, sans jamais matérialiser l'original.
    static func thumbnail(at url: URL, maxPixels: Int = thumbnailPixels) -> NSImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }
}

/// L'avatar d'un bot : son visage, résolu comme dans la console.
struct AvatarView: View {
    let bot: Bot
    var size: CGFloat

    var body: some View {
        // En démo, `artwork` porte l'illustration et `face` est vide.
        FaceView(seed: bot.id, name: bot.name, face: bot.face ?? bot.artwork.map { BotFace(artwork: $0) }, size: size)
    }
}
