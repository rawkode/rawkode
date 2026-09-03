// swift-tools-version:5.9
// AthenaeumRPC — the Phase 2 "Decisions" stage's answer to "how does a native Swift client talk
// to the backend's Cap'n Web RPC surface?" (see apps/athenaeum/native/docs/decisions.md).
//
// Zero external dependencies deliberately: this is a hand-rolled minimal client for capnweb's
// HTTP-batch wire protocol (push/pull/resolve/reject over newline-delimited JSON), reverse-
// engineered and empirically verified against the real `@athenaeum/backend` Worker (capnweb
// 0.11.1) rather than against any spec — see decisions.md for the verification transcript. Pure
// Foundation + URLSession, so unlike AthenaeumCore's future Automerge integration, this package
// builds and runs on watchOS too (proven below in Package.swift's platform list and exercised by
// a plain structured-record RPC call, no Automerge dependency in this package at all).
import PackageDescription

let package = Package(
    name: "AthenaeumRPC",
    platforms: [.macOS(.v13), .iOS(.v16), .watchOS(.v9)],
    products: [
        .library(name: "AthenaeumRPC", targets: ["AthenaeumRPC"])
    ],
    dependencies: [
        .package(name: "AthenaeumDomain", path: "../AthenaeumDomain")
    ],
    targets: [
        .target(
            name: "AthenaeumRPC",
            dependencies: [.product(name: "AthenaeumDomain", package: "AthenaeumDomain")]
        ),
        .testTarget(name: "AthenaeumRPCTests", dependencies: ["AthenaeumRPC"])
    ]
)
