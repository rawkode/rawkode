// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "EnchiridionCore",
  platforms: [
    .iOS(.v26),
    .macOS(.v26),
  ],
  products: [
    .library(name: "EnchiridionCore", targets: ["EnchiridionCore"])
  ],
  dependencies: [
    .package(
      url: "https://github.com/automerge/automerge-swift.git",
      exact: "0.7.2"
    ),
    .package(
      url: "https://github.com/groue/GRDB.swift.git",
      exact: "7.10.0"
    ),
  ],
  targets: [
    .target(
      name: "EnchiridionCore",
      dependencies: [
        .product(name: "Automerge", package: "automerge-swift"),
        .product(name: "GRDB", package: "GRDB.swift"),
      ],
      linkerSettings: [
        .linkedFramework("CloudKit"),
        .linkedFramework("EventKit"),
        .linkedFramework("AuthenticationServices"),
        .linkedFramework("AVFoundation"),
        .linkedFramework("Security"),
        .linkedFramework("NaturalLanguage"),
        .linkedFramework("UserNotifications"),
        .linkedFramework("WidgetKit"),
      ]
    ),
    .testTarget(
      name: "EnchiridionCoreTests",
      dependencies: ["EnchiridionCore"]
    ),
  ]
)
