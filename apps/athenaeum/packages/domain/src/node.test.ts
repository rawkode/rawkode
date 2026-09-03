import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  CreateNodeInput,
  CreateNodeOutput,
  GetNodeInput,
  GetNodeOutput,
  ListNodesInput,
  ListNodesOutput,
  NodesChangedEvent
} from "./rpc.js"
import { EntityId, IsoDateTimeString, Node, PendingMarker } from "./node.js"

const validUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const validIso = "2026-08-20T12:00:00.000Z"

describe("Node schema", () => {
  it("round-trips encode/decode for a ULID-identified node", () => {
    const node = new Node({
      id: EntityId.make(validUlid),
      workspaceId: EntityId.make(validUuid),
      title: "My first note",
      createdAt: IsoDateTimeString.make(validIso)
    })

    const encoded = Schema.encodeSync(Node)(node)
    expect(encoded).toEqual({
      id: validUlid,
      workspaceId: validUuid,
      title: "My first note",
      createdAt: validIso
    })

    const decoded = Schema.decodeUnknownSync(Node)(encoded)
    expect(decoded).toEqual(node)
  })

  it("accepts a UUID id (not only ULID)", () => {
    const result = Schema.decodeUnknownEither(Node)({
      id: validUuid,
      workspaceId: validUuid,
      title: "UUID node",
      createdAt: validIso
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("rejects an id that is neither a ULID nor a UUID", () => {
    const result = Schema.decodeUnknownEither(Node)({
      id: "not-an-id",
      workspaceId: validUuid,
      title: "Bad id",
      createdAt: validIso
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects an empty title", () => {
    const result = Schema.decodeUnknownEither(Node)({
      id: validUlid,
      workspaceId: validUuid,
      title: "",
      createdAt: validIso
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a createdAt that is not a valid ISO date-time string", () => {
    const result = Schema.decodeUnknownEither(Node)({
      id: validUlid,
      workspaceId: validUuid,
      title: "Bad date",
      createdAt: "not-a-date"
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("omits pending from the encoded shape when absent (mainline node)", () => {
    const node = new Node({
      id: EntityId.make(validUlid),
      workspaceId: EntityId.make(validUuid),
      title: "Mainline note",
      createdAt: IsoDateTimeString.make(validIso)
    })
    const encoded = Schema.encodeSync(Node)(node)
    expect("pending" in encoded).toBe(false)
    expect(Schema.decodeUnknownSync(Node)(encoded)).toEqual(node)
  })

  it("round-trips a pending node with an unstamped marker (no sequence)", () => {
    const node = new Node({
      id: EntityId.make(validUlid),
      workspaceId: EntityId.make(validUuid),
      title: "Agent-proposed note",
      createdAt: IsoDateTimeString.make(validIso),
      pending: new PendingMarker({ chatId: EntityId.make(validUuid) })
    })
    const encoded = Schema.encodeSync(Node)(node)
    expect(encoded.pending).toEqual({ chatId: validUuid })
    expect("sequence" in (encoded.pending as object)).toBe(false)
    expect(Schema.decodeUnknownSync(Node)(encoded)).toEqual(node)
  })

  it("round-trips a pending node with a stamped sequence", () => {
    const node = new Node({
      id: EntityId.make(validUlid),
      workspaceId: EntityId.make(validUuid),
      title: "Agent-proposed note",
      createdAt: IsoDateTimeString.make(validIso),
      pending: new PendingMarker({ chatId: EntityId.make(validUuid), sequence: 2 })
    })
    const encoded = Schema.encodeSync(Node)(node)
    expect(Schema.decodeUnknownSync(Node)(encoded)).toEqual(node)
  })
})

describe("PendingMarker schema", () => {
  it("rejects a negative sequence", () => {
    const result = Schema.decodeUnknownEither(PendingMarker)({ chatId: validUuid, sequence: -1 })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a chatId that is neither a ULID nor a UUID", () => {
    const result = Schema.decodeUnknownEither(PendingMarker)({ chatId: "not-an-id" })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("wire schemas", () => {
  const node = new Node({
    id: EntityId.make(validUlid),
    workspaceId: EntityId.make(validUuid),
    title: "Wire round trip",
    createdAt: IsoDateTimeString.make(validIso)
  })

  it("round-trips CreateNodeInput", () => {
    const input = new CreateNodeInput({ workspaceId: EntityId.make(validUuid), title: "New node" })
    const encoded = Schema.encodeSync(CreateNodeInput)(input)
    expect(Schema.decodeUnknownSync(CreateNodeInput)(encoded)).toEqual(input)
  })

  it("round-trips CreateNodeOutput", () => {
    const output = new CreateNodeOutput({ node })
    const encoded = Schema.encodeSync(CreateNodeOutput)(output)
    expect(Schema.decodeUnknownSync(CreateNodeOutput)(encoded)).toEqual(output)
  })

  it("round-trips ListNodesInput", () => {
    const input = new ListNodesInput({ workspaceId: EntityId.make(validUuid) })
    const encoded = Schema.encodeSync(ListNodesInput)(input)
    expect(Schema.decodeUnknownSync(ListNodesInput)(encoded)).toEqual(input)
  })

  it("round-trips ListNodesOutput with multiple nodes", () => {
    const output = new ListNodesOutput({ nodes: [node, node] })
    const encoded = Schema.encodeSync(ListNodesOutput)(output)
    expect(Schema.decodeUnknownSync(ListNodesOutput)(encoded)).toEqual(output)
  })

  it("round-trips NodesChangedEvent", () => {
    const event = new NodesChangedEvent({ workspaceId: EntityId.make(validUuid), nodes: [node] })
    const encoded = Schema.encodeSync(NodesChangedEvent)(event)
    expect(Schema.decodeUnknownSync(NodesChangedEvent)(encoded)).toEqual(event)
  })

  it("round-trips GetNodeInput", () => {
    const input = new GetNodeInput({ workspaceId: EntityId.make(validUuid), nodeId: EntityId.make(validUlid) })
    const encoded = Schema.encodeSync(GetNodeInput)(input)
    expect(Schema.decodeUnknownSync(GetNodeInput)(encoded)).toEqual(input)
  })

  it("round-trips GetNodeOutput", () => {
    const output = new GetNodeOutput({ node })
    const encoded = Schema.encodeSync(GetNodeOutput)(output)
    expect(Schema.decodeUnknownSync(GetNodeOutput)(encoded)).toEqual(output)
  })
})
