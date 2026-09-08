// Real, repeatable tests of the `ModelClientScripted` test double against the real `ModelClient`
// Context.Tag boundary (plan §"Agent-native editing & gatekeeper integrations", "1. Pluggable
// model-client design"): a deterministic in-memory queue of pre-programmed tool-call sequences,
// standing in for a real LLM's `converse` calls.

import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  ChatMessage,
  ChatTextBlock,
  ChatThread,
  ChatToolResultBlock,
  ModelClient,
  ModelTurnFinalText,
  ModelTurnToolCalls,
  ToolCallRequest,
  ToolSpec
} from "@athenaeum/domain"
import { makeModelClientScripted } from "../src/model-client-scripted.js"

const userThread = (text: string): ChatThread =>
  new ChatThread({ messages: [new ChatMessage({ role: "user", content: [new ChatTextBlock({ type: "text", text })] })] })

describe("ModelClientScripted: deterministic pre-programmed turn sequence", () => {
  it("returns each scripted turn in order, one per converse() call", async () => {
    const toolCallTurn = new ModelTurnToolCalls({
      kind: "tool_calls",
      calls: [new ToolCallRequest({ id: "call-1", name: "createNode", input: { title: "From the agent" } })]
    })
    const finalTextTurn = new ModelTurnFinalText({ kind: "final_text", text: "Created the node." })

    const scripted = makeModelClientScripted([toolCallTurn, finalTextTurn])

    const program = Effect.gen(function* () {
      const client = yield* ModelClient
      const first = yield* client.converse(userThread("Create a node"), [])
      const second = yield* client.converse(userThread("Create a node"), [])
      return [first, second] as const
    })

    const [first, second] = await Effect.runPromise(program.pipe(Effect.provide(scripted.layer)))
    expect(first).toEqual(toolCallTurn)
    expect(second).toEqual(finalTextTurn)
    expect(scripted.remaining()).toBe(0)
  })

  it("records every converse() call's thread and available tools, in order", async () => {
    const scripted = makeModelClientScripted([new ModelTurnFinalText({ kind: "final_text", text: "ok" })])
    const tools = [new ToolSpec({ name: "createNode", description: "Create a node", inputSchema: { type: "object" } })]

    const program = Effect.gen(function* () {
      const client = yield* ModelClient
      yield* client.converse(userThread("hello"), tools)
    })

    await Effect.runPromise(program.pipe(Effect.provide(scripted.layer)))

    expect(scripted.calls).toHaveLength(1)
    expect(scripted.calls[0]!.thread.messages[0]!.content[0]).toEqual(new ChatTextBlock({ type: "text", text: "hello" }))
    expect(scripted.calls[0]!.availableTools).toEqual(tools)
  })

  it("fails with ModelUnavailable once the script is exhausted, without corrupting subsequent state", async () => {
    const scripted = makeModelClientScripted([new ModelTurnFinalText({ kind: "final_text", text: "only turn" })])

    const runOnce = Effect.gen(function* () {
      const client = yield* ModelClient
      return yield* client.converse(userThread("go"), [])
    }).pipe(Effect.provide(scripted.layer))

    const ok = await Effect.runPromise(runOnce)
    expect(ok).toEqual(new ModelTurnFinalText({ kind: "final_text", text: "only turn" }))

    const exhausted = await Effect.runPromiseExit(runOnce)
    expect(Exit.isFailure(exhausted)).toBe(true)
    if (Exit.isFailure(exhausted)) {
      const failure = exhausted.cause
      expect(failure._tag).toBe("Fail")
    }
    // Two calls were made (the successful one plus the exhausted one) — the queue draining is
    // visible in `calls` even though the second call had nothing left to return.
    expect(scripted.calls).toHaveLength(2)
  })

  it("a chat's fork-edit tool-result round trip: the second converse() call's thread includes the first call's tool_result", async () => {
    // Mirrors the shape a real AgentEditService turn will take: propose a tool call, execute it,
    // feed the result back as the next thread's last message, get a final text reply.
    const scripted = makeModelClientScripted([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "call-1", name: "editNote", input: { insertText: "Hello" } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Applied the edit." })
    ])

    const program = Effect.gen(function* () {
      const client = yield* ModelClient
      const first = yield* client.converse(userThread("Edit the note to say Hello"), [])
      if (first.kind !== "tool_calls") throw new Error("expected tool_calls")

      const threadWithToolResult = new ChatThread({
        messages: [
          new ChatMessage({ role: "user", content: [new ChatTextBlock({ type: "text", text: "Edit the note to say Hello" })] }),
          new ChatMessage({
            role: "user",
            content: [new ChatToolResultBlock({ type: "tool_result", toolUseId: first.calls[0]!.id, content: "ok" })]
          })
        ]
      })
      return yield* client.converse(threadWithToolResult, [])
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(scripted.layer)))
    expect(result).toEqual(new ModelTurnFinalText({ kind: "final_text", text: "Applied the edit." }))
    expect(scripted.calls).toHaveLength(2)
    expect(scripted.calls[1]!.thread.messages[1]!.content[0]).toEqual(
      new ChatToolResultBlock({ type: "tool_result", toolUseId: "call-1", content: "ok" })
    )
  })
})
