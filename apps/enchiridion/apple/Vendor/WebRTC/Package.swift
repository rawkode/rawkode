// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WebRTC",
    platforms: [.iOS(.v13), .macOS(.v11)],
    products: [.library(name: "WebRTC", targets: ["WebRTC"])],
    targets: [
        .binaryTarget(
            name: "WebRTC",
            url: "https://github.com/rawkode/rawkode/releases/download/enchiridion-webrtc-153.0.0-p4x.1/WebRTC-M153-P4X.xcframework.zip",
            checksum: "08d5d7d1de004cde64f5dd108b8b8839bbdf0f1c4118980bef33f917a88a30f5"
        )
    ]
)
