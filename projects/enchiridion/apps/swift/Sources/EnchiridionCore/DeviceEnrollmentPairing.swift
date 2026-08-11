// DeviceEnrollmentPairing.swift
// EnchiridionCore
//
// Plan §Live Backend Connectivity (P8), "Device auth" paragraph + §Native
// apps device-enrollment-flow bullet: "short-lived pairing code/QR from an
// already-authenticated device; the server mints the device-specific
// token — never a shared secret baked into the binary." This is the
// client-side half of that flow, pairing with
// `workers/vault/src/enroll-routes.ts`'s `POST /enroll/provision` (read
// that file's header FIRST — it has the full protocol design and, in
// particular, why the ALREADY-ENROLLED device is the sole caller of the
// server endpoint, never the new device).
//
// ROLE SPLIT (mirrors the server-side design exactly):
//   - The ALREADY-ENROLLED device (role: "existing") generates a
//     `PairingCode`, calls `DeviceEnrollmentProvisioningClient.provision`
//     (its own already-valid `DeviceAccessCredentialStore` credential
//     authenticates the request, the normal way — see
//     `EnchiridionAPI/EmailSearchClient.swift` for the identical
//     CF-Access-Client-Id/Secret header pattern this client reuses), and
//     receives a freshly-minted credential for the NEW device back. It
//     encodes that into a `DeviceEnrollmentPairingPayload` and displays it
//     — as a QR code (`EnchiridionUI/DeviceEnrollmentViews.swift` renders
//     it) or as copyable text — for the new device to consume OUT OF
//     BAND. This device's own role never touches
//     `DeviceAccessCredentialStore`'s WRITE path for the new credential —
//     it only ever reads its OWN existing one to authenticate the
//     provisioning call.
//   - The NEW, still-unenrolled device (role: "new") never calls vault at
//     all (it has no credential yet — see enroll-routes.ts's header for
//     why that's a hard requirement, not a missed optimization). It only
//     decodes a `DeviceEnrollmentPairingPayload` it was handed out of band
//     (scanned QR / pasted text) and, once decoded, saves the credential
//     inside it directly to ITS OWN `DeviceAccessCredentialStore` — no
//     network call in this role at all.
//
// EXPIRY-WARNING UX (plan: "In-app expiry warning + re-enrollment UX
// before a token goes dark") — `DeviceCredentialExpiryStatus` /
// `evaluateDeviceCredentialExpiry` below is the pure decision logic;
// `EnchiridionUI/DeviceEnrollmentViews.swift`'s banner view is the actual
// UI, driven by this.

import Foundation

// MARK: - Pairing code

/// A short-lived, single-use nonce the ALREADY-ENROLLED device generates
/// locally and sends to `/enroll/provision` — see
/// `workers/vault/src/enroll-routes.ts`'s header for exactly what job this
/// does and does not do (idempotency + a human-checkable shared value
/// across the two devices' screens; NOT the actual security boundary,
/// which is Access authentication on the calling device's own request).
///
/// Format (`XXXX-XXXX`) and alphabet (uppercase letters + digits, excluding
/// visually-ambiguous `0`/`O`/`1`/`I`/`L`) are a direct, deliberate port of
/// `workers/vault/src/enroll-routes.ts`'s `PAIRING_CODE_PATTERN`/
/// `PAIRING_CODE_ALPHABET` — the two sides MUST agree on this shape, since
/// the server validates exactly this pattern.
public enum PairingCode {
  static let alphabet = Array("ABCDEFGHJKMNPQRSTUVWXYZ23456789")

  /// Generates a fresh pairing code using `SystemRandomNumberGenerator`
  /// (a real CSPRNG on Apple platforms — Swift's default `RandomNumberGenerator`
  /// is documented to be cryptographically secure). Injectable generator
  /// for deterministic tests.
  public static func generate<G: RandomNumberGenerator>(using generator: inout G) -> String {
    let chars = (0..<8).map { _ in alphabet[Int.random(in: 0..<alphabet.count, using: &generator)] }
    return "\(String(chars[0..<4]))-\(String(chars[4..<8]))"
  }

  public static func generate() -> String {
    var generator = SystemRandomNumberGenerator()
    return generate(using: &generator)
  }

  /// Mirrors `enroll-routes.ts`'s `validatePairingCodeFormat` exactly —
  /// `XXXX-XXXX`, uppercase letters/digits only, no ambiguous characters.
  public static func isValidFormat(_ code: String) -> Bool {
    let pattern = "^[A-Z2-9]{4}-[A-Z2-9]{4}$"
    return code.range(of: pattern, options: .regularExpression) != nil
  }
}

