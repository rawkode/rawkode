import Foundation
import AthenaeumDomain

// The watchOS analog of `AthenaeumApp/Sources/AthenaeumAppUI/WorkspaceConfiguration.swift` — same
// `UserDefaults`-backed resolve-or-generate shape, same key names (`athenaeum.workspaceId` /
// `athenaeum.backendURL`), deliberately duplicated here rather than shared via a new common
// package: `WorkspaceConfiguration` lives in `AthenaeumApp`, which depends on `AthenaeumCore`, which
// depends on `automerge-swift` — a package this target must never link (see this package's
// `Package.swift` top doc comment). Duplicating ~15 lines here is cheaper than restructuring the
// macOS/iOS package graph just to share it, and the two independently-typed-but-identical copies
// can't silently drift in a way that breaks a build (an `EntityId`/`URL` typo would just fail to
// resolve, not compile-succeed with wrong behavior).
//
// One real difference from the phone/Mac app: there is no on-device SQLite local authority here
// (`AthenaeumWatchUI` has no `LocalWorkspaceStore` — this is the plan's documented "plain-text
// quick-capture flow synced as a minimal structured record" fallback, not a durable-before-sync
// local-first client), so this type has no `localStorePath` — quick captures go straight over the
// wire via `QuickCaptureClient`, with only an `UserDefaults`-persisted `workspaceId`/`backendURL`, the
// same watch-vs-phone tradeoff the plan's own watchOS callout anticipates.
public enum WatchWorkspaceConfiguration {
    private static let workspaceIdDefaultsKey = "athenaeum.workspaceId"
    private static let backendURLDefaultsKey = "athenaeum.backendURL"

    /// `wrangler dev`'s own default port — matches `WorkspaceConfiguration.defaultBackendURL` and
    /// `AthenaeumRPC`/`AthenaeumCore`'s live-test default. A real watch/phone pairing would need a
    /// reachable LAN address here instead of `127.0.0.1` (the watch is a distinct network client,
    /// not the same host as a Simulator-paired Mac) — out of scope for this stage; see this
    /// file's report for the honest callout.
    public static let defaultBackendURL = URL(string: "http://127.0.0.1:8787")!

    public static func resolveBackendURL(defaults: UserDefaults = .standard) -> URL {
        if let stored = defaults.string(forKey: backendURLDefaultsKey), let url = URL(string: stored) {
            return url
        }
        return defaultBackendURL
    }

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
}
