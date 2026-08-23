// swift-tools-version:5.9
// AthenaeumWatchUI — plan §"Repo/package layout"'s `native/…/watchOS/` slot, split the same way
// `native/AthenaeumApp` splits macOS/iOS: this package holds the actual SwiftUI quick-capture
// screen + its view-model/RPC-facing actor as a cross-platform *library*, `native/watchOS/App`
// holds a thin, xcodegen-generated Xcode project whose only job is the platform `@main App` entry
// point + watch-app-bundle plumbing wiring this library's `QuickCaptureRootView` into a window.
//
// Deliberately its OWN package, not a new watchOS target bolted onto `AthenaeumApp` or
// `AthenaeumCore`: the Decisions stage's Decision 2 (`native/docs/decisions.md`) proved
// `automerge-swift` 0.7.2 ships no watchOS slice (`AthenaeumCore`'s own top-of-file doc comment
// records the same finding) — so anything watchOS-facing must depend on `AthenaeumRPC` +
// `AthenaeumDomain` only, never `AthenaeumCore`/`Automerge`, or it silently stops building for
// watchOS the moment someone adds an innocuous `import AthenaeumCore` convenience method. A
// separate package makes that boundary a real dependency-graph fact the compiler enforces, not
// just a doc comment someone has to remember.
//
// Platforms: watchOS (the actual target) plus macOS/iOS so `swift test` can run this package's
// logic tests on the host Mac without a watchOS simulator/device attached — SwiftUI compiles and
// runs fine on macOS 14+ even though this package's real consumer is `native/watchOS/App`.
import PackageDescription

let package = Package(
    name: "AthenaeumWatchUI",
    platforms: [.macOS(.v14), .iOS(.v16), .watchOS(.v9)],
    products: [
        .library(name: "AthenaeumWatchUI", targets: ["AthenaeumWatchUI"])
    ],
    dependencies: [
        .package(name: "AthenaeumDomain", path: "../../AthenaeumDomain"),
        .package(name: "AthenaeumRPC", path: "../../AthenaeumRPC")
    ],
    targets: [
        .target(
            name: "AthenaeumWatchUI",
            dependencies: [
                .product(name: "AthenaeumDomain", package: "AthenaeumDomain"),
                .product(name: "AthenaeumRPC", package: "AthenaeumRPC")
            ]
        ),
        .testTarget(
            name: "AthenaeumWatchUITests",
            dependencies: ["AthenaeumWatchUI"]
        )
    ]
)
