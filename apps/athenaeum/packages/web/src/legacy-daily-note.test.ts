/** @vitest-environment happy-dom */

import * as Effect from "effect/Effect"
import { describe, expect, it, vi } from "vitest"
import { UnexpectedError, type EntityId } from "@athenaeum/domain"
import {
  resolveLegacyDailyNote,
  type LegacyDailyNoteCell,
  type LegacyDailyNoteRuntime
} from "./legacy-daily-note.js"
import type { WorkspaceRpcClientService } from "./rpc-client.js"

const workspaceId = "00000000-0000-4000-8000-000000000001" as EntityId
const nodeId = "00000000-0000-4000-8000-000000000002" as EntityId
const client = {} as WorkspaceRpcClientService

describe("legacy daily-note adapter", () => {
  it("keeps one caller-owned session object and id when a failed first sync is retried", async () => {
    const session = { id: "legacy-session-reused-after-failure" }
    const factory = vi.fn(() => session)
    const firstDoc = {} as never
    const sync = vi.fn()
      .mockReturnValueOnce(Effect.fail(new UnexpectedError({ message: "initial sync response lost" })))
      .mockReturnValueOnce(Effect.succeed(firstDoc))
    const runtime = {
      emptyPageDoc: vi.fn(() => firstDoc),
      newSyncSessionHandle: factory,
      syncPageWithServer: sync,
      ensureRichTextSchema: vi.fn((doc) => doc)
    } as unknown as LegacyDailyNoteRuntime
    const cell: LegacyDailyNoteCell = { session: null }

    await expect(Effect.runPromise(resolveLegacyDailyNote(client, workspaceId, nodeId, cell, runtime)))
      .rejects.toThrow("initial sync response lost")

    expect(cell.session).toBe(session)
    expect(cell.session?.id).toBe("legacy-session-reused-after-failure")

    const resolved = await Effect.runPromise(resolveLegacyDailyNote(client, workspaceId, nodeId, cell, runtime))

    expect(factory).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync.mock.calls[0]?.[4]).toBe(session)
    expect(sync.mock.calls[1]?.[4]).toBe(session)
    expect((sync.mock.calls[0]?.[4] as { id: string }).id).toBe((sync.mock.calls[1]?.[4] as { id: string }).id)
    expect(resolved.session).toBe(session)
  })

  it("runs the optional rich-text migration sync with the initial session", async () => {
    const session = { id: "legacy-session-through-migration" }
    const initialDoc = { phase: "initial" } as never
    const migratedDoc = { phase: "migrated" } as never
    const sync = vi.fn()
      .mockReturnValueOnce(Effect.succeed(initialDoc))
      .mockReturnValueOnce(Effect.succeed(migratedDoc))
    const runtime = {
      emptyPageDoc: vi.fn(() => initialDoc),
      newSyncSessionHandle: vi.fn(() => session),
      syncPageWithServer: sync,
      ensureRichTextSchema: vi.fn(() => migratedDoc)
    } as unknown as LegacyDailyNoteRuntime
    const cell: LegacyDailyNoteCell = { session: null }

    const resolved = await Effect.runPromise(resolveLegacyDailyNote(client, workspaceId, nodeId, cell, runtime))

    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync.mock.calls[0]?.[3]).toBe(initialDoc)
    expect(sync.mock.calls[1]?.[3]).toBe(migratedDoc)
    expect(sync.mock.calls.every((call) => call[4] === session)).toBe(true)
    expect(resolved.doc).toBe(migratedDoc)
    expect(resolved.session).toBe(session)
  })
})
