// Real proof of the App Library backend-implementation stage: `AppsService` (mainline/direct
// CRUD, `apps-service-live.ts`) and `AgentEditService`'s agent-facing `createAppTool`/
// `updateAppCodeTool` pair (`agent-edit-service-live.ts`), both exercised over the real production
// Cap'n Web RPC path exactly like `agent-edit.test.ts` — never a shortcut into either service's
// internals.
//
// Per this task's hard constraint (no real LLM API key exists in this environment): the
// agent-facing path is driven by a deterministic `ModelClientScripted` double programmed to
// author REAL, hand-written app code — a tiny sandboxed counter Worker (`server`) and a matching
// iframe UI (`client`) — proving the create/propose/accept-or-revert PIPELINE end-to-end for
// real, even though actual LLM-driven code-generation quality can't be evaluated without a live
// key (stated explicitly, not glossed over).

import { exports } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  AppIcon,
  CreateAppInput,
  CreateAppOutput,
  CreateChatInput,
  CreateChatOutput,
  DeleteAppInput,
  DeleteAppOutput,
  GetAppCodeInput,
  GetAppCodeOutput,
  GetAppInput,
  GetAppOutput,
  ListAppsInput,
  ListAppsOutput,
  ListChatChangesInput,
  ListChatChangesOutput,
  MergeChangesInput,
  ModelClient,
  ModelTurnFinalText,
  ModelTurnToolCalls,
  RevertChangesInput,
  SendChatMessageInput,
  SendChatMessageOutput,
  ToolCallRequest,
  UpdateAppCodeInput,
  UpdateAppCodeOutput
} from "@athenaeum/domain"
import { agentEditTestHooks } from "../src/agent-edit-service-live.js"
import { agentEditModelClientTestHook } from "../src/workspace-durable-object.js"
import { makeModelClientScripted } from "../src/model-client-scripted.js"
import { connectToWorkspaceAsTestUser, freshWorkspaceId, rejectionToDomainError } from "./support.js"

const installScriptedModel = (script: ReadonlyArray<ModelTurnToolCalls | ModelTurnFinalText>) => {
  const scripted = makeModelClientScripted(script)
  const service = Effect.runSync(ModelClient.pipe(Effect.provide(scripted.layer)))
  agentEditModelClientTestHook.converse = service.converse
  return scripted
}

// Drives the real plain-HTTP `.../apps/:appId/run` route through the real Worker `fetch` entry
// point (`exports.default.fetch`) — the same route `app-runtime.test.ts` proves the sandboxed
// runtime's security boundary against, reused here (on an ungoverned `freshWorkspaceId()`
// workspace, so no credential is needed — `requireRoleForGovernedWorkspace`'s own doc comment:
// "ungoverned workspace: unchanged pre-Phase-4 behavior") to prove the SEPARATE concern this
// stage cares about: that code the AGENT-AUTHORING pipeline proposed and `mergeChanges` promoted
// is not just stored/readable, but actually executes through `AppRuntimeService` afterward.
const runAppHttp = (workspaceId: string, appId: string, restPath: string): Promise<Response> =>
  exports.default.fetch(
    new Request(`https://athenaeum.invalid/api/workspace/${workspaceId}/apps/${appId}/run${restPath}`)
  )

// A real, hand-written, tiny sandboxed Worker Loader module — this is the "server" code kind
// (app.ts's `AppCodeKind`): a counter that reads/increments an in-memory count per request. Small
// enough to be readable in a test assertion, real enough to prove the pipeline stores/versions
// actual executable-looking source, not a placeholder string.
const COUNTER_SERVER_CODE = `
let count = 0
export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/increment") count++
    return new Response(JSON.stringify({ count }), { headers: { "content-type": "application/json" } })
  }
}
`.trim()

// A real, hand-written "client" code kind — the iframe-rendered UI bundle counterpart.
const COUNTER_CLIENT_CODE = `
<!doctype html>
<html>
  <body>
    <button id="inc">+1</button>
    <span id="count">0</span>
    <script>
      document.getElementById("inc").addEventListener("click", async () => {
        const res = await fetch("/increment")
        const data = await res.json()
        document.getElementById("count").textContent = String(data.count)
      })
    </script>
  </body>
</html>
`.trim()

