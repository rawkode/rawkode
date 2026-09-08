import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it, vi } from "vitest"
import {
  ChatForkPreviewInput,
  EntityId,
  GetPageDocumentDescriptorInput,
  PageNotFound,
  PageFormatMismatch,
  UnexpectedError,
  type PageDocumentDescriptor
} from "@athenaeum/domain"
import {
  collectLegacyForkNodeIds,
  decodeEditNoteNodeId,
  decodeToolLogEntry,
  loadLegacyForkPreviews,
  type ToolLogEntry
} from "./chat-fork-routing.js"
import type { WorkspaceRpcClientService } from "./rpc-client.js"

const node = (value: string): EntityId => Schema.decodeUnknownSync(EntityId)(value)
const nodeA = node("00000000-0000-4000-8000-000000000001")
const nodeB = node("00000000-0000-4000-8000-000000000002")
const workspaceId = node("00000000-0000-4000-8000-000000000003")
const chatId = node("00000000-0000-4000-8000-000000000004")

const descriptor = (
  nodeId: EntityId,
  activeFormat: "automerge-v1" | "loro-v1",
  automerge = activeFormat === "loro-v1"
    ? { docId: "legacy-doc", headsHash: "legacy-heads", bytesSha256: "legacy-bytes" }
    : undefined
): PageDocumentDescriptor => ({
  nodeId,
  storageVersion: activeFormat === "loro-v1" && automerge !== undefined ? 2 : 1,
  activeFormat,
  ...(automerge === undefined ? {} : { automerge }),
  ...(activeFormat === "loro-v1"
    ? { loro: { schemaVersion: 1, snapshotSha256: "loro-snapshot" } }
    : {})
}) as PageDocumentDescriptor

const nativeLoroDescriptor = (nodeId: EntityId): PageDocumentDescriptor => ({
  nodeId,
  storageVersion: 1,
  activeFormat: "loro-v1",
  loro: { schemaVersion: 1, snapshotSha256: "native-loro-snapshot" }
}) as PageDocumentDescriptor

const logEntry = (result: unknown, isError = false): ToolLogEntry => ({
  toolUseId: "tool-call",
  entityIds: [],
  result: typeof result === "string" ? result : JSON.stringify(result),
  isError
})

const successfulEdit = (nodeId: unknown, text = "draft") => ({ text, nodeId })

const makeClient = (descriptors: Map<EntityId, PageDocumentDescriptor>, options: {
  readonly descriptorFailure?: Error
  readonly previewFailure?: Error
} = {}) => {
  const calls: string[] = []
  const getPageDocumentDescriptor = vi.fn((input: GetPageDocumentDescriptorInput) => {
    calls.push(`descriptor:${input.nodeId}`)
    if (options.descriptorFailure !== undefined) return Effect.fail(options.descriptorFailure)
    const value = descriptors.get(input.nodeId)
    return value === undefined
      ? Effect.fail(new PageNotFound({ nodeId: input.nodeId }))
      : Effect.succeed({ descriptor: value })
  })
  const chatForkPreview = vi.fn((input: ChatForkPreviewInput) => {
    calls.push(`preview:${input.nodeId}`)
    if (options.previewFailure !== undefined) return Effect.fail(options.previewFailure)
    return Effect.succeed({ forked: true, text: "legacy draft" })
  })
  return {
    client: { getPageDocumentDescriptor, chatForkPreview } as unknown as WorkspaceRpcClientService,
    calls,
    getPageDocumentDescriptor,
    chatForkPreview
  }
}

