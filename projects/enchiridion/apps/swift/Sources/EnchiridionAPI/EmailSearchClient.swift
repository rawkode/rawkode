// EmailSearchClient.swift
// EnchiridionAPI
//
// Task #66 ("Assistant read tools") — the concrete, real (not mocked away)
// implementation of `EnchiridionCore.AssistantEmailSearchClient` against
// vault's server-only `emailSearch` GraphQL field (plan §Google gatekeeper:
// "served via server-only GraphQL fields (`thread.messages`, `emailSearch`)";
// §Assistant (P5): "`searchEmailThreads` ... calls vault's server-only
// `emailSearch`/`thread.messages` GraphQL fields ... through the existing
// thin `EnchiridionAPI` client"). This is this target's first real source
// file — see README.md for the plan's original placeholder scope, which
// this narrowly fulfills (the `emailSearch` slice only; `thread.messages`
// and the rest of the generated supertag client types remain a later
// task's job per that README).
//
// Deliberately NOT Apollo (plan's pinned-technology table: "Thin generated
// types + URLSession (no Apollo)") — a hand-written `URLRequest`/
// `URLSession` POST with a fixed, hand-written GraphQL document, matching
// `workers/vault/src/graphql/composed-schema.ts`'s real
// `emailSearch(query: String!, limit: Int): [EmailMessage!]!` field
// signature (verified directly against that file, not guessed) and
// `EmailMessage`'s real field names.
//
// Auth: Cloudflare Access service-token headers (plan §Native apps: "Access
// service tokens per device"), confirmed against
// `workers/vault/src/access-auth.ts`'s own header-name constants
// (`CF-Access-Client-Id`/`CF-Access-Client-Secret`) — Access itself
// intercepts these at the edge before the worker is reached; this client
// only needs to set them, never to verify anything itself.

import EnchiridionCore
import Foundation

/// Per-device Cloudflare Access service-token credentials (plan §Native
/// apps: "per-device Access service tokens in Keychain"). Storage/retrieval
/// from Keychain is a UI-layer concern outside this target's scope — this
/// type is just the two header values once they're already in hand.
public struct EnchiridionAPICredentials: Sendable {
  public var accessClientID: String
  public var accessClientSecret: String

  public init(accessClientID: String, accessClientSecret: String) {
    self.accessClientID = accessClientID
    self.accessClientSecret = accessClientSecret
  }
}

public enum VaultGraphQLClientError: Error, LocalizedError, Equatable, Sendable {
  case invalidResponse
  case httpError(Int)
  case graphQLErrors([String])
  case decodingFailed

  public var errorDescription: String? {
    switch self {
    case .invalidResponse: "The server returned an unexpected response."
    case .httpError(let status): "The server returned HTTP \(status)."
    case .graphQLErrors(let messages): messages.joined(separator: "; ")
    case .decodingFailed: "The server's response could not be decoded."
    }
  }
}

/// Real `URLSession`-backed implementation of
/// `AssistantEmailSearchClient` — see this file's header. `Sendable`: every
/// stored property is an immutable value/`URLSession` (itself
/// `Sendable`-safe for concurrent use by design), so one instance may be
/// shared across concurrent assistant turns.
///
/// TWO WAYS TO SUPPLY CREDENTIALS (task #96, plan §Live Backend
/// Connectivity (P8) scope item 4): the original `credentials:` init below
/// (a static, optional value fixed at construction — no headers sent at
/// all when `nil`) predates any real device-enrollment mechanism and is
/// kept unchanged for source/test compatibility. `credentialProvider:` is
/// new — a throwing closure resolved fresh on every call (mirrors
/// `EnchiridionBlobs.BlobServiceEndpoint.accessCredential`'s identical
/// per-call-resolution shape), so a real `EnchiridionCore
/// .DeviceAccessCredentialResolver.resolveCredential()` can be plugged in
/// by app-assembly code (`EnchiridionUI/AssistantSceneAssembly.swift`) and
/// throw a real, distinct "device not enrolled" error BEFORE any request
/// is sent, rather than silently sending an unauthenticated request that
/// would only fail once it reached the network with a generic, hard-to-
/// diagnose 401. When both are supplied, `credentialProvider` wins (it is
/// the ONLY path real app-assembly code should use going forward); a
/// caller supplying neither sends no Access headers at all, same as
/// before.
public struct VaultEmailSearchClient: AssistantEmailSearchClient {
  public var endpoint: URL
  public var credentials: EnchiridionAPICredentials?
  private let credentialProvider: (@Sendable () async throws -> EnchiridionAPICredentials)?
  private let urlSession: URLSession

