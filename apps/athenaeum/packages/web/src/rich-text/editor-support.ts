import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Node as PMNode, Schema as ProseMirrorSchema } from "prosemirror-model"
import { dropCursor } from "prosemirror-dropcursor"
import { gapCursor } from "prosemirror-gapcursor"
import type { EditorView } from "prosemirror-view"
import type { Plugin } from "prosemirror-state"
import {
  ApplySupertagInput,
  AssignTagInput,
  CreateNodeWithIntentInput,
  CreateTagInput,
  EntityId,
  HumanUiMutationAttribution,
  ListNodesInput,
  ListTagsInput,
  SyncNoteReferencesInput,
  UnassignTagInput
} from "@athenaeum/domain"
import { runtime } from "../runtime.js"
import { WorkspaceRpcClient } from "../rpc-client.js"
import { buildInputRules } from "./input-rules.js"
import { buildKeymapPlugins, type KeymapHistoryOptions } from "./commands.js"
import { slashMenuPlugin } from "./slash-menu-plugin.js"
import { toolbarPlugin } from "./toolbar-plugin.js"
import { mentionPlugin, collectEntityRefIds, type MentionCandidate } from "./mention-plugin.js"
import { supertagPlugin, collectSupertagRefIds, type SupertagCandidate } from "./supertag-plugin.js"
import { dragHandlePlugin } from "./drag-handle-plugin.js"
import { createTagMembershipReconciler } from "./tag-membership-reconciliation.js"
import { createReferenceReconciler } from "./reference-reconciliation.js"
import type { FloatingAnchorRect, FloatingAnchorRectSource } from "../floating-popover-position.js"

const SYNC_DEBOUNCE_MS = 500

const canonicalNodeTitle = (title: string): string => title.trim().replace(/\s+/g, " ")

export interface NoteEditorSupport {
  readonly plugins: readonly Plugin[]
  readonly scheduleReferenceSync: (view: EditorView) => void
  readonly scheduleSupertagSync: (view: EditorView) => void
  readonly seedProjectionBaselines: (doc: PMNode) => void
  readonly dispose: () => void
}

/**
 * Shared collaboration and graph-projection wiring for both Automerge and Loro note editors.
 * The CRDT-specific editor plugin and body-sync callback stay in each editor; mentions, tags,
 * menus, keyboard behavior, and projection reconciliation must remain identical across formats.
 */
