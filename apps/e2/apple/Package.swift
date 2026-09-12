// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ApsidesCore",
    platforms: [.macOS("26.0"), .iOS("26.0"), .watchOS("26.0")],
    products: [.library(name: "ApsidesCore", targets: ["ApsidesCore"])],
    targets: [
        .target(name: "ApsidesCore", path: "Sources/Core"),
        .testTarget(name: "ApsidesCoreTests", dependencies: ["ApsidesCore"], path: "Tests/Core")
    ]
)
