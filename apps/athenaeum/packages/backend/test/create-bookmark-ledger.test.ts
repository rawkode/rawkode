import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  CreateBookmarkInput,
  CreateBookmarkLedgerCommand,
  CreateBookmarkOutput,
  HumanUiMutationAttribution,
  ListBookmarksOutput,
  ListRecentLedgerActivityOutput,
  SyncFeedInput,
  SyncFeedOutput,
  EntityId
} from "@athenaeum/domain"
import { ledgerExecuteTestHook } from "../src/ledger-service.js"
import {
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

const attribution = (surface: "web-bookmarks" | "macos" = "web-bookmarks") => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface
})

const input = (args: {
  readonly workspaceId: EntityId
  readonly requestId: string
  readonly url?: string
  readonly title?: string
  readonly includeTitle?: boolean
  readonly commitMessage?: string
  readonly attribution?: HumanUiMutationAttribution
}) => Schema.encodeSync(CreateBookmarkInput)(new CreateBookmarkInput({
  workspaceId: args.workspaceId,
  url: args.url ?? "https://EXAMPLE.test/article?token=private",
  ...(args.includeTitle === true || args.title !== undefined ? { title: args.title ?? "" } : {}),
  requestId: args.requestId,
  commitMessage: args.commitMessage ?? "Capture this bookmark for the second brain.",
  attribution: args.attribution ?? attribution()
}))

const bookmarks = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(ListBookmarksOutput)(await stub.listBookmarks({ workspaceId})).bookmarks

const feed = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 })))).entries