export const makeNoteEditorSupport = ({
  workspaceId,
  nodeId,
  schema,
  onSupertagApplied,
  keymapHistory
}: {
  readonly workspaceId: EntityId
  readonly nodeId: EntityId
  readonly schema: ProseMirrorSchema
  readonly onSupertagApplied: (
    candidate: SupertagCandidate,
    anchorRect: FloatingAnchorRect,
    anchorRectSource?: FloatingAnchorRectSource
  ) => void
  readonly keymapHistory?: KeymapHistoryOptions
}): NoteEditorSupport => {
  let referencesTimer: ReturnType<typeof setTimeout> | undefined
  let supertagsTimer: ReturnType<typeof setTimeout> | undefined
  const referenceReconciler = createReferenceReconciler({
    send: (plan) => runtime.runPromise(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.syncNoteReferences(new SyncNoteReferencesInput({
          workspaceId,
          nodeId,
          referencedNodeIds: plan.referencedNodeIds,
          requestId: plan.requestId,
          commitMessage: "Reconcile @-mentions from the note editor.",
          attribution: new HumanUiMutationAttribution({
            version: "athenaeum.mutation-attribution.v1",
            kind: "humanUi",
            surface: "rich-text-editor"
          })
        })))
      )
    ).then(() => undefined),
    onError: (error) => console.error("syncNoteReferences failed:", error)
  })
  const tagReconciler = createTagMembershipReconciler({
    send: (operations) => runtime.runPromise(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          Effect.all(
            operations.map((operation) => operation.kind === "assign"
              ? client.assignTag(new AssignTagInput({
                  workspaceId,
                  nodeId,
                  tagId: operation.tagId,
                  requestId: operation.requestId,
                  commitMessage: "Apply the Supertag membership from the note editor.",
                  attribution: new HumanUiMutationAttribution({
                    version: "athenaeum.mutation-attribution.v1",
                    kind: "humanUi",
                    surface: "rich-text-editor"
                  })
                }))
              : client.unassignTag(new UnassignTagInput({
                  workspaceId,
                  nodeId,
                  tagId: operation.tagId,
                  requestId: operation.requestId,
                  commitMessage: "Remove the Supertag membership from the note editor.",
                  attribution: new HumanUiMutationAttribution({
                    version: "athenaeum.mutation-attribution.v1",
                    kind: "humanUi",
                    surface: "rich-text-editor"
                  })
                }))),
            { discard: true }
          )
        )
      )
    ),
    onError: (error) => console.error("supertag reconciliation failed:", error)
  })

  const listCandidates = (): Promise<readonly MentionCandidate[]> =>
    runtime.runPromise(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.listNodes(new ListNodesInput({ workspaceId }))),
        Effect.map((output) => output.nodes.map((node) => ({ nodeId: node.id, title: node.title })))
      )
    )

  const pendingNodeCreations = new Map<string, {
    readonly nodeId: EntityId
    readonly requestId: string
  }>()

  const createNode = (title: string): Promise<MentionCandidate> => {
    const canonicalTitle = canonicalNodeTitle(title)
    const pending = pendingNodeCreations.get(canonicalTitle) ?? {
      nodeId: Schema.decodeUnknownSync(EntityId)(crypto.randomUUID()),
      requestId: crypto.randomUUID()
    }
    pendingNodeCreations.set(canonicalTitle, pending)
    // Capture one immutable operation before the first network call. The mention picker can
    // safely retry this exact request after an uncertain response without minting a duplicate.
    return runtime.runPromise(Effect.gen(function* () {
      const operation = new CreateNodeWithIntentInput({
        workspaceId,
        id: pending.nodeId,
        title: canonicalTitle,
        requestId: pending.requestId,
        commitMessage: `Create ${canonicalTitle} from the note's @-mention picker.`,
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1",
          kind: "humanUi",
          surface: "rich-text-editor"
        })
      })
      const client = yield* WorkspaceRpcClient
      const output = yield* client.createNodeWithIntent(operation)
      return { nodeId: output.node.id, title: output.node.title }
    }))
  }

  const confirmNodeCreation = (title: string, candidate: MentionCandidate): void => {
    const key = canonicalNodeTitle(title)
    if (pendingNodeCreations.get(key)?.nodeId === candidate.nodeId) pendingNodeCreations.delete(key)
  }

  const listTagCandidates = (): Promise<readonly SupertagCandidate[]> =>
    runtime.runPromise(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.listTags(new ListTagsInput({ workspaceId }))),
        Effect.map((output) => output.tags.map((tag) => ({ tagId: tag.id, name: tag.name })))
      )
    )

  const createTagCandidate = (name: string): Promise<SupertagCandidate> =>
    runtime.runPromise(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.createTag(new CreateTagInput({
          workspaceId,
          name,
          parentIds: [],
          requestId: crypto.randomUUID(),
          commitMessage: `Create the ${name} Supertag from the note editor.`,
          attribution: new HumanUiMutationAttribution({
            version: "athenaeum.mutation-attribution.v1",
            kind: "humanUi",
            surface: "rich-text-editor"
          })
        }))),
        Effect.map((output) => ({ tagId: output.tag.id, name: output.tag.name }))
      )
    )

  const applySupertagNow = async (
    candidate: SupertagCandidate,
    anchorRect: FloatingAnchorRect,
    anchorRectSource?: FloatingAnchorRectSource
  ): Promise<void> => {
    const tagId = Schema.decodeUnknownOption(EntityId)(candidate.tagId)
    if (Option.isNone(tagId)) throw new Error(`invalid Supertag id: ${candidate.tagId}`)
    // Keep one immutable operation object for this user action. If the UI grows a retry affordance,
    // it can resubmit the same requestId and receive the recorded result rather than tagging twice.
    const operation = new ApplySupertagInput({
      workspaceId,
      nodeId,
      tagId: tagId.value,
      requestId: crypto.randomUUID(),
      commitMessage: `Apply ${candidate.name} to structure this note.`,
      attribution: new HumanUiMutationAttribution({
        version: "athenaeum.mutation-attribution.v1",
        kind: "humanUi",
        surface: "rich-text-editor"
      }),
      fieldValues: []
    })
    await runtime.runPromise(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.applySupertag(operation))
      )
    )
    // The mark is inserted only after the ledgered write succeeds. Treating it as already
    // projected prevents the debounced document reconciliation from issuing a second, direct
    // assignTag call for this same user action.
    const projectedTagIds = new Set(tagReconciler.snapshot().confirmedKey.split(",").filter((id) => id.length > 0))
    projectedTagIds.add(tagId.value)
    tagReconciler.confirm([...projectedTagIds] as EntityId[])
    onSupertagApplied(candidate, anchorRect, anchorRectSource)
  }

  const scheduleReferenceSync = (view: EditorView) => {
    if (referencesTimer !== undefined) clearTimeout(referencesTimer)
    referencesTimer = setTimeout(() => {
      const ids = collectEntityRefIds(view.state.doc, schema)
        .map((id) => Schema.decodeUnknownOption(EntityId)(id))
        .filter(Option.isSome)
        .map((decoded) => decoded.value)
      referenceReconciler.request(ids)
    }, SYNC_DEBOUNCE_MS)
  }

  const scheduleSupertagSync = (view: EditorView) => {
    if (supertagsTimer !== undefined) clearTimeout(supertagsTimer)
    supertagsTimer = setTimeout(() => {
      const ids = collectSupertagRefIds(view.state.doc, schema)
        .map((id) => Schema.decodeUnknownOption(EntityId)(id))
        .filter(Option.isSome)
        .map((decoded) => decoded.value)
      tagReconciler.request(ids)
    }, SYNC_DEBOUNCE_MS)
  }

  return {
    plugins: [
      buildInputRules(schema),
      slashMenuPlugin(schema),
      mentionPlugin(schema, { listCandidates, createNode, confirmNodeCreation }),
      supertagPlugin(schema, { listCandidates: listTagCandidates, createTag: createTagCandidate, onApplied: applySupertagNow }),
      ...buildKeymapPlugins(schema, keymapHistory),
      dropCursor(),
      gapCursor(),
      toolbarPlugin(schema),
      dragHandlePlugin()
    ],
    scheduleReferenceSync,
    scheduleSupertagSync,
    seedProjectionBaselines: (doc) => {
      const baselineIds = collectEntityRefIds(doc, schema)
        .map((id) => Schema.decodeUnknownOption(EntityId)(id))
        .filter(Option.isSome)
        .map((decoded) => decoded.value)
      referenceReconciler.seed(baselineIds)
      const ids = [...collectSupertagRefIds(doc, schema)]
        .map((id) => Schema.decodeUnknownOption(EntityId)(id))
        .filter(Option.isSome)
        .map((decoded) => decoded.value)
      tagReconciler.seed(ids)
    },
    dispose: () => {
      if (referencesTimer !== undefined) clearTimeout(referencesTimer)
      if (supertagsTimer !== undefined) clearTimeout(supertagsTimer)
      pendingNodeCreations.clear()
    }
  }
}
