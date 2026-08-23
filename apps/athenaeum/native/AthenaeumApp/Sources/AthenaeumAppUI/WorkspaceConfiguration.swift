import Foundation
import AthenaeumDomain

// The native mirror of `web/src/workspace-id.ts`'s own doc comment: "Phase 0 has no auth or
// workspace-creation flow yet... deliberately minimal stand-in just so a real session has a stable
// workspaceId" — same honest scope limit here, adapted for a native app with no URL query string to
// read (`?workspace=` on web becomes a `UserDefaults` override a developer sets manually, e.g. via
// `defaults write` or a future debug menu — not built here, out of this stage's scope).

public enum WorkspaceConfiguration {
    private static let workspaceIdDefaultsKey = "athenaeum.workspaceId"
    private static let backendURLDefaultsKey = "athenaeum.backendURL"

    /// `wrangler dev`'s own default port (`packages/backend/package.json`'s `"dev": "wrangler
    /// dev"`) — matches the port `native/AthenaeumRPC`'s and `native/AthenaeumCore`'s own live
    /// tests default to via `ATHENAEUM_TEST_BACKEND_URL`.
    public static let defaultBackendURL = URL(string: "http://127.0.0.1:8787")!

    /// Resolves which backend this app talks to: a `UserDefaults` override
    /// (`athenaeum.backendURL`) if set, else `defaultBackendURL`.
    public static func resolveBackendURL(defaults: UserDefaults = .standard) -> URL {
        if let stored = defaults.string(forKey: backendURLDefaultsKey), let url = URL(string: stored) {
            return url
        }
        return defaultBackendURL
    }

    /// Resolves which workspace this device talks to: a persisted `UserDefaults` value if one exists
    /// (so relaunching the app keeps talking to the same `WorkspaceDurableObject` instance instead of
    /// minting a fresh one every launch — the native analog of `workspace-id.ts`'s
    /// `localStorage`-backed persistence), otherwise a UUID generated once and persisted.
    ///
    /// Mirrors `workspace-id.ts`'s `resolveWorkspaceId` shape (query-param override, then storage, then
    /// generate-and-persist) minus the query-param step, which has no native equivalent.
    public static func resolveWorkspaceId(defaults: UserDefaults = .standard) -> EntityId {
        if let stored = defaults.string(forKey: workspaceIdDefaultsKey), let decoded = try? EntityId(validating: stored) {
            return decoded
        }
        let generated = UUID().uuidString.lowercased()
        defaults.set(generated, forKey: workspaceIdDefaultsKey)
        // Safe to force-try: `UUID().uuidString.lowercased()` always matches `EntityId`'s UUID
        // pattern (see `EntityId.swift`'s `uuidPattern`).
        // swiftlint:disable:next force_try
        return try! EntityId(validating: generated)
    }

    /// A stable per-device, per-workspace path for `LocalWorkspaceStore`'s SQLite file, under this app's
    /// real Application Support directory (not a scratch/temp path — this is the actual local
    /// authority a real install should keep across launches, per the plan's "durable-before-sync").
    public static func localStorePath(workspaceId: EntityId, fileManager: FileManager = .default) throws -> String {
        let supportDir = try fileManager.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ).appendingPathComponent("Athenaeum", isDirectory: true)
        if !fileManager.fileExists(atPath: supportDir.path) {
            try fileManager.createDirectory(at: supportDir, withIntermediateDirectories: true)
        }
        return supportDir.appendingPathComponent("workspace-\(workspaceId.rawValue).sqlite3").path
    }
}
