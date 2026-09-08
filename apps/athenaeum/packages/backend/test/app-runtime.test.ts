// Real proof of the App Library backend-EXECUTION stage: `AppRuntimeService`
// (`src/app-runtime-service-live.ts`) and the two plain-HTTP App routes
// (`src/workspace-durable-object.ts`'s `#handleAppRoute`/`#runAppRequest`/`#serveAppClientCode`) —
// exercised over a real, running `WorkspaceDurableObject`, a real Worker Loader binding
// (`wrangler.jsonc`'s `worker_loaders`), and real dynamically-loaded Worker isolates. Every
// "server" module below is real, hand-written source — never a placeholder string — proving the
// full pipeline (`createApp`/`updateAppCode` RPC -> `AppRuntimeService.runRequest` ->
// `env.LOADER.get()` -> a real loaded Worker's `fetch()` -> the `Response` this test asserts on)
// actually executes agent-author-shaped code, even though no real LLM key exists in this
// environment to generate that code (per this task's hard constraint — the Apps Service stage's
// own `app-library.test.ts` already proves the `ModelClientScripted`-driven authoring pipeline;
// THIS file proves the separate concern of running whatever code that pipeline produces).
//
// What this file's negative tests DO and DO NOT prove, stated explicitly (per this task's own
// instruction to be honest about the isolation guarantee):
//   - PROVEN: the `env` a loaded App Worker actually receives at runtime is empty (`Object.keys(env)
//     === []`) — not "we believe it's empty because we wrote `env: {}`," but "the sandboxed code
//     itself, executing for real inside its own loaded isolate, observed zero ambient bindings."
//   - PROVEN: the loaded Worker's global `fetch()` is genuinely blocked (`globalOutbound: null`) —
//     a real `fetch()` call from inside the sandboxed code, executing for real, throws, INCLUDING
//     an attempted fetch back to the literal address of this same workspace's own RPC API
//     (`https://athenaeum.invalid/api/workspace/:workspaceId`) — not just some unrelated
//     third-party host.
//   - PROVEN: two different Apps (and the same App across a code-version bump) never share
//     in-memory module-scope state — each observed to start its own counter at zero independently.
//   - PROVEN: a caller without workspace access is rejected (401 with no credential on a governed
//     workspace, 403 with a credential that carries no role in it) before ever reaching
//     `AppRuntimeService`.
//   - NOT proven here (structural/by-construction, not independently tested): that DO storage
//     (`ctx.storage`) itself is unreachable from inside a loaded Worker. This isn't tested by
//     trying to break in and failing — it's true by construction, because
//     `app-runtime-service-live.ts#makeAppRuntimeServiceLive` never constructs a
//     `WorkerLoaderWorkerCode.env` value that references `ctx.storage`, `AppsRepository`, or any
//     other service at all (see that file's own header comment). The `env` emptiness test above is
//     the closest empirical proxy available: if `env` is empty, there is nothing for sandboxed code
//     to call, full stop — but this file does not claim to have attempted and blocked a storage
//     access attempt, since no such access is ever offered as an ambient global in the first place.

import { exports } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  AppIcon,
  CreateAppInput,
  CreateAppOutput,
  CreateWorkspaceInput,
  CreateWorkspaceOutput,
  GetAppInput,
  GetAppOutput,
  HumanUiMutationAttribution,
  MintAppRunCredentialInput,
  MintAppRunCredentialOutput,
  UpdateAppCodeInput,
  UpdateAppCodeOutput,
  type EntityId
} from "@athenaeum/domain"
import {
  connectToUserAs,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshNodeId,
  freshWorkspaceId,
  rejectionToDomainError,
  type WorkspaceApi
} from "./support.js"
import type { RpcStub } from "capnweb"

const freshEmail = (label: string): string => `app-runtime-${label}-${crypto.randomUUID()}@rawkode.academy`

const appAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "web-app-library"
})

