import AppKit
import Foundation
import Testing
import UniformTypeIdentifiers
@testable import OHBPopup

// Les pièces jointes : classement, bornes du serveur, réduction d'image, et leur passage dans les flux.

@Suite(.french)
struct AttachmentTests {
    private func png(width: Int, height: Int) -> Data {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        for y in 0..<height { for x in 0..<width where (x / 7 + y / 5) % 3 == 0 {
            rep.setColor(NSColor(red: Double(x % 255) / 255, green: Double(y % 255) / 255, blue: 0.4, alpha: 1), atX: x, y: y)
        } }
        return rep.representation(using: .png, properties: [:])!
    }

    @Test func markdownIsADocumentWrappedForThePrompt() throws {
        let item = try AttachmentRules.classify(name: "notes.md", data: Data("# Titre\ncorps".utf8), type: UTType(filenameExtension: "md"))
        #expect(item.kind == .document)
        #expect(item.contentType.hasPrefix("text/"))
        let wire = item.wire
        #expect(wire.kind == "document")
        #expect(wire.content.count == 1 && wire.content[0].type == "text")
        #expect(wire.content[0].text == "<attachment name=notes.md>\n# Titre\ncorps\n</attachment>")
        #expect(wire.content[0].image == nil)
    }

    @Test func sourceFilesWithOddUTTypesStayText() throws {
        // « .ts » est un flux MPEG pour macOS ; l'extension prime et le MIME retombe sur text/plain.
        let item = try AttachmentRules.classify(name: "main.ts", data: Data("const a = 1".utf8), type: UTType(filenameExtension: "ts"))
        #expect(item.kind == .document)
        #expect(item.contentType == "text/plain")
        let json = try AttachmentRules.classify(name: "x.json", data: Data("{}".utf8), type: UTType(filenameExtension: "json"))
        #expect(json.contentType == "application/json")
    }

    @Test func refusalsAreNamedAndEarly() {
        func fails(_ name: String, _ data: Data, _ type: UTType?) -> AttachmentRules.Failure? {
            do { _ = try AttachmentRules.classify(name: name, data: data, type: type); return nil } catch { return error }
        }
        #expect(fails("vide.txt", Data(), .plainText) == .empty(name: "vide.txt"))
        #expect(fails("blob.bin", Data([0xFF, 0xFE, 0x00, 0x80]), UTType(filenameExtension: "bin")) == .unsupported(name: "blob.bin"))
        #expect(fails("app.zip", Data("abc".utf8), .zip) == .unsupported(name: "app.zip"))
        let big = Data(repeating: UInt8(ascii: "a"), count: AttachmentRules.maxBytesEach + 1)
        #expect(fails("gros.txt", big, .plainText) == .tooLarge(name: "gros.txt", bytes: big.count))
        #expect(AttachmentRules.Failure.tooLarge(name: "g", bytes: 2_097_152).message.contains("2,0 Mo") ||
                AttachmentRules.Failure.tooLarge(name: "g", bytes: 2_097_152).message.contains("2.0 Mo"))
    }

    @Test func countAndTotalAreBounded() {
        let small = PendingAttachment(name: "a.txt", contentType: "text/plain", kind: .document, data: Data("a".utf8))
        let five = Array(repeating: small, count: 5)
        #expect((try? AttachmentRules.check(adding: small, to: five)) == nil)
        do { try AttachmentRules.check(adding: small, to: five); Issue.record("attendu tooMany") } catch { #expect(error == .tooMany) }
        let mb = PendingAttachment(name: "m.txt", contentType: "text/plain", kind: .document, data: Data(repeating: 1, count: AttachmentRules.maxBytesEach))
        do { try AttachmentRules.check(adding: mb, to: [mb, mb, mb]); Issue.record("attendu totalTooLarge") }
        catch { #expect(error == .totalTooLarge(bytes: 4 * AttachmentRules.maxBytesEach)) }
        #expect((try? AttachmentRules.check(adding: mb, to: [mb, mb])) != nil)
    }

    @Test func smallImagesTravelUntouchedAsDataURI() throws {
        let data = png(width: 120, height: 80)
        let item = try AttachmentRules.classify(name: "icone.png", data: data, type: .png)
        #expect(item.kind == .image)
        #expect(item.contentType == "image/png")
        #expect(item.data == data)
        #expect(item.wire.content[0].image?.hasPrefix("data:image/png;base64,") == true)
        #expect(item.wire.content[0].text == nil)
    }

    @Test func largeImagesAreShrunkToTheServerEdge() throws {
        let data = png(width: 3000, height: 1800)
        let item = try AttachmentRules.classify(name: "capture.png", data: data, type: .png)
        #expect(item.kind == .image)
        #expect(item.contentType == "image/jpeg")
        #expect(item.bytes <= AttachmentRules.maxBytesEach)
        let rep = try #require(NSBitmapImageRep(data: item.data))
        #expect(max(rep.pixelsWide, rep.pixelsHigh) <= Int(AttachmentRules.imageMaxEdge))
        #expect(rep.pixelsWide == 1568 && rep.pixelsHigh == 941)
    }

    @Test func loadReadsDiskAndNamesWhatItCannot() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "ohb-att-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appending(path: "liste.csv")
        try Data("a,b\n1,2".utf8).write(to: file)
        let item = try AttachmentRules.load(file)
        #expect(item.name == "liste.csv" && item.kind == .document)
        do { _ = try AttachmentRules.load(dir.appending(path: "absent.txt")); Issue.record("attendu unreadable") }
        catch { #expect(error == .unreadable(name: "absent.txt")) }
    }

    @Test func wireEncodesLikeTheWebClient() throws {
        let item = PendingAttachment(name: "n.md", contentType: "text/markdown", kind: .document, data: Data("x".utf8))
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(item.wire)) as? [String: Any]
        #expect(json?["name"] as? String == "n.md")
        #expect(json?["contentType"] as? String == "text/markdown")
        #expect(json?["kind"] as? String == "document")
        let part = (json?["content"] as? [[String: Any]])?.first
        #expect(part?["type"] as? String == "text")
        #expect(part?["image"] == nil) // nil omis, pas `null`
    }
}

