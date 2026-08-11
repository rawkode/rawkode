// DeviceAccessCredentialResolution.swift
// EnchiridionCore
//
// Plan §Live Backend Connectivity (P8), scope item 4 ("Final wiring: point
// AppBackendConfiguration/AssistantRemoteWriteClient/VaultEmailSearchClient/
// canvas blob upload at real endpoints"). Every real client this pass wires
// up (`EnchiridionCore.AssistantRemoteWriteClient`/`AssistantRemoteWriteReviewClient`,
// `EnchiridionAPI.VaultEmailSearchClient`, `EnchiridionBlobs.BlobCache` via
// `EnchiridionUI/PageCanvasEmbedding.swift`) needs the SAME answer to "where
// does this device's Cloudflare Access service-token credential come from,
// and what happens when there isn't one yet" — this file is that one
// answer, shared rather than reimplemented per call site (the same
// discipline `DeviceAccessCredentialStore.swift`'s own header describes for
// reusing `AssistantKeychainClient` instead of a second Keychain seam).
//
// THE HONESTY REQUIREMENT THIS FILE EXISTS TO SATISFY: task #95 built real
// Keychain storage (`DeviceAccessCredentialStore`) but every consumer this
// task wires still needs to answer "what happens on the very first call,
// before any device has ever been enrolled?" `DeviceAccessCredentialStore
// .readCredential()` already answers that honestly one layer down (`nil`,
// never a thrown error, for "nothing stored yet" — see that method's doc
// comment) — but `nil` is not itself a usable Access credential, and every
// consumer here needs an ACTUAL `{clientId, clientSecret}` pair to build a
// request with. Silently sending empty-string headers (what this task
// found `AppBackendConfiguration.placeholderAccessCredential()` did before
// this pass) would let a request go out, reach Access, and fail with a
// generic 401 an app-code caller has no reliable way to distinguish from
// "the credential is stale" or "the server rejected it for some other
// reason." `resolveCredential()` below turns "nothing stored yet" into a
// distinct, catchable, honestly-worded error BEFORE any network call is
// even attempted — every call site in this pass (`AssistantRemoteWriteTools
// .swift`'s `AssistantRemoteWriteHTTP.perform`, `EnchiridionBlobs.BlobCache
// .uploadBlob`/`.downloadBlob` via its now-throwing `accessCredential`
// closure, `EnchiridionAPI.VaultEmailSearchClient`'s new
// `credentialProvider` path) surfaces this same error type rather than
// reaching the network with an empty/garbage credential.
import Foundation

/// Thrown by `DeviceAccessCredentialResolver.resolveCredential()` — see
/// this file's header. Distinct from `DeviceAccessCredentialStoreError`
/// (that type is Keychain-LAYER failures: a locked/unavailable Keychain, a
/// corrupted stored value; genuine I/O-adjacent problems) — `.deviceNotEnrolled`
/// is not a failure at all in the Keychain sense, it is the normal,
/// expected state of a device that has simply never been paired yet.
/// Keeping these as two distinct error types (rather than folding
/// `.deviceNotEnrolled` into `DeviceAccessCredentialStoreError` as a new
/// case) means a caller that only wants to say "please enroll this device"
/// doesn't also need to pattern-match every Keychain-layer failure mode to
/// do it.
public enum DeviceAccessCredentialResolutionError: Error, LocalizedError, Equatable, Sendable {
  /// `DeviceAccessCredentialStore.readCredential()` returned `nil` — this
  /// device has never completed the pairing flow
  /// (`DeviceEnrollmentPairing.swift`) and holds no Access service-token
  /// credential of its own yet.
  case deviceNotEnrolled
  /// `DeviceAccessCredentialStore.readCredential()` itself threw — a real
  /// Keychain-layer failure (locked, unavailable, or corrupted stored
  /// value), not "not enrolled." Carries the underlying error for
  /// diagnostics.
  case storeUnavailable(DeviceAccessCredentialStoreError)

  public var errorDescription: String? {
    switch self {
    case .deviceNotEnrolled:
      "This device isn't enrolled yet. Pair it from the Devices screen before using this feature."
    case .storeUnavailable(let underlying):
      "Couldn't read this device's saved credential: \(underlying)"
    }
  }
}

/// Resolves THIS device's own `DeviceAccessCredential` on demand, turning
/// "nothing enrolled yet" into a distinct, catchable
/// `DeviceAccessCredentialResolutionError.deviceNotEnrolled` — see this
/// file's header. A thin wrapper over `DeviceAccessCredentialStore`, not a
/// second storage mechanism: every real call site in this pass constructs
/// one of these around the SAME `DeviceAccessCredentialStore` instance
/// `DeviceEnrollmentViews.swift`'s enrollment UI reads/writes, so a device
/// enrolled (or re-enrolled) through that UI is immediately visible to
/// every consumer here without any extra plumbing.
public struct DeviceAccessCredentialResolver: Sendable {
  private let store: DeviceAccessCredentialStore

  public init(store: DeviceAccessCredentialStore = DeviceAccessCredentialStore()) {
    self.store = store
  }

  /// Returns this device's stored credential, or throws
  /// `DeviceAccessCredentialResolutionError` — never returns a placeholder/
  /// empty credential. Callers (every `accessCredential`/`credential`
  /// closure this pass wires) should let this throw propagate rather than
  /// catching it here; each call site's own established error-handling
  /// path (an HTTP client's thrown-error contract, a SwiftUI sheet's
  /// `errorMessage` state) is where a person actually sees the honest
  /// "not enrolled" message.
  public func resolveCredential() async throws -> DeviceAccessCredential {
    do {
      guard let credential = try await store.readCredential() else {
        throw DeviceAccessCredentialResolutionError.deviceNotEnrolled
      }
      return credential
    } catch let error as DeviceAccessCredentialResolutionError {
      throw error
    } catch let error as DeviceAccessCredentialStoreError {
      throw DeviceAccessCredentialResolutionError.storeUnavailable(error)
    }
  }
}
