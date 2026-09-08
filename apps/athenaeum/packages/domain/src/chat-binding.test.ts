import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  AppBindingTarget,
  ChatBinding,
  ChatBindingName,
  GatekeeperBindingTarget,
  isValidChatBindingName,
  NodeBindingTarget
} from "./chat-binding.js"
import { EntityId } from "./node.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"

describe("isValidChatBindingName", () => {
  it("accepts ordinary and ALL_CAPS identifiers", () => {
    expect(isValidChatBindingName("MY_NOTE")).toBe(true)
    expect(isValidChatBindingName("myNote")).toBe(true)
    expect(isValidChatBindingName("_private")).toBe(true)
    expect(isValidChatBindingName("note2")).toBe(true)
  })

  it("rejects names that aren't valid identifiers", () => {
    expect(isValidChatBindingName("")).toBe(false)
    expect(isValidChatBindingName("2note")).toBe(false)
    expect(isValidChatBindingName("my-note")).toBe(false)
    expect(isValidChatBindingName("my note")).toBe(false)
    // '$' is valid JS but not valid Swift — rejected because the name must work in both.
    expect(isValidChatBindingName("my$note")).toBe(false)
  })

  it("rejects JS reserved words", () => {
    expect(isValidChatBindingName("class")).toBe(false)
    expect(isValidChatBindingName("typeof")).toBe(false)
    expect(isValidChatBindingName("await")).toBe(false)
  })

  it("rejects Swift reserved words that aren't reserved in JS", () => {
    expect(isValidChatBindingName("subscript")).toBe(false)
    expect(isValidChatBindingName("fileprivate")).toBe(false)
    expect(isValidChatBindingName("guard")).toBe(false)
  })

  it("rejects dangerous Object.prototype property names", () => {
    expect(isValidChatBindingName("__proto__")).toBe(false)
    expect(isValidChatBindingName("constructor")).toBe(false)
    expect(isValidChatBindingName("hasOwnProperty")).toBe(false)
    expect(isValidChatBindingName("toString")).toBe(false)
    expect(isValidChatBindingName("prototype")).toBe(false)
  })
})

describe("ChatBindingName schema", () => {
  it("round-trips a valid name", () => {
    const name = ChatBindingName.make("MY_NOTE")
    expect(Schema.decodeUnknownSync(ChatBindingName)(Schema.encodeSync(ChatBindingName)(name))).toEqual(name)
  })

  it("rejects an invalid name via decodeUnknown", () => {
    const result = Schema.decodeUnknownEither(ChatBindingName)("__proto__")
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("ChatBinding schema", () => {
  it("round-trips a node-target binding", () => {
    const binding = new ChatBinding({
      name: ChatBindingName.make("MY_NOTE"),
      target: new NodeBindingTarget({ kind: "node", id: EntityId.make(validUuid) })
    })
    const encoded = Schema.encodeSync(ChatBinding)(binding)
    expect(encoded).toEqual({ name: "MY_NOTE", target: { kind: "node", id: validUuid } })
    expect(Schema.decodeUnknownSync(ChatBinding)(encoded)).toEqual(binding)
  })

  it("round-trips a gatekeeperBinding-target binding (declared for forward-compat, no Phase 3 producer)", () => {
    const binding = new ChatBinding({
      name: ChatBindingName.make("CALENDAR"),
      target: new GatekeeperBindingTarget({ kind: "gatekeeperBinding", id: EntityId.make(validUuid) })
    })
    const encoded = Schema.encodeSync(ChatBinding)(binding)
    expect(Schema.decodeUnknownSync(ChatBinding)(encoded)).toEqual(binding)
  })

  it("round-trips an app-target binding (App Library domain-extension task)", () => {
    const binding = new ChatBinding({
      name: ChatBindingName.make("COUNTER_APP"),
      target: new AppBindingTarget({ kind: "app", id: EntityId.make(validUuid) })
    })
    const encoded = Schema.encodeSync(ChatBinding)(binding)
    expect(encoded).toEqual({ name: "COUNTER_APP", target: { kind: "app", id: validUuid } })
    expect(Schema.decodeUnknownSync(ChatBinding)(encoded)).toEqual(binding)
  })

  it("rejects a binding whose name fails validation", () => {
    const result = Schema.decodeUnknownEither(ChatBinding)({
      name: "constructor",
      target: { kind: "node", id: validUuid }
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a target kind outside node/gatekeeperBinding", () => {
    const result = Schema.decodeUnknownEither(ChatBinding)({
      name: "MY_NOTE",
      target: { kind: "somethingElse", id: validUuid }
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})
