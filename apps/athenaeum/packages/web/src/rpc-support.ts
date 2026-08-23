import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import { decodeRpcError, UnexpectedError, type DomainError } from "@athenaeum/domain"

// Extracted from `rpc-client.ts` (which originally kept these private) now that a second Cap'n
// Web client — `user-rpc-client.ts`'s `/api/user` session — needs the identical thrown-envelope
// recovery / schema-decode-on-response discipline. Behavior is unchanged from `rpc-client.ts`'s
// original private copies; this module exists purely so both clients share one implementation
// instead of drifting apart.

/** Recovers a typed `DomainError` from whatever a Cap'n Web call threw. A well-formed envelope
 *  (thrown by `backend`'s `throwRpcError`) decodes cleanly; anything else — a network failure, a
 *  non-`Error` throw, a malformed/unrecognized envelope — fails closed as `UnexpectedError`
 *  rather than crashing the caller with an unrelated exception type. */
export const domainErrorFromThrown = (thrown: unknown): Effect.Effect<never, DomainError> => {
  if (!(thrown instanceof Error)) {
    return Effect.fail(new UnexpectedError({ message: String(thrown) }))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(thrown.message)
  } catch {
    return Effect.fail(new UnexpectedError({ message: thrown.message }))
  }
  return decodeRpcError(parsed).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.fail(new UnexpectedError({ message: thrown.message })),
      onSuccess: (domainError) => Effect.fail(domainError)
    })
  )
}

/** Calls a Cap'n Web method that returns wire data, decoding the result against `schema`. */
export const callForValue = <A, I>(
  schema: Schema.Schema<A, I>,
  thunk: () => Promise<unknown>
): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({ try: thunk, catch: (thrown) => thrown }).pipe(
    Effect.catchAll(domainErrorFromThrown),
    Effect.flatMap((raw) =>
      Schema.decodeUnknown(schema)(raw).pipe(
        Effect.mapError(
          (parseError: ParseResult.ParseError) =>
            new UnexpectedError({ message: ParseResult.TreeFormatter.formatErrorSync(parseError) })
        )
      )
    )
  )

/** Calls a Cap'n Web method that returns a live stub (e.g. `subscribeToNodes`) rather than wire
 *  data — no schema decode, the stub itself is the result. */
export const callForStub = <S>(thunk: () => Promise<S>): Effect.Effect<S, DomainError> =>
  Effect.tryPromise({ try: thunk, catch: (thrown) => thrown }).pipe(Effect.catchAll(domainErrorFromThrown))

/** Same recovery as `domainErrorFromThrown`, but as a plain-Promise string message — for the
 *  small number of client modules (`user-rpc-client.ts`, the bootstrap/session-management
 *  surface) that deliberately stay outside the Effect/`ManagedRuntime` machinery, mirroring
 *  `auth.ts`'s own precedent that sign-in-adjacent, pre-connection concerns are "a bespoke HTTP
 *  exchange," not routed through the same Layer/Context plumbing as the main workspace RPC surface. */
export const describeRpcError = (thrown: unknown): Promise<string> =>
  Effect.runPromise(
    domainErrorFromThrown(thrown).pipe(Effect.catchAll((domainError) => Effect.succeed(domainError.message)))
  )
