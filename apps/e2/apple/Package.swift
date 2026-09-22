// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "EnchiridionCore",
    platforms: [.macOS("26.0"), .iOS("26.0"), .watchOS("26.0")],
    products: [.library(name: "EnchiridionCore", targets: ["EnchiridionCore"])],
    targets: [
        .target(name: "EnchiridionCore", path: "Sources/Core"),
        .testTarget(name: "EnchiridionCoreTests", dependencies: ["EnchiridionCore"], path: "Tests/Core")
    ]
)
