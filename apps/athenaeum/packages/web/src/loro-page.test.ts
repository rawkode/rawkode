import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import { LoroDoc } from "loro-crdt/bundler"
import {
  createLoroPage,
  convergeLoroPageFromServer,
  newLoroSyncSessionHandle,
  syncLoroPageWithServer
} from "./loro-page.js"
import type { WorkspaceRpcClientService } from "./rpc-client.js"

const runSync = (
  client: WorkspaceRpcClientService,
  doc: LoroDoc,
  session = newLoroSyncSessionHandle()
) => Effect.runPromise(
  syncLoroPageWithServer(
    client,
    "00000000-0000-4000-8000-000000000001" as never,
    "00000000-0000-4000-8000-000000000002" as never,
    doc,
    session
  )
)

describe("Loro page sync", () => {
  it("downloads authority using an empty raw frame only", async () => {
    const server = createLoroPage()
    const updates: Uint8Array[] = []
    const client = {
      startLoroPageSync: () => Effect.succeed({ sessionId: "server-session", message: server.doc.export({ mode: "snapshot" }), serverVersion: server.doc.version().encode() }),
      loroPageSyncMessage: (input: { update: Uint8Array }) => {
        updates.push(input.update)
        return Effect.succeed({ sessionId: "server-session", ordinal: 0, update: null, serverVersion: server.doc.version().encode(), converged: true, reset: false })
      }
    } as unknown as WorkspaceRpcClientService
    await Effect.runPromise(convergeLoroPageFromServer(client, "00000000-0000-4000-8000-000000000001" as never, "00000000-0000-4000-8000-000000000002" as never))
    expect(updates).toHaveLength(1)
    expect(updates[0]!.byteLength).toBe(0)
  })

  it("creates the canonical valid empty ProseMirror genesis", () => {
    const page = createLoroPage()
    const children = page.pmRoot.get("children")
    expect(children).toBeDefined()
    expect((children as { length: number }).length).toBe(1)
    const paragraph = (children as { get: (index: number) => unknown }).get(0) as { get: (key: string) => unknown }
    expect(paragraph.get("nodeName")).toBe("paragraph")
    expect((paragraph.get("children") as { length: number }).length).toBe(1)
  })

  it("does not send a sync message for an initial no-op document", async () => {
    const server = createLoroPage()
    const calls: string[] = []
    const client = {
      startLoroPageSync: () => {
        calls.push("start")
        return Effect.succeed({
          sessionId: "server-session",
          message: server.doc.export({ mode: "snapshot" }),
          serverVersion: server.doc.version().encode()
        })
      },
      loroPageSyncMessage: () => {
        calls.push("message")
        throw new Error("no-op sync must not send a message")
      }
    } as unknown as WorkspaceRpcClientService

    const session = newLoroSyncSessionHandle()
    await runSync(client, new LoroDoc(), session)

    expect(calls).toEqual(["start"])
    expect(session.started).toBe(true)
    expect(session.ordinal).toBe(0)
  })

  it("reuses the server session and advances ordinals across saves", async () => {
    const server = createLoroPage()
    const doc = new LoroDoc()
    const starts: string[] = []
    const messages: Array<{ sessionId: string; ordinal: number; updateSize: number }> = []
    const client = {
      startLoroPageSync: (input: { sessionId: string }) => {
        starts.push(input.sessionId)
        return Effect.succeed({
          sessionId: "server-session",
          message: server.doc.export({ mode: "snapshot" }),
          serverVersion: server.doc.version().encode()
        })
      },
      loroPageSyncMessage: (input: { sessionId: string; ordinal: number; update: Uint8Array }) => {
        messages.push({ sessionId: input.sessionId, ordinal: input.ordinal, updateSize: input.update.byteLength })
        return Effect.succeed({
          sessionId: input.sessionId,
          ordinal: input.ordinal,
          update: null,
          serverVersion: input.update.byteLength === 0 ? server.doc.version().encode() : doc.version().encode(),
          converged: true,
          reset: false
        })
      }
    } as unknown as WorkspaceRpcClientService
    const session = newLoroSyncSessionHandle()

    await runSync(client, doc, session)
    doc.getMap("athenaeum-page-meta-v1").set("save", "one")
    doc.commit()
    await runSync(client, doc, session)
    doc.getMap("athenaeum-page-meta-v1").set("save", "two")
    doc.commit()
    await runSync(client, doc, session)
    await runSync(client, doc, session)

    expect(starts).toHaveLength(1)
    expect(messages.map(({ ordinal }) => ordinal)).toEqual([0, 1])
    expect(messages.every(({ sessionId }) => sessionId === "server-session")).toBe(true)
    expect(messages.every(({ updateSize }) => updateSize > 0)).toBe(true)
    expect(session.ordinal).toBe(2)
    expect(session.knownServerVersion.compare(doc.version())).toBe(0)
  })

  it("fails explicitly when the convergence bound is exhausted", async () => {
    const server = createLoroPage()
    const doc = new LoroDoc()
    let messageCount = 0
    const client = {
      startLoroPageSync: () =>
        Effect.succeed({
          sessionId: "server-session",
          message: server.doc.export({ mode: "snapshot" }),
          serverVersion: server.doc.version().encode()
        }),
      loroPageSyncMessage: (input: { ordinal: number }) => {
        messageCount += 1
        return Effect.succeed({
          sessionId: "server-session",
          ordinal: input.ordinal,
          update: null,
          serverVersion: server.doc.version().encode(),
          converged: false,
          reset: false
        })
      }
    } as unknown as WorkspaceRpcClientService
    const session = newLoroSyncSessionHandle()

    await runSync(client, doc, session)
    doc.getMap("athenaeum-page-meta-v1").set("never", "converges")
    doc.commit()

    await expect(runSync(client, doc, session)).rejects.toThrow("did not converge after 50 messages")
    expect(messageCount).toBe(50)
    expect(session.ordinal).toBe(50)
  })
})
