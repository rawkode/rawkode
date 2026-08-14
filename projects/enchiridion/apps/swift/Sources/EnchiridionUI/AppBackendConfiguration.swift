// AppBackendConfiguration.swift
// EnchiridionUI
//
// Task #85 (P7 integration wave — "make it actually drivable"). Composition
// glue only: names ONE place the app-assembly code (`RootView.swift` on
// both platforms) reaches for "where is vault" when constructing the few
// pieces of this app that talk to a server — `EnchiridionBlobs.BlobCache`
// (canvas attachment upload/download), `EnchiridionAPI.VaultEmailSearchClient`,
// and `EnchiridionCore.AssistantRemoteWriteClient`/`AssistantRemoteWriteReviewClient`.
//
// ============================================================================
// READ BEFORE ASSUMING THIS MEANS "THE APP CAN REACH A LIVE BACKEND"
// ============================================================================
//
// UPDATE (task #96, plan §Live Backend Connectivity (P8) scope item 4 —
// "Final wiring"): the two reasons this file's header used to give for why
// the app couldn't reach a live backend are now BOTH resolved at the code
// level:
//   1. `AssistantRemoteWriteTools.swift`'s header used to say vault had no
//      HTTP proxy route to `gatekeeper-google`'s write RPCs. Task #94 built
//      that route (`workers/vault/src/gatekeeper-google-write-routes.ts`,
//      mounted at `/gatekeeper-google/*`) — `AssistantRemoteWriteClient`'s
//      request paths now match it exactly (verified by reading that file
//      directly, not guessed).
//   2. This file's own `placeholderAccessCredential()` used to be an
//      honestly-empty `("", "")` stub with no real device-enrollment
//      mechanism behind it. Task #95 built real Keychain-backed device
//      enrollment (`EnchiridionCore.DeviceAccessCredentialStore`/
//      `DeviceEnrollmentPairing`, `EnchiridionUI.DeviceEnrollmentViews`).
//      This task wires every consumer below to
//      `EnchiridionCore.DeviceAccessCredentialResolver` instead —
//      `placeholderAccessCredential()` is REMOVED (not deprecated-in-place)
//      because keeping it around would invite a future call site to keep
//      using an empty placeholder instead of the real resolver.
//
// WHAT IS STILL, HONESTLY, NOT LIVE — the one thing neither task #94 nor
// #95 nor this task can fix from inside this sandbox: `vaultBaseURL` below
// is still a plausible, documented PLACEHOLDER HOST, not a reachable one.
// There is no real Cloudflare account, no `wrangler deploy` of any of the
// three workers, and no real Cloudflare Access application gating that
// host in this sandbox (plan's own "Explicit, separate prerequisite ...
// user-only" paragraph). Concretely, that means:
//   - A real, enrolled device's credential (a real `client_id`/
//     `client_secret` pair, genuinely read from Keychain) will be attached
//     to every request this file's consumers build — but the request
//     itself will fail at the network layer (DNS/connection failure, most
//     likely, since `vault.enchiridion2.rawkode.academy` resolves to
//     nothing) rather than succeeding or even reaching a real Cloudflare
//     Access 401. That failure surfaces through each consumer's own
//     already-established honest-error path (`AssistantRemoteWriteError
//     .transportFailure`, `VaultGraphQLClientError`, `BlobCacheError`/a raw
//     `URLError`) — never swallowed, never faked as success.
//   - A device with NO enrolled credential yet fails EARLIER and more
//     specifically: `DeviceAccessCredentialResolver.resolveCredential()`
//     throws `DeviceAccessCredentialResolutionError.deviceNotEnrolled`
//     before any request is even constructed — see that type's own doc
//     comment (`EnchiridionCore/DeviceAccessCredentialResolution.swift`)
//     for why this is a distinct, deliberately earlier failure than a
//     network-layer one.
// So: real request construction, real credential lookup/injection, real
// honest failure in both the "not enrolled" and "no live host" cases —
// proven by mocked/stubbed-transport tests throughout this pass (this
// codebase's established convention for server integrations built ahead of
// a live deployment) — never a claim of live end-to-end verification this
// sandbox cannot perform.
//
// LOCAL PROTOTYPE UPDATE: a locally-running `wrangler dev` Vault is now a
// supported development target for CRDT sync only. The explicit loopback
// configuration below leaves all production endpoint and credential users
// unchanged.
import Foundation