/** Same local helper `phase4-exit-criteria.test.ts` defines for itself — registers a real,
 *  governed workspace (via `UserDurableObject#createWorkspace`) owned by `credential`'s identity,
 *  so `requireRoleForGovernedWorkspace` actually enforces something for this file's negative
 *  tests (a bare `freshWorkspaceId()` with no owner is deliberately wide-open — see that helper's
 *  own doc comment in `workspace-durable-object.ts`). */
const createWorkspace = async (credential: string, title: string): Promise<EntityId> => {
  const { stub, socket } = await connectToUserAs(credential)
  try {
    const created = Schema.decodeUnknownSync(CreateWorkspaceOutput)(
      await stub.createWorkspace(Schema.encodeSync(CreateWorkspaceInput)(new CreateWorkspaceInput({ title })))
    )
    return created.workspace.workspaceId
  } finally {
    stub[Symbol.dispose]()
    socket.close()
  }
}

const runAppHttp = (
  workspaceId: EntityId,
  appId: EntityId,
  restPath: string,
  opts?: { readonly credential?: string; readonly method?: string }
): Promise<Response> =>
  exports.default.fetch(
    new Request(`https://athenaeum.invalid/api/workspace/${workspaceId}/apps/${appId}/run${restPath}`, {
      method: opts?.method ?? "GET",
      ...(opts?.credential !== undefined ? { headers: { Authorization: `Bearer ${opts.credential}` } } : {})
    })
  )

const fetchAppClientJs = (
  workspaceId: EntityId,
  appId: EntityId,
  opts?: { readonly credential?: string }
): Promise<Response> =>
  exports.default.fetch(
    new Request(`https://athenaeum.invalid/api/workspace/${workspaceId}/apps/${appId}/client.js`, {
      ...(opts?.credential !== undefined ? { headers: { Authorization: `Bearer ${opts.credential}` } } : {})
    })
  )

const createAppWithServerCode = async (
  stub: RpcStub<WorkspaceApi>,
  workspaceId: EntityId,
  title: string,
  serverCode: string
): Promise<EntityId> => {
  const created = Schema.decodeUnknownSync(CreateAppOutput)(
    await stub.createApp(Schema.encodeSync(CreateAppInput)(new CreateAppInput({
      workspaceId,
      title,
      icon: AppIcon.make("🧮"),
      id: freshNodeId(),
      requestId: `create-${crypto.randomUUID()}`,
      commitMessage: `Create ${title}.`,
      attribution: appAttribution()
    })))
  ).app
  await stub.updateAppCode(
    Schema.encodeSync(UpdateAppCodeInput)(new UpdateAppCodeInput({
      workspaceId,
      appId: created.id,
      kind: "server",
      code: serverCode,
      expectedCurrentVersion: created.serverCodeVersion,
      expectedRevision: created.revision,
      expectedUpdatedAt: created.updatedAt,
      requestId: `server-${crypto.randomUUID()}`,
      commitMessage: "Install the server test fixture.",
      attribution: appAttribution()
    }))
  )
  return created.id
}

const updateCurrentAppCode = async (
  stub: RpcStub<WorkspaceApi>,
  workspaceId: EntityId,
  appId: EntityId,
  kind: "client" | "server",
  code: string,
  requestId: string
): Promise<void> => {
  const app = Schema.decodeUnknownSync(GetAppOutput)(
    await stub.getApp(Schema.encodeSync(GetAppInput)(new GetAppInput({ workspaceId, appId })))
  ).app
  await stub.updateAppCode(
    Schema.encodeSync(UpdateAppCodeInput)(new UpdateAppCodeInput({
      workspaceId,
      appId,
      kind,
      code,
      expectedCurrentVersion: kind === "client" ? app.clientCodeVersion : app.serverCodeVersion,
      expectedRevision: app.revision,
      expectedUpdatedAt: app.updatedAt,
      requestId,
      commitMessage: `Update ${kind} runtime fixture.`,
      attribution: appAttribution()
    }))
  )
}

