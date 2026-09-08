# Dev-auth identity scheme + the `ctx.abort()` revocation caveat

Status: Phase 4 prerequisite work, complete. Resolves two open questions blocking the
`SharingManager` port (plan §"Agent-native editing & gatekeeper integrations", "Sharing/observers"
paragraph, and the "Caveat on `ctx.abort()` reuse" finding under "Top risks, explicitly flagged").
Real, working code and tests — not a design memo.

## 1. Minimal real dev-auth / identity scheme

**Files:** `packages/domain/src/auth.ts` (identity types, `CurrentUser` auth-context tag,
`Unauthorized` error wiring), `packages/backend/src/dev-auth.ts` (real HMAC-SHA-256 sign/verify),
`packages/backend/src/user-durable-object.ts` (real `UserDurableObject`, `idFromName(email)`),
`packages/backend/src/index.ts` (`POST /api/dev/sign-in`), `packages/backend/src/workspace-durable-object.ts`
(auth parsing in `fetch()`, `whoami()` RPC proof). **Tests:** `packages/backend/test/dev-auth.test.ts`
(13 tests, all real: real HMAC, real HTTP round trip, real `UserDurableObject` storage, real Cap'n
Web `whoami` call).

### Identity model

Cited directly from cloudflare-os's `workshop-backend/src/user.ts`/`src/auth/login-flow.ts`: the
sole account key is a provider-verified-or-claimed email, and the account's `UserDurableObject` is
addressed via `idFromName(email)` — every one of cloudflare-os's own sign-in paths
(`server.ts#authenticate`/`#authenticateFromCfAccess`/`#login`, `login-flow.ts`'s
`LoginConnectCallbackImpl#complete`) does the identical `this.users.idFromName(email)` lookup, and
`UserDurableObject`'s own doc comment there states it explicitly: *"the user DO is keyed by the
verified email (this DO's id derives from `idFromName(email)`)... `email` is also used as the
profile id."* Athenaeum's `UserDurableObject` follows this exactly, and self-verifies its own
identity the same way `WorkspaceDurableObject` already does for `workspaceId` (`ctx.id.name` read back and
checked against every call's claimed email — defense in depth, not just convention).

### Credential shape — a deliberate departure from cloudflare-os, not an oversight

cloudflare-os's own session tokens (`user.ts#newSessionToken`) are opaque random bytes; verifying
one round-trips to the issuing `UserDurableObject` to check a stored hash. That is the right
choice for a system already built around per-account DOs holding session state. This task's brief
asked for something different: *"mint an HMAC-signed, scoped session credential... reuse the
crypto/HMAC discipline already established in this codebase."* cloudflare-os's own established
discipline is `sharing.ts#hashShareKey` (`crypto.subtle.importKey("raw", ..., {name:"HMAC",
hash:"SHA-256"}, false, [usage])`) — `dev-auth.ts` applies the same primitives to mint a
**stateless, self-verifying** token instead: `base64url({v,email,iat,exp}).base64url(HMAC
signature)`, checked with `crypto.subtle.verify` (a real constant-time HMAC comparison) and no
storage round trip at all. This matters concretely: a Bearer credential is checked on every single
`WorkspaceDurableObject` connection — a *different* DO than the issuing `UserDurableObject` — so a
storage-backed session scheme would make every workspace connection depend on a third DO's
reachability. Verified empirically fail-closed against every failure mode: wrong secret, tampered
payload, malformed string, and real (injectable-`now`) expiry — see `dev-auth.test.ts`'s five
"sign+verify" unit tests.

### Gating (HARD CONSTRAINT compliance)

`POST /api/dev/sign-in` is gated behind `env.DEV_AUTH_ENABLED === "true"` (literal string match,
mirroring the plan's own `AUTH_GATEKEEPERS`/`DISABLE_PASSWORD_AUTH` discipline) and requires
`env.DEV_AUTH_HMAC_SECRET` to be configured (fails closed with a 500, never a guessable default).
Both are `wrangler.jsonc` `vars` — loudly commented there as dev-only, checked-in, and explicitly
**not** how a real deployment would do this (leave `DEV_AUTH_ENABLED` unset once real OAuth
sign-in exists, or promote the secret to `wrangler secret put` for a reachable dev/staging
deployment). This is explicitly **not** OAuth, **not** a magic link — a directly-issued credential
for local testing, exactly as scoped.

### The auth-context shape for next stages

```ts
// domain/src/auth.ts
export class AuthenticatedUser extends Schema.Class<AuthenticatedUser>("AuthenticatedUser")({
  email: Email,
  issuedAt: IsoDateTimeString,
  expiresAt: IsoDateTimeString
}) {}

export class CurrentUser extends Context.Tag("@athenaeum/domain/CurrentUser")<
  CurrentUser,
  Option.Option<AuthenticatedUser>
>() {}

export const requireAuthenticatedUser: Effect.Effect<AuthenticatedUser, Unauthorized, CurrentUser>
```

- `WorkspaceRpcApi` (one instance per WebSocket connection / per HTTP-batch call — **not** per DO) captures
  the connection's parsed `AuthenticatedUser | undefined` once, at `fetch()`/WS-upgrade time.
- Any RPC method that needs the caller's identity provides it locally via
  `Effect.provideService(CurrentUser, Option.fromNullable(this.#currentUser))`, layered **on top
  of**, not baked into, the DO's shared construction-time `#runtime`/`ManagedRuntime` — because one
  `WorkspaceDurableObject` instance serves many concurrent connections, each potentially a different
  caller, while the `ManagedRuntime`'s `Layer` graph is built exactly once before any connection
  exists.
- A method that must reject anonymous/unauthenticated callers does `yield* requireAuthenticatedUser`
  (fails `Unauthorized`, already wired into `RpcErrorEnvelope`/`DomainError`); a method that's fine
  either way (like `whoami`) reads `CurrentUser` and pattern-matches the `Option`.
- **Reference implementation**: `WorkspaceRpcApi#whoami()` in `workspace-durable-object.ts` — the smallest
  real, tested proof this plumbing reaches an actual Cap'n Web call in both the anonymous and
  authenticated cases (`dev-auth.test.ts`'s "auth-context plumbing" suite, 3 tests).
- Credential transport: `Authorization: Bearer <credential>` header (works for HTTP batch and any
  client that can set headers) **or** a `?token=` query parameter, checked in that order
  (`dev-auth.ts#extractBearerCredential`) — the documented fallback for browser `WebSocket`
  upgrades, which cannot set custom headers at all. No credential present → fully anonymous,
  zero behavior change to any existing RPC method. A credential present but invalid/expired →
  the connection is rejected outright (401 before the WS upgrade completes), never silently
  downgraded to anonymous.

**Explicitly out of scope here** (per the task's Phase 4 boundary): no RPC method other than
`whoami` actually checks `CurrentUser` yet. Wiring real per-method authorization (a `SharingService`
built on this) is the next stage's work; this stage only builds and proves the mechanism it will
use.

## 2. The `ctx.abort()` revocation caveat — resolved for real

**Files:** `packages/backend/src/workspace-durable-object.ts` (`#activeSockets`, `evictSessions()`,
`fetch()`'s WebSocket-pair tracking). **Tests:** `packages/backend/test/revocation-eviction.test.ts`
(3 tests, all passing, all against real Automerge sync sessions over real Cap'n Web RPC).

### What the plan's caveat asked to verify

> cloudflare-os's revocation-triggered `ctx.abort()` is validated against Yjs sessions, which
> resync cheaply and statelessly from the update log on reconnect. This plan's Automerge sync
> sessions carry more state... A forced mid-sync `ctx.abort()` during revocation could plausibly
> land a client in that ambiguous-timeout branch and force a full Automerge resync.

### Confirmed real, not hypothetical

`notes-service-live.ts`'s sync-session state (`sessions`, a `Map<sessionKey, {syncState,
expectedOrdinal}>`) is a plain in-memory closure inside `makeNotesServiceLive` — never persisted
to `ctx.storage`. `revocation-eviction.test.ts`'s first suite proves the consequence empirically:
establish a real Automerge session (full sync handshake + a live probe round trip, `reset: false`),
force a real Miniflare-level ungraceful DO reset (`abortAllDurableObjects()` — the same primitive
`do-recovery.test.ts` already uses as "the closest available proxy for a hard kill," reproducing
exactly what `ctx.abort()` does to in-memory state), reconnect, and continue the *same* session id
at the *same* next ordinal: **`reset: true`**, confirmed. The caveat is real, not a hand-waved risk.

### Decision: build a gentler drain, and it fully resolves the caveat for this app's shape

`evictSessions(opts: {email?, reason})` (`workspace-durable-object.ts`), reached only via native
`ctx.exports` RPC (deliberately never exposed on `WorkspaceRpcApi`/Cap'n Web — no connected client can
evict another connection itself; only a trusted same-Worker caller, e.g. a future
`SharingService.removeCollaborator`, may call it — exactly where cloudflare-os calls
`scheduleRevocationRestart` today):

```ts
async evictSessions(opts: { readonly email?: string; readonly reason: string }): Promise<{ evictedCount: number }> {
  let evictedCount = 0
  for (const [socket, user] of this.#activeSockets) {
    if (opts.email !== undefined && user?.email !== opts.email) continue
    try { socket.close(4001, opts.reason) } catch { /* already closing */ }
    this.#activeSockets.delete(socket)
    evictedCount++
  }
  return { evictedCount }
}
```

`#activeSockets: Map<WebSocket, AuthenticatedUser | undefined>` is populated in a hand-rolled
`fetch()` WebSocket branch (`new WebSocketPair()`, `server.accept()`, track, `newWebSocketRpcSession`)
instead of the one-line `newWorkersRpcResponse` convenience wrapper — the only way to keep a
reference to the raw server-side socket for later targeted closure. **This deliberately does not
call `ctx.abort()` at all.** Closing only the matching raw socket(s) leaves the DO instance — and
thus `NotesService`'s `docCache`/`sessions` — completely untouched.

`revocation-eviction.test.ts`'s second suite proves all three resulting properties empirically,
against two real, independent, concurrently-live Automerge sessions (owner + collaborator, real
dev-auth identities, real `devSignIn` round trip each):

1. **Targeted**: `evictSessions({email: collabEmail, ...})` closes exactly one socket
   (`evictedCount: 1`), confirmed via the collaborator's raw `WebSocket.readyState` transitioning
   to `CLOSED` while the owner's stays `OPEN`.
2. **Bystanders unaffected**: the owner's own, completely independent session continues afterward
   with `reset: false` — no forced resync, in direct contrast to part 1's whole-DO reset.
3. **Cheap reconnect even for the evicted party**: the collaborator reconnects (their dev
   credential was never revoked — `evictSessions` only closed the transport, modeling a downgrade
   rather than a full removal) and resumes their *exact* prior session id/ordinal with
   `reset: false` — because the DO's in-memory session state for that session was never destroyed,
   only the transport that carried it was.

A third test confirms the coarse `evictSessions({reason})` (no `email`) case evicts every live
session — the "evict everyone" fallback a future full workspace deletion/lockdown could use.

### The concrete revocation-eviction mechanism for next stages

A future `SharingService.removeCollaborator`/`revokeShareLink` (the actual `SharingManager` port,
per `docs/sharing.md`'s "Terminating live sessions on revocation" section) should call
`evictSessions({email: <removed collaborator's email>, reason: "access revoked"})` — via
`ctx.exports.WorkspaceDurableObject.getByName(workspaceId).evictSessions(...)`, from within the same Worker
— in place of cloudflare-os's `scheduleRevocationRestart`/`ctx.abort()`. No `ctx.storage.sync()`
flush precaution is needed the way cloudflare-os's version requires (nothing about the severed
permission edge is DO-instance-local in-memory state the way `ctx.abort()`'s target was — the
edge itself lives in `collaborators`/`shareKeys` `ctx.storage`, already durable by the time
`evictSessions` is called). The ~100ms pre-abort delay cloudflare-os uses (letting the triggering
RPC's own response reach the caller before their connection drops) is also unnecessary here: unlike
`ctx.abort()`, `evictSessions` never touches the caller's own connection unless the caller is
themselves being evicted.

## What's explicitly not built here (deliberately, per Phase 4 scope)

- No `collaborators`/`shareKeys` storage collections, no `SharingManager` fixed-point permission
  graph, no `addCollaborator`/`removeCollaborator`/share-link RPCs. This stage only builds and
  proves the two prerequisites those will depend on.
- No observer verification logic (Phase 5, after a gatekeeper exists to leak).
- No per-method authorization enforcement on the existing 30-ish RPC methods — `CurrentUser` is
  real and reachable (`whoami` proves it), but nothing besides `whoami` reads it yet.
- The Swift `AthenaeumDomain` mirror was not updated with `AuthenticatedUser`/`Email`/etc. — an
  accepted manual-sync gap per the plan's own risk #7, same as every other domain addition to date.
