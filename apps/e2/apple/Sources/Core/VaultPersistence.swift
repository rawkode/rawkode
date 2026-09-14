import Foundation

public enum VaultError: LocalizedError {
    case unsupportedVersion(Int), invalidCapture, tooLarge, duplicateIdentity
    public var errorDescription: String? {
        switch self {
        case .unsupportedVersion(let version): "This notebook uses version \(version). Update Enchiridion before opening it."
        case .invalidCapture: "Write a thought before saving."
        case .tooLarge: "This thought is too large to save. Keep it under 100,000 characters."
        case .duplicateIdentity: "A different capture already uses this identifier. Neither copy was changed."
        }
    }
}

public struct VaultPersistence: Sendable {
    public let url: URL
    public init(url: URL) { self.url = url }
    public static func defaultURL() -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Apsides", isDirectory: true).appendingPathComponent("notebook.json")
    }
    public func load() throws -> Vault {
        guard FileManager.default.fileExists(atPath: url.path) else { return Vault() }
        let vault = try JSONDecoder().decode(Vault.self, from: Data(contentsOf: url))
        guard vault.version == 1 else { throw VaultError.unsupportedVersion(vault.version) }
        return vault
    }
    public func save(_ vault: Vault) throws {
        guard vault.version == 1 else { throw VaultError.unsupportedVersion(vault.version) }
        let data = try JSONEncoder().encode(vault)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS) || os(watchOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }
}

/// Pure reducers make retry and acknowledgement behavior independent of transport.
public enum CaptureLedger {
    public static func inserting(_ capture: Capture, into vault: Vault) throws -> Vault {
        guard !capture.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw VaultError.invalidCapture }
        guard capture.text.count <= 100_000 else { throw VaultError.tooLarge }
        if let existing = vault.captures.first(where: { $0.id == capture.id }) {
            guard existing == capture else { throw VaultError.duplicateIdentity }
            return vault
        }
        var result = vault
        result.captures.append(capture)
        return result
    }
    public static func pendingPhoneDelivery(in vault: Vault) -> [Capture] {
        vault.captures.filter { $0.source == .watch && !vault.phoneReceipts.contains($0.id) }
    }
}

public enum PortableCapture {
    /// Only exports native-owned text. Never converts or overwrites a fetched rich document.
    public static func data(text: String) throws -> Data {
        let blocks: [[String: Any]] = text.components(separatedBy: "\n").map { line in
            line.isEmpty ? ["type": "paragraph"] : ["type": "paragraph", "content": [["type": "text", "text": line]]]
        }
        return try JSONSerialization.data(withJSONObject: ["type": "doc", "content": blocks], options: [.sortedKeys])
    }
}
