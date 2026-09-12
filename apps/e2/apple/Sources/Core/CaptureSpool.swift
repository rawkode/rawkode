import Foundation

public enum CaptureSpoolError: LocalizedError {
    case invalidFile(String)
    public var errorDescription: String? {
        switch self {
        case .invalidFile(let name): "Could not read incoming capture \(name). It has been kept for recovery."
        }
    }
}

/// One immutable file per capture prevents concurrent system actions from replacing the notebook.
/// The app must commit a capture to its ledger before acknowledging its spool file.
public struct CaptureSpool: Sendable {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }
    public static func defaultDirectory() -> URL {
        VaultPersistence.defaultURL().deletingLastPathComponent().appendingPathComponent("Incoming", isDirectory: true)
    }

    public func save(_ capture: Capture) throws {
        _ = try CaptureLedger.inserting(capture, into: Vault())
        let manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = file(capture.id)
        let staging = directory.appendingPathComponent(".\(UUID().uuidString).pending")
        defer { try? manager.removeItem(at: staging) }
        let data = try JSONEncoder().encode(capture)
        #if os(iOS) || os(watchOS)
        try data.write(to: staging, options: [.atomic, .completeFileProtectionUnlessOpen])
        #else
        try data.write(to: staging, options: .atomic)
        #endif
        do {
            // A hard link atomically publishes a complete file and never replaces an existing ID.
            try manager.linkItem(at: staging, to: target)
        } catch {
            guard manager.fileExists(atPath: target.path) else { throw error }
            let existing = try read(target)
            guard existing == capture else { throw VaultError.duplicateIdentity }
        }
    }

    public func pending() throws -> [Capture] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: .skipsHiddenFiles)
            .filter { $0.pathExtension == "json" }
            .map(read)
            .sorted { $0.createdAt == $1.createdAt ? $0.id.uuidString < $1.id.uuidString : $0.createdAt < $1.createdAt }
    }

    public func acknowledge(_ id: UUID) throws {
        do { try FileManager.default.removeItem(at: file(id)) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { return }
    }

    private func file(_ id: UUID) -> URL { directory.appendingPathComponent("\(id.uuidString).json") }
    private func read(_ url: URL) throws -> Capture {
        do {
            let capture = try JSONDecoder().decode(Capture.self, from: Data(contentsOf: url))
            guard UUID(uuidString: url.deletingPathExtension().lastPathComponent) == capture.id else {
                throw CaptureSpoolError.invalidFile(url.lastPathComponent)
            }
            _ = try CaptureLedger.inserting(capture, into: Vault())
            return capture
        } catch { throw CaptureSpoolError.invalidFile(url.lastPathComponent) }
    }
}
