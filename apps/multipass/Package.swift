// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Multipass",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Multipass", targets: ["Multipass"])],
    targets: [
        .target(name: "MultipassCore"),
        .target(name: "MultipassNetwork"),
        .target(name: "MultipassHardware", linkerSettings: [.linkedFramework("IOKit")]),
        .executableTarget(name: "Multipass", dependencies: ["MultipassCore", "MultipassNetwork", "MultipassHardware"]),
        .testTarget(name: "MultipassCoreTests", dependencies: ["MultipassCore"]),
        .testTarget(name: "MultipassNetworkTests", dependencies: ["MultipassNetwork"]),
        .testTarget(name: "MultipassHardwareTests", dependencies: ["MultipassHardware"])
    ]
)