// MARK: - Pairing payload (the out-of-band QR/manual-code transfer)

/// Everything the new device needs to enroll itself, transferred out of
/// band (QR scan or manual paste) from the already-enrolled device's
/// screen after a successful `/enroll/provision` call. Field names match
/// that endpoint's JSON response body exactly (see enroll-routes.ts) so
/// the already-enrolled device can forward the response with no
/// reshaping.
public struct DeviceEnrollmentPairingPayload: Codable, Equatable, Sendable {
  public var pairingCode: String
  public var deviceName: String
  public var clientId: String
  public var clientSecret: String
  public var mintedAt: Date
  public var expiresAt: Date

  public init(
    pairingCode: String, deviceName: String, clientId: String, clientSecret: String, mintedAt: Date,
    expiresAt: Date
  ) {
    self.pairingCode = pairingCode
    self.deviceName = deviceName
    self.clientId = clientId
    self.clientSecret = clientSecret
    self.mintedAt = mintedAt
    self.expiresAt = expiresAt
  }

  public var asDeviceAccessCredential: DeviceAccessCredential {
    DeviceAccessCredential(
      clientId: clientId, clientSecret: clientSecret, deviceName: deviceName, mintedAt: mintedAt,
      expiresAt: expiresAt)
  }
}

public enum DeviceEnrollmentPairingCodecError: Error, Equatable, Sendable {
  case malformed
}

/// Encodes/decodes a `DeviceEnrollmentPairingPayload` to/from the single
/// string that travels through the QR code or the manual-paste text field.
/// Plain JSON (not a custom compact format) — the payload is already small
/// (two UUIDs-worth of credential plus a device name and two timestamps),
/// well within a QR code's practical capacity at low-medium error
/// correction, and using JSON directly (rather than inventing a bespoke
/// delimiter format) means one fewer hand-rolled parser to get subtly
/// wrong.
public enum DeviceEnrollmentPairingCodec {
  public static func encode(_ payload: DeviceEnrollmentPairingPayload) throws -> String {
    let data = try encoder.encode(payload)
    guard let string = String(data: data, encoding: .utf8) else {
      throw DeviceEnrollmentPairingCodecError.malformed
    }
    return string
  }

  public static func decode(_ string: String) throws -> DeviceEnrollmentPairingPayload {
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let data = trimmed.data(using: .utf8) else {
      throw DeviceEnrollmentPairingCodecError.malformed
    }
    do {
      return try decoder.decode(DeviceEnrollmentPairingPayload.self, from: data)
    } catch {
      throw DeviceEnrollmentPairingCodecError.malformed
    }
  }

  private static let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return encoder
  }()

  private static let decoder: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }()
}

// MARK: - Provisioning client (already-enrolled device's role)

/// The already-enrolled device's own Access credential — used to
/// authenticate the `/enroll/provision` call, exactly like every other
/// vault request (`EnchiridionAPI/EmailSearchClient.swift`'s
/// `EnchiridionAPICredentials`, `EnchiridionSync/VaultSyncClient.swift`'s
/// `AccessServiceTokenCredential`). Declared locally rather than importing
/// one of those types — `EnchiridionCore` cannot depend on
/// `EnchiridionAPI`/`EnchiridionSync` (they depend on IT; see
/// `Package.swift`), and this credential's role here (authenticating a
/// request as an ALREADY-ENROLLED device) is conceptually the same
/// two-string pair regardless.
public struct ExistingDeviceAccessCredential: Sendable, Equatable {
  public var clientId: String
  public var clientSecret: String

  public init(clientId: String, clientSecret: String) {
    self.clientId = clientId
    self.clientSecret = clientSecret
  }
}

public enum DeviceEnrollmentProvisioningError: Error, LocalizedError, Equatable, Sendable {
  case invalidResponse
  case httpError(status: Int, message: String?)
  case decodingFailed

  public var errorDescription: String? {
    switch self {
    case .invalidResponse: "The server returned an unexpected response."
    case .httpError(let status, let message): message ?? "The server returned HTTP \(status)."
    case .decodingFailed: "The server's response could not be decoded."
    }
  }
}

