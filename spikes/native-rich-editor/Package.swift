// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NativeRichEditor",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "NativeRichEditor", targets: ["NativeRichEditor"])],
    targets: [
        .executableTarget(name: "NativeRichEditor"),
        .testTarget(name: "NativeRichEditorTests", dependencies: ["NativeRichEditor"]),
    ],
    swiftLanguageModes: [.v5]
)