describe("AppsService: mainline CRUD (createApp/updateAppCode/listApps/getApp/getAppCode/deleteApp)", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspaceAsTestUser>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("creates a codeless App, writes real server+client code, reads it back, versions correctly, then deletes", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    const created = Schema.decodeUnknownSync(CreateAppOutput)(
      await workspaceStub.createApp(
        Schema.encodeSync(CreateAppInput)(
          new CreateAppInput({ workspaceId, title: "Counter", icon: AppIcon.make("🧮") })
        )
      )
    ).app
    expect(created.clientCodeVersion).toBe(0)
    expect(created.serverCodeVersion).toBe(0)
    expect(created.pending).toBeUndefined()

    // Mainline listApps sees it immediately (never pending).
    const listed = Schema.decodeUnknownSync(ListAppsOutput)(
      await workspaceStub.listApps(Schema.encodeSync(ListAppsInput)(new ListAppsInput({ workspaceId })))
    ).apps
    expect(listed.find((a) => a.id === created.id)).toBeDefined()

    // Write real server code — version becomes 1, pointer advances immediately (mainline, no pending).
    const afterServer = Schema.decodeUnknownSync(UpdateAppCodeOutput)(
      await workspaceStub.updateAppCode(
        Schema.encodeSync(UpdateAppCodeInput)(
          new UpdateAppCodeInput({ workspaceId, appId: created.id, kind: "server", code: COUNTER_SERVER_CODE })
        )
      )
    )
    expect(afterServer.codeVersion.version).toBe(1)
    expect(afterServer.codeVersion.code).toBe(COUNTER_SERVER_CODE)
    expect(afterServer.app.serverCodeVersion).toBe(1)
    expect(afterServer.app.clientCodeVersion).toBe(0)

    // Write real client code too — independent version counter, also becomes 1.
    const afterClient = Schema.decodeUnknownSync(UpdateAppCodeOutput)(
      await workspaceStub.updateAppCode(
        Schema.encodeSync(UpdateAppCodeInput)(
          new UpdateAppCodeInput({ workspaceId, appId: created.id, kind: "client", code: COUNTER_CLIENT_CODE })
        )
      )
    )
    expect(afterClient.codeVersion.version).toBe(1)
    expect(afterClient.app.clientCodeVersion).toBe(1)
    expect(afterClient.app.serverCodeVersion).toBe(1)

    // A second server-code write advances the SERVER counter independently to 2, leaving client at 1.
    const secondServerWrite = Schema.decodeUnknownSync(UpdateAppCodeOutput)(
      await workspaceStub.updateAppCode(
        Schema.encodeSync(UpdateAppCodeInput)(
          new UpdateAppCodeInput({
            workspaceId,
            appId: created.id,
            kind: "server",
            code: COUNTER_SERVER_CODE.replace("count++", "count += 1")
          })
        )
      )
    )
    expect(secondServerWrite.codeVersion.version).toBe(2)
    expect(secondServerWrite.app.serverCodeVersion).toBe(2)
    expect(secondServerWrite.app.clientCodeVersion).toBe(1)

    // getAppCode with no explicit version resolves the current pointer (server = v2).
    const currentServerCode = Schema.decodeUnknownSync(GetAppCodeOutput)(
      await workspaceStub.getAppCode(
        Schema.encodeSync(GetAppCodeInput)(new GetAppCodeInput({ workspaceId, appId: created.id, kind: "server" }))
      )
    ).codeVersion
    expect(currentServerCode.version).toBe(2)
    expect(currentServerCode.code).toContain("count += 1")

    // getAppCode with an explicit historical version still retrieves it (retained history).
    const historicalServerCode = Schema.decodeUnknownSync(GetAppCodeOutput)(
      await workspaceStub.getAppCode(
        Schema.encodeSync(GetAppCodeInput)(
          new GetAppCodeInput({ workspaceId, appId: created.id, kind: "server", version: 1 })
        )
      )
    ).codeVersion
    expect(historicalServerCode.code).toBe(COUNTER_SERVER_CODE)

    // getApp reflects the latest pointers.
    const refetched = Schema.decodeUnknownSync(GetAppOutput)(
      await workspaceStub.getApp(Schema.encodeSync(GetAppInput)(new GetAppInput({ workspaceId, appId: created.id })))
    ).app
    expect(refetched.serverCodeVersion).toBe(2)
    expect(refetched.clientCodeVersion).toBe(1)

    // deleteApp removes it — both listApps and getApp/getAppCode now fail/omit it.
    const deleted = Schema.decodeUnknownSync(DeleteAppOutput)(
      await workspaceStub.deleteApp(Schema.encodeSync(DeleteAppInput)(new DeleteAppInput({ workspaceId, appId: created.id })))
    )
    expect(deleted.deleted).toBe(true)

    const listedAfterDelete = Schema.decodeUnknownSync(ListAppsOutput)(
      await workspaceStub.listApps(Schema.encodeSync(ListAppsInput)(new ListAppsInput({ workspaceId })))
    ).apps
    expect(listedAfterDelete.find((a) => a.id === created.id)).toBeUndefined()

    const getAppError = await rejectionToDomainError(
      workspaceStub.getApp(Schema.encodeSync(GetAppInput)(new GetAppInput({ workspaceId, appId: created.id })))
    )
    expect(getAppError._tag).toBe("AppNotFound")
  })

  it("getAppCode fails AppCodeVersionNotFound when a kind has no code yet", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const created = Schema.decodeUnknownSync(CreateAppOutput)(
      await workspaceStub.createApp(
        Schema.encodeSync(CreateAppInput)(new CreateAppInput({ workspaceId, title: "Blank", icon: AppIcon.make("✨") }))
      )
    ).app

    const error = await rejectionToDomainError(
      workspaceStub.getAppCode(
        Schema.encodeSync(GetAppCodeInput)(new GetAppCodeInput({ workspaceId, appId: created.id, kind: "server" }))
      )
    )
    expect(error._tag).toBe("AppCodeVersionNotFound")
  })

  it("updateAppCode rejects code over MAX_APP_CODE_BYTES with AppCodeTooLarge", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const created = Schema.decodeUnknownSync(CreateAppOutput)(
      await workspaceStub.createApp(
        Schema.encodeSync(CreateAppInput)(new CreateAppInput({ workspaceId, title: "Huge", icon: AppIcon.make("🧮") }))
      )
    ).app

    const tooLargeCode = "x".repeat(256 * 1024 + 1)
    const error = await rejectionToDomainError(
      workspaceStub.updateAppCode(
        Schema.encodeSync(UpdateAppCodeInput)(
          new UpdateAppCodeInput({ workspaceId, appId: created.id, kind: "server", code: tooLargeCode })
        )
      )
    )
    expect(error._tag).toBe("AppCodeTooLarge")
  })
})

