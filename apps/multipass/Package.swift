// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Multipass",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Multipass", targets: ["Multipass"])],
    targets: [.executableTarget(name: "Multipass")]
)