@MainActor
@Suite(.french)
struct AttachmentFeedTests {
    @Test func mockSendKeepsAttachmentNamesAndAcceptsFilesAlone() {
        let model = NotchModel()
        let feed = MockBotFeed(model: model, timeScale: 0)
        model.sections = MockBotFeed.sections
        model.bots = MockBotFeed.roster(now: Date())
        let before = model.bot("notes")!.thread.count
        let item = PendingAttachment(name: "rapport.md", contentType: "text/markdown", kind: .document, data: Data("x".utf8))
        feed.send("  ", attachments: [], to: "notes")
        #expect(model.bot("notes")!.thread.count == before)
        feed.send("  ", attachments: [item], to: "notes")
        let last = model.bot("notes")!.thread.last
        #expect(last?.role == .user && last?.text == "" && last?.attachments == ["rapport.md"])
        feed.send("Lis ça", attachments: [item, item], to: "notes")
        #expect(model.bot("notes")!.thread.last?.attachments == ["rapport.md", "rapport.md"])
        feed.stop()
    }
}

@Suite(.french)
struct PDFAttachmentTests {
    private func pdf(text: String?) -> Data {
        let data = NSMutableData()
        var box = CGRect(x: 0, y: 0, width: 300, height: 200)
        let consumer = CGDataConsumer(data: data as CFMutableData)!
        let ctx = CGContext(consumer: consumer, mediaBox: &box, nil)!
        ctx.beginPDFPage(nil)
        if let text {
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 14)]))
            ctx.textPosition = CGPoint(x: 20, y: 100)
            CTLineDraw(line, ctx)
        } else {
            ctx.setFillColor(NSColor.red.cgColor)
            ctx.fill(CGRect(x: 20, y: 20, width: 100, height: 100)) // un « scan » : du dessin, aucun texte
        }
        ctx.endPDFPage()
        ctx.closePDF()
        return data as Data
    }

    @Test func aPDFTravelsAsItsTextLikeADocument() throws {
        let item = try AttachmentRules.classify(name: "facture.pdf", data: pdf(text: "Total 7319 euros"), type: .pdf)
        #expect(item.kind == .document && item.contentType == "text/plain" && item.name == "facture.pdf")
        #expect(String(decoding: item.data, as: UTF8.self).contains("7319"))
        #expect(item.wire.content.first?.text?.hasPrefix("<attachment name=facture.pdf>\n") == true)
    }

    @Test func aScannedOrBrokenPDFIsRefusedByName() {
        do { _ = try AttachmentRules.classify(name: "scan.pdf", data: pdf(text: nil), type: .pdf); Issue.record("attendu pdfWithoutText") }
        catch { #expect(error == .pdfWithoutText(name: "scan.pdf")) }
        do { _ = try AttachmentRules.classify(name: "cassé.pdf", data: Data("pas un pdf".utf8), type: .pdf); Issue.record("attendu unreadable") }
        catch { #expect(error == .unreadable(name: "cassé.pdf")) }
    }
}
