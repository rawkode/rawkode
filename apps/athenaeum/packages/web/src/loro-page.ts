import { LoroDoc, LoroList, LoroMap, LoroText, VersionVector } from "loro-crdt/bundler"
import type { ContainerID } from "loro-crdt/bundler"
import * as Effect from "effect/Effect"
import {
  LORO_PAGE_META_CONTAINER,
  LORO_PROSEMIRROR_CONTAINER,
  LORO_PAGE_SCHEMA_VERSION,
  LoroPageSyncMessageInput,
  StartLoroPageSyncInput,
  UnexpectedError,
  type DomainError,
  type EntityId
} from "@athenaeum/domain"
import type { WorkspaceRpcClientService } from "./rpc-client.js"

/** Re-export the domain-owned wire constants for editor-facing imports. */
export { LORO_PAGE_META_CONTAINER, LORO_PROSEMIRROR_CONTAINER, LORO_PAGE_SCHEMA_VERSION }

export interface LoroPageMeta {
  readonly schemaVersion: number
}

export interface LoroPageDocument {
  readonly doc: LoroDoc
  readonly meta: LoroMap
  readonly pmRoot: LoroMap
}

/** Caller-owned state for one Loro page sync session. */
export interface LoroSyncSessionHandle {
  id: string
  started: boolean
  ordinal: number
  knownServerVersion: VersionVector
}

export const newLoroSyncSessionHandle = (): LoroSyncSessionHandle => ({
  id: crypto.randomUUID(),
  started: false,
  ordinal: 0,
  knownServerVersion: new VersionVector(null)
})

/** Create a new, empty Loro page with the app's stable metadata and PM roots. */
export const createLoroPage = (): LoroPageDocument => {
  const doc = new LoroDoc()
  const meta = doc.getMap(LORO_PAGE_META_CONTAINER)
  meta.set("schemaVersion", LORO_PAGE_SCHEMA_VERSION)
  const pmRoot = doc.getMap(LORO_PROSEMIRROR_CONTAINER)
  pmRoot.set("nodeName", "doc")
  const rootAttributes = pmRoot.getOrCreateContainer("attributes", new LoroMap())
  if (!(rootAttributes instanceof LoroMap)) throw new Error("failed to create Loro root attributes")
  rootAttributes.set("isAmgBlock", false)
  const children = pmRoot.getOrCreateContainer("children", new LoroList())
  if (!(children instanceof LoroList)) throw new Error("failed to create Loro root children")
  const paragraph = children.insertContainer(0, new LoroMap()).getAttached()
  if (!(paragraph instanceof LoroMap)) throw new Error("failed to create Loro paragraph")
  paragraph.set("nodeName", "paragraph")
  const paragraphAttributes = paragraph.getOrCreateContainer("attributes", new LoroMap())
  if (!(paragraphAttributes instanceof LoroMap)) throw new Error("failed to create Loro paragraph attributes")
  paragraphAttributes.set("isAmgBlock", false)
  const paragraphChildren = paragraph.getOrCreateContainer("children", new LoroList())
  if (!(paragraphChildren instanceof LoroList)) throw new Error("failed to create Loro paragraph children")
  paragraphChildren.insertContainer(0, new LoroText())
  doc.commit()
  return { doc, meta, pmRoot }
}

/** Import and validate a persisted Loro page snapshot. */
export const importLoroPage = (snapshot: Uint8Array): LoroPageDocument => {
  const doc = new LoroDoc()
  doc.import(snapshot)
  return inspectLoroPage(doc)
}

/** Export a complete page snapshot suitable for durable storage. */
export const exportLoroPageSnapshot = (page: LoroPageDocument): Uint8Array =>
  page.doc.export({ mode: "snapshot" })

/** Export the current version vector for update-based sync. */
export const exportLoroPageVersion = (page: LoroPageDocument): Uint8Array =>
  page.doc.version().encode()

/** Export only operations after a known version vector. */
export const exportLoroPageUpdate = (
  page: LoroPageDocument,
  from: VersionVector
): Uint8Array => page.doc.export({ mode: "update", from })

/** Return the official loro-prosemirror root container after checking its identity. */
export const extractLoroPagePmRoot = (doc: LoroDoc): LoroMap => {
  const root = doc.getMap(LORO_PROSEMIRROR_CONTAINER)
  if (root.get("nodeName") !== "doc") {
    throw new Error(`Invalid Loro PM root: expected doc, got ${String(root.get("nodeName"))}`)
  }
  const shallow = root.getShallowValue()
  if (typeof shallow.children !== "string" || typeof shallow.attributes !== "string") {
    throw new Error("Invalid Loro PM root: missing children or attributes container")
  }
  return root
}

/** Validate the metadata and PM roots of a Loro document. */
export const inspectLoroPage = (doc: LoroDoc): LoroPageDocument => {
  const meta = doc.getMap(LORO_PAGE_META_CONTAINER)
  if (meta.get("schemaVersion") !== LORO_PAGE_SCHEMA_VERSION) {
    throw new Error("Unsupported Loro page schema version")
  }
  const pmRoot = extractLoroPagePmRoot(doc)
  return { doc, meta, pmRoot }
}

/** Container id used by LoroSyncPlugin when binding ProseMirror to this page. */
export const loroPagePmContainerId = (page: LoroPageDocument): ContainerID => page.pmRoot.id

