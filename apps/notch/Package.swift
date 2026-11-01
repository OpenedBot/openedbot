// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "openedbot-notch",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "OHBPopup",
            path: "Sources/OHBPopup",
            resources: [.copy("../../Resources/bots"), .copy("../../Resources/faces"), .copy("../../Resources/brand-marks.json")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "OHBPopupTests",
            dependencies: ["OHBPopup"],
            path: "Tests/OHBPopupTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