/// Seam for testing `AddDeviceView`-style flows without a real network
/// call — mirrors this codebase's existing convention of a small
/// protocol behind each real client (e.g. `AssistantEmailSearchClient`).
public protocol DeviceEnrollmentProvisioningClient: Sendable {
  /// Calls `POST /enroll/provision` (workers/vault/src/enroll-routes.ts)
  /// to mint a fresh credential for a device named `deviceName`, using
  /// `pairingCode` (generate with `PairingCode.generate()`) and this
  /// device's own `existingCredential` to authenticate. Returns the full
  /// payload ready to hand to the new device out of band.
  func provisionDevice(
    deviceName: String, pairingCode: String, existingCredential: ExistingDeviceAccessCredential
  ) async throws -> DeviceEnrollmentPairingPayload
}

/// Real `URLSession`-backed implementation, matching
/// `EnchiridionAPI/EmailSearchClient.swift`'s `VaultEmailSearchClient`
/// shape (hand-written `URLRequest`/`URLSession`, no Apollo — plan's
/// pinned-technology table). `endpoint` is vault's `/enroll/provision`
/// route (`AppBackendConfiguration.vaultBaseURL.appending(path:
/// "enroll/provision")`, wired by the composition root — see that file).
public struct VaultDeviceEnrollmentClient: DeviceEnrollmentProvisioningClient {
  public var endpoint: URL
  private let urlSession: URLSession

  public init(endpoint: URL, urlSession: URLSession = .shared) {
    self.endpoint = endpoint
    self.urlSession = urlSession
  }

  public func provisionDevice(
    deviceName: String, pairingCode: String, existingCredential: ExistingDeviceAccessCredential
  ) async throws -> DeviceEnrollmentPairingPayload {
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    // Real Cloudflare Access service-token header pair (see this file's
    // header + workers/vault/src/access-auth.ts) — authenticates THIS
    // request as coming from an already-enrolled device.
    request.setValue(existingCredential.clientId, forHTTPHeaderField: "CF-Access-Client-Id")
    request.setValue(existingCredential.clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
    request.httpBody = try JSONEncoder().encode(
      ProvisionRequestBody(pairingCode: pairingCode, deviceName: deviceName))

    let (data, response) = try await urlSession.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw DeviceEnrollmentProvisioningError.invalidResponse }
    guard (200..<300).contains(http.statusCode) else {
      let message = try? JSONDecoder().decode(ErrorResponseBody.self, from: data).error
      throw DeviceEnrollmentProvisioningError.httpError(status: http.statusCode, message: message)
    }

    do {
      let decoder = JSONDecoder()
      decoder.dateDecodingStrategy = .iso8601
      return try decoder.decode(DeviceEnrollmentPairingPayload.self, from: data)
    } catch {
      throw DeviceEnrollmentProvisioningError.decodingFailed
    }
  }

  private struct ProvisionRequestBody: Encodable {
    var pairingCode: String
    var deviceName: String
  }

  private struct ErrorResponseBody: Decodable {
    var error: String
  }
}

// MARK: - Expiry warning (plan: "In-app expiry warning + re-enrollment UX")

public enum DeviceCredentialExpiryStatus: Equatable, Sendable {
  /// Not expiring soon — no warning needed.
  case healthy
  /// Still valid, but within `warningWindow` of expiring — the plan's
  /// "in-app expiry warning" case. `daysRemaining` is floor-rounded (0 on
  /// the final day) for a human-readable "N days left" banner.
  case expiringSoon(daysRemaining: Int)
  /// Already past `expiresAt` — the plan's "before a token goes dark"
  /// case has already arrived; every request using this credential will
  /// now fail. Distinct from `expiringSoon` so the UI can show a harder
  /// "re-enroll now" state instead of a softer warning.
  case expired
}

/// Pure decision function — no I/O, no dependency on `Date()` at the call
/// site (the caller supplies `now`), so this is fully unit-testable and
/// the actual "when to show a banner" policy lives in exactly one place.
/// `warningWindow` defaults to 30 days: generous enough that a user who
/// opens the app at least monthly always sees the warning before a
/// same-duration (`DEFAULT_SERVICE_TOKEN_DURATION` in
/// cloudflare-access-api.ts, one year) credential goes dark.
public func evaluateDeviceCredentialExpiry(
  now: Date = Date(), expiresAt: Date, warningWindow: TimeInterval = 30 * 24 * 60 * 60
) -> DeviceCredentialExpiryStatus {
  if expiresAt <= now { return .expired }
  let remaining = expiresAt.timeIntervalSince(now)
  guard remaining <= warningWindow else { return .healthy }
  let daysRemaining = Int(remaining / (24 * 60 * 60))
  return .expiringSoon(daysRemaining: daysRemaining)
}
