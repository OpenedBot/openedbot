import SwiftUI

/// Le markdown d'un message de bot, découpé en blocs : SwiftUI ne rend que l'inline, le reste est à nous.
enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case bullets([String])
    case ordered(start: Int, items: [String])
    case code(language: String?, text: String)
    case quote(String)
    case rule
}

enum Markdown {
    /// Découpe ligne à ligne : clôtures ```, titres #, listes - / 1., citations >, filets ---, paragraphes.
    /// Les lignes d'un même paragraphe gardent leurs retours (un modèle écrit souvent un item par ligne).
    static func blocks(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var ordered: (start: Int, items: [String])? = nil

        func flushParagraph() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
        }
        func flushLists() {
            if !bullets.isEmpty { blocks.append(.bullets(bullets)); bullets = [] }
            if let o = ordered { blocks.append(.ordered(start: o.start, items: o.items)); ordered = nil }
        }
        func flushAll() { flushParagraph(); flushLists() }

        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                flushAll()
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { body.append(lines[i]); i += 1 }
                blocks.append(.code(language: language.isEmpty ? nil : language, text: body.joined(separator: "\n")))
                i += 1 // la clôture, si elle existe
                continue
            }
            if trimmed.isEmpty { flushAll(); i += 1; continue }
            if trimmed == "---" || trimmed == "***" || trimmed == "___" { flushAll(); blocks.append(.rule); i += 1; continue }
            if let (level, rest) = heading(trimmed) { flushAll(); blocks.append(.heading(level: level, text: rest)); i += 1; continue }
            if trimmed.hasPrefix("> ") || trimmed == ">" {
                flushAll()
                var quote: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix(">") else { break }
                    quote.append(t.dropFirst(1).trimmingCharacters(in: .whitespaces)); i += 1
                }
                blocks.append(.quote(quote.joined(separator: "\n")))
                continue
            }
            if let item = bullet(trimmed) {
                flushParagraph()
                if let o = ordered { blocks.append(.ordered(start: o.start, items: o.items)); ordered = nil }
                bullets.append(item); i += 1; continue
            }
            if let (number, item) = numbered(trimmed) {
                flushParagraph()
                if !bullets.isEmpty { blocks.append(.bullets(bullets)); bullets = [] }
                if ordered == nil { ordered = (number, []) }
                ordered?.items.append(item); i += 1; continue
            }
            // Une ligne indentée sous un item le prolonge.
            if line.hasPrefix("  ") || line.hasPrefix("\t") {
                if !bullets.isEmpty { bullets[bullets.count - 1] += " " + trimmed; i += 1; continue }
                if ordered != nil, let last = ordered?.items.indices.last { ordered?.items[last] += " " + trimmed; i += 1; continue }
            }
            flushLists()
            paragraph.append(trimmed)
            i += 1
        }
        flushAll()
        return blocks
    }

    private static func heading(_ s: String) -> (Int, String)? {
        var level = 0
        var idx = s.startIndex
        while idx < s.endIndex, s[idx] == "#", level < 6 { level += 1; idx = s.index(after: idx) }
        guard level > 0, idx < s.endIndex, s[idx] == " " else { return nil }
        let rest = s[idx...].trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? nil : (level, rest)
    }

    private static func bullet(_ s: String) -> String? {
        for marker in ["- ", "* ", "• ", "+ "] where s.hasPrefix(marker) {
            let rest = s.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
            return rest.isEmpty ? nil : rest
        }
        return nil
    }

    private static func numbered(_ s: String) -> (Int, String)? {
        var digits = ""
        var idx = s.startIndex
        while idx < s.endIndex, s[idx].isNumber, digits.count < 4 { digits.append(s[idx]); idx = s.index(after: idx) }
        guard !digits.isEmpty, idx < s.endIndex, s[idx] == "." || s[idx] == ")" else { return nil }
        idx = s.index(after: idx)
        guard idx < s.endIndex, s[idx] == " ", let n = Int(digits) else { return nil }
        let rest = s[idx...].trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? nil : (n, rest)
    }

    /// L'inline (gras, italique, `code`, liens) en AttributedString ; le texte brut si le markdown est malformé.
    static func inline(_ text: String, size: CGFloat, color: Color) -> AttributedString {
        var attributed = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
        attributed.font = .system(size: size)
        attributed.foregroundColor = color
        for run in attributed.runs {
            if let intent = run.inlinePresentationIntent {
                if intent.contains(.code) {
                    attributed[run.range].font = .system(size: size - 1, design: .monospaced)
                    attributed[run.range].backgroundColor = Color.white.opacity(0.10)
                }
                var weightBold = intent.contains(.stronglyEmphasized)
                let italic = intent.contains(.emphasized)
                if intent.contains(.code) { weightBold = false }
                if weightBold || italic {
                    var font = Font.system(size: size, weight: weightBold ? .semibold : .regular)
                    if italic { font = font.italic() }
                    attributed[run.range].font = font
                }
            }
            if run.link != nil {
                attributed[run.range].foregroundColor = Color(hex: 0x93C5FD)
                attributed[run.range].underlineStyle = .single
            }
        }
        return attributed
    }
}

/// Un message en markdown : paragraphes, listes numérotées ou à puces, titres, code, citations.
struct MarkdownText: View {
    let text: String
    var size: CGFloat = 13
    var color: Color = Surface.textPrimary

    var body: some View {
        let blocks = Markdown.blocks(text)
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in view(block) }
        }
    }

    @ViewBuilder
    private func view(_ block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let s):
            inline(s)
        case .heading(let level, let s):
            Text(Markdown.inline(s, size: size + (level == 1 ? 2 : 1), color: color))
                .fontWeight(.semibold).lineSpacing(2).textSelection(.enabled)
                .padding(.top, 2)
        case .bullets(let items):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("•").font(.system(size: size)).foregroundStyle(color.opacity(0.7)).frame(width: 10, alignment: .trailing)
                        inline(item)
                    }
                }
            }
        case .ordered(let start, let items):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { offset, item in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("\(start + offset).").font(.system(size: size)).foregroundStyle(color.opacity(0.7))
                            .frame(minWidth: 16, alignment: .trailing)
                        inline(item)
                    }
                }
            }
        case .code(_, let s):
            Text(s).font(.system(size: size - 1.5, design: .monospaced)).foregroundStyle(color.opacity(0.9))
                .textSelection(.enabled)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.black.opacity(0.35)))
        case .quote(let s):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1).fill(color.opacity(0.3)).frame(width: 2)
                Text(Markdown.inline(s, size: size, color: color.opacity(0.8))).lineSpacing(3).textSelection(.enabled)
            }
        case .rule:
            Rectangle().fill(color.opacity(0.15)).frame(height: 1).padding(.vertical, 2)
        }
    }

    private func inline(_ s: String) -> some View {
        Text(Markdown.inline(s, size: size, color: color)).lineSpacing(3).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
