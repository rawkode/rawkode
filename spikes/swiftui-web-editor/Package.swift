// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FieldnotesWeb",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "FieldnotesWeb", targets: ["FieldnotesWeb"])],
    targets: [.executableTarget(name: "FieldnotesWeb")],
    swiftLanguageModes: [.v5]
)