describe("AgentEditService: createApp/updateAppCode tools — real counter app authored through the pending pipeline", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspaceAsTestUser>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
  })

  it("proposes a new pending App with real server+client code, invisible to mainline reads, then mergeChanges makes it real", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({
            id: "call_1",
            name: "createApp",
            input: { title: "Counter", icon: "🧮", binding: "COUNTER" }
          }),
          new ToolCallRequest({
            id: "call_2",
            name: "updateAppCode",
            input: { binding: "COUNTER", kind: "server", code: COUNTER_SERVER_CODE }
          }),
          new ToolCallRequest({
            id: "call_3",
            name: "updateAppCode",
            input: { binding: "COUNTER", kind: "client", code: COUNTER_CLIENT_CODE }
          })
        ]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Built a counter App with a server and a client." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Build a counter" })))
    ).chat

    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Build me a counter App." }))
      )
    )
    expect(turn.changesSequences).toEqual([0, 1, 2])

    const changes = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    expect(changes.length).toBe(3)
    expect(changes[0]!.createdApps?.[0]!.title).toBe("Counter")
    expect(changes[1]!.updatedAppCode?.[0]!.kind).toBe("server")
    expect(changes[1]!.updatedAppCode?.[0]!.version).toBe(1)
    expect(changes[2]!.updatedAppCode?.[0]!.kind).toBe("client")
    expect(changes[2]!.updatedAppCode?.[0]!.version).toBe(1)
    const appId = changes[0]!.createdApps?.[0]!.appId
    expect(appId).toBeDefined()

    // --- Invisible to mainline listApps/getApp before merge -----------------------------------
    const appsBeforeMerge = Schema.decodeUnknownSync(ListAppsOutput)(
      await workspaceStub.listApps(Schema.encodeSync(ListAppsInput)(new ListAppsInput({ workspaceId })))
    ).apps
    expect(appsBeforeMerge.find((a) => a.id === appId)).toBeUndefined()

    // --- mergeChanges promotes the App AND both pending code versions in one shot -------------
    await workspaceStub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 2 })))

    const appsAfterMerge = Schema.decodeUnknownSync(ListAppsOutput)(
      await workspaceStub.listApps(Schema.encodeSync(ListAppsInput)(new ListAppsInput({ workspaceId })))
    ).apps
    const mergedApp = appsAfterMerge.find((a) => a.id === appId)
    expect(mergedApp).toBeDefined()
    expect(mergedApp!.pending).toBeUndefined()
    expect(mergedApp!.serverCodeVersion).toBe(1)
    expect(mergedApp!.clientCodeVersion).toBe(1)

    const serverCode = Schema.decodeUnknownSync(GetAppCodeOutput)(
      await workspaceStub.getAppCode(
        Schema.encodeSync(GetAppCodeInput)(new GetAppCodeInput({ workspaceId, appId: appId!, kind: "server" }))
      )
    ).codeVersion
    expect(serverCode.code).toBe(COUNTER_SERVER_CODE)

    const clientCode = Schema.decodeUnknownSync(GetAppCodeOutput)(
      await workspaceStub.getAppCode(
        Schema.encodeSync(GetAppCodeInput)(new GetAppCodeInput({ workspaceId, appId: appId!, kind: "client" }))
      )
    ).codeVersion
    expect(clientCode.code).toBe(COUNTER_CLIENT_CODE)

    // --- The merged App doesn't just READ back correctly — it actually RUNS through the real
    // sandboxed AppRuntimeService (a genuine `env.LOADER.get()` Worker Loader isolate), proving
    // the full pipeline this stage exists to verify: agent-authored code, proposed as a pending
    // change, promoted by `mergeChanges`, then genuinely executed. -------------------------------
    const initialRun = await runAppHttp(workspaceId, appId!, "")
    expect(initialRun.status).toBe(200)
    expect(await initialRun.json()).toEqual({ count: 0 })

    const afterIncrement = await runAppHttp(workspaceId, appId!, "/increment")
    expect(afterIncrement.status).toBe(200)
    expect(await afterIncrement.json()).toEqual({ count: 1 })
  })

  it("revertChanges deletes a never-merged pending App entirely, including its pending code versions", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({ id: "call_1", name: "createApp", input: { title: "Scratch", icon: "✨", binding: "SCRATCH" } }),
          new ToolCallRequest({
            id: "call_2",
            name: "updateAppCode",
            input: { binding: "SCRATCH", kind: "server", code: COUNTER_SERVER_CODE }
          })
        ]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "..." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Scratch app" })))
    ).chat

    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Make a scratch App." }))
    )

    const changes = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    const appId = changes[0]!.createdApps?.[0]!.appId!

    await workspaceStub.revertChanges(Schema.encodeSync(RevertChangesInput)(new RevertChangesInput({ chatId: chat.id, revertFrom: 0 })))

    const getAppError = await rejectionToDomainError(
      workspaceStub.getApp(Schema.encodeSync(GetAppInput)(new GetAppInput({ workspaceId, appId })))
    )
    expect(getAppError._tag).toBe("AppNotFound")

    const getCodeError = await rejectionToDomainError(
      workspaceStub.getAppCode(
        Schema.encodeSync(GetAppCodeInput)(new GetAppCodeInput({ workspaceId, appId, kind: "server", version: 1 }))
      )
    )
    // The App itself is gone, so its code versions are unreachable through the mainline path too
    // (getAppCode's own `AppNotFound` check on `appId` fires first).
    expect(getCodeError._tag).toBe("AppNotFound")
  })

  it("re-editing an already-accepted App (same chat, later turn) proposes a new pending code version; reverting it keeps the App real but discards only the proposal", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    // Turn 1: create the App and write its first server code, then accept — a real, mainline App
    // with `updatedAt !== createdAt` (the `promoteApp` bump), the exact precondition
    // `revertApp`'s `wasNeverAccepted` discriminator (agent-edit-service-live.ts) needs to decide
    // "keep the row" instead of "delete it" on a later revert.
    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({ id: "call_1", name: "createApp", input: { title: "Counter", icon: "🧮", binding: "COUNTER" } }),
          new ToolCallRequest({
            id: "call_2",
            name: "updateAppCode",
            input: { binding: "COUNTER", kind: "server", code: COUNTER_SERVER_CODE }
          })
        ]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "..." })
    ])
    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Counter, then a fix" })))
    ).chat
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Build a counter." }))
    )
    await workspaceStub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 1 })))

    const changesAfterTurn1 = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    const appId = changesAfterTurn1[0]!.createdApps?.[0]!.appId!
    const realApp = Schema.decodeUnknownSync(GetAppOutput)(
      await workspaceStub.getApp(Schema.encodeSync(GetAppInput)(new GetAppInput({ workspaceId, appId })))
    ).app
    expect(realApp.pending).toBeUndefined()
    expect(realApp.serverCodeVersion).toBe(1)

    // Turn 2 (SAME chat — its binding map still resolves "COUNTER" to this now-real App):
    // propose a fix to the server code. This re-marks the already-real App pending again.
    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({
            id: "call_1",
            name: "updateAppCode",
            input: { binding: "COUNTER", kind: "server", code: COUNTER_SERVER_CODE.replace("count++", "count += 2") }
          })
        ]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "..." })
    ])
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Actually, increment by 2." }))
    )

    const pendingEdit = Schema.decodeUnknownSync(GetAppOutput)(
      await workspaceStub.getApp(Schema.encodeSync(GetAppInput)(new GetAppInput({ workspaceId, appId })))
    ).app
    expect(pendingEdit.pending).toBeDefined()
    // Mainline pointer is untouched until accepted — still serving the ORIGINAL v1 code.
    expect(pendingEdit.serverCodeVersion).toBe(1)

    // Revert the proposal: the App row survives (it was already real before this turn), but the
    // pending v2 code version is gone and the pointer is unchanged.
    const changesAfterTurn2 = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    const turn2Sequence = changesAfterTurn2[changesAfterTurn2.length - 1]!.sequence
    await workspaceStub.revertChanges(
      Schema.encodeSync(RevertChangesInput)(new RevertChangesInput({ chatId: chat.id, revertFrom: turn2Sequence }))
    )

    const afterRevert = Schema.decodeUnknownSync(GetAppOutput)(
      await workspaceStub.getApp(Schema.encodeSync(GetAppInput)(new GetAppInput({ workspaceId, appId })))
    ).app
    expect(afterRevert.pending).toBeUndefined()
    expect(afterRevert.serverCodeVersion).toBe(1)

    const currentCode = Schema.decodeUnknownSync(GetAppCodeOutput)(
      await workspaceStub.getAppCode(
        Schema.encodeSync(GetAppCodeInput)(new GetAppCodeInput({ workspaceId, appId, kind: "server" }))
      )
    ).codeVersion
    expect(currentCode.code).toBe(COUNTER_SERVER_CODE)

    // The pending v2 row itself is gone (never became real) — an explicit fetch for it 404s.
    const goneVersion = await rejectionToDomainError(
      workspaceStub.getAppCode(
        Schema.encodeSync(GetAppCodeInput)(new GetAppCodeInput({ workspaceId, appId, kind: "server", version: 2 }))
      )
    )
    expect(goneVersion._tag).toBe("AppCodeVersionNotFound")
  })
})

