import * as Schema from "effect/Schema"

// Phase 5 domain-extension task, item 4: "Observer/verifier schemas per Decisions stage's design:
// an opaque GatekeeperUserVerifier wire token, verification-strategy result types." Scoped
// exactly to what the task asks for — NOT the full cloudflare-os
// `GatekeeperVendor`/`GatekeeperUser`/`Gatekeeper<Session>` three-tier RPC contract the plan's
// "Agent-native editing & gatekeeper integrations" paragraph names as `domain`'s eventual
// `gatekeeper.ts` target shape ("reuse the interface contracts... as the target shape for
// domain's own gatekeeper.ts"). That full three-tier contract is deliberately NOT built here:
// Athenaeum has exactly one gatekeeper today (`gatekeeper-google-calendar`), so generalizing a
// cross-vendor interface contract now would be speculative — cloudflare-os's own three-tier shape
// earned its generality from coordinating many real vendors' gatekeepers behind one `Overseer`;
// Athenaeum's router forwards to one gatekeeper Worker per binding directly (plan §"Repo/package
// layout": "one Worker per gatekeeper... wired to the router via a service binding"), with no
// Overseer-equivalent that would consume a shared three-tier contract yet. This file is this
// stage's honest, narrower slice: the two wire shapes a real cross-Worker observer-verification
// call will need regardless of how many gatekeepers eventually exist.
//
// **`GatekeeperUserVerifier`** — the cross-cutting, vendor-agnostic wire envelope. The
// package-local `GatekeeperUserVerifier` the Decisions pre-work stage already built
// (`gatekeeper-google-calendar/src/observer-verifier.ts`) is deliberately package-local (that
// file's own header comment: "since THIS gatekeeper Worker will be the sole owner of... minting
// naturally becomes something THIS gatekeeper does"). This domain-level type is the SAME opaque
// token shape, exported from the one package every future gatekeeper and `backend`'s own
// `SharingService`/observer-tracking code both already depend on, so a real cross-Worker
// `addObserver(observerId, verifier)` RPC call (docs/gatekeeper-google-calendar-decisions.md §2's
// own "next stage builds against" list: "a real, callable addObserver... RPC surface") has one
// shared wire type to decode/encode on both sides of the service-binding boundary, instead of
// each gatekeeper package inventing its own. Per that same decisions doc: "the SAME opaque token
// becomes the payload a real Fetcher<GatekeeperUserVerifier> stub carries across THAT
// boundary — the token format does not need to change, only its transport" — this class is that
// eventual transport-level shape, decoupled from any one gatekeeper package's own internal
// minting/unwrapping logic (which stays exactly where it is, package-local, since the HMAC secret
// it signs with must never be readable outside the minting Worker).
export class GatekeeperUserVerifier extends Schema.Class<GatekeeperUserVerifier>(
  "GatekeeperUserVerifier"
)({
  token: Schema.String
}) {}

/**
 * Which per-resource observer-verification strategy governed a check, per `docs/observers.md`
 * §9.1's decision table (read in full for the Decisions pre-work stage): **A** private-only
 * (always deny), **B** single-ACL-unit check, **C** dataset-tracking (re-verify per touched
 * sub-resource), **D** low-stakes (always allow). Athenaeum's only gatekeeper today (Google
 * Calendar) uses B (a `"selected"`-mode binding) and C (an `"allVisible"`-mode binding) — see
 * `GoogleCalendarBindingConfig.mode` (gatekeeper-binding.ts) and the Decisions stage's
 * `observer-verification.ts` for the real, tested implementations of both. Declared as the full
 * four-member set (not narrowed to `"B" | "C"`) for the same "architect for the full feature
 * vision now" reason `chat-binding.ts`'s `ChatBindingTarget` declares its currently-unused
 * `"gatekeeperBinding"` variant — a future low-stakes or private-only gatekeeper slots into an
 * already-shaped literal instead of widening it later. Carried on the result below purely for
 * observability (a denial the workspace surfaces to a user can say *which* kind of check failed) —
 * never branched on by workspace-side code, since strategy selection is entirely each gatekeeper's own
 * internal concern, exactly as `docs/observers.md` describes it ("Strategy is chosen per resource
 * type... not per gatekeeper package").
 */
export const ObserverVerificationStrategy = Schema.Literal("A", "B", "C", "D")
export type ObserverVerificationStrategy = typeof ObserverVerificationStrategy.Type

/** An observer was verified: the calling gatekeeper's `addObserver()` succeeded (per
 *  `docs/observers.md` §7's contract: "addObserver(observerId, verifier) MUST throw if the user
 *  represented by verifier is not allowed to observe everything read through this gatekeeper so
 *  far"). This `Granted`/`Denied` union exists because a real cross-Worker RPC call needs a
 *  TYPED result to relay back to the workspace/sharing layer (which must render a denial reason to a
 *  user, per `ensureObserver`'s own UX contract in `docs/observers.md` §3/§5), not merely a thrown
 *  exception — the union is the wire-level materialization of that same throw/succeed contract. */
export class ObserverVerificationGranted extends Schema.Class<ObserverVerificationGranted>(
  "ObserverVerificationGranted"
)({
  outcome: Schema.Literal("granted"),
  strategy: ObserverVerificationStrategy
}) {}

/** An observer failed verification — the calling gatekeeper's `addObserver()` (or, for Strategy C,
 *  a later `onDatasetTouched` re-verification sweep) determined this observer cannot independently
 *  see everything the binding has read. `message` is the human-readable reason (mirrors
 *  `ObserverVerificationFailed`'s own `message` field, errors.ts) — deliberately present on the
 *  wire result, not just the thrown-error path, so a UI can render it without a second round trip
 *  through the RPC error envelope. */
export class ObserverVerificationDenied extends Schema.Class<ObserverVerificationDenied>(
  "ObserverVerificationDenied"
)({
  outcome: Schema.Literal("denied"),
  strategy: ObserverVerificationStrategy,
  message: Schema.String
}) {}

/** The workspace-facing result of asking a gatekeeper binding to verify one observer — the typed
 *  counterpart to `docs/observers.md` §7's `addObserver()` throw contract (see
 *  `ObserverVerificationDenied`'s own doc comment for why a typed result exists alongside the
 *  thrown-error path this package already has via `ObserverVerificationFailed`, errors.ts). */
export const ObserverVerificationResult = Schema.Union(
  ObserverVerificationGranted,
  ObserverVerificationDenied
)
export type ObserverVerificationResult = typeof ObserverVerificationResult.Type
