import AppKit
import Testing
@testable import OHBPopup

/// The settings window frame: never below the minimum, never larger than the visible screen.
@MainActor
struct SettingsWindowTests {
    @Test func defaultIsRoomierThanTheMinimum() {
        #expect(AppDelegate.settingsDefaultSize.width > AppDelegate.settingsMinSize.width)
        #expect(AppDelegate.settingsDefaultSize.height > AppDelegate.settingsMinSize.height)
    }

    @Test func savedFrameBelowTheMinimumGrows() {
        let f = AppDelegate.clamped(NSRect(x: 544, y: 512, width: 560, height: 428), min: AppDelegate.settingsMinSize,
                                    in: NSRect(x: 0, y: 0, width: 1728, height: 1084))
        #expect(f.size == AppDelegate.settingsMinSize)
    }

    @Test func frameStaysOnASmallScreen() {
        let screen = NSRect(x: 0, y: 0, width: 800, height: 600)
        let f = AppDelegate.clamped(NSRect(x: 500, y: 400, width: 880, height: 640), min: AppDelegate.settingsMinSize, in: screen)
        #expect(screen.contains(f))
    }

    @Test func userSizeAboveTheMinimumIsKept() {
        let saved = NSRect(x: 100, y: 100, width: 900, height: 700)
        #expect(AppDelegate.clamped(saved, min: AppDelegate.settingsMinSize, in: NSRect(x: 0, y: 0, width: 1728, height: 1084)) == saved)
    }
}