/**
 * Legacy raw-update transport. This can upload non-empty CRDT updates and is intentionally kept
 * for compatibility until C4 owns the server-side fence; C2 semantic editors must not call it.
 * Exchange Loro updates with the page service until this replica is caught up.
 * The handle must be reused for subsequent calls so session ordinals and the known server
 * version remain continuous across editor saves.
 */
export const syncLoroPageWithServer = (
  client: WorkspaceRpcClientService,
  workspaceId: EntityId,
  nodeId: EntityId,
  doc: LoroDoc,
  session: LoroSyncSessionHandle
): Effect.Effect<LoroDoc, DomainError> =>
  Effect.gen(function* () {
    let serverMessage: Uint8Array | null = null

    // The session handle is deliberately mutable caller-owned protocol state. In particular, do
    // not call startLoroPageSync again for a normal follow-up save: the server associates the
    // ordinal with the session id and a retry after a failed message must send the same ordinal.
    if (!session.started) {
      const started = yield* client.startLoroPageSync(
        new StartLoroPageSyncInput({ workspaceId, nodeId, sessionId: session.id })
      )
      session.id = started.sessionId
      session.started = true
      session.ordinal = 0
      session.knownServerVersion = VersionVector.decode(started.serverVersion)
      serverMessage = started.message.byteLength === 0 ? null : started.message
    }

    for (let round = 0; round < 50; round += 1) {
      if (serverMessage !== null) {
        doc.import(serverMessage)
        serverMessage = null
      }

      const comparison = doc.version().compare(session.knownServerVersion)
      if (comparison === 0) return doc
      if (comparison === -1) {
        return yield* Effect.fail(
          new UnexpectedError({
            message: `Loro sync cannot converge: local document is behind known server version in session ${session.id}`
          })
        )
      }

      const update = exportLoroPageUpdate(
        { doc, meta: doc.getMap(LORO_PAGE_META_CONTAINER), pmRoot: doc.getMap(LORO_PROSEMIRROR_CONTAINER) },
        session.knownServerVersion
      )
      if (update.byteLength === 0) {
        return yield* Effect.fail(
          new UnexpectedError({
            message: `Loro sync cannot converge: computed an empty update for non-matching versions in session ${session.id}`
          })
        )
      }

      const response = yield* client.loroPageSyncMessage(
        new LoroPageSyncMessageInput({
          workspaceId,
          nodeId,
          sessionId: session.id,
          ordinal: session.ordinal,
          update,
          clientVersion: doc.version().encode()
        })
      )

      if (response.reset) {
        session.id = crypto.randomUUID()
        session.started = false
        session.ordinal = 0
        session.knownServerVersion = new VersionVector(null)
        const restarted = yield* client.startLoroPageSync(
          new StartLoroPageSyncInput({ workspaceId, nodeId, sessionId: session.id })
        )
        session.id = restarted.sessionId
        session.started = true
        session.ordinal = 0
        session.knownServerVersion = VersionVector.decode(restarted.serverVersion)
        serverMessage = restarted.message.byteLength === 0 ? null : restarted.message
        continue
      }

      session.ordinal += 1
      session.knownServerVersion = VersionVector.decode(response.serverVersion)
      serverMessage = response.update?.byteLength === 0 ? null : response.update
    }

    return yield* Effect.fail(
      new UnexpectedError({
        message: `Loro sync did not converge after 50 messages in session ${session.id} (ordinal ${session.ordinal})`
      })
    )
  })

/**
 * Download/converge authority for semantic writers.  Unlike the legacy sync helper above this
 * function is mechanically incapable of uploading a draft: every outgoing raw frame is empty.
 * User content must go through `commitLoroPageContent` instead.
 */
export const convergeLoroPageFromServer = (
  client: WorkspaceRpcClientService,
  workspaceId: EntityId,
  nodeId: EntityId
): Effect.Effect<LoroDoc, DomainError> =>
  Effect.gen(function* () {
    const sessionId = crypto.randomUUID()
    const started = yield* client.startLoroPageSync(
      new StartLoroPageSyncInput({ workspaceId, nodeId, sessionId })
    )
    const doc = new LoroDoc()
    if (started.message.byteLength > 0) doc.import(started.message)
    let known = VersionVector.decode(started.serverVersion)
    let ordinal = 0
    for (let round = 0; round < 50; round += 1) {
      // Send at least one empty frame. This is both an authoritative convergence acknowledgement
      // and an executable boundary: this helper cannot ever carry a user draft.
      if (round > 0 && doc.version().compare(known) === 0) return doc
      const response = yield* client.loroPageSyncMessage(new LoroPageSyncMessageInput({
        workspaceId, nodeId, sessionId: started.sessionId, ordinal,
        update: new Uint8Array(), clientVersion: doc.version().encode()
      }))
      ordinal += 1
      if (response.update !== null && response.update.byteLength > 0) doc.import(response.update)
      known = VersionVector.decode(response.serverVersion)
      if (response.reset) return yield* Effect.fail(new UnexpectedError({ message: "Loro authority convergence was reset" }))
      if (doc.version().compare(known) === 0) return doc
    }
    return yield* Effect.fail(new UnexpectedError({ message: "Loro authority convergence did not complete after 50 empty frames" }))
  })
