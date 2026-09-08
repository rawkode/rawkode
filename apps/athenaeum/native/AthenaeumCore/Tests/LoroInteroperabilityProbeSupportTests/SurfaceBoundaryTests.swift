import Foundation
import XCTest

final class SurfaceBoundaryTests: XCTestCase {
    private let supportTarget = "LoroInteroperabilityProbeSupport"

    func testAthenaeumCoreDoesNotExposeProbeSymbolsOrSupportProduct() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let appRoot = packageRoot
            .deletingLastPathComponent()
            .appendingPathComponent("AthenaeumApp")
        let temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent("athenaeum-core-surface-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)

        let coreManifest = try packageDump(at: packageRoot, temporary: temporary, named: "core")
        assertSupportIsNotAPackageProduct(coreManifest)

        let appManifest = try packageDump(at: appRoot, temporary: temporary, named: "app")
        assertAppUIDependsOnlyOnCoreForTheCorePackage(appManifest)
        assertAppSourcesDoNotImportSupport(at: appRoot)

        try FileManager.default.createDirectory(
            at: temporary.appendingPathComponent("Sources/SurfaceProbe"),
            withIntermediateDirectories: true
        )
        try """
        // swift-tools-version:5.9
        import PackageDescription
        let package = Package(name: "SurfaceProbe", platforms: [.macOS(.v13)], dependencies: [.package(path: "\(packageRoot.path)")], targets: [.executableTarget(name: "SurfaceProbe", dependencies: [.product(name: "AthenaeumCore", package: "AthenaeumCore")])])
        """.write(
            to: temporary.appendingPathComponent("Package.swift"),
            atomically: true,
            encoding: .utf8
        )
        try """
        import AthenaeumCore
        let _: Any.Type = LoroInteroperabilityProbe.self
        """.write(
            to: temporary.appendingPathComponent("Sources/SurfaceProbe/main.swift"),
            atomically: true,
            encoding: .utf8
        )

        let result = try runSwift(["build"], in: temporary, temporary: temporary, named: "normal-import")
        XCTAssertNotEqual(result.status, 0, "normal AthenaeumCore import exposed the probe")
        XCTAssertTrue(
            result.diagnostics.contains("cannot find 'LoroInteroperabilityProbe' in scope"),
            result.diagnostics
        )
    }

    private func packageDump(at packageRoot: URL, temporary: URL, named: String) throws -> [String: Any] {
        let result = try runSwift(["package", "dump-package"], in: packageRoot, temporary: temporary, named: named)
        guard result.status == 0 else {
            XCTFail(result.diagnostics)
            throw NSError(domain: "SurfaceBoundaryTests", code: Int(result.status))
        }
        let object = try JSONSerialization.jsonObject(with: result.standardOutput)
        return try XCTUnwrap(object as? [String: Any])
    }

    private func assertSupportIsNotAPackageProduct(_ manifest: [String: Any]) {
        let products = manifest["products"] as? [[String: Any]] ?? []
        let supportProducts = products.filter { product in
            (product["targets"] as? [String] ?? []).contains(supportTarget)
        }
        XCTAssertTrue(supportProducts.isEmpty, "Support must not be exposed by any package product: \(supportProducts)")

        let supportLibraryProducts = products.filter { product in
            let targets = product["targets"] as? [String] ?? []
            let type = product["type"] as? [String: Any] ?? [:]
            return targets.contains(supportTarget) && type["library"] != nil
        }
        XCTAssertTrue(supportLibraryProducts.isEmpty, "Support must not be exposed as a library product: \(supportLibraryProducts)")
    }

    private func assertAppUIDependsOnlyOnCoreForTheCorePackage(_ manifest: [String: Any]) {
        let targets = manifest["targets"] as? [[String: Any]] ?? []
        let appUI = targets.first { ($0["name"] as? String) == "AthenaeumAppUI" }
        let dependencies = appUI?["dependencies"] as? [[String: Any]] ?? []
        let products = dependencies.compactMap { dependency -> String? in
            (dependency["product"] as? [Any])?.first as? String
        }
        XCTAssertTrue(products.contains("AthenaeumCore"), "AthenaeumAppUI must depend on AthenaeumCore: \(products)")
        XCTAssertFalse(products.contains(supportTarget), "AthenaeumAppUI must not depend on probe support: \(products)")
    }

    private func assertAppSourcesDoNotImportSupport(at appRoot: URL) {
        let sources = appRoot.appendingPathComponent("Sources")
        let enumerator = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)
        let offenders = (enumerator?.allObjects as? [URL] ?? []).filter { url in
            guard url.pathExtension == "swift",
                  let source = try? String(contentsOf: url) else { return false }
            return source.contains("import \(supportTarget)")
        }
        XCTAssertTrue(offenders.isEmpty, "App sources must not import probe support: \(offenders)")
    }

    private func runSwift(
        _ arguments: [String],
        in directory: URL,
        temporary: URL,
        named name: String
    ) throws -> SwiftCommandResult {
        let standardOutputURL = temporary.appendingPathComponent("\(name).stdout")
        let standardErrorURL = temporary.appendingPathComponent("\(name).stderr")
        try Data().write(to: standardOutputURL)
        try Data().write(to: standardErrorURL)
        let standardOutput = try FileHandle(forWritingTo: standardOutputURL)
        let standardError = try FileHandle(forWritingTo: standardErrorURL)
        defer {
            try? standardOutput.close()
            try? standardError.close()
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "swift"
        ] + Array(arguments.prefix(1)) + [
            "--scratch-path",
            temporary.appendingPathComponent("scratch-\(name)").path
        ] + Array(arguments.dropFirst())
        process.currentDirectoryURL = directory
        process.standardOutput = standardOutput
        process.standardError = standardError
        try process.run()
        process.waitUntilExit()
        try standardOutput.close()
        try standardError.close()

        return SwiftCommandResult(
            status: process.terminationStatus,
            standardOutput: try Data(contentsOf: standardOutputURL),
            standardError: try Data(contentsOf: standardErrorURL)
        )
    }
}

private struct SwiftCommandResult {
    let status: Int32
    let standardOutput: Data
    let standardError: Data

    var diagnostics: String {
        String(data: standardOutput + standardError, encoding: .utf8) ?? ""
    }
}