describe("AgentEditService: crash-safety — reconcilePendingChanges handles Apps too", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspaceAsTestUser>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
    agentEditTestHooks.skipToolLog = false
    agentEditTestHooks.skipFlush = false
    agentEditTestHooks.skipReconcile = false
  })

  it("orphan case: a pending App with no logged tool call is reaped, not re-adopted", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "call_1", name: "createApp", input: { title: "Orphan", icon: "🧮", binding: "ORPHAN" } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "..." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Orphan app test" })))
    ).chat

    // Simulate a crash: the pending write happens, but NEITHER the tool-call log NOR the flush NOR
    // `sendChatMessage`'s own automatic start-/end-of-turn reconcile ever lands — mirrors
    // `agent-edit.test.ts`'s exact "orphan case" scenario, substituting `createApp` for `createNode`.
    agentEditTestHooks.skipToolLog = true
    agentEditTestHooks.skipFlush = true
    agentEditTestHooks.skipReconcile = true
    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create an orphan App." }))
      )
    )
    expect(turn.changesSequences).toEqual([])

    // "The DO restarts" (hooks back to normal); a fresh turn's start-of-turn reconcile finds the
    // orphaned, never-logged pending App and reaps (deletes) it, not re-adopts it.
    agentEditTestHooks.skipToolLog = false
    agentEditTestHooks.skipFlush = false
    agentEditTestHooks.skipReconcile = false
    installScriptedModel([new ModelTurnFinalText({ kind: "final_text", text: "noop" })])
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "trigger reconcile" }))
    )

    const changes = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    expect(changes.length).toBe(0)

    const apps = Schema.decodeUnknownSync(ListAppsOutput)(
      await workspaceStub.listApps(Schema.encodeSync(ListAppsInput)(new ListAppsInput({ workspaceId })))
    ).apps
    expect(apps.find((a) => a.title === "Orphan")).toBeUndefined()

    // A merge over any range is a safe no-op — there is nothing left pending to promote.
    await workspaceStub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 100 })))
    const appsAfterMerge = Schema.decodeUnknownSync(ListAppsOutput)(
      await workspaceStub.listApps(Schema.encodeSync(ListAppsInput)(new ListAppsInput({ workspaceId })))
    ).apps
    expect(appsAfterMerge.find((a) => a.title === "Orphan")).toBeUndefined()
  })

  it("re-adopt case: a pending App whose tool call WAS logged, but never flushed, is re-adopted (stamped) on reconcile", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "call_1", name: "createApp", input: { title: "Readopt Me", icon: "🧮", binding: "READOPT" } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "..." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Re-adopt app test" })))
    ).chat

    // Crash lands between the log write and the flush: the tool call IS logged, but neither the
    // flush that would stamp `pending.sequence` NOR the automatic end-of-turn reconcile ever runs.
    agentEditTestHooks.skipFlush = true
    agentEditTestHooks.skipReconcile = true
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create a re-adoptable App." }))
    )

    const beforeReconcile = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    expect(beforeReconcile.length).toBe(0)

    // "The DO restarts": both hooks back to normal, and a fresh turn's start-of-turn reconcile
    // finds the logged-but-unstamped App and re-adopts it (stamps it via a brand-new `ChangesMessage`
    // with a `createdApps` summary) before the model is even called.
    agentEditTestHooks.skipFlush = false
    agentEditTestHooks.skipReconcile = false
    installScriptedModel([new ModelTurnFinalText({ kind: "final_text", text: "noop" })])
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "trigger reconcile" }))
    )

    const afterReconcile = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    expect(afterReconcile.length).toBe(1)
    expect(afterReconcile[0]!.createdApps?.[0]!.title).toBe("Readopt Me")

    // The re-adopted App is now mergeable.
    await workspaceStub.mergeChanges(
      Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: afterReconcile[0]!.sequence }))
    )
    const apps = Schema.decodeUnknownSync(ListAppsOutput)(
      await workspaceStub.listApps(Schema.encodeSync(ListAppsInput)(new ListAppsInput({ workspaceId })))
    ).apps
    expect(apps.find((a) => a.title === "Readopt Me")).toBeDefined()
  })
})