describe("createBookmark ledger authority slice", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
  })

  it("preserves exact URL/title values and replays one capture without leaking private fields", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential, email } = await devSignIn(`bookmark-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const first = Schema.decodeUnknownSync(CreateBookmarkOutput)(await connection.stub.createBookmark(input({
        workspaceId,
        requestId: "bookmark-ledger-1",
        title: "Exact title"
      })))
      const replay = Schema.decodeUnknownSync(CreateBookmarkOutput)(await connection.stub.createBookmark(input({
        workspaceId,
        requestId: "bookmark-ledger-1",
        title: "Exact title"
      })))
      expect(replay).toEqual(first)
      expect(first.bookmark.url).toBe("https://EXAMPLE.test/article?token=private")
      expect(first.bookmark.title).toBe("Exact title")

      const native = workspaceDurableObjectStub(workspaceId)
      const requestIdentity = "create-bookmark:bookmark-ledger-1"
      const command = Schema.decodeUnknownSync(CreateBookmarkLedgerCommand)(await native.debugGetLedgerCommand(requestIdentity))
      expect(command).toMatchObject({
        type: "createBookmark",
        principal: email,
        message: "Captured a bookmark.",
        payload: {
          bookmarkId: first.bookmark.id,
          url: "https://EXAMPLE.test/article?token=private",
          title: { present: true, value: "Exact title" },
          commitMessage: "Capture this bookmark for the second brain.",
          attribution: { kind: "humanUi", surface: "web-bookmarks" }
        }
      })
      const event = await native.debugGetLedgerEvent(requestIdentity)
      const outbox = await native.debugGetLedgerOutboxIntent(requestIdentity)
      expect(event).toEqual({ kind: "create-bookmark", payload: { bookmarkId: first.bookmark.id } })
      expect(outbox).toEqual({ kind: "create-bookmark", payload: { bookmarkId: first.bookmark.id } })
      expect(JSON.stringify(event)).not.toContain("private")
      expect(JSON.stringify(outbox)).not.toContain("EXAMPLE")
      expect((await bookmarks(connection.stub, workspaceId)).filter((bookmark) => bookmark.id === first.bookmark.id)).toHaveLength(1)
      expect((await feed(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "bookmark" && entry.entityId === first.bookmark.id)).toHaveLength(1)

      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await connection.stub.listRecentLedgerActivity({ workspaceId, limit: 10 }))
      expect(activity.entries.find((entry) => entry.type === "createBookmark")).toEqual({
        occurredAt: expect.any(String), type: "createBookmark", actor: "you", message: "Captured a bookmark."
      })
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("treats URL, title presence/value, rationale, and attribution as immutable request semantics", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`bookmark-conflicts-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const cases = [
        { requestId: "bookmark-url-conflict", changed: { url: "https://example.test/article?token=private" } },
        { requestId: "bookmark-title-conflict", changed: { title: "Changed", includeTitle: true } },
        { requestId: "bookmark-title-presence-conflict", changed: { includeTitle: true } },
        { requestId: "bookmark-rationale-conflict", changed: { commitMessage: "A different reason." } },
        { requestId: "bookmark-attribution-conflict", changed: { attribution: attribution("macos") } }
      ] as const
      for (const [index, testCase] of cases.entries()) {
        const first = Schema.decodeUnknownSync(CreateBookmarkOutput)(await connection.stub.createBookmark(input({
          workspaceId,
          requestId: testCase.requestId,
          url: `https://example.test/article-${index}`,
          title: index === 2 ? undefined : "Original title",
          includeTitle: index === 2 ? false : true
        })))
        const error = await rejectionToDomainError(connection.stub.createBookmark(input({
          workspaceId,
          requestId: testCase.requestId,
          url: `https://example.test/article-${index}`,
          title: index === 2 ? undefined : "Original title",
          includeTitle: index === 2 ? false : true,
          ...testCase.changed
        })))
        expect(error._tag).toBe("ValidationError")
        expect((await bookmarks(connection.stub, workspaceId)).filter((bookmark) => bookmark.id === first.bookmark.id)).toHaveLength(1)
      }

      const absent = Schema.decodeUnknownSync(CreateBookmarkOutput)(await connection.stub.createBookmark(input({ workspaceId, requestId: "bookmark-absent-title", url: "https://example.test/absent" })))
      const explicitEmpty = Schema.decodeUnknownSync(CreateBookmarkOutput)(await connection.stub.createBookmark(input({ workspaceId, requestId: "bookmark-explicit-empty-title", url: "https://example.test/empty", title: "", includeTitle: true })))
      expect(absent.bookmark.title).toBeUndefined()
      expect(explicitEmpty.bookmark.title).toBe("")
      const absentCommand = await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("create-bookmark:bookmark-absent-title")
      const emptyCommand = await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("create-bookmark:bookmark-explicit-empty-title")
      expect(absentCommand).toMatchObject({ payload: { title: { present: false, value: null } } })
      expect(emptyCommand).toMatchObject({ payload: { title: { present: true, value: "" } } })
      const duplicateA = Schema.decodeUnknownSync(CreateBookmarkOutput)(await connection.stub.createBookmark(input({ workspaceId, requestId: "bookmark-duplicate-a", url: "https://example.test/duplicate" })))
      const duplicateB = Schema.decodeUnknownSync(CreateBookmarkOutput)(await connection.stub.createBookmark(input({ workspaceId, requestId: "bookmark-duplicate-b", url: "https://example.test/duplicate" })))
      expect(duplicateB.bookmark.id).not.toBe(duplicateA.bookmark.id)
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rejects anonymous and rolls back every capture side effect", async () => {
    const workspaceId = freshWorkspaceId()
    const anonymous = await connectToWorkspace(workspaceId)
    const { credential } = await devSignIn(`bookmark-invalid-${crypto.randomUUID()}@example.com`)
    const authenticated = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      expect((await rejectionToDomainError(anonymous.createBookmark(input({ workspaceId, requestId: "bookmark-anonymous" }))))._tag).toBe("Unauthorized")
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("create-bookmark:bookmark-anonymous")).toBeNull()

      const beforeBookmarks = await bookmarks(authenticated.stub, workspaceId)
      const beforeFeed = await feed(authenticated.stub, workspaceId)
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("createBookmark ledger failpoint") }
      expect((await rejectionToDomainError(authenticated.stub.createBookmark(input({ workspaceId, requestId: "bookmark-rollback" }))))._tag).toBe("UnexpectedError")
      ledgerExecuteTestHook.afterMutation = undefined
      expect(await bookmarks(authenticated.stub, workspaceId)).toEqual(beforeBookmarks)
      expect(await feed(authenticated.stub, workspaceId)).toEqual(beforeFeed)
      expect(await native.debugGetLedgerCommand("create-bookmark:bookmark-rollback")).toBeNull()
      expect(await native.debugGetLedgerReceipt("create-bookmark:bookmark-rollback")).toBeNull()
      expect(await native.debugGetLedgerEvent("create-bookmark:bookmark-rollback")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("create-bookmark:bookmark-rollback")).toBeNull()
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
      authenticated.stub[Symbol.dispose]()
      anonymous[Symbol.dispose]()
    }
  })
})
