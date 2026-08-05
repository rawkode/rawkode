import AuthenticationServices
import CryptoKit
import Foundation
import Security
#if os(macOS)
import AppKit
#else
import UIKit
#endif

public enum GoogleCalendarError: Error, LocalizedError, Equatable {
  case notConfigured
  case authorizationCancelled
  case authorizationRevoked
  case invalidCallback
  case invalidResponse
  case api(String)

  public var errorDescription: String? {
    switch self {
    case .notConfigured:
      "Google Calendar is not configured. Add GoogleOAuthClientID and GoogleOAuthRedirectScheme to the app configuration."
    case .authorizationCancelled: "Google authorization was cancelled."
    case .authorizationRevoked: "Google Calendar access was revoked. Reconnect Google Calendar to continue."
    case .invalidCallback: "Google returned an invalid authorization response."
    case .invalidResponse: "Google Calendar returned an invalid response."
    case .api(let message): "Google Calendar is unavailable: \(message)"
    }
  }
}

@MainActor
public final class GoogleCalendarProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
  public struct Configuration: Sendable {
    public var clientID: String
    public var redirectScheme: String

    public init(clientID: String, redirectScheme: String) {
      self.clientID = clientID
      self.redirectScheme = redirectScheme
    }

    var redirectURI: String { "\(redirectScheme):/oauth2redirect" }
  }

  private let configuration: Configuration
  private var authenticationSession: ASWebAuthenticationSession?
  private var accessToken: String?
  private var accessTokenExpiry: Date = .distantPast

  public init(configuration: Configuration) {
    self.configuration = configuration
  }

  public static func fromBundle(_ bundle: Bundle = .main) throws -> GoogleCalendarProvider {
    guard let clientID = bundle.object(forInfoDictionaryKey: "GoogleOAuthClientID") as? String,
      !clientID.isEmpty,
      let redirectScheme = bundle.object(forInfoDictionaryKey: "GoogleOAuthRedirectScheme") as? String,
      !redirectScheme.isEmpty,
      !clientID.hasPrefix("CONFIGURE_")
    else { throw GoogleCalendarError.notConfigured }
    return GoogleCalendarProvider(configuration: .init(clientID: clientID, redirectScheme: redirectScheme))
  }

  public func authorize() async throws {
    if Keychain.refreshToken(clientID: configuration.clientID) != nil { return }
    let verifier = Self.base64URL(Data((0..<48).map { _ in UInt8.random(in: .min ... .max) }))
    let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    let state = UUID().uuidString
    var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
    components.queryItems = [
      URLQueryItem(name: "client_id", value: configuration.clientID),
      URLQueryItem(name: "redirect_uri", value: configuration.redirectURI),
      URLQueryItem(name: "response_type", value: "code"),
      URLQueryItem(name: "scope", value: "https://www.googleapis.com/auth/calendar.readonly"),
      URLQueryItem(name: "access_type", value: "offline"),
      URLQueryItem(name: "prompt", value: "consent"),
      URLQueryItem(name: "code_challenge", value: challenge),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
      URLQueryItem(name: "state", value: state),
    ]
    guard let authorizationURL = components.url else { throw GoogleCalendarError.notConfigured }

    let callbackURL: URL = try await withCheckedThrowingContinuation { continuation in
      let session = ASWebAuthenticationSession(url: authorizationURL, callbackURLScheme: configuration.redirectScheme) {
        url, error in
        if let url { continuation.resume(returning: url) }
        else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
          continuation.resume(throwing: GoogleCalendarError.authorizationCancelled)
        } else {
          continuation.resume(throwing: error ?? GoogleCalendarError.invalidCallback)
        }
      }
      session.presentationContextProvider = self
      session.prefersEphemeralWebBrowserSession = false
      authenticationSession = session
      guard session.start() else {
        continuation.resume(throwing: GoogleCalendarError.authorizationCancelled)
        return
      }
    }
    authenticationSession = nil
    guard let callback = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
      callback.queryItems?.first(where: { $0.name == "state" })?.value == state,
      let code = callback.queryItems?.first(where: { $0.name == "code" })?.value
    else { throw GoogleCalendarError.invalidCallback }
    let token = try await exchangeToken(code: code, verifier: verifier)
    apply(token)
    if let refreshToken = token.refreshToken {
      try Keychain.store(refreshToken: refreshToken, clientID: configuration.clientID)
    }
  }

  public func events(from start: Date, through end: Date) async throws -> [CalendarEventSnapshot] {
    try await authorize()
    let token = try await validAccessToken()
    var calendars: [GoogleCalendar] = []
    var calendarPageToken: String?
    repeat {
      var components = URLComponents(string: "https://www.googleapis.com/calendar/v3/users/me/calendarList")!
      components.queryItems = [calendarPageToken.map { URLQueryItem(name: "pageToken", value: $0) }].compactMap { $0 }
      guard let url = components.url else { throw GoogleCalendarError.invalidResponse }
      let page: CalendarList = try await get(url.absoluteString, token: token)
      calendars.append(contentsOf: page.items ?? [])
      calendarPageToken = page.nextPageToken
    } while calendarPageToken != nil
    var results: [CalendarEventSnapshot] = []
    for calendar in calendars where calendar.selected != false {
      var pageToken: String?
      repeat {
        var components = URLComponents(string: "https://www.googleapis.com/calendar/v3/calendars/\(calendar.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? calendar.id)/events")!
        components.queryItems = [
          URLQueryItem(name: "timeMin", value: Self.rfc3339.string(from: start)),
          URLQueryItem(name: "timeMax", value: Self.rfc3339.string(from: end)),
          URLQueryItem(name: "singleEvents", value: "true"),
          URLQueryItem(name: "showDeleted", value: "false"),
          URLQueryItem(name: "maxResults", value: "2500"),
          pageToken.map { URLQueryItem(name: "pageToken", value: $0) },
        ].compactMap { $0 }
        guard let url = components.url else { throw GoogleCalendarError.invalidResponse }
        let response: EventsList = try await get(url.absoluteString, token: token)
        results.append(contentsOf: (response.items ?? []).compactMap { event in
          Self.snapshot(event: event, calendar: calendar)
        })
        pageToken = response.nextPageToken
      } while pageToken != nil
    }
    return results.sorted { $0.startDate < $1.startDate }
  }

  public func authoritativeProjection(from start: Date, through end: Date) async throws -> AuthoritativeCalendarProjection {
    .init(provider: "google", interval: .init(start: start, end: end), events: try await events(from: start, through: end))
  }

  /// Refreshes the stored credential without fetching a calendar projection.
  /// A successful result is the only startup condition that may authorize
  /// legacy cached Google rows to become normal Event pages.
  public func validateStoredAuthorization() async throws {
    _ = try await validAccessToken()
  }

  /// Safe startup check: no UI and no prompt, only configuration plus an
  /// existing refresh credential.
  public static func isRestorable(from bundle: Bundle = .main) -> Bool {
    guard let provider = try? fromBundle(bundle) else { return false }
    return Keychain.refreshToken(clientID: provider.configuration.clientID) != nil
  }

  public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    #if os(macOS)
    NSApplication.shared.keyWindow ?? ASPresentationAnchor()
    #else
    UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    #endif
  }

  private func validAccessToken() async throws -> String {
    if let accessToken, accessTokenExpiry.timeIntervalSinceNow > 60 { return accessToken }
    guard let refreshToken = Keychain.refreshToken(clientID: configuration.clientID) else {
      throw GoogleCalendarError.authorizationCancelled
    }
    let token = try await tokenRequest([
      "client_id": configuration.clientID,
      "refresh_token": refreshToken,
      "grant_type": "refresh_token",
    ])
    apply(token)
    guard let accessToken else { throw GoogleCalendarError.invalidResponse }
    return accessToken
  }

  private func exchangeToken(code: String, verifier: String) async throws -> TokenResponse {
    try await tokenRequest([
      "client_id": configuration.clientID,
      "code": code,
      "code_verifier": verifier,
      "grant_type": "authorization_code",
      "redirect_uri": configuration.redirectURI,
    ])
  }

  private func tokenRequest(_ form: [String: String]) async throws -> TokenResponse {
    var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = form.map { key, value in
      "\(Self.formEncode(key))=\(Self.formEncode(value))"
    }.sorted().joined(separator: "&").data(using: .utf8)
    let (data, response) = try await URLSession.shared.data(for: request)
    try Self.validate(response: response, data: data, tokenEndpoint: true)
    return try JSONDecoder().decode(TokenResponse.self, from: data)
  }

  private func get<T: Decodable>(_ value: String, token: String) async throws -> T {
    guard let url = URL(string: value) else { throw GoogleCalendarError.invalidResponse }
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let (data, response) = try await URLSession.shared.data(for: request)
    try Self.validate(response: response, data: data)
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func apply(_ token: TokenResponse) {
    accessToken = token.accessToken
    accessTokenExpiry = Date().addingTimeInterval(TimeInterval(token.expiresIn ?? 3600))
  }

  private static func snapshot(event: GoogleEvent, calendar: GoogleCalendar) -> CalendarEventSnapshot? {
    guard event.status != "cancelled", let start = event.start?.resolvedDate, let end = event.end?.resolvedDate else { return nil }
    let originalStart = event.originalStartTime?.resolvedDate ?? start
    let series = event.recurringEventId.map {
      CalendarSeriesIdentity(
        provider: "google",
        externalIdentifier: $0,
        disambiguator: calendar.id,
        crossProviderIdentifier: event.iCalUID
      )
    }
    return CalendarEventSnapshot(
      identity: CalendarEventIdentity(
        provider: "google",
        externalIdentifier: event.id,
        occurrenceStart: originalStart,
        disambiguator: calendar.id,
        series: series
      ),
      title: event.summary?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "Untitled event",
      startDate: start,
      endDate: end,
      isAllDay: event.start?.date != nil,
      location: event.location?.nonEmpty,
      notes: event.description?.nonEmpty,
      url: event.htmlLink.flatMap(URL.init(string:)),
      calendarTitle: calendar.summary,
      calendarColorHex: calendar.backgroundColor,
      isDetached: series != nil && abs(start.timeIntervalSince(originalStart)) > 1,
      attendees: event.attendees?.map { attendee in
        CalendarAttendeeIdentity(
          email: attendee.email,
          displayName: attendee.displayName,
          role: attendee.organizer == true ? "organizer" : "attendee",
          responseStatus: attendee.responseStatus ?? "unknown",
          isCurrentUser: attendee.selfIdentity == true,
          sourceIdentifier: attendee.id
        )
      },
      organizer: event.organizer.map { organizer in
        CalendarAttendeeIdentity(
          email: organizer.email,
          displayName: organizer.displayName,
          role: "organizer",
          responseStatus: "accepted",
          isCurrentUser: organizer.selfIdentity == true,
          sourceIdentifier: organizer.id
        )
      },
      iCalendarUID: event.iCalUID,
      originalStartDate: originalStart,
      timeZoneIdentifier: event.start?.timeZone ?? event.originalStartTime?.timeZone ?? TimeZone.current.identifier,
      // A moved all-day recurring occurrence keeps its original civil day for
      // stable materialized-Event identity, just as timed occurrences keep
      // `originalStartTime.dateTime` above.
      originalStartCivilDay: (event.originalStartTime?.date ?? event.start?.date)
        .map(DayKey.init(rawValue:))
    )
  }

  private static func validate(
    response: URLResponse,
    data: Data,
    tokenEndpoint: Bool = false
  ) throws {
    guard let http = response as? HTTPURLResponse else { throw GoogleCalendarError.invalidResponse }
    guard (200..<300).contains(http.statusCode) else {
      throw classifyHTTPFailure(statusCode: http.statusCode, data: data, tokenEndpoint: tokenEndpoint)
    }
  }

  /// Internal for focused, no-network classification tests. The error body is
  /// never logged; callers receive only the stable category/message.
  static func classifyHTTPFailure(
    statusCode: Int,
    data: Data,
    tokenEndpoint: Bool
  ) -> GoogleCalendarError {
    let oauth = try? JSONDecoder().decode(GoogleOAuthError.self, from: data)
    let calendar = try? JSONDecoder().decode(GoogleAPIError.self, from: data)
    let message = oauth?.errorDescription
      ?? calendar?.error.message
      ?? HTTPURLResponse.localizedString(forStatusCode: statusCode)
    if statusCode == 401
      || (tokenEndpoint && statusCode == 400 && oauth?.error == "invalid_grant")
    {
      return .authorizationRevoked
    }
    return .api(message)
  }

  fileprivate static let rfc3339: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
  }()

  private static func base64URL(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  private static func formEncode(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
  }
}

