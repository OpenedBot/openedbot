import Testing
import Foundation
@testable import OHBPopup

// Le découpage markdown des messages de bot : blocs, listes, clôtures, et les cas tordus.

@Suite(.french)
struct MarkdownTests {
    @Test func paragraphsKeepSoftBreaksAndSplitOnBlankLines() {
        let blocks = Markdown.blocks("Salut kev !\nQuoi de neuf ?\n\nLimites : contrôle HTTP.")
        #expect(blocks == [.paragraph("Salut kev !\nQuoi de neuf ?"), .paragraph("Limites : contrôle HTTP.")])
    }

    @Test func orderedListKeepsItsStartAndContinuationLines() {
        let text = "Plan :\n3. Contrôler les URLs\n  sans déduire un problème.\n4. Décider quoi faire\n\nFin."
        let blocks = Markdown.blocks(text)
        #expect(blocks == [
            .paragraph("Plan :"),
            .ordered(start: 3, items: ["Contrôler les URLs sans déduire un problème.", "Décider quoi faire"]),
            .paragraph("Fin."),
        ])
    }

    @Test func bulletsAndNumbersDoNotMerge() {
        let blocks = Markdown.blocks("- a\n- b\n1. c\n2) d\n* e")
        #expect(blocks == [.bullets(["a", "b"]), .ordered(start: 1, items: ["c", "d"]), .bullets(["e"])])
    }

    @Test func fencedCodeSurvivesWithoutClosingFence() {
        #expect(Markdown.blocks("```sh\nls -la\n\necho ok\n```\nok") == [.code(language: "sh", text: "ls -la\n\necho ok"), .paragraph("ok")])
        #expect(Markdown.blocks("```\n1. pas une liste") == [.code(language: nil, text: "1. pas une liste")])
    }

    @Test func headingsQuotesAndRules() {
        let blocks = Markdown.blocks("## Résumé\n> une citation\n> sur deux lignes\n---\n#pas un titre\n####### pas non plus")
        #expect(blocks == [
            .heading(level: 2, text: "Résumé"),
            .quote("une citation\nsur deux lignes"),
            .rule,
            .paragraph("#pas un titre\n####### pas non plus"),
        ])
    }

    @Test func emptyAndWhitespaceOnlyGiveNothing() {
        #expect(Markdown.blocks("") == [])
        #expect(Markdown.blocks("\n\n  \n") == [])
        #expect(Markdown.blocks("- \n1. ") == [.paragraph("-\n1.")])
    }

    @Test func inlineFallsBackToPlainTextAndStylesCode() {
        let bold = Markdown.inline("un **mot** et `code`", size: 13, color: .white)
        #expect(String(bold.characters) == "un mot et code")
        let codeRun = bold.runs.first { $0.inlinePresentationIntent?.contains(.code) == true }
        #expect(codeRun != nil)
        #expect(codeRun.map { bold[$0.range].backgroundColor != nil } == true)
        // Un markdown cassé ne fait pas disparaître le texte.
        let broken = Markdown.inline("[lien sans fin](http://", size: 13, color: .white)
        #expect(!String(broken.characters).isEmpty)
    }
}
