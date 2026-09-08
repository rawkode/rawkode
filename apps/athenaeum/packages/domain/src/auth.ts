import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { IsoDateTimeString } from "./node.js"
import { Unauthorized } from "./errors.js"

// Phase 4 prerequisite stage ("Minimal real dev-auth / identity scheme" — resolved ahead of the
// full `SharingManager` port, per the plan's "Sharing/observers" paragraph and cloudflare-os's
// `docs/sharing.md`, which this stage's sibling package additions build toward). Full production
// sign-in (the plan's `docs/oauth-signin.md`-inspired "gatekeeper-as-auth" pattern, risk #6) is
// explicitly out of scope here — no real OAuth provider is available in this environment, and
// wiring one is its own future stage. What sharing genuinely needs *now* to be buildable and
// testable is: distinct, real user identities (an owner and at least one real collaborator), a
// real (not fabricated) way to authenticate as one locally, and a concrete shape every future RPC
// method can use to learn "who is calling." This file is the domain-only half of that: the
// identity types, the Cap'n Web-throw-boundary error, and the `Context.Tag` auth-context shape.
// The actual credential minting/verification (real HMAC-SHA-256, `crypto.subtle`) lives in
// `backend/src/dev-auth.ts` — deliberately not here, for the same reason `ModelClient`'s real
// implementations live in `backend` and not `domain` (see model-client.ts's own doc comment):
// this package stays zero-Cloudflare/zero-crypto-backend-dependent, interface only.
//
// **Identity model** (cites cloudflare-os's own precedent directly, per this stage's brief):
// cloudflare-os's `workshop-backend/src/user.ts`/`src/auth/login-flow.ts` key every
// `UserDurableObject` by `idFromName(email)` — "the user DO is keyed by email... `email` is also
// used as the profile id" (`user.ts`'s own `loginOrCreateViaGatekeeper` doc comment) — and reach
// it the same way from every sign-in path (`login-flow.ts`: `this.ctx.exports.UserDurableObject
// .idFromName(email)`, `server.ts`'s `authenticate`/`authenticateFromCfAccess`/`login`, all doing
// the identical `this.users.idFromName(...)` lookup). Athenaeum's `UserDurableObject`
// (`backend/src/user-durable-object.ts`) follows this exactly: the sole account key is a
// provider-verified-or-claimed email, addressed via `idFromName(email)`, real for the dev-auth
// path this stage builds (not a stub).
//
// **Credential shape — a deliberate departure from cloudflare-os's own scheme, not an oversight.**
// cloudflare-os's session tokens (`user.ts#newSessionToken`) are opaque random bytes; validating
// one (`server.ts#authenticate`) round-trips to the specific `UserDurableObject` to check a
// stored hash. That's the right choice for a system already built around per-account DOs holding
// session state. This task's brief explicitly asks for something narrower and self-contained: "an
// HMAC-signed, scoped session credential... reuse the crypto/HMAC discipline already established
// in this codebase" — cloudflare-os's `sharing.ts#hashShareKey` is that established discipline
// (`crypto.subtle.importKey("raw", ..., {name:"HMAC", hash:"SHA-256"}, false, ["sign"])` plus
// `crypto.subtle.sign`/`crypto.subtle.verify`, with a fixed domain-separation key). Athenaeum's
// dev credential applies the same primitives to a *stateless*, self-verifying token instead of an
// opaque+stored one: `base64url(JSON payload).base64url(HMAC signature)`, verified with no
// storage round trip at all — appropriate for a Bearer credential that must be checked on every
// `WorkspaceDurableObject` connection (a different DO than the issuing `UserDurableObject`), where a
// storage round trip per connection would mean every workspace fetch depends on network reachability
// to a *third* DO. See `dev-auth.ts` for the real implementation.

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A lower-cased, syntactically-plausible email address — the sole account key (see this file's
 *  header comment). Format-only validation; normalization (trimming/lower-casing) is the caller's
 *  job before this schema ever sees the value (`backend`'s dev sign-in route does this once, at
 *  the one place a raw string first becomes an `Email`), matching `EntityId`'s own
 *  validate-don't-normalize convention in node.ts. */
