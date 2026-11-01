import Testing
import Foundation
@testable import OHBPopup

struct GeometryTests {
    let screen = CGRect(x: 0, y: 0, width: 1728, height: 1117)

    private func geometry(_ edge: NotchEdge, cells: Int = 3, offset: CGFloat = 0) -> NotchGeometry {
        NotchGeometry(edge: edge, metrics: NotchMetrics(), cellCount: cells, screen: screen, alongOffset: offset)
    }

    @Test func ringIs32PointsAndCardKeepsItsSize() {
        let m = NotchMetrics()
        #expect(abs(m.ring - 32) < 0.01)
        #expect(abs(m.cardWidth - Design.px(600)) < 0.01)
        let small = NotchMetrics(scale: 0.85)
        #expect(small.ring < m.ring && small.cardWidth == m.cardWidth)
    }

    @Test func panelHugsEachEdge() {
        #expect(geometry(.right).panelFrame.maxX == screen.maxX)
        #expect(geometry(.top).panelFrame.maxY == screen.maxY)
        #expect(geometry(.bottom).panelFrame.minY == screen.minY)
    }

    @Test func stackMappingRoundTrips() {
        for edge in NotchEdge.allCases {
            let g = geometry(edge)
            let p = g.point(along: 123.5, across: 42)
            let s = g.stack(from: p)
            #expect(abs(s.along - 123.5) < 0.001 && abs(s.across - 42) < 0.001)
        }
    }

    @Test func tenCellsStillFitTheScreenOnAVerticalEdge() {
        let g = geometry(.right, cells: 10)
        #expect(g.shapeLength < screen.height)
    }

    @Test func hitTestDistinguishesPillCellOrb() {
        let g = geometry(.right)
        let mid = g.shapeStart + g.shapeLength / 2
        #expect(g.hit(along: mid, across: 4, expanded: false, card: nil) == .pill)
        let ring = g.ringCenter(index: 1)
        #expect(g.hit(along: ring.along, across: ring.across, expanded: true, card: nil) == .cell(1))
        let orb = g.orbCenter
        #expect(g.hit(along: orb.along, across: orb.across, expanded: true, card: nil) == .orb)
    }
}
