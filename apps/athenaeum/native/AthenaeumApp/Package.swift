// swift-tools-version:5.9
// AthenaeumApp — plan §"Repo/package layout"'s "macOS/ iOS/ watchOS/" app layer, split as: this
// package holds the actual SwiftUI screens/view-model as a cross-platform *library*
// (`AthenaeumAppUI`), and `native/macOS`/`native/iOS` each hold a thin, generated Xcode project
// whose only job is a platform-specific `@main App` entry point + app-bundle plumbing
// (Info.plist, bundle id, asset catalog) that wires that library's `ContentView` into a window.
//
// Why one shared UI library + two thin app shells, rather than two independent app targets that
// each redefine the same views (the "single shared SwiftUI app target with per-platform entry
// points" option the task offered): the daily-note/backlinks/graph-view screens themselves have
// zero platform-specific logic (SwiftUI's `TextEditor`/`List`/`Form` are already cross-platform on
// macOS 13+/iOS 16+) — only the app-lifecycle entry point (`App`/`WindowGroup` vs. `App`/
// `WindowGroup` inside an actual `.app` bundle with a `UIApplicationSceneManifest`) and the Xcode
// project machinery around it differ per platform. Keeping that one real difference in two tiny
// per-platform directories, and everything else in one Swift Package Manager target, is the
// literal "additive, not duplicated" version of the plan's own "compose services, don't recreate
// god objects" preference, applied one layer up at the app-shell boundary.
import PackageDescription

let package = Package(
    name: "AthenaeumApp",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "AthenaeumAppUI", targets: ["AthenaeumAppUI"])
    ],
    dependencies: [
        .package(name: "AthenaeumDomain", path: "../AthenaeumDomain"),
        .package(name: "AthenaeumRPC", path: "../AthenaeumRPC"),
        .package(name: "AthenaeumCore", path: "../AthenaeumCore")
    ],
    targets: [
        .target(
            name: "AthenaeumAppUI",
            dependencies: [
                .product(name: "AthenaeumDomain", package: "AthenaeumDomain"),
                .product(name: "AthenaeumRPC", package: "AthenaeumRPC"),
                .product(name: "AthenaeumCore", package: "AthenaeumCore")
            ]
        ),
        .testTarget(
            name: "AthenaeumAppUITests",
            dependencies: ["AthenaeumAppUI"]
        )
    ]
)