private struct TokenResponse: Decodable {
  var accessToken: String
  var expiresIn: Int?
  var refreshToken: String?
  enum CodingKeys: String, CodingKey {
    case accessToken = "access_token", expiresIn = "expires_in", refreshToken = "refresh_token"
  }
}

private struct CalendarList: Decodable { var items: [GoogleCalendar]?; var nextPageToken: String? }
private struct GoogleCalendar: Decodable {
  var id: String
  var summary: String
  var selected: Bool?
  var backgroundColor: String?
}
private struct EventsList: Decodable { var items: [GoogleEvent]?; var nextPageToken: String? }
private struct GoogleEvent: Decodable {
  var id: String
  var status: String?
  var summary: String?
  var description: String?
  var location: String?
  var htmlLink: String?
  var recurringEventId: String?
  var iCalUID: String?
  var originalStartTime: GoogleEventDate?
  var start: GoogleEventDate?
  var end: GoogleEventDate?
  var attendees: [GoogleAttendee]?
  var organizer: GoogleAttendee?
}
private struct GoogleAttendee: Decodable {
  var id: String?
  var email: String?
  var displayName: String?
  var responseStatus: String?
  var organizer: Bool?
  var selfIdentity: Bool?

  enum CodingKeys: String, CodingKey {
    case id, email, displayName, responseStatus, organizer
    case selfIdentity = "self"
  }
}
private struct GoogleEventDate: Decodable {
  var date: String?
  var dateTime: String?
  var timeZone: String?
  var resolvedDate: Date? {
    if let dateTime { return ISO8601DateFormatter().date(from: dateTime) }
    guard let date else { return nil }
    return Calendar(identifier: .gregorian).date(from: DateComponents(
      year: Int(date.prefix(4)), month: Int(date.dropFirst(5).prefix(2)), day: Int(date.dropFirst(8).prefix(2))
    ))
  }
}
private struct GoogleAPIError: Decodable {
  struct Body: Decodable { var message: String }
  var error: Body
}
private struct GoogleOAuthError: Decodable {
  var error: String
  var errorDescription: String?

  enum CodingKeys: String, CodingKey {
    case error
    case errorDescription = "error_description"
  }
}

private enum Keychain {
  static let service = "dev.rawkode.enchiridion.google-calendar"

  static func store(refreshToken: String, clientID: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: clientID,
    ]
    SecItemDelete(query as CFDictionary)
    var insert = query
    insert[kSecValueData as String] = Data(refreshToken.utf8)
    insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(insert as CFDictionary, nil)
    guard status == errSecSuccess else { throw GoogleCalendarError.api("Keychain error \(status)") }
  }

  static func refreshToken(clientID: String) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: clientID,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }
}

private extension String {
  var nonEmpty: String? {
    let value = trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }
}
