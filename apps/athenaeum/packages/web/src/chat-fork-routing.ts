import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  ChatForkPreviewInput,
  EditNoteToolOutput,
  EntityId,
  GetPageDocumentDescriptorInput,
  type DomainError
} from "@athenaeum/domain"
import type { WorkspaceRpcClientService } from "./rpc-client.js"

/** One dispatched tool call, decoded from a `tool`-role chat log row. */
export interface ToolLogEntry {
  readonly toolUseId: string
  readonly entityIds: ReadonlyArray<string>
  readonly result: string
  readonly isError: boolean | undefined
}

/** Decodes a tool log row without allowing malformed historic data into routing decisions. */
export const decodeToolLogEntry = (content: string): ToolLogEntry | undefined => {
  try {
    const raw: unknown = JSON.parse(content)
    if (typeof raw !== "object" || raw === null) return undefined
    const record = raw as Record<string, unknown>
    const toolUseId = record.toolUseId
    const result = record.result
    const isError = record.isError
    const entityIds = record.entityIds
    if (typeof toolUseId !== "string" || typeof result !== "string") return undefined
    if (isError !== undefined && typeof isError !== "boolean") return undefined
    if (
      entityIds !== undefined &&
      (!Array.isArray(entityIds) || !entityIds.every((value): value is string => typeof value === "string"))
    ) {
      return undefined
    }
    return {
      toolUseId,
      result,
      entityIds: entityIds === undefined ? [] : entityIds,
      isError
    }
  } catch {
    return undefined
  }
}

/**
 * Extracts the node id from a successful `editNote` result. Historic chat rows are untrusted:
 * failed tool calls, malformed JSON, and arbitrary strings must never become descriptor or fork
 * RPC inputs. Decoding through the domain schema also keeps the runtime UUID/ULID invariant
 * instead of relying on a TypeScript cast.
 */
export const decodeEditNoteNodeId = (entry: ToolLogEntry): EntityId | undefined => {
  if (entry.isError !== false) return undefined
  try {
    return Schema.decodeUnknownSync(EditNoteToolOutput)(JSON.parse(entry.result)).nodeId
  } catch {
    return undefined
  }
}

/** Collects only explicit successful `editNote` tool results from a chat history. */
export const collectLegacyForkNodeIds = (
  messages: ReadonlyArray<{ readonly role: string; readonly content: string }>,
  toolNameByCallId: ReadonlyMap<string, string>
): ReadonlyArray<EntityId> => {
  const ids = new Set<EntityId>()
  for (const message of messages) {
    if (message.role !== "tool") continue
    const entry = decodeToolLogEntry(message.content)
    if (entry === undefined || toolNameByCallId.get(entry.toolUseId) !== "editNote") continue
    const nodeId = decodeEditNoteNodeId(entry)
    if (nodeId !== undefined) ids.add(nodeId)
  }
  return [...ids]
}

export interface LegacyForkPreview {
  readonly nodeId: EntityId
  readonly forked: boolean
  readonly text: string
}

/** Resolves the durable page format before touching the legacy chat-fork RPC. This is kept as a
 * pure client-service helper so its call ordering and fail-closed behavior are testable without
 * rendering the whole chat shell. A migrated Loro page may retain an Automerge witness, but its
 * `activeFormat` remains `loro-v1` and therefore never enters this compatibility path. */
export const loadLegacyForkPreviews = (
  client: WorkspaceRpcClientService,
  workspaceId: EntityId,
  chatId: EntityId,
  nodeIds: ReadonlyArray<EntityId>
): Effect.Effect<ReadonlyArray<LegacyForkPreview>, DomainError> =>
  Effect.forEach(nodeIds, (nodeId) =>
    client.getPageDocumentDescriptor(new GetPageDocumentDescriptorInput({ workspaceId, nodeId })).pipe(
      Effect.flatMap(({ descriptor }) =>
        descriptor.activeFormat === "automerge-v1"
          ? client
              .chatForkPreview(new ChatForkPreviewInput({ workspaceId, chatId, nodeId }))
              .pipe(Effect.map((preview) => ({ nodeId, forked: preview.forked, text: preview.text })))
          : Effect.succeed(undefined)
      )
    )
  ).pipe(
    Effect.map((previews) => previews.filter((preview): preview is LegacyForkPreview => preview !== undefined))
  )