export const Email = Schema.String.pipe(
  Schema.filter((value) => emailPattern.test(value) && value === value.toLowerCase(), {
    message: () => "Email must be a lower-cased, valid-looking email address"
  }),
  Schema.brand("Email")
)
export type Email = typeof Email.Type

/**
 * A verified caller identity, valid for `[issuedAt, expiresAt)`. Intentionally minimal — just
 * enough for `WorkspaceDurableObject` to know "who is this connection" and for a future
 * `SharingService` (the `collaborators`/`shareKeys` schema surface this stage deliberately only
 * notes, per the task's Phase 4 scope boundary — "no observers yet... note the schema surface it
 * attaches to later") to key its permission graph on `email`, exactly as cloudflare-os's own
 * `SharingCaller.profileId` does (`sharing.ts`: "the caller's `profile.id` (username/email)").
 */
export class AuthenticatedUser extends Schema.Class<AuthenticatedUser>("AuthenticatedUser")({
  email: Email,
  issuedAt: IsoDateTimeString,
  expiresAt: IsoDateTimeString
}) {}

/**
 * The auth-context shape every future RPC method builds against: an `Option` (not the bare
 * value) because a connection may be genuinely anonymous — today's Phase 0-3 RPC surface stays
 * fully open (no Bearer credential sent, no behavior change), and even once sharing lands, some
 * calls may legitimately be unauthenticated (e.g. redeeming a share link is presumptively how an
 * *unrecognized* caller becomes recognized). Provided **per RPC call, per connection**
 * (`WorkspaceRpcApi`'s constructor captures the connection's parsed identity once, at `fetch()`/WS
 * upgrade time — see `workspace-durable-object.ts`'s doc comment on why this cannot live in the DO's
 * shared, construction-time `ManagedRuntime`: one DO instance serves many concurrent connections,
 * each potentially a different caller), via `Effect.provideService(CurrentUser, ...)` layered on
 * top of the shared runtime — never baked into the base `Layer` the way `NodesRepository` etc.
 * are. `whoami()` (`workspace-durable-object.ts`) is the reference implementation of this pattern; a
 * future `SharingService` method that must reject anonymous/insufficiently-privileged callers
 * uses the same per-call `Effect.provideService` plus `requireAuthenticatedUser` below.
 */
export class CurrentUser extends Context.Tag("@athenaeum/domain/CurrentUser")<
  CurrentUser,
  Option.Option<AuthenticatedUser>
>() {}

/** Fails closed with `Unauthorized` if the current connection has no verified identity —
 *  the one helper every future auth-gated RPC method (or `SharingService` operation) needs,
 *  so "require a real caller" is a one-line `yield*` rather than re-deriving the
 *  `Option.match` at each call site. */
export const requireAuthenticatedUser: Effect.Effect<AuthenticatedUser, Unauthorized, CurrentUser> =
  CurrentUser.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Unauthorized({ message: "Authentication required." })),
        onSome: (user) => Effect.succeed(user)
      })
    )
  )

// --- Dev sign-in wire schemas -----------------------------------------------------------------
//
// Plain HTTP (`POST /api/dev/sign-in`), not a Cap'n Web RPC method — deliberately: sign-in
// happens *before* any `WorkspaceDurableObject`/Cap'n Web session exists (there is nothing to call an
// RPC method "on" yet), exactly the same reason cloudflare-os's own login flow is a bespoke HTTP
// exchange (`PublicApi.authenticate`) rather than a method on the thing it's authenticating into.
// Still schema-validated with the same `effect/Schema` discipline as every Cap'n Web wire type in
// this package — `backend`'s route decodes/encodes through these directly.

export class DevSignInInput extends Schema.Class<DevSignInInput>("DevSignInInput")({
  email: Email
}) {}

export class DevSignInOutput extends Schema.Class<DevSignInOutput>("DevSignInOutput")({
  credential: Schema.String,
  email: Email,
  issuedAt: IsoDateTimeString,
  expiresAt: IsoDateTimeString
}) {}

/** `WorkspaceRpcApi.whoami()`'s wire output — the smallest possible proof that the per-connection
 *  `CurrentUser` plumbing above actually reaches a real Cap'n Web RPC call. */
export class WhoamiOutput extends Schema.Class<WhoamiOutput>("WhoamiOutput")({
  authenticated: Schema.Boolean,
  email: Schema.optional(Email)
}) {}
