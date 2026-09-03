// swift-tools-version:5.9
// AthenaeumDomain — plan §"Repo/package layout": "native/AthenaeumDomain/ — Swift package
// mirroring domain/ types (hand-synced; CI schema-diff check)". Hand-written Codable Swift
// mirrors of every `effect/Schema` entity, RPC wire schema, and the RpcErrorEnvelope/DomainError
// pair in `packages/domain/src` — see that package for the source of truth and
// `scripts/schema-diff.ts` for the tool that catches field-name drift between the two.
//
// Zero external dependencies (Foundation only) — same discipline as AthenaeumRPC, and for the
// same reason: this package must build on watchOS too (plan's Decision 2: watchOS quick-capture
// uses AthenaeumRPC's structured-record RPC methods, whose input/output types live here).
import PackageDescription

let package = Package(
    name: "AthenaeumDomain",
    platforms: [.macOS(.v13), .iOS(.v16), .watchOS(.v9)],
    products: [
        .library(name: "AthenaeumDomain", targets: ["AthenaeumDomain"])
    ],
    targets: [
        .target(name: "AthenaeumDomain"),
        .testTarget(
            name: "AthenaeumDomainTests",
            dependencies: ["AthenaeumDomain"],
            resources: [.copy("Fixtures")]
        )
    ]
)
