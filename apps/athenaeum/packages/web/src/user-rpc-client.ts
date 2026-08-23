// Web-stage task item 2: "A workspace switcher (list workspaces from the user's catalog, switch the
// active workspace, showing the default Personal workspace)." Client for `UserDurableObject`'s
// `/api/user` Cap'n Web session (`user-durable-object.ts`'s `UserRpcApi`) — `createWorkspace`/
// `listWorkspaces` only, per that class's own surface.
//
// Deliberately NOT built the same way as `rpc-client.ts`'s `WorkspaceRpcClient` (a `Context.Tag` +
// `Layer` fed into the app's single long-lived `ManagedRuntime`): the user catalog is a
// bootstrap/account-management concern reached rarely (once at sign-in, and whenever the workspace
// switcher's create-workspace form is used), not something any live subscription or per-render hook
// needs — the same "plain HTTP/bespoke exchange, not routed through the main RPC plumbing"
// precedent `auth.ts`'s header comment sets for sign-in itself, applied here one layer up the
// stack (a bespoke Cap'n Web session instead of a bespoke HTTP exchange, since `/api/user`
// *is* a Cap'n Web endpoint — but still opened/closed around a single short-lived use rather than
// kept as a standing connection). `WorkspaceSwitcher.tsx` opens one connection per mount and disposes
// it on unmount.

import { newWebSocketRpcSession, type RpcStub } from "capnweb"
import * as Schema from "effect/Schema"
import { CreateWorkspaceInput, CreateWorkspaceOutput, ListWorkspacesOutput, type WorkspaceCatalogEntry } from "@athenaeum/domain"
import { backendWsBase } from "./backend-host.js"
import { describeRpcError } from "./rpc-support.js"

/** Structural client-side mirror of `UserDurableObject`'s `UserRpcApi`
 *  (`backend/src/user-durable-object.ts`) — the same hand-write-the-interface convention
 *  `rpc-client.ts`'s own `WorkspaceApi` uses and documents, for the same reason. */
interface UserApi {
  createWorkspace(input: unknown): Promise<unknown>
  listWorkspaces(input: unknown): Promise<unknown>
}

/** Opens a real Cap'n Web WebSocket session against the caller's own `/api/user` route,
 *  presenting `credential` via the `?token=` query param — mandatory here (unlike the workspace
 *  route), since `UserDurableObject#fetch()` rejects outright with no credential at all. */
export const openUserSession = (credential: string): RpcStub<UserApi> =>
  newWebSocketRpcSession<UserApi>(`${backendWsBase}/api/user?token=${encodeURIComponent(credential)}`)

/** Closes `stub`'s underlying WebSocket connection — `RpcStub[Symbol.dispose]()` is Cap'n Web's
 *  own disposal protocol, the same one `rpc-client.ts`'s `Effect.acquireRelease` release
 *  functions call. */
export const closeUserSession = (stub: RpcStub<UserApi>): void => {
  stub[Symbol.dispose]()
}

/** Lists every workspace in the caller's own catalog (owned workspaces — see this file's header comment
 *  and `ListWorkspacesOutput`'s own doc comment in `sharing-rpc.ts` for the "owned-only, today" scope
 *  note; a workspace shared with the caller does not appear here until a later stage adds
 *  `recordSharedGadgetOpen`-equivalent bookkeeping — `WorkspaceSwitcher.tsx`'s own comment covers how
 *  this stage's UI still lets a collaborator reach a shared workspace regardless, via `?workspace=`). */
export const listWorkspaces = async (stub: RpcStub<UserApi>): Promise<ReadonlyArray<WorkspaceCatalogEntry>> => {
  try {
    // Deliberately `{}` literal, not `Schema.encodeSync(ListWorkspacesInput)({})`: `ListWorkspacesInput`
    // has zero fields, and `effect/Schema`'s `Schema.Class` encode for a zero-field class is an
    // identity transform that returns the ORIGINAL class instance unchanged rather than a plain
    // object (verified empirically — even `Schema.encodeSync(ListWorkspacesInput)(new
    // ListWorkspacesInput({}))` returns a real `ListWorkspacesInput` instance, not `{}`). Cap'n Web can't
    // serialize an arbitrary class instance (only plain data / stubs / `RpcTarget`s), so sending
    // that encoded value fails with "Cannot serialize value: ListWorkspacesInput({ })". There's
    // nothing to encode for an empty-fields input anyway — `{}` IS the correct wire shape.
    const raw = await stub.listWorkspaces({})
    return Schema.decodeUnknownSync(ListWorkspacesOutput)(raw).workspaces
  } catch (thrown) {
    throw new Error(await describeRpcError(thrown))
  }
}

/** Creates a new (never-default) workspace owned by the caller, registering it in their catalog and
 *  initializing its `WorkspaceDurableObject` owner record — see `registerWorkspace` in
 *  `user-durable-object.ts`. */
export const createWorkspace = async (stub: RpcStub<UserApi>, title: string): Promise<WorkspaceCatalogEntry> => {
  try {
    const raw = await stub.createWorkspace(Schema.encodeSync(CreateWorkspaceInput)({ title }))
    return Schema.decodeUnknownSync(CreateWorkspaceOutput)(raw).workspace
  } catch (thrown) {
    throw new Error(await describeRpcError(thrown))
  }
}
