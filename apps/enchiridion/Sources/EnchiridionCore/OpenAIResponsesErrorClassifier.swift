import Foundation

enum OpenAIResponsesAssistantError: Error, Equatable {
  case authorization(OpenAITextAuthorizationFailure)
  case credentialBinding
  case authorizationRejected
  case accessDenied
  case rateLimited(retryAfterSeconds: Int?)
  case billingRequired
  case serviceUnavailable
  case networkUnavailable
  case invalidResponse
  case incomplete
  case failed
  case tooManyToolCalls
}

enum OpenAIResponsesErrorClassifier {
  static let billingOrLimitCodes: Set<String> = [
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "insufficient_quota",
  ]

  static func failure(for result: OpenAIResponsesTransportResult) -> OpenAIResponsesAssistantError?
  {
    guard !(200..<300).contains(result.statusCode) else { return nil }
    if let code = result.errorCode, billingOrLimitCodes.contains(code) {
      return .billingRequired
    }
    switch result.statusCode {
    case 401:
      return .authorizationRejected
    case 403:
      return .accessDenied
    case 429 where result.errorCode == "rate_limit_exceeded":
      return .rateLimited(retryAfterSeconds: result.retryAfterSeconds)
    case 429:
      return .rateLimited(retryAfterSeconds: nil)
    case 500...599:
      return .serviceUnavailable
    default:
      return .invalidResponse
    }
  }
}
