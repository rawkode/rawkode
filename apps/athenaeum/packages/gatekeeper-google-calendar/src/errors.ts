// `GoogleCalendarClient`'s closed failure channel — same design discipline as
// `@athenaeum/domain`'s `ModelError` (model-client.ts): one variant per place a real provider
// call can fail, shared by both the `Real` and `Scripted` Layer, so calling code (and tests) never
// need to special-case which implementation is running.

import * as Data from "effect/Data"

/** No OAuth client id/secret is configured (`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` env bindings unset)
 *  — the hard-constraint case this package exists to handle cleanly, exactly mirroring
 *  `ModelUnavailable`'s role for `ModelClientAnthropic`. Every `GoogleCalendarClientReal` method
 *  that needs a credential fails with this BEFORE attempting any network I/O. */
export class GoogleCalendarNotConfigured extends Data.TaggedError("GoogleCalendarNotConfigured")<{
  readonly message: string
}> {}

/** An outbound call to Google was attempted and failed before/without producing a usable
 *  response: network failure, timeout, or a non-2xx HTTP status NOT covered by a more specific
 *  variant below. */
export class GoogleCalendarRequestFailed extends Data.TaggedError("GoogleCalendarRequestFailed")<{
  readonly message: string
  readonly status?: number
}> {}

/** A response was received but could not be decoded into the expected shape — malformed JSON, a
 *  missing required field, an event with neither `date` nor `dateTime` on `start`/`end`, etc. */
export class GoogleCalendarResponseInvalid extends Data.TaggedError("GoogleCalendarResponseInvalid")<{
  readonly message: string
}> {}

/**
 * The OAuth token endpoint rejected a code/refresh-token exchange with a recognized `error` value
 * (verified against Google's docs this stage): `invalid_grant` (the code/refresh token is
 * expired, revoked, already used, or malformed — the ONLY reason that means "the user must
 * re-consent", per `google.ts`'s own `RefreshFailure.reason: "revoked"` precedent this mirrors)
 * or `admin_policy_enforced`/other (a Workspace admin has restricted a scope; re-authenticating
 * will not fix it). Kept distinct from `GoogleCalendarRequestFailed` because a caller needs to
 * tell "ask the user to reconnect" apart from "retry later" / "this is a bug".
 */
export class GoogleCalendarAuthFailed extends Data.TaggedError("GoogleCalendarAuthFailed")<{
  readonly reason: "invalidGrant" | "policyBlocked" | "other"
  readonly message: string
}> {}

/**
 * `events.list`'s `syncToken` has expired (Google's documented 410 Gone response — verified this
 * stage: "If the syncToken expires, the server will respond with a 410 GONE response code and the
 * client should clear its storage and perform a full synchronization without any syncToken").
 * Deliberately its own tag (not folded into `GoogleCalendarRequestFailed`'s generic
 * non-2xx-status case) — new-notes' cited pattern treats this as a distinct, expected, recoverable
 * outcome with its own remediation ("installs a fresh one-month-past/six-month-future window, and
 * retries once"), not a generic failure a caller should log-and-give-up on.
 */
export class GoogleCalendarSyncTokenExpired extends Data.TaggedError("GoogleCalendarSyncTokenExpired")<{
  readonly calendarId: string
}> {}

export type GoogleCalendarClientError =
  | GoogleCalendarNotConfigured
  | GoogleCalendarRequestFailed
  | GoogleCalendarResponseInvalid
  | GoogleCalendarAuthFailed
  | GoogleCalendarSyncTokenExpired

// --- Account-service errors (this stage's addition) --------------------------------------------
//
// `GatekeeperAccountService` (gatekeeper-account-service-live.ts) is the "GatekeeperUser"
// adaptation this stage builds — see that file's own header comment for the full design. Its own
// closed failure channel, same discipline as `GoogleCalendarClientError` above.

/** No account has ever completed the OAuth flow for this `GatekeeperAccountDurableObject`
 *  instance (no `connect()` call has ever succeeded, or `disconnect()` was called and nothing
 *  reconnected since) — the account-service-level analog of `GoogleCalendarNotConfigured`
 *  (missing CLIENT credentials) for the missing ACCOUNT-level connection instead. */
export class GatekeeperAccountNotConnected extends Data.TaggedError("GatekeeperAccountNotConnected")<{
  readonly message: string
}> {}

export type GatekeeperAccountServiceError =
  | GoogleCalendarClientError
  | GatekeeperAccountNotConnected
  | ObserverVerificationFailed
  | VerifierUnwrapFailed

// --- Observer verification (Strategy B/C) errors ----------------------------------------------
//
// Named directly after the plan's own deferred-error list ("ObserverVerificationFailed" —
// `@athenaeum/domain/errors.ts`'s Phase 0 header comment names it verbatim as one of the errors
// deferred every phase since; this package's own local variant below is the real thing for THIS
// gatekeeper, per this stage's scope — see docs/gatekeeper-google-calendar-decisions.md §2 for why
// it is not (yet) folded into `@athenaeum/domain`'s `DomainError` union: that union is the
// Cap'n Web RPC throw-boundary envelope for `WorkspaceDurableObject`'s OWN RPC methods, and this
// gatekeeper is a separate Worker with no RPC methods on that boundary yet — see this file's
// header comment on `GoogleCalendarClientError` for the same "own closed channel" reasoning).

/** The observer's own connected Google account does not have sufficient access to satisfy this
 *  binding's observer-verification strategy — Strategy B: below `writer`; Strategy C: cannot read
 *  free/busy for one or more calendars this binding has actually touched. */
export class ObserverVerificationFailed extends Data.TaggedError("ObserverVerificationFailed")<{
  readonly observerId: string
  readonly message: string
}> {}

/** The opaque `GatekeeperUserVerifier` token failed to unwrap — malformed, wrong HMAC signature,
 *  or (deliberately, per `observer-verifier.ts`'s own doc comment) minted for a different
 *  binding/workspace than the one `addObserver` was called for. Distinct from
 *  `ObserverVerificationFailed`: this is "the credential itself is not trustworthy", not "the
 *  credential is trustworthy but the access it proves isn't enough". */
export class VerifierUnwrapFailed extends Data.TaggedError("VerifierUnwrapFailed")<{
  readonly message: string
}> {}

export type ObserverVerificationError = ObserverVerificationFailed | VerifierUnwrapFailed