// A real, hand-written per-isolate counter Worker: module-scope `count` persists only for as long
// as this exact loaded Worker instance stays warm (i.e. across requests that reuse the same
// `env.LOADER.get(key, ...)` key — same App, same server code version) — never across a code
// edit (new version -> new key -> fresh isolate -> `count` back to 0) and never across a
// DIFFERENT App (different key entirely).
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

// Reads a query param and echoes it — the exact shape this stage's own task description names
// ("a simple server.js e.g. one that reads a query param and echoes it").
const ECHO_SERVER_CODE = `
export default {
  async fetch(request) {
    const url = new URL(request.url)
    const echo = url.searchParams.get("echo") ?? ""
    return new Response(JSON.stringify({ echo, path: url.pathname }), { headers: { "content-type": "application/json" } })
  }
}
`.trim()

// The security-boundary probe: reports exactly what ambient capability the sandboxed code
// actually observes at runtime, rather than what this codebase merely intends to withhold from
// it. See this file's own header comment for what this test does and does not prove.
//
// `?workspaceApiUrl=` is the literal address of the CALLER's own `athenaeum-backend` Worker
// (`https://athenaeum.invalid/api/workspace/...` — the very API this test suite drives every
// other RPC call through) — passed in by the test, not hardcoded, since the sandboxed code has no
// ambient way to discover it itself. Attempting to `fetch()` it is the most literal version of
// "can this App reach the workspace's own data" this probe can exercise: if `globalOutbound: null`
// didn't actually block it, this fetch would succeed and could, in principle, reach the workspace
// DO the App itself belongs to (not merely some unrelated third-party host).
const AMBIENT_ACCESS_PROBE_SERVER_CODE = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const envKeys = Object.keys(env ?? {})
    const workspaceApiUrl = url.searchParams.get("workspaceApiUrl")

    const attemptFetch = async (target) => {
      try {
        await fetch(target)
        return { blocked: false }
      } catch (error) {
        return { blocked: true, message: String(error) }
      }
    }

    const externalFetch = await attemptFetch("https://example.com/")
    const workspaceApiFetch = workspaceApiUrl ? await attemptFetch(workspaceApiUrl) : undefined

    return new Response(
      JSON.stringify({ envKeys, externalFetch, workspaceApiFetch }),
      { headers: { "content-type": "application/json" } }
    )
  }
}
`.trim()

const CLIENT_CODE = `
<!doctype html>
<html><body><span id="c">0</span></body></html>
`.trim()

describe("AppRuntimeService: real sandboxed execution over a real Worker Loader", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspaceWithSocketAs>> | undefined
  afterEach(() => {
    workspaceStub?.stub[Symbol.dispose]()
    workspaceStub?.socket.close()
    workspaceStub = undefined
  })

  it("runs a real hand-written server.js via env.LOADER.get(), and serves client.js — mainline round trip", async () => {
    const email = freshEmail("owner")
    const { credential } = await devSignIn(email)
    const workspaceId = await createWorkspace(credential, "Runtime workspace")
    workspaceStub = await connectToWorkspaceWithSocketAs(workspaceId, credential)

    const appId = await createAppWithServerCode(workspaceStub.stub, workspaceId, "Echo", ECHO_SERVER_CODE)
    await updateCurrentAppCode(workspaceStub.stub, workspaceId, appId, "client", CLIENT_CODE, `client-${crypto.randomUUID()}`)

    // A real request reaches the real loaded Worker and gets a correct response back.
    const response = await runAppHttp(workspaceId, appId, "?echo=hello-app-library", { credential })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ echo: "hello-app-library", path: "/" })

    // A sub-path under /run reaches the App with that sub-path, not the /run prefix.
    const subPathResponse = await runAppHttp(workspaceId, appId, "/widgets/7?echo=nested", { credential })
    expect(await subPathResponse.json()).toEqual({ echo: "nested", path: "/widgets/7" })

    // client.js is served verbatim, for the iframe to load.
    const clientJsResponse = await fetchAppClientJs(workspaceId, appId, { credential })
    expect(clientJsResponse.status).toBe(200)
    expect(clientJsResponse.headers.get("Content-Type")).toContain("javascript")
    expect(await clientJsResponse.text()).toBe(CLIENT_CODE)
  })

  it("maintains real per-isolate state across separate HTTP requests to the same App/code-version", async () => {
    const email = freshEmail("counter")
    const { credential } = await devSignIn(email)
    const workspaceId = await createWorkspace(credential, "Counter workspace")
    workspaceStub = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    const appId = await createAppWithServerCode(workspaceStub.stub, workspaceId, "Counter", COUNTER_SERVER_CODE)

    const initial = await runAppHttp(workspaceId, appId, "", { credential })
    expect(await initial.json()).toEqual({ count: 0 })

    const afterFirstIncrement = await runAppHttp(workspaceId, appId, "/increment", { credential })
    expect(await afterFirstIncrement.json()).toEqual({ count: 1 })

    const afterSecondIncrement = await runAppHttp(workspaceId, appId, "/increment", { credential })
    expect(await afterSecondIncrement.json()).toEqual({ count: 2 })

    // Editing the server code advances the version, which changes the loader key — a FRESH
    // isolate loads, with its own fresh module-scope state, never the previous version's counter.
    await updateCurrentAppCode(workspaceStub.stub, workspaceId, appId, "server", COUNTER_SERVER_CODE.replace("count++", "count += 1"), `server-${crypto.randomUUID()}`)
    const afterCodeEdit = await runAppHttp(workspaceId, appId, "", { credential })
    expect(await afterCodeEdit.json()).toEqual({ count: 0 })
  })

  it("never shares in-memory state between two different Apps running the identical server code", async () => {
    const email = freshEmail("isolation")
    const { credential } = await devSignIn(email)
    const workspaceId = await createWorkspace(credential, "Isolation workspace")
    workspaceStub = await connectToWorkspaceWithSocketAs(workspaceId, credential)

    const appA = await createAppWithServerCode(workspaceStub.stub, workspaceId, "Counter A", COUNTER_SERVER_CODE)
    const appB = await createAppWithServerCode(workspaceStub.stub, workspaceId, "Counter B", COUNTER_SERVER_CODE)

    await runAppHttp(workspaceId, appA, "/increment", { credential })
    await runAppHttp(workspaceId, appA, "/increment", { credential })
    const appAThird = await runAppHttp(workspaceId, appA, "/increment", { credential })
    expect(await appAThird.json()).toEqual({ count: 3 })

    // App B, never incremented, starts at zero — proves the two Apps' identical source code did
    // NOT resolve to a shared loaded Worker instance.
    const appBFirst = await runAppHttp(workspaceId, appB, "", { credential })
    expect(await appBFirst.json()).toEqual({ count: 0 })
  })

  it("gives a loaded App's server code zero ambient bindings and no network egress — real, executed proof, not just an unread config value", async () => {
    const email = freshEmail("ambient")
    const { credential } = await devSignIn(email)
    const workspaceId = await createWorkspace(credential, "Ambient-access workspace")
    workspaceStub = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    const appId = await createAppWithServerCode(workspaceStub.stub, workspaceId, "Probe", AMBIENT_ACCESS_PROBE_SERVER_CODE)

    // The literal address of the workspace's OWN RPC API — the sandboxed code will attempt to
    // fetch this directly, not just some unrelated third-party host (see the server code's own
    // comment for why this is the more literal version of "can this App reach the workspace's own
    // data").
    const workspaceApiUrl = `https://athenaeum.invalid/api/workspace/${workspaceId}`
    const response = await runAppHttp(workspaceId, appId, `?workspaceApiUrl=${encodeURIComponent(workspaceApiUrl)}`, {
      credential
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      envKeys: ReadonlyArray<string>
      externalFetch: { blocked: boolean }
      workspaceApiFetch: { blocked: boolean }
    }
    expect(body.envKeys).toEqual([])
    expect(body.externalFetch.blocked).toBe(true)
    expect(body.workspaceApiFetch.blocked).toBe(true)
  })

  it("rejects a caller with no credential at all, on a governed workspace, before ever reaching AppRuntimeService", async () => {
    const email = freshEmail("guarded-owner")
    const { credential } = await devSignIn(email)
    const workspaceId = await createWorkspace(credential, "Guarded workspace")
    workspaceStub = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    const appId = await createAppWithServerCode(workspaceStub.stub, workspaceId, "Guarded", ECHO_SERVER_CODE)

    const noCredentialRun = await runAppHttp(workspaceId, appId, "")
    expect(noCredentialRun.status).toBe(401)

    const noCredentialClientJs = await fetchAppClientJs(workspaceId, appId)
    expect(noCredentialClientJs.status).toBe(401)
  })

  it("rejects a real, authenticated caller who has no role in this workspace's permission graph", async () => {
    const ownerEmail = freshEmail("real-owner")
    const { credential: ownerCredential } = await devSignIn(ownerEmail)
    const workspaceId = await createWorkspace(ownerCredential, "Members-only workspace")
    workspaceStub = await connectToWorkspaceWithSocketAs(workspaceId, ownerCredential)
    const appId = await createAppWithServerCode(workspaceStub.stub, workspaceId, "Members only", ECHO_SERVER_CODE)

    // A second, real, independently-authenticated identity — never added as a collaborator on
    // this workspace at all.
    const strangerEmail = freshEmail("stranger")
    const { credential: strangerCredential } = await devSignIn(strangerEmail)

    const strangerRun = await runAppHttp(workspaceId, appId, "", { credential: strangerCredential })
    expect(strangerRun.status).toBe(403)

    const strangerClientJs = await fetchAppClientJs(workspaceId, appId, { credential: strangerCredential })
    expect(strangerClientJs.status).toBe(403)
  })

  it("adversarial-review fix: a minted App-run credential — NOT the caller's own session credential — successfully authenticates client.js/run on a governed workspace", async () => {
    const email = freshEmail("mint-owner")
    const { credential } = await devSignIn(email)
    const workspaceId = await createWorkspace(credential, "Mint workspace")
    workspaceStub = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    const appId = await createAppWithServerCode(workspaceStub.stub, workspaceId, "Echo", ECHO_SERVER_CODE)
    await updateCurrentAppCode(workspaceStub.stub, workspaceId, appId, "client", CLIENT_CODE, `client-${crypto.randomUUID()}`)

    const minted = Schema.decodeUnknownSync(MintAppRunCredentialOutput)(
      await workspaceStub.stub.mintAppRunCredential(
        Schema.encodeSync(MintAppRunCredentialInput)(new MintAppRunCredentialInput({ workspaceId, appId }))
      )
    )
    expect(minted.credential.split(".")).toHaveLength(2)
    expect(minted.credential).not.toBe(credential) // a distinct token, not a copy of the session credential

    // The App-run credential alone — no session credential presented at all — authenticates both
    // routes, on a GOVERNED workspace.
    const runResponse = await runAppHttp(workspaceId, appId, "?echo=via-app-run-credential", {
      credential: minted.credential
    })
    expect(runResponse.status).toBe(200)
    expect(await runResponse.json()).toEqual({ echo: "via-app-run-credential", path: "/" })

    const clientJsResponse = await fetchAppClientJs(workspaceId, appId, { credential: minted.credential })
    expect(clientJsResponse.status).toBe(200)
    expect(await clientJsResponse.text()).toBe(CLIENT_CODE)
  })

  it("adversarial-review fix: an App-run credential minted for one App is rejected against a DIFFERENT App in the same workspace", async () => {
    const email = freshEmail("mint-scope")
    const { credential } = await devSignIn(email)
    const workspaceId = await createWorkspace(credential, "Scope workspace")
    workspaceStub = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    const appA = await createAppWithServerCode(workspaceStub.stub, workspaceId, "App A", ECHO_SERVER_CODE)
    const appB = await createAppWithServerCode(workspaceStub.stub, workspaceId, "App B", ECHO_SERVER_CODE)

    const mintedForA = Schema.decodeUnknownSync(MintAppRunCredentialOutput)(
      await workspaceStub.stub.mintAppRunCredential(
        Schema.encodeSync(MintAppRunCredentialInput)(new MintAppRunCredentialInput({ workspaceId, appId: appA }))
      )
    )

    // Valid against the App it was minted for...
    const runOnA = await runAppHttp(workspaceId, appA, "?echo=a", { credential: mintedForA.credential })
    expect(runOnA.status).toBe(200)

    // ...but rejected outright against a different App in the SAME workspace, even though both
    // credential and target share a signer/secret.
    const runOnB = await runAppHttp(workspaceId, appB, "?echo=b", { credential: mintedForA.credential })
    expect(runOnB.status).toBe(401)
  })

  it("adversarial-review fix: mintAppRunCredential itself requires 'use' role — a stranger with no role in the workspace is rejected", async () => {
    const ownerEmail = freshEmail("mint-real-owner")
    const { credential: ownerCredential } = await devSignIn(ownerEmail)
    const workspaceId = await createWorkspace(ownerCredential, "Mint-gated workspace")
    workspaceStub = await connectToWorkspaceWithSocketAs(workspaceId, ownerCredential)
    const appId = await createAppWithServerCode(workspaceStub.stub, workspaceId, "Gated", ECHO_SERVER_CODE)

    const strangerEmail = freshEmail("mint-stranger")
    const { credential: strangerCredential } = await devSignIn(strangerEmail)
    const { stub: strangerStub, socket: strangerSocket } = await connectToWorkspaceWithSocketAs(
      workspaceId,
      strangerCredential
    )
    try {
      await expect(
        strangerStub.mintAppRunCredential(
          Schema.encodeSync(MintAppRunCredentialInput)(new MintAppRunCredentialInput({ workspaceId, appId }))
        )
      ).rejects.toThrow()
    } finally {
      strangerStub[Symbol.dispose]()
      strangerSocket.close()
    }
  })

  it("adversarial-review fix: mintAppRunCredential fails AppNotFound for a nonexistent appId, rather than minting a token for nothing", async () => {
    const email = freshEmail("mint-notfound")
    const { credential } = await devSignIn(email)
    const workspaceId = await createWorkspace(credential, "Mint-notfound workspace")
    workspaceStub = await connectToWorkspaceWithSocketAs(workspaceId, credential)

    const error = await rejectionToDomainError(
      workspaceStub.stub.mintAppRunCredential(
        Schema.encodeSync(MintAppRunCredentialInput)(
          // `freshWorkspaceId()` just mints a fresh, well-formed, random `EntityId` — reused here
          // as a guaranteed-nonexistent `appId`, same trick this suite's own `freshNodeId()`
          // sibling helper is named for elsewhere in this test package.
          new MintAppRunCredentialInput({ workspaceId, appId: freshWorkspaceId() })
        )
      )
    )
    expect(error._tag).toBe("AppNotFound")
  })

  it("returns 404 for an App with no server code yet, rather than silently succeeding", async () => {
    const email = freshEmail("codeless")
    const { credential } = await devSignIn(email)
    const workspaceId = await createWorkspace(credential, "Codeless workspace")
    workspaceStub = await connectToWorkspaceWithSocketAs(workspaceId, credential)

    const created = Schema.decodeUnknownSync(CreateAppOutput)(
      await workspaceStub.stub.createApp(
        Schema.encodeSync(CreateAppInput)(new CreateAppInput({
          workspaceId,
          title: "No code yet",
          icon: AppIcon.make("📭"),
          id: freshNodeId(),
          requestId: `create-${crypto.randomUUID()}`,
          commitMessage: "Create a codeless runtime fixture.",
          attribution: appAttribution()
        }))
      )
    ).app

    const response = await runAppHttp(workspaceId, created.id, "", { credential })
    expect(response.status).toBe(404)
  })
})
