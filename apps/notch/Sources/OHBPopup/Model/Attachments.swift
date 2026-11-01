import AppKit
import Foundation
import PDFKit
import UniformTypeIdentifiers

/// Une pièce à joindre au prochain message, lue sur le disque et déjà au format du serveur :
/// une image en data-URI, un texte emballé dans `<attachment name=…>` (`modules/conversation/domain/attachments.ts`).
struct PendingAttachment: Identifiable, Equatable, Sendable {
    enum Kind: String, Sendable { case image, document }
    let id: UUID
    let name: String
    let contentType: String
    let kind: Kind
    /// Les octets réels de la pièce (après réduction pour une image) : c'est eux que le serveur borne.
    let data: Data

    init(id: UUID = UUID(), name: String, contentType: String, kind: Kind, data: Data) {
        self.id = id; self.name = name; self.contentType = contentType; self.kind = kind; self.data = data
    }

    var bytes: Int { data.count }

    /// `MessageAttachmentInput` : ce que `POST /api/threads/:id/messages` lit dans `attachments`.
    var wire: WireAttachment {
        switch kind {
        case .image:
            WireAttachment(name: name, contentType: contentType, kind: kind.rawValue,
                           content: [.init(type: "image", image: "data:\(contentType);base64,\(data.base64EncodedString())")])
        case .document:
            WireAttachment(name: name, contentType: contentType, kind: kind.rawValue,
                           content: [.init(type: "text", text: "<attachment name=\(name)>\n\(String(decoding: data, as: UTF8.self))\n</attachment>")])
        }
    }
}

struct WireAttachment: Encodable, Equatable, Sendable {
    struct Part: Encodable, Equatable, Sendable {
        var type: String
        var text: String?
        var image: String?
    }
    var name: String
    var contentType: String
    var kind: String
    var content: [Part]
}

/// Les bornes du serveur (`ATTACHMENT_LIMITS`, `IMAGE_DOWNSCALE`), appliquées avant l'envoi pour
/// refuser tôt avec un mot clair plutôt qu'un 413 après coup.
enum AttachmentRules {
    static let maxCount = 5
    static let maxBytesEach = 1024 * 1024
    static let maxBytesTotal = 3 * 1024 * 1024
    static let imageMaxEdge: CGFloat = 1568
    static let imageQuality: CGFloat = 0.82
    /// Les extensions sans type MIME fiable que l'`accept` du web admet.
    static let textExtensions: Set<String> = ["md", "txt", "csv", "json", "log", "ts", "tsx", "js", "jsx", "py", "rs", "go",
                                              "sql", "yaml", "yml", "toml", "html", "htm", "xml", "css"]

    enum Failure: Error, Equatable {
        case unreadable(name: String)
        case unsupported(name: String)
        /// Un PDF sans couche texte (scan) : rien que le bot puisse lire.
        case pdfWithoutText(name: String)
        case empty(name: String)
        case tooLarge(name: String, bytes: Int)
        case tooMany
        case totalTooLarge(bytes: Int)

        var message: String {
            switch self {
            case .unreadable(let n): tr("Couldn’t read “\(n)”.", "Impossible de lire « \(n) ».")
            case .unsupported(let n): tr("“\(n)” is not an image, a PDF or a text file.", "« \(n) » n'est ni une image, ni un PDF, ni un texte.")
            case .pdfWithoutText(let n): tr("“\(n)” has no readable text (scanned PDF?).", "« \(n) » ne contient pas de texte lisible (PDF scanné ?).")
            case .empty(let n): tr("“\(n)” is empty.", "« \(n) » est vide.")
            case .tooLarge(let n, let b): tr("“\(n)” is \(Self.mb(b)); 1 MB max per file.", "« \(n) » fait \(Self.mb(b)) ; 1 Mo maximum par pièce.")
            case .tooMany: tr("Five files at most per message.", "Cinq pièces au plus par message.")
            case .totalTooLarge(let b): tr("\(Self.mb(b)) in total; 3 MB max per message.", "\(Self.mb(b)) au total ; 3 Mo maximum par message.")
            }
        }
        private static func mb(_ bytes: Int) -> String { String(format: tr("%.1f MB", "%.1f Mo"), Double(bytes) / 1_048_576) }
    }

