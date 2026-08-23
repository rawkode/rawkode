// The Cap'n Web throw-boundary shim (plan §"Effect-TS integration": "Effect.provide the
// instance Layer, Effect.catchAll converting any Data.TaggedError into the domain package's
// RpcErrorEnvelope encoding and throwing it" — plan §"Top risks", risk #3's mitigation).
//
// Cap'n Web's RPC methods are plain async functions: a thrown value crosses the wire as a
// generic `Error` on the client (see capnweb's `Devaluator`/`abort` message handling — errors are
// serialized structurally, but a caller only gets back an `Error` instance, not our
// `Data.TaggedError` subclass). The convention (domain's `rpc-error.ts`, already implemented) is:
// flatten the failure to a `RpcErrorEnvelope`, JSON-stringify it as the thrown `Error#message`,
// and have the client run it back through `decodeRpcError`.
//
// This module is the one place that Effect-runs a program, converts its outcome, and either
// returns the encoded success payload or throws the encoded failure envelope — every RPC method
// in `workspace-durable-object.ts` funnels through `runRpcProgram`.

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import { encodeRpcError, UnexpectedError, ValidationError, type DomainError } from "@athenaeum/domain"

/** Decodes RPC input against `schema`, mapping a `ParseError` to the domain `ValidationError` so
 *  every failure mode downstream of decoding shares one error channel (`DomainError`). */
export const decodeRpcInput = <A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown
): Effect.Effect<A, DomainError> =>
  Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError(
      (parseError: ParseResult.ParseError) =>
        new ValidationError({
          message: ParseResult.TreeFormatter.formatErrorSync(parseError),
          cause: parseError
        })
    )
  )

/**
 * Recovers a `DomainError` from an Effect `Cause`. A `Fail` carries the real typed error through
 * unchanged; a `Die` (defect) or `Interrupt` — which `Data.TaggedError`-based programs should
 * never normally produce, but a storage bug or an unexpected exception could — is not silently
 * swallowed: it's still flattened to a typed `UnexpectedError` (with the cause's pretty-printed
 * trace as the message) so it *still* crosses the RPC boundary as a well-formed envelope instead
 * of an opaque `FiberFailure`. This is slightly more defensive than the plan's literal
 * "Effect.catchAll converting any Data.TaggedError" wording, which only names the Fail case —
 * documented here as a deliberate strengthening, not a deviation in intent.
 */
export const domainErrorFromCause = (cause: Cause.Cause<DomainError>): DomainError => {
  const failure = Cause.failureOption(cause)
  if (Option.isSome(failure)) return failure.value
  return new UnexpectedError({ message: Cause.pretty(cause) })
}

/** Throws the `{tag, message, data}` envelope (JSON-stringified as `Error#message`) that
 *  `@athenaeum/domain`'s `decodeRpcError` expects on the other side of the Cap'n Web throw
 *  boundary. Never returns (typed `never` so call sites don't need an unreachable `return`). */
export const throwRpcError = (error: DomainError): never => {
  throw new Error(JSON.stringify(encodeRpcError(error)))
}

/**
 * Runs `program` to completion against `runtime` (a pre-built `ManagedRuntime`, not
 * `Effect.provide(layer)` + a bare top-level `Effect.runPromiseExit` — see
 * `workspace-durable-object.ts`'s constructor doc comment for why: a `Layer` built from `Layer.effect`
 * services (`GraphServiceLive`/`NotesServiceLive`, which carry real in-memory state like Automerge
 * sync sessions) re-runs its construction effect on *every* separate `Effect.provide` + top-level
 * run, producing a fresh, empty service instance per RPC call rather than the one shared,
 * long-lived instance every service in this DO is meant to be. A `ManagedRuntime` builds the Layer
 * graph exactly once and reuses the same resolved `Context` for every subsequent run — the same
 * fix the plan itself prescribes for the web frontend ("build a ManagedRuntime once at app boot...
 * do not rebuild the Layer per call/render"), just as genuinely needed server-side once any
 * service here stopped being a trivial `Layer.succeed`.
 *
 * Still uses `runPromiseExit` (not `runPromise`) — see `domainErrorFromCause` above for why the
 * `Exit` needs inspecting directly rather than letting a rejected promise carry Effect's own
 * `FiberFailure` wrapping across the boundary. Returns the schema-encoded success value or throws
 * the encoded `DomainError` envelope.
 */
export const runRpcProgram = async <A, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  program: Effect.Effect<A, DomainError, R>,
  outputSchema: Schema.Schema<A, any>
): Promise<unknown> => {
  const exit = await runtime.runPromiseExit(program)
  if (Exit.isSuccess(exit)) {
    return Schema.encodeSync(outputSchema)(exit.value)
  }
  return throwRpcError(domainErrorFromCause(exit.cause))
}

/**
 * Like `runRpcProgram`, but for RPC methods whose success value isn't itself a wire payload to
 * encode — namely `subscribeToNodes`, whose success value is a live `RpcTarget` handle, not data.
 * Runs `program` to completion via `Exit` against `runtime` (same rationale as `runRpcProgram`)
 * and either returns the value as-is or throws the encoded `DomainError` envelope.
 */
export const runOrThrowRpcError = async <A, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  program: Effect.Effect<A, DomainError, R>
): Promise<A> => {
  const exit = await runtime.runPromiseExit(program)
  if (Exit.isSuccess(exit)) {
    return exit.value
  }
  return throwRpcError(domainErrorFromCause(exit.cause))
}

/**
 * Like `runRpcProgram`, but for a DO whose Cap'n Web methods have no `Context.Tag`/`Layer`
 * dependency graph to build a `ManagedRuntime` for — `UserDurableObject`'s `createWorkspace`/
 * `listWorkspaces` read/write `typed-storage-effect` collections directly (closed over in
 * `UserRpcApi`'s constructor, exactly the way `WorkspaceRpcApi` closes over `#collections`/`#sql`
 * for its own non-service state), rather than through a `NodesRepository`-style service `yield*`ed
 * out of a shared runtime. Extending — not duplicating — `runRpcProgram`'s envelope contract: same
 * `Exit` inspection, same `domainErrorFromCause`/`throwRpcError`/`Schema.encodeSync` shape, just
 * `Effect.runPromiseExit` directly instead of through a `ManagedRuntime` there is no Layer graph
 * to justify building.
 */
export const runRpcEffect = async <A>(
  program: Effect.Effect<A, DomainError>,
  outputSchema: Schema.Schema<A, any>
): Promise<unknown> => {
  const exit = await Effect.runPromiseExit(program)
  if (Exit.isSuccess(exit)) {
    return Schema.encodeSync(outputSchema)(exit.value)
  }
  return throwRpcError(domainErrorFromCause(exit.cause))
}