  public init(
    endpoint: URL,
    credentials: EnchiridionAPICredentials? = nil,
    urlSession: URLSession = .shared
  ) {
    self.endpoint = endpoint
    self.credentials = credentials
    self.credentialProvider = nil
    self.urlSession = urlSession
  }

  /// See this type's doc comment — the real, per-call-resolved credential
  /// path production app-assembly code should use.
  public init(
    endpoint: URL,
    credentialProvider: @escaping @Sendable () async throws -> EnchiridionAPICredentials,
    urlSession: URLSession = .shared
  ) {
    self.endpoint = endpoint
    self.credentials = nil
    self.credentialProvider = credentialProvider
    self.urlSession = urlSession
  }

  public func searchEmail(query: String, limit: Int) async throws -> [AssistantEmailMessage] {
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let credentialProvider {
      let resolved = try await credentialProvider()
      request.setValue(resolved.accessClientID, forHTTPHeaderField: "CF-Access-Client-Id")
      request.setValue(resolved.accessClientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
    } else if let credentials {
      request.setValue(credentials.accessClientID, forHTTPHeaderField: "CF-Access-Client-Id")
      request.setValue(credentials.accessClientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
    }
    let body = GraphQLRequestBody(
      query: Self.emailSearchQuery,
      variables: EmailSearchVariables(query: query, limit: limit)
    )
    request.httpBody = try JSONEncoder().encode(body)

    let (data, response) = try await urlSession.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw VaultGraphQLClientError.invalidResponse }
    guard (200..<300).contains(http.statusCode) else {
      throw VaultGraphQLClientError.httpError(http.statusCode)
    }

    let decoded: GraphQLResponse<EmailSearchData>
    do {
      decoded = try JSONDecoder().decode(GraphQLResponse<EmailSearchData>.self, from: data)
    } catch {
      throw VaultGraphQLClientError.decodingFailed
    }
    if let errors = decoded.errors, !errors.isEmpty {
      throw VaultGraphQLClientError.graphQLErrors(errors.map(\.message))
    }
    guard let messages = decoded.data?.emailSearch else { throw VaultGraphQLClientError.decodingFailed }
    return messages.map(\.asAssistantEmailMessage)
  }

  /// Matches `workers/vault/src/graphql/composed-schema.ts`'s real
  /// `Query.emailSearch(query: String!, limit: Int): [EmailMessage!]!`
  /// field and `EmailMessage` type exactly (field names verified against
  /// that file, not guessed) — only the subset of `EmailMessage` fields
  /// `AssistantEmailMessage` actually needs (see that type's doc comment
  /// on why the assistant never sees a message's full body/HTML/CC list).
  fileprivate static let emailSearchQuery = """
    query AssistantEmailSearch($query: String!, $limit: Int) {
      emailSearch(query: $query, limit: $limit) {
        id
        threadPageId
        from
        subject
        bodyText
        receivedAt
      }
    }
    """
}

// MARK: - Wire types (private — see `AssistantEmailMessage`'s doc comment
// for why this is deliberately narrower than the full `EmailMessage` type).

private struct EmailSearchVariables: Encodable {
  var query: String
  var limit: Int
}

private struct GraphQLRequestBody<Variables: Encodable>: Encodable {
  var query: String
  var variables: Variables
}

private struct GraphQLError: Decodable {
  var message: String
}

private struct GraphQLResponse<T: Decodable>: Decodable {
  var data: T?
  var errors: [GraphQLError]?
}

private struct EmailSearchData: Decodable {
  var emailSearch: [EmailMessageWire]
}

/// One `EmailMessage` GraphQL object, decoded. `receivedAt` is the
/// composed schema's epoch-millisecond `Float` convention (matches every
/// other generated type in `EnchiridionSchema` — see
/// `CoreSupertags.swift`'s header comment on that same convention).
private struct EmailMessageWire: Decodable {
  var id: String
  var threadPageId: String
  var from: String?
  var subject: String?
  var bodyText: String?
  var receivedAt: Double

  var asAssistantEmailMessage: AssistantEmailMessage {
    AssistantEmailMessage(
      id: id,
      threadPageID: threadPageId,
      from: from,
      subject: subject,
      snippet: bodyText.map { AssistantReadToolSupport.bounded($0, maximum: 400) },
      receivedAt: Date(timeIntervalSince1970: receivedAt / 1000)
    )
  }
}
