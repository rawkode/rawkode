import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import { describe, expect, it } from "vitest"
import {
  AppCodeTooLarge,
  AppCodeVersionNotFound,
  AppNotFound,
  GatekeeperNotConnected,
  MeetingNotFound,
  NodeNotFound,
  OAuthExchangeFailed,
  ObserverVerificationFailed,
  TagFieldDefinitionNotFound,
  UnexpectedError,
  ValidationError,
  VoiceSessionNotFound,
  WorkoutImportConflict,
  WorkoutNotFound,
  WorkspaceAccessDenied,
  WorkspaceNotFound
} from "./errors.js"
import { decodeRpcError, encodeRpcError, RpcErrorEnvelope } from "./rpc-error.js"

describe("RPC error envelope", () => {
  it("round-trips NodeNotFound through encode -> JSON -> decode", async () => {
    const original = new NodeNotFound({ nodeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })

    const envelope = encodeRpcError(original)
    expect(envelope).toBeInstanceOf(RpcErrorEnvelope)
    expect(envelope.tag).toBe("NodeNotFound")
    expect(envelope.data).toEqual({ nodeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })

    // Simulate the actual Cap'n Web throw boundary: the envelope is serialized into a real
    // Error's message on the server side, and the client only has the caught Error to work with.
    const thrown = new Error(JSON.stringify(envelope))
    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(thrown.message)))

    expect(recovered).toBeInstanceOf(NodeNotFound)
    expect(recovered).toEqual(original)
  })

  it("round-trips ValidationError with a cause", async () => {
    const original = new ValidationError({ message: "title must not be empty", cause: "empty string" })

    const envelope = encodeRpcError(original)
    expect(envelope.data).toEqual({ cause: "empty string" })

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(ValidationError)
    expect(recovered).toEqual(new ValidationError({ message: "title must not be empty", cause: "empty string" }))
  })

  it("round-trips ValidationError without a cause", async () => {
    const original = new ValidationError({ message: "workspaceId is required" })

    const envelope = encodeRpcError(original)
    expect(envelope.data).toEqual({})

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toEqual(new ValidationError({ message: "workspaceId is required", cause: undefined }))
  })

  it("round-trips UnexpectedError", async () => {
    const original = new UnexpectedError({ message: "storage backend unavailable" })

    const envelope = encodeRpcError(original)
    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))

    expect(recovered).toBeInstanceOf(UnexpectedError)
    expect(recovered).toEqual(original)
  })

  it("round-trips WorkspaceNotFound (docs/sharing.md's WORKSPACE_NOT_FOUND analog)", async () => {
    const original = new WorkspaceNotFound({ workspaceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("WorkspaceNotFound")
    expect(envelope.data).toEqual({ workspaceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(WorkspaceNotFound)
    expect(recovered).toEqual(original)
  })

  it("round-trips WorkspaceAccessDenied (docs/sharing.md's WORKSPACE_ACCESS_DENIED analog, distinct from WorkspaceNotFound)", async () => {
    const original = new WorkspaceAccessDenied({ workspaceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("WorkspaceAccessDenied")

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(WorkspaceAccessDenied)
    expect(recovered).toEqual(original)
  })

  it("round-trips GatekeeperNotConnected", async () => {
    const original = new GatekeeperNotConnected({
      workspaceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      gatekeeperKind: "google-calendar"
    })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("GatekeeperNotConnected")
    expect(envelope.data).toEqual({
      workspaceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      gatekeeperKind: "google-calendar"
    })

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(GatekeeperNotConnected)
    expect(recovered).toEqual(original)
  })

  it("round-trips OAuthExchangeFailed", async () => {
    const original = new OAuthExchangeFailed({ message: "invalid_grant: authorization code expired" })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("OAuthExchangeFailed")
    expect(envelope.data).toEqual({})

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(OAuthExchangeFailed)
    expect(recovered).toEqual(original)
  })

  it("round-trips ObserverVerificationFailed (an opaque observerId, never an Email/profileId)", async () => {
    const original = new ObserverVerificationFailed({
      observerId: "obs_9f2c1e",
      message: "The observer's own Google account has \"reader\" access, but this binding requires \"writer\" or \"owner\"."
    })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("ObserverVerificationFailed")
    expect(envelope.data).toEqual({ observerId: "obs_9f2c1e", message: original.message })

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(ObserverVerificationFailed)
    expect(recovered).toEqual(original)
  })

  it("round-trips MeetingNotFound", async () => {
    const original = new MeetingNotFound({ meetingId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("MeetingNotFound")
    expect(envelope.data).toEqual({ meetingId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(MeetingNotFound)
    expect(recovered).toEqual(original)
  })

  it("round-trips VoiceSessionNotFound", async () => {
    const original = new VoiceSessionNotFound({ voiceSessionId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("VoiceSessionNotFound")
    expect(envelope.data).toEqual({ voiceSessionId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(VoiceSessionNotFound)
    expect(recovered).toEqual(original)
  })

  it("round-trips WorkoutNotFound", async () => {
    const original = new WorkoutNotFound({ nodeId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("WorkoutNotFound")
    expect(envelope.data).toEqual({ nodeId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(WorkoutNotFound)
    expect(recovered).toEqual(original)
  })

  it("round-trips WorkoutImportConflict (different content under the same sourceWorkoutId)", async () => {
    const original = new WorkoutImportConflict({
      sourceWorkoutId: "healthkit-uuid-1",
      message: "workout healthkit-uuid-1 was already imported with different content"
    })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("WorkoutImportConflict")
    expect(envelope.data).toEqual({ sourceWorkoutId: "healthkit-uuid-1", message: original.message })

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(WorkoutImportConflict)
    expect(recovered).toEqual(original)
  })

  it("round-trips AppNotFound", async () => {
    const original = new AppNotFound({ appId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("AppNotFound")
    expect(envelope.data).toEqual({ appId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(AppNotFound)
    expect(recovered).toEqual(original)
  })

  it("round-trips AppCodeVersionNotFound", async () => {
    const original = new AppCodeVersionNotFound({
      appId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      kind: "server",
      version: 3
    })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("AppCodeVersionNotFound")
    expect(envelope.data).toEqual({
      appId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      kind: "server",
      version: 3
    })

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(AppCodeVersionNotFound)
    expect(recovered).toEqual(original)
  })

  it("round-trips AppCodeTooLarge", async () => {
    const original = new AppCodeTooLarge({
      appId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      kind: "client",
      sizeBytes: 320_000,
      maxBytes: 262_144
    })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("AppCodeTooLarge")
    expect(envelope.data).toEqual({
      appId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      kind: "client",
      sizeBytes: 320_000,
      maxBytes: 262_144
    })

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(AppCodeTooLarge)
    expect(recovered).toEqual(original)
  })

  it("round-trips TagFieldDefinitionNotFound", async () => {
    const original = new TagFieldDefinitionNotFound({ fieldId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const envelope = encodeRpcError(original)
    expect(envelope.tag).toBe("TagFieldDefinitionNotFound")
    expect(envelope.data).toEqual({ fieldId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })

    const recovered = await Effect.runPromise(decodeRpcError(JSON.parse(JSON.stringify(envelope))))
    expect(recovered).toBeInstanceOf(TagFieldDefinitionNotFound)
    expect(recovered).toEqual(original)
  })

  it("fails closed (as a typed ParseError, not a bad reconstruction) on a malformed envelope", async () => {
    const result = await Effect.runPromise(Effect.either(decodeRpcError({ tag: "TotallyUnknownTag", message: "?" })))
    expect(Either.isLeft(result)).toBe(true)
  })

  it("fails closed on a non-object payload (e.g. a plain Error.message that wasn't JSON)", async () => {
    const result = await Effect.runPromise(Effect.either(decodeRpcError("not an envelope")))
    expect(Either.isLeft(result)).toBe(true)
  })
})
