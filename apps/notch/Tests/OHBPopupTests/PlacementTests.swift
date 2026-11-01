import Foundation
import Testing
@testable import OHBPopup

/// Les trois positions : bord droit, à côté du Dock, île sur la caméra.
struct PlacementTests {
    let screen = CGRect(x: 0, y: 0, width: 1728, height: 1117)
    /// Dock en bas de 40 pt, barre des menus de 33 pt.
    let visible = CGRect(x: 0, y: 40, width: 1728, height: 1044)
    /// L'encoche d'un MacBook Pro 16 pouces : 185 × 32 pt, centrée à 863,5.
    let camera = CGRect(x: 771, y: 1085, width: 185, height: 32)

    private func geometry(_ edge: NotchEdge, camera: CGRect?, cells: Int = 2, offset: CGFloat = 0) -> NotchGeometry {
        let p = NotchGeometry.placement(edge: edge, screenFrame: screen, visibleFrame: visible, camera: camera)
        return NotchGeometry(edge: edge, metrics: NotchMetrics(), cellCount: cells, screen: p.screen, alongOffset: offset,
                             inset: p.inset, restLength: p.restLength, minBodyLength: p.minBodyLength, anchor: p.anchor)
    }

    @Test func onlyRightDockAndIslandAreOffered() {
        #expect(NotchEdge.allCases == [.right, .bottom, .top])
        #expect(NotchEdge.bottom.title == "Dock" && NotchEdge.top.title == "Island")
        // Un ancien réglage « left » ne se lit plus : le modèle garde le bord droit par défaut.
        #expect(NotchEdge(rawValue: "left") == nil)
    }

    @Test func rightKeepsTheWholeScreen() {
        let g = geometry(.right, camera: camera)
        #expect(g.inset == 0 && !g.isIsland && g.panelFrame.maxX == screen.maxX)
    }

    // MARK: Dock

    @Test func dockModeSitsBesideTheDockNotOnIt() {
        let g = geometry(.bottom, camera: camera)
        let f = g.panelFrame
        // Soudée au bas de l'écran, au bout droit : le centre de l'écran, où vit le Dock, reste libre.
        #expect(f.minY == screen.minY && f.maxX == screen.maxX)
        let shapeLeft = f.minX + g.shapeStart
        #expect(shapeLeft > screen.midX + 200)
    }

    @Test func dockModeDragsLeftButNeverOffScreen() {
        let far = geometry(.bottom, camera: camera, offset: -5000).panelFrame
        #expect(far.minX == screen.minX)
        let wrongWay = geometry(.bottom, camera: camera, offset: 300).panelFrame
        #expect(wrongWay.maxX == screen.maxX)
    }

    // MARK: Île

    @Test func islandRestsExactlyOnTheCamera() {
        let g = geometry(.top, camera: camera)
        #expect(g.isIsland && !g.isDraggable)
        let rest = g.rect(along: g.pillRange, across: 0...g.inset)
        let onScreen = CGRect(x: g.panelFrame.minX + rest.minX, y: g.panelFrame.maxY - rest.maxY, width: rest.width, height: rest.height)
        #expect(abs(onScreen.minX - camera.minX) < 0.001 && abs(onScreen.width - camera.width) < 0.001)
        #expect(abs(onScreen.maxY - screen.maxY) < 0.001 && abs(onScreen.height - camera.height) < 0.001)
    }

    @Test func islandPanelIsCenteredOnTheCameraAndWiderThanIt() {
        let g = geometry(.top, camera: camera)
        let range = g.islandRange
        let left = g.panelFrame.minX + range.lowerBound, right = g.panelFrame.minX + range.upperBound
        #expect(abs((left + right) / 2 - camera.midX) < 0.001)
        #expect(right - left > camera.width + 200)
        #expect(g.panelFrame.maxY == screen.maxY)
    }

    @Test func islandOpensOverTheCameraOnly() {
        let g = geometry(.top, camera: camera)
        let mid = g.restMid
        #expect(g.hit(along: mid, across: 10, expanded: false, card: nil) == .pill)
        // Juste sous la caméra, ou dans la barre des menus à côté : rien ne s'ouvre.
        #expect(g.hit(along: mid, across: 40, expanded: false, card: nil) == .none)
        #expect(g.hit(along: g.pillRange.upperBound + 20, across: 10, expanded: false, card: nil) == .none)
    }

    @Test func islandWingsOpenItToo() {
        let g = geometry(.top, camera: camera)
        let beside = g.pillRange.upperBound + 20
        #expect(g.hit(along: beside, across: 10, expanded: false, card: nil, wingsSide: 42) == .pill)
        #expect(g.hit(along: beside + 40, across: 10, expanded: false, card: nil, wingsSide: 42) == .none)
    }

    @Test func openIslandKeepsThePointerInsideItsMeasuredPanel() {
        let g = geometry(.top, camera: camera)
        let mid = g.restMid
        #expect(g.hit(along: mid + 200, across: 150, expanded: true, card: nil, islandHeight: 220) == .body)
        #expect(g.hit(along: mid, across: 260, expanded: true, card: nil, islandHeight: 220) == .none)
        #expect(g.hit(along: g.islandRange.upperBound + 10, across: 20, expanded: true, card: nil, islandHeight: 220) == .none)
    }

    @Test func openingAChatClosesTheIslandButKeepsTheEdgeNotchOpen() {
        #expect(!NotchWindowController.pinsWhileDialogOpen(island: true))
        #expect(NotchWindowController.pinsWhileDialogOpen(island: false))
    }

    @Test func islandIgnoresTheDragOffset() {
        let g = geometry(.top, camera: camera, offset: 250)
        #expect(abs(g.panelFrame.minX + g.restMid - camera.midX) < 0.001)
    }

    @Test func islandWithoutCameraUsesAVirtualNotch() {
        let g = geometry(.top, camera: nil)
        #expect(g.restLength == 180 && g.inset == screen.maxY - visible.maxY)
        #expect(abs(g.panelFrame.minX + g.restMid - screen.midX) < 0.001)
    }
}