/// Explicit opt-in configuration for a local `wrangler dev` Vault. This is
/// intentionally limited to loopback so a developer cannot accidentally send
/// a local development token to an arbitrary host.
public struct LocalVaultSyncConfiguration: Equatable, Sendable {
  public let baseURL: URL
  public let syncURL: URL
  public let token: String
  /// An explicitly supplied SQLite path for an unsigned local app build.
  /// A normally signed app continues to use its App Group store instead.
  public let storePath: String?

  public init(baseURL: URL, syncURL: URL, token: String, storePath: String? = nil) {
    self.baseURL = baseURL
    self.syncURL = syncURL
    self.token = token
    self.storePath = storePath
  }
}

public enum AppBackendConfiguration {
  /// A plausible future `vault` worker hostname — NOT a live, reachable
  /// endpoint today (see this file's header). Chosen to read clearly as
  /// "the vault worker for the rebuilt app" without claiming to be a real,
  /// currently-provisioned DNS name.
  public static let vaultBaseURL = URL(string: "https://vault.enchiridion2.rawkode.academy")!

  /// Set both of these only when running a local Vault alongside the app:
  ///
  /// - `ENCHIRIDION_LOCAL_VAULT_URL=http://127.0.0.1:8787`
  /// - `ENCHIRIDION_LOCAL_VAULT_TOKEN=<same LOCAL_DEV_ACCESS_TOKEN passed to wrangler>`
  /// - `ENCHIRIDION_LOCAL_STORE_PATH=/private/tmp/enchiridion-local-prototype.sqlite`
  ///
  /// Any incomplete, malformed, or non-loopback configuration is ignored
  /// rather than altering the app's production defaults.
  public static var localVaultSyncConfiguration: LocalVaultSyncConfiguration? {
    localVaultSyncConfiguration(environment: ProcessInfo.processInfo.environment)
  }

  static func localVaultSyncConfiguration(
    environment: [String: String]
  ) -> LocalVaultSyncConfiguration? {
    guard
      let rawURL = environment["ENCHIRIDION_LOCAL_VAULT_URL"],
      let baseURL = URL(string: rawURL),
      let scheme = baseURL.scheme?.lowercased(),
      scheme == "http" || scheme == "https",
      isLoopbackHost(baseURL.host),
      let token = environment["ENCHIRIDION_LOCAL_VAULT_TOKEN"],
      !token.isEmpty,
      var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
    else {
      return nil
    }

    components.scheme = scheme == "https" ? "wss" : "ws"
    let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    components.path = basePath.isEmpty ? "/sync" : "/\(basePath)/sync"
    components.query = nil
    components.fragment = nil
    guard let syncURL = components.url else { return nil }

    let storePath = environment["ENCHIRIDION_LOCAL_STORE_PATH"].flatMap { path in
      path.isEmpty ? nil : path
    }
    return LocalVaultSyncConfiguration(
      baseURL: baseURL,
      syncURL: syncURL,
      token: token,
      storePath: storePath
    )
  }

  private static func isLoopbackHost(_ host: String?) -> Bool {
    switch host?.lowercased() {
    case "localhost", "127.0.0.1", "::1", "[::1]": true
    default: false
    }
  }

  /// `workers/vault/src/enroll-routes.ts`'s `POST /enroll/provision` route
  /// (task #95), for `EnchiridionCore.VaultDeviceEnrollmentClient`'s
  /// `endpoint`. Same "plausible hostname, not a live endpoint today"
  /// caveat as `vaultBaseURL` above.
  public static var enrollProvisionURL: URL {
    vaultBaseURL.appendingPathComponent("enroll/provision")
  }

  /// `workers/vault/src/index.ts`'s `POST /graphql` route (verified
  /// directly against that file's `url.pathname === "/graphql"` dispatch,
  /// not guessed) — vault's single Pothos+Yoga GraphQL schema, including
  /// the server-only `emailSearch` field `EnchiridionAPI.VaultEmailSearchClient`
  /// calls. Same "plausible hostname, not a live endpoint today" caveat as
  /// `vaultBaseURL` above.
  public static var graphQLURL: URL {
    vaultBaseURL.appendingPathComponent("graphql")
  }
}
