import Foundation
import Observation
import Testing
@testable import OHBPopup

/// The language switch: English by default, French on request, saved, observed, task-scoped in tests.
struct LanguageTests {
    @Test func englishIsTheDefault() {
        // No override and nothing loaded: the app speaks English.
        Language.$override.withValue(nil) {
            #expect(Language.current == .en)
            #expect(tr("Account", "Compte") == "Account")
            #expect(SettingsView.Page.account.title == "Account")
        }
    }

    @Test func overrideScopesFrenchToTheTask() {
        Language.$override.withValue(.fr) {
            #expect(tr("Account", "Compte") == "Compte")
            #expect(SettingsView.Page.general.title == "Général")
        }
        #expect(Language.$override.withValue(nil) { tr("Account", "Compte") } == "Account")
    }

    @Test func loadReadsTheSavedChoiceAndSavesChanges() {
        let defaults = TestSupport.defaults("language")
        let language = Language()
        language.load(from: defaults)
        #expect(language.value == .en)

        language.value = .fr
        #expect(defaults.string(forKey: Language.defaultsKey) == "fr")

        let reloaded = Language()
        reloaded.load(from: defaults)
        #expect(reloaded.value == .fr)
    }

    @Test func unknownSavedValueFallsBackToEnglish() {
        let defaults = TestSupport.defaults("language-unknown")
        defaults.set("de", forKey: Language.defaultsKey)
        let language = Language()
        language.load(from: defaults)
        #expect(language.value == .en)
    }

    @Test func nothingIsSavedBeforeLoad() {
        // Tests and previews never load: switching must not write the user's preferences.
        let language = Language()
        language.value = .fr
        #expect(language.value == .fr)
    }

    @Test func changesAreObserved() {
        let language = Language()
        nonisolated(unsafe) var fired = false
        withObservationTracking { _ = language.value } onChange: { fired = true }
        language.value = .fr
        #expect(fired)
    }

    @Test func sameValueDoesNotNotify() {
        let language = Language()
        nonisolated(unsafe) var fired = false
        withObservationTracking { _ = language.value } onChange: { fired = true }
        language.value = .en
        #expect(!fired)
    }

    @Test func datesAndDurationsFollowTheLanguage() {
        let now = Date()
        Language.$override.withValue(.en) {
            #expect(ThreadCopy.day(now, now: now) == "Today")
            #expect(ToolCopy.duration(2400) == "2.4 s")
            #expect(ThreadCopy.byteCount(96).hasSuffix("bytes"))
        }
        Language.$override.withValue(.fr) {
            #expect(ThreadCopy.day(now, now: now) == "Aujourd’hui")
            #expect(ToolCopy.duration(2400) == "2,4 s")
            #expect(ThreadCopy.byteCount(96).hasSuffix("octets")) // espace insécable fine avant l’unité
        }
    }

    @Test func eachLanguageNamesItself() {
        #expect(AppLanguage.en.nativeName == "English")
        #expect(AppLanguage.fr.nativeName == "Français")
        #expect(AppLanguage.fr.locale.identifier == "fr_FR")
    }
}

/// Le bouton « aller en bas » n'apparaît qu'une fois le bas du fil vraiment quitté.
struct ScrollToBottomTests {
    @Test func atTheBottomOrJustAboveCountsAsBottom() {
        #expect(AgentDialogView.isNearBottom(visibleMaxY: 1000, contentHeight: 1000))
        #expect(AgentDialogView.isNearBottom(visibleMaxY: 960, contentHeight: 1000))
    }

    @Test func scrolledUpShowsTheButton() {
        #expect(!AgentDialogView.isNearBottom(visibleMaxY: 900, contentHeight: 1000))
    }

    @Test func shortThreadIsAlwaysAtTheBottom() {
        // Un fil plus court que la fenêtre : le bas visible dépasse le contenu.
        #expect(AgentDialogView.isNearBottom(visibleMaxY: 520, contentHeight: 200))
    }
}
