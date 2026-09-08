import * as Automerge from "@automerge/automerge"
import * as Effect from "effect/Effect"
import type { DomainError, EntityId } from "@athenaeum/domain"
import type { WorkspaceRpcClientService } from "./rpc-client.js"
import {
  emptyPageDoc,
  newSyncSessionHandle,
  syncPageWithServer,
  type PageDoc,
  type SyncSessionHandle
} from "./automerge-page.js"
import { ensureRichTextSchema } from "./rich-text/migration.js"
import { RichNoteEditor } from "./RichNoteEditor.js"

/**
 * Caller-owned storage for the old sync session. `DailyNote` creates this small plain object by
 * ref, but does not import Automerge or mint a session itself: only an explicit `automerge-v1`
 * descriptor reaches this module and initializes the cell.
 */
export interface LegacyDailyNoteCell {
  session: SyncSessionHandle | null
}

export interface LegacyDailyNoteResolved {
  readonly nodeId: EntityId
  readonly format: "automerge-v1"
  readonly doc: Automerge.Doc<PageDoc>
  readonly session: SyncSessionHandle
}

/**
 * The legacy editor has a stable module export. The caller carries this exact value from the
 * loaded adapter through resolution to rendering rather than starting a second dynamic import.
 */
export { RichNoteEditor }

export interface LegacyDailyNoteRuntime {
  readonly emptyPageDoc: typeof emptyPageDoc
  readonly newSyncSessionHandle: typeof newSyncSessionHandle
  readonly syncPageWithServer: typeof syncPageWithServer
  readonly ensureRichTextSchema: typeof ensureRichTextSchema
}

const browserLegacyDailyNoteRuntime: LegacyDailyNoteRuntime = {
  emptyPageDoc,
  newSyncSessionHandle,
  syncPageWithServer,
  ensureRichTextSchema
}

/**
 * Resolve an Automerge page using the pre-existing sync protocol. The session is assigned to the
 * caller's stable cell before the first RPC, which preserves the same object (and any reset id)
 * across a failed first attempt, retry, and editor handoff. There is deliberately no module-global
 * session or promise cache.
 */
export const resolveLegacyDailyNote = (
  client: WorkspaceRpcClientService,
  workspaceId: EntityId,
  nodeId: EntityId,
  cell: LegacyDailyNoteCell,
  runtime: LegacyDailyNoteRuntime = browserLegacyDailyNoteRuntime
): Effect.Effect<LegacyDailyNoteResolved, DomainError> => {
  const session = cell.session ?? runtime.newSyncSessionHandle()
  if (cell.session === null) cell.session = session

  return Effect.gen(function* () {
    // Pull the page's current content into a fresh local Automerge replica via the real sync
    // protocol (not a bytes-fetching RPC — there isn't one, by design; see `automerge-page.ts`).
    const synced = yield* runtime.syncPageWithServer(client, workspaceId, nodeId, runtime.emptyPageDoc(), session)

    // Compatibility migration: if this note predates the rich-text schema (flat text, no block
    // markers), wrap it in one paragraph block — a real Automerge change on the *same* just-synced
    // doc. An already-rich or new empty page preserves identity and needs no second sync.
    const migrated = runtime.ensureRichTextSchema(synced)
    const doc = migrated === synced
      ? synced
      : yield* runtime.syncPageWithServer(client, workspaceId, nodeId, migrated, session)

    return { nodeId, format: "automerge-v1", doc, session }
  })
}

export interface LegacyDailyNoteModule {
  readonly resolveLegacyDailyNote: typeof resolveLegacyDailyNote
  readonly RichNoteEditor: typeof RichNoteEditor
}
