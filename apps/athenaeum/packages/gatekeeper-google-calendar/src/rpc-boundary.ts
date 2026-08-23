// This package's own `{tag, message}` thrown-error envelope — the same wire discipline
// `@athenaeum/backend`'s `rpc-boundary.ts` establishes for `WorkspaceDurableObject`'s Cap'n Web
// surface, reused here for this package's own (much smaller) closed error unions
// (`GatekeeperAccountServiceError`) instead of `@athenaeum/domain`'s `DomainError`/
// `encodeRpcError` — this package's errors are its own, package-local channel (`errors.ts`'s own
// header comment on `GoogleCalendarClientError` explains why they are not folded into
// `DomainError`).
//
// **Why this crosses `GatekeeperAccountDurableObject`'s own boundary as a plain thrown `Error`,
// not a Cap'n Web throw**: this package's DO methods are reached two ways, NEITHER of which is a
// Cap'n Web session — (1) same-Worker `ctx.exports` native RPC (`worker.ts` calling into
// `GatekeeperAccountDurableObject` directly, and one account DO calling another's
// `getAccessTokenForVerification` for observer verification), which already propagates a thrown
// value structurally without needing a wire encoding of its own; (2) `athenaeum-backend`'s own
// `CalendarGatekeeperClient` (backend/src) calling THIS Worker over a plain HTTP service-binding
// fetch — see that file's header comment for why that hop is deliberately plain JSON-over-fetch,
// not a second Cap'n Web session, a documented simplification of the plan's literal "own Worker
// package... Effect + capnweb" scaffold description: capnweb's object-capability machinery
// (live stubs, promise pipelining, `Symbol.dispose`) has no use case on either of this file's two
// actual call boundaries, both of which are simple call/response, so this stage does not add an
// unused dependency merely to match the letter of the scaffold description. The `{tag, message}`
// envelope below is what actually carries typed-error information across BOTH of those real
// boundaries, exactly as `RpcErrorEnvelope` does for `WorkspaceDurableObject`'s Cap'n Web one.

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"

export interface ErrorEnvelope {
  readonly tag: string
  readonly message: string
}

const isTaggedError = (value: unknown): value is { readonly _tag: string; readonly message?: unknown } =>
  typeof value === "object" && value !== null && typeof (value as { _tag?: unknown })._tag === "string"

/** Flattens any `Cause` (a real `Fail`, or a `Die`/`Interrupt` a storage bug could produce) into
 *  the `{tag, message}` envelope — same defensive strengthening as `@athenaeum/backend`'s own
 *  `domainErrorFromCause` (never lets a defect cross the boundary as an opaque `FiberFailure`). */
export const errorEnvelopeFromCause = (cause: Cause.Cause<unknown>): ErrorEnvelope => {
  const failure = Cause.failureOption(cause)
  if (Option.isSome(failure) && isTaggedError(failure.value)) {
    return {
      tag: failure.value._tag,
      message: typeof failure.value.message === "string" ? failure.value.message : failure.value._tag
    }
  }
  return { tag: "UnexpectedError", message: Cause.pretty(cause) }
}

export const throwErrorEnvelope = (envelope: ErrorEnvelope): never => {
  throw new Error(JSON.stringify(envelope))
}

/** Attempts to parse a caught value (an HTTP error response body, or a thrown `Error#message`
 *  from a same-Worker `ctx.exports` call) back into an `ErrorEnvelope` — the receiving side's
 *  counterpart to `throwErrorEnvelope`. Falls back to a generic envelope rather than throwing
 *  itself, so a malformed/unexpected error never masks the real one with a decode failure. */
export const parseErrorEnvelope = (value: unknown): ErrorEnvelope => {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : undefined
  if (message !== undefined) {
    try {
      const parsed: unknown = JSON.parse(message)
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).tag === "string" &&
        typeof (parsed as Record<string, unknown>).message === "string"
      ) {
        return parsed as ErrorEnvelope
      }
    } catch {
      // Not JSON — fall through to the generic envelope below.
    }
  }
  return { tag: "UnexpectedError", message: message ?? String(value) }
}

/** Runs `program` to completion; returns its success value, or throws the `{tag, message}`
 *  envelope (as a stringified `Error#message`, matching `@athenaeum/backend`'s identical
 *  convention) on failure. The one place every `GatekeeperAccountDurableObject` method funnels
 *  through — mirrors `runOrThrowRpcError`'s role in `@athenaeum/backend`'s own `rpc-boundary.ts`. */
export const runOrThrowEnvelope = async <A, E>(program: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(program)
  if (Exit.isSuccess(exit)) return exit.value
  return throwErrorEnvelope(errorEnvelopeFromCause(exit.cause))
}
