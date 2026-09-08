import Foundation

// Mirrors `packages/domain/src/auth.ts` — the dev-auth identity/auth-context wire schemas (plan
// §"Sharing/observers on workspaces" prerequisite: "a real (not fabricated) way to authenticate as
// one locally, and a concrete shape every future RPC method can use to learn 'who is calling'").
// `CurrentUser`/`requireAuthenticatedUser` themselves are server-side Effect plumbing with no
// wire representation — nothing here mirrors those, only the schemas that actually cross the
// wire: `Email`, `AuthenticatedUser`, `DevSignInInput`/`Output`, `WhoamiOutput`.

/// Mirrors `auth.ts`'s `Email` brand: "a lower-cased, syntactically-plausible email address — the
/// sole account key." Format-only validation, same `EntityId.swift`/`IsoDateTimeString`
/// validate-don't-normalize convention: normalization (trimming/lower-casing) is the caller's job
/// before this type ever sees a raw string (see `DevAuthClient.swift`'s sign-in helper).
public struct Email: Hashable, Sendable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let rawValue: String

    private static let pattern = #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#

    public static func isValid(_ value: String) -> Bool {
        guard value == value.lowercased() else { return false }
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return regex.firstMatch(in: value, range: range) != nil
    }

    /// See `EntityId.init(validating:)`'s doc comment for why this is labeled, not `init(_:)`.
    public init(validating rawValue: String) throws {
        guard Email.isValid(rawValue) else {
            throw AthenaeumDomainDecodingError.invalidEmail(rawValue)
        }
        self.rawValue = rawValue
    }

    public init(stringLiteral value: String) {
        precondition(Email.isValid(value), "Email literal is not a lower-cased, valid-looking email address: \(value)")
        self.rawValue = value
    }

    public var description: String { rawValue }
}

extension Email: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard Email.isValid(value) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Email must be a lower-cased, valid-looking email address, got: \(value)"
            )
        }
        self.rawValue = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// A verified caller identity, valid for `[issuedAt, expiresAt)` — mirrors `auth.ts`'s
/// `AuthenticatedUser`. Never constructed client-side (a native client never signs its own
/// credential); this is a decode target for anything the backend ever hands back an
/// `AuthenticatedUser` shape in (`WhoamiOutput`'s `email` field is the current one).
public struct AuthenticatedUser: Codable, Hashable, Sendable {
    public let email: Email
    public let issuedAt: IsoDateTimeString
    public let expiresAt: IsoDateTimeString
    public init(email: Email, issuedAt: IsoDateTimeString, expiresAt: IsoDateTimeString) {
        self.email = email
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }
}

/// Mirrors `auth.ts`'s `DevSignInInput` — the `POST /api/dev/sign-in` request body. Plain HTTP,
/// not a Cap'n Web RPC method (see that file's own doc comment for why), so this is encoded by
/// hand as `{"email": "..."}` JSON rather than via `CapnWebValue` — see `DevAuthClient.swift`.
public struct DevSignInInput: Codable, Hashable, Sendable {
    public let email: Email
    public init(email: Email) { self.email = email }
}

/// Mirrors `auth.ts`'s `DevSignInOutput` — the `POST /api/dev/sign-in` response body. `credential`
/// is an opaque Bearer token (base64url payload + base64url HMAC signature, per `dev-auth.ts`'s
/// own doc comment) — deliberately `Schema.String`/`String` here, not a domain type, exactly like
/// `ShareKeyHash`'s doc comment explains for the raw share key: this client only ever passes it
/// through, never inspects its structure.
public struct DevSignInOutput: Codable, Hashable, Sendable {
    public let credential: String
    public let email: Email
    public let issuedAt: IsoDateTimeString
    public let expiresAt: IsoDateTimeString
    public init(credential: String, email: Email, issuedAt: IsoDateTimeString, expiresAt: IsoDateTimeString) {
        self.credential = credential
        self.email = email
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }
}

/// Mirrors `auth.ts`'s `WhoamiOutput` — `WorkspaceRpcApi.whoami()`'s wire output, the smallest proof
/// the per-connection auth-context plumbing reaches a real Cap'n Web RPC call.
public struct WhoamiOutput: Codable, Hashable, Sendable {
    public let authenticated: Bool
    public let email: Email?
    public init(authenticated: Bool, email: Email? = nil) {
        self.authenticated = authenticated
        self.email = email
    }
}
