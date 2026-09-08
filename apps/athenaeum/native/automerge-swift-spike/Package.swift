// swift-tools-version:5.9
// Throwaway SPM package for the Athenaeum native Phase 2 "Decisions" stage (see
// apps/athenaeum/native/docs/decisions.md). Not part of the shipped AthenaeumCore/AthenaeumDomain
// tree — exists solely to empirically prove (a) automerge-swift builds and runs a real Text-CRDT
// splice/read round trip on this machine, and (b) whether its shipped binary artifact supports a
// watchOS target. Pinned to an EXACT version (0.7.2), not `from:`, mirroring new-notes' documented
// vendoring discipline for a pre-1.0 ("beta") dependency — SwiftPM additionally verifies the
// binaryTarget's SHA-256 checksum against `automerge-swift`'s own Package.swift on every resolve,
// so exact-version + checksum verification is the practical equivalent of new-notes' commit-pinned
// vendoring for a binary-artifact release (there is no "source commit" to point at beyond the tag
// itself — the prebuilt automergeFFI.xcframework.zip *is* the artifact).
import PackageDescription

let package = Package(
    name: "AutomergeSpike",
    platforms: [.macOS(.v13), .iOS(.v16), .watchOS(.v9)],
    products: [
        .library(name: "AutomergeSpike", targets: ["AutomergeSpike"])
    ],
    dependencies: [
        .package(url: "https://github.com/automerge/automerge-swift.git", exact: "0.7.2")
    ],
    targets: [
        .target(
            name: "AutomergeSpike",
            dependencies: [.product(name: "Automerge", package: "automerge-swift")]
        ),
        .testTarget(
            name: "AutomergeSpikeTests",
            dependencies: ["AutomergeSpike"]
        )
    ]
)
