import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  AppIcon,
  CreateAppInput,
  CreateAppOutput,
  DeleteAppInput,
  DeleteAppOutput,
  GetAppInput,
  GetAppOutput,
  GetAppCodeInput,
  GetAppCodeOutput,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListRecentLedgerActivityInput,
  ListRecentLedgerActivityOutput,
  UpdateAppCodeInput,
  UpdateAppCodeOutput
} from "@athenaeum/domain"
import { ledgerExecuteTestHook } from "../src/ledger-service.js"
import { migrateLegacyAppRecord } from "../src/app-collections.js"
import { connectToWorkspace, connectToWorkspaceWithSocketAs, devSignIn, freshNodeId, freshWorkspaceId, rejectionToDomainError, workspaceDurableObjectStub } from "./support.js"

const attribution = () => new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-app-library" })

describe("App lifecycle workspace ledger", () => {
  let stub: Awaited<ReturnType<typeof connectToWorkspaceWithSocketAs>>["stub"] | undefined
  afterEach(() => { stub?.[Symbol.dispose](); stub = undefined; ledgerExecuteTestHook.afterMutation = undefined })

  const connect = async (workspaceId: ReturnType<typeof freshWorkspaceId>) => {
    const { credential, email } = await devSignIn(`app-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    stub = connection.stub
    return email
  }
  const createInput = (workspaceId: ReturnType<typeof freshWorkspaceId>, id: ReturnType<typeof freshNodeId>, requestId: string) =>
    Schema.encodeSync(CreateAppInput)(new CreateAppInput({ workspaceId, id, title: "Ledger App", icon: AppIcon.make("🧪"), requestId, commitMessage: "Create the ledger app.", attribution: attribution() }))

  it("requires authentication and a stable create intent, then replays without raw artifacts", async () => {
    const workspaceId = freshWorkspaceId(); const id = freshNodeId(); const anonymous = await connectToWorkspace(workspaceId)
    expect((await rejectionToDomainError(anonymous.createApp(createInput(workspaceId, id, "anonymous"))))._tag).toBe("Unauthorized")
    anonymous[Symbol.dispose](); const email = await connect(workspaceId)
    const first = Schema.decodeUnknownSync(CreateAppOutput)(await stub!.createApp(createInput(workspaceId, id, "create-1")))
    const replay = Schema.decodeUnknownSync(CreateAppOutput)(await stub!.createApp(createInput(workspaceId, id, "create-1")))
    expect(replay).toEqual(first)
    const collision = await rejectionToDomainError(stub!.createApp(createInput(workspaceId, id, "create-2")))
    expect(collision._tag).toBe("ValidationError")
    const native = workspaceDurableObjectStub(workspaceId)
    const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand("create-app:create-1"))
    expect(command).toMatchObject({ type: "createApp", principal: email, payload: { appId: id } })
    expect(await native.debugGetLedgerCustody("create-app:create-1")).toMatchObject({ actorKind: "user", targetKind: "app", targetId: id })
    const serialized = JSON.stringify([await native.debugGetLedgerCommand("create-app:create-1"), await native.debugGetLedgerReceipt("create-app:create-1"), await native.debugGetLedgerEvent("create-app:create-1"), await native.debugGetLedgerOutboxIntent("create-app:create-1")])
    expect(serialized).not.toContain("export default")
    const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await stub!.listRecentLedgerActivity(
      Schema.encodeSync(ListRecentLedgerActivityInput)(new ListRecentLedgerActivityInput({ workspaceId, limit: 20 }))
    ))
    const appActivity = activity.entries.find((entry) => entry.type === "createApp")
    expect(appActivity).toMatchObject({ type: "createApp", actor: "you", message: "Created an App." })
    expect(JSON.stringify(appActivity)).not.toContain(id)
    expect(JSON.stringify(appActivity)).not.toContain("Create the ledger app.")
  })

  it("fences stale code saves and binds exact UTF-8 source identity without retaining source", async () => {
    const workspaceId = freshWorkspaceId(); const id = freshNodeId(); await connect(workspaceId)
    await stub!.createApp(createInput(workspaceId, id, "create-code"))
    const app = Schema.decodeUnknownSync(GetAppOutput)(await stub!.getApp(Schema.encodeSync(GetAppInput)(new GetAppInput({ workspaceId, appId: id })))).app
    const code = "// CRLF\r\nconst café = '😀\0';\r\n"
    const firstInput = new UpdateAppCodeInput({ workspaceId, appId: id, kind: "client", code, expectedCurrentVersion: 0, expectedRevision: app.revision, expectedUpdatedAt: app.updatedAt, requestId: "code-1", commitMessage: "Save literal client source.", attribution: attribution() })
    const first = Schema.decodeUnknownSync(UpdateAppCodeOutput)(await stub!.updateAppCode(Schema.encodeSync(UpdateAppCodeInput)(firstInput)))
    const replay = Schema.decodeUnknownSync(UpdateAppCodeOutput)(await stub!.updateAppCode(Schema.encodeSync(UpdateAppCodeInput)(firstInput)))
    expect(replay).toEqual(first)
    const stale = await rejectionToDomainError(stub!.updateAppCode(Schema.encodeSync(UpdateAppCodeInput)(new UpdateAppCodeInput({ ...firstInput, requestId: "code-stale", code: "different", expectedCurrentVersion: 0, expectedUpdatedAt: app.updatedAt }))))
    expect(stale._tag).toBe("ValidationError")
    const native = workspaceDurableObjectStub(workspaceId)
    const serialized = JSON.stringify([await native.debugGetLedgerCommand("update-app-code:code-1"), await native.debugGetLedgerReceipt("update-app-code:code-1"), await native.debugGetLedgerEvent("update-app-code:code-1"), await native.debugGetLedgerOutboxIntent("update-app-code:code-1")])
    expect(serialized).not.toContain(code)
    expect(serialized).toContain("codeSha256")
    expect(serialized).toContain("byteLength")
  })

  it("rolls a fenced delete back atomically", async () => {
    const workspaceId = freshWorkspaceId(); const id = freshNodeId(); await connect(workspaceId)
    const created = Schema.decodeUnknownSync(CreateAppOutput)(await stub!.createApp(createInput(workspaceId, id, "create-delete"))).app
    const updated = Schema.decodeUnknownSync(UpdateAppCodeOutput)(await stub!.updateAppCode(Schema.encodeSync(UpdateAppCodeInput)(new UpdateAppCodeInput({
      workspaceId, appId: id, kind: "server", code: "export default {}", expectedCurrentVersion: 0, expectedRevision: created.revision,
      expectedUpdatedAt: created.updatedAt, requestId: "delete-code", commitMessage: "Add code before delete rollback.", attribution: attribution()
    })))).app
    ledgerExecuteTestHook.afterMutation = () => { throw new Error("app delete rollback") }
    const input = new DeleteAppInput({ workspaceId, appId: id, expectedUpdatedAt: updated.updatedAt, expectedRevision: updated.revision, expectedClientCodeVersion: 0, expectedServerCodeVersion: 1, requestId: "delete-rollback", commitMessage: "Exercise delete rollback.", attribution: attribution() })
    expect((await rejectionToDomainError(stub!.deleteApp(Schema.encodeSync(DeleteAppInput)(input))))._tag).toBe("UnexpectedError")
    const native = workspaceDurableObjectStub(workspaceId)
    expect(await native.debugGetLedgerCommand("delete-app:delete-rollback")).toBeNull()
    expect(Schema.decodeUnknownSync(GetAppOutput)(await stub!.getApp(Schema.encodeSync(GetAppInput)(new GetAppInput({ workspaceId, appId: id })))).app.id).toBe(id)
    expect(Schema.decodeUnknownSync(GetAppCodeOutput)(await stub!.getAppCode(Schema.encodeSync(GetAppCodeInput)(new GetAppCodeInput({ workspaceId, appId: id, kind: "server" })))).codeVersion.code).toBe("export default {}")
  })

  it("migrates legacy App lifecycle rows as accepted lineage without timestamp guessing", () => {
    const legacy = {
      id: freshNodeId(), workspaceId: freshWorkspaceId(), title: "Historical App", icon: "🧭",
      clientCodeVersion: 0, serverCodeVersion: 0,
      createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
      pending: { chatId: freshNodeId() }
    }
    const migrated = migrateLegacyAppRecord(legacy)
    expect(migrated.legacy).toBe(true)
    expect(migrated.value).toMatchObject({ revision: 1, acceptedRevision: 1, pending: legacy.pending })

    const modern = migrateLegacyAppRecord({ ...legacy, revision: 4, acceptedRevision: 3 })
    expect(modern.legacy).toBe(false)
    expect(modern.value).toEqual({ ...legacy, revision: 4, acceptedRevision: 3 })
  })
})
