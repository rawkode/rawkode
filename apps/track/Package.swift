// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Kree",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "Kree", targets: ["Kree"])
    ],
    targets: [
        .executableTarget(
            name: "Kree",
            dependencies: [],
            resources: [
                .process("Resources")
            ],
            linkerSettings: [
                .unsafeFlags(["-framework", "ApplicationServices"]),
                .unsafeFlags(["-framework", "Carbon"])
            ]
        )
    ]
)