describe("ChatPanel Loro/legacy review routing", () => {
  it("rejects malformed outer tool log fields and preserves literal status booleans before any routing decision", () => {
    expect(decodeToolLogEntry(JSON.stringify({ toolUseId: "tool-call", result: "{}", isError: "false" }))).toBeUndefined()
    expect(decodeToolLogEntry(JSON.stringify({ toolUseId: "tool-call", result: "{}", isError: false }))).toEqual({
      toolUseId: "tool-call",
      result: "{}",
      entityIds: [],
      isError: false
    })
    expect(decodeToolLogEntry(JSON.stringify({ toolUseId: "tool-call", result: "{}", isError: true }))).toEqual({
      toolUseId: "tool-call",
      result: "{}",
      entityIds: [],
      isError: true
    })
    expect(decodeToolLogEntry(JSON.stringify({ toolUseId: "tool-call", result: "{}", entityIds: [nodeA] }))).toEqual({
      toolUseId: "tool-call",
      result: "{}",
      entityIds: [nodeA],
      isError: undefined
    })
    expect(decodeToolLogEntry(JSON.stringify({ toolUseId: "tool-call", result: "{}", entityIds: [42] }))).toBeUndefined()
  })

  it("validates successful tool output and rejects failed, malformed, or invalid historic logs", () => {
    const valid = decodeEditNoteNodeId(logEntry(successfulEdit(nodeA)))
    expect(valid).toBe(nodeA)
    expect(decodeEditNoteNodeId(logEntry(successfulEdit(nodeA), true))).toBeUndefined()
    expect(decodeEditNoteNodeId(logEntry({ text: "missing node id" }))).toBeUndefined()
    expect(decodeEditNoteNodeId(logEntry(successfulEdit("not-an-entity-id")))).toBeUndefined()
    expect(decodeEditNoteNodeId(logEntry("not-json"))).toBeUndefined()
  })

  it("admits only explicit successful editNote calls with the exact tool name", async () => {
    const { client, calls } = makeClient(new Map([[nodeA, descriptor(nodeA, "automerge-v1")]]))
    const messages = [
      {
        role: "tool",
        content: JSON.stringify({
          toolUseId: "lookup-call",
          entityIds: [],
          result: JSON.stringify(successfulEdit(nodeA)),
          isError: false
        })
      },
      {
        role: "tool",
        content: JSON.stringify({
          toolUseId: "missing-outcome-call",
          entityIds: [],
          result: JSON.stringify(successfulEdit(nodeA))
        })
      }
    ]
    const nodeIds = collectLegacyForkNodeIds(messages, new Map([
      ["lookup-call", "lookupEntity"],
      ["missing-outcome-call", "editNote"]
    ]))
    expect(nodeIds).toEqual([])
    expect(await Effect.runPromise(loadLegacyForkPreviews(client, workspaceId, chatId, nodeIds))).toEqual([])
    expect(calls).toEqual([])
  })

  it("checks Loro pages, including migrated pages with an Automerge witness, without previewing forks", async () => {
    const { client, calls, chatForkPreview } = makeClient(new Map([
      [nodeA, nativeLoroDescriptor(nodeA)],
      [nodeB, descriptor(nodeB, "loro-v1")]
    ]))
    const result = await Effect.runPromise(loadLegacyForkPreviews(client, workspaceId, chatId, [nodeA, nodeB]))
    expect(result).toEqual([])
    expect(calls).toEqual([`descriptor:${nodeA}`, `descriptor:${nodeB}`])
    expect(chatForkPreview).not.toHaveBeenCalled()
  })

  it("previews only explicit legacy pages, after their descriptor has been resolved", async () => {
    const { client, calls, chatForkPreview } = makeClient(new Map([
      [nodeA, descriptor(nodeA, "automerge-v1")],
      [nodeB, descriptor(nodeB, "loro-v1")]
    ]))
    const result = await Effect.runPromise(loadLegacyForkPreviews(client, workspaceId, chatId, [nodeA, nodeB]))
    expect(result).toEqual([{ nodeId: nodeA, forked: true, text: "legacy draft" }])
    expect(calls).toEqual([`descriptor:${nodeA}`, `preview:${nodeA}`, `descriptor:${nodeB}`])
    expect(chatForkPreview).toHaveBeenCalledTimes(1)
    expect(chatForkPreview).toHaveBeenCalledWith(new ChatForkPreviewInput({ workspaceId, chatId, nodeId: nodeA }))
  })

  it("fails closed when descriptor or preview lookup fails", async () => {
    const descriptorFailure = new UnexpectedError({ message: "descriptor unavailable" })
    const descriptorClient = makeClient(new Map([[nodeA, descriptor(nodeA, "automerge-v1")]]), { descriptorFailure })
    const descriptorResult = await Effect.runPromise(Effect.either(
      loadLegacyForkPreviews(descriptorClient.client, workspaceId, chatId, [nodeA])
    ))
    expect(descriptorResult._tag).toBe("Left")
    expect(descriptorClient.calls).toEqual([`descriptor:${nodeA}`])
    expect(descriptorClient.chatForkPreview).not.toHaveBeenCalled()

    const previewFailure = new PageFormatMismatch({ nodeId: nodeA, expected: "automerge-v1", actual: "loro-v1" })
    const previewClient = makeClient(new Map([[nodeA, descriptor(nodeA, "automerge-v1")]]), { previewFailure })
    const previewResult = await Effect.runPromise(Effect.either(
      loadLegacyForkPreviews(previewClient.client, workspaceId, chatId, [nodeA])
    ))
    expect(previewResult._tag).toBe("Left")
    expect(previewClient.calls).toEqual([`descriptor:${nodeA}`, `preview:${nodeA}`])
  })

  it("does not issue any routing RPC for malformed or failed historic entries", async () => {
    const { client, calls } = makeClient(new Map([[nodeA, descriptor(nodeA, "automerge-v1")]]))
    const historic = [
      logEntry(successfulEdit("not-an-entity-id")),
      logEntry(successfulEdit(nodeA), true),
      logEntry("{broken-json")
    ]
    const nodeIds = historic
      .map(decodeEditNoteNodeId)
      .filter((value): value is EntityId => value !== undefined)
    expect(nodeIds).toEqual([])
    expect(await Effect.runPromise(loadLegacyForkPreviews(client, workspaceId, chatId, nodeIds))).toEqual([])
    expect(calls).toEqual([])
  })
})