    /// Lit un fichier et le classe : image (réduite si trop grande) ou texte UTF-8 ; le reste est refusé.
    static func load(_ url: URL) throws(Failure) -> PendingAttachment {
        let name = url.lastPathComponent
        guard let raw = try? Data(contentsOf: url) else { throw .unreadable(name: name) }
        return try classify(name: name, data: raw, type: UTType(filenameExtension: url.pathExtension))
    }

    static func classify(name: String, data raw: Data, type: UTType?) throws(Failure) -> PendingAttachment {
        guard !raw.isEmpty else { throw .empty(name: name) }
        let ext = (name as NSString).pathExtension.lowercased()
        if let type, type.conforms(to: .image) {
            let (data, mime) = ImageShrink.fit(raw, maxEdge: imageMaxEdge, maxBytes: maxBytesEach, quality: imageQuality,
                                               originalMIME: type.preferredMIMEType ?? "image/png")
            let item = PendingAttachment(name: name, contentType: mime, kind: .image, data: data)
            guard item.bytes <= maxBytesEach else { throw .tooLarge(name: name, bytes: item.bytes) }
            return item
        }
        // Un PDF part comme la console envoie un document : son texte, emballé dans `<attachment name=…>`.
        // Le serveur n'accepte que des images et du texte, et le bot ne lit que ce texte.
        if type?.conforms(to: .pdf) == true || ext == "pdf" {
            guard let pdf = PDFDocument(data: raw) else { throw .unreadable(name: name) }
            let text = (pdf.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { throw .pdfWithoutText(name: name) }
            let data = Data(text.utf8)
            guard data.count <= maxBytesEach else { throw .tooLarge(name: name, bytes: data.count) }
            return PendingAttachment(name: name, contentType: "text/plain", kind: .document, data: data)
        }
        let textual = type?.conforms(to: .text) == true || type?.conforms(to: .json) == true || textExtensions.contains(ext)
        guard textual, String(data: raw, encoding: .utf8) != nil else { throw .unsupported(name: name) }
        guard raw.count <= maxBytesEach else { throw .tooLarge(name: name, bytes: raw.count) }
        let mime = type?.preferredMIMEType ?? "text/plain"
        return PendingAttachment(name: name, contentType: mime.hasPrefix("text/") || mime == "application/json" ? mime : "text/plain",
                                 kind: .document, data: raw)
    }

    /// Ce qu'ajouter `item` à `existing` enfreindrait, avant de l'accepter.
    static func check(adding item: PendingAttachment, to existing: [PendingAttachment]) throws(Failure) {
        guard existing.count < maxCount else { throw .tooMany }
        let total = existing.reduce(0) { $0 + $1.bytes } + item.bytes
        guard total <= maxBytesTotal else { throw .totalTooLarge(bytes: total) }
    }
}

/// Réduit une image comme le web le fait : plus grand côté à 1568 px, JPEG à 0,82 si elle dépasse
/// la borne de taille ou de poids ; sinon elle part telle quelle.
enum ImageShrink {
    static func fit(_ data: Data, maxEdge: CGFloat, maxBytes: Int, quality: CGFloat, originalMIME: String) -> (Data, String) {
        guard let rep = NSBitmapImageRep(data: data) else { return (data, originalMIME) }
        let w = CGFloat(rep.pixelsWide), h = CGFloat(rep.pixelsHigh)
        let edge = max(w, h)
        if edge <= maxEdge, data.count <= maxBytes { return (data, originalMIME) }
        let scale = min(1, maxEdge / max(edge, 1))
        let target = NSSize(width: max(1, (w * scale).rounded()), height: max(1, (h * scale).rounded()))
        guard let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(target.width), pixelsHigh: Int(target.height),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return (data, originalMIME) }
        out.size = target
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
        NSGraphicsContext.current?.imageInterpolation = .high
        // Fond blanc : le JPEG n'a pas d'alpha, une capture transparente deviendrait noire.
        NSColor.white.setFill(); NSRect(origin: .zero, size: target).fill()
        rep.draw(in: NSRect(origin: .zero, size: target))
        NSGraphicsContext.restoreGraphicsState()
        guard let jpeg = out.representation(using: .jpeg, properties: [.compressionFactor: quality]) else { return (data, originalMIME) }
        return (jpeg, "image/jpeg")
    }
}
