import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"
import { Page } from "./page.js"

// Wire schemas for `NotesService`'s page-body RPC methods (plan §"Storage & domain model":
// "Automerge note-body storage... Implement RPC methods to create a page (initializes an empty
// Automerge text doc), read a page's current text content, and apply a local edit (a plain
// text-replace op for Phase 1)"). Same one-Schema.Class-pair-per-method convention as rpc.ts/
// graph-rpc.ts.

export class CreatePageInput extends Schema.Class<CreatePageInput>("CreatePageInput")({
  workspaceId: EntityId,
  nodeId: EntityId
}) {}

export class CreatePageOutput extends Schema.Class<CreatePageOutput>("CreatePageOutput")({
  page: Page,
  text: Schema.String
}) {}

export class GetPageTextInput extends Schema.Class<GetPageTextInput>("GetPageTextInput")({
  workspaceId: EntityId,
  nodeId: EntityId
}) {}

export class GetPageTextOutput extends Schema.Class<GetPageTextOutput>("GetPageTextOutput")({
  page: Page,
  text: Schema.String
}) {}

/**
 * A plain text-replace op (plan: "a plain text-replace op for Phase 1 — a full ProseMirror
 * rich-text schema is NOT required this phase"): delete `deleteCount` UTF-16 code units starting
 * at `index`, then insert `insertText` at that same position — the same `(index, del, newText)`
 * shape `@automerge/automerge`'s own `splice` primitive takes, applied inside a single Automerge
 * `change` so it's one atomic local edit/one new CRDT change.
 */
export class ApplyPageEditInput extends Schema.Class<ApplyPageEditInput>("ApplyPageEditInput")({
  workspaceId: EntityId,
  nodeId: EntityId,
  index: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  deleteCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  insertText: Schema.String
}) {}

export class ApplyPageEditOutput extends Schema.Class<ApplyPageEditOutput>("ApplyPageEditOutput")({
  page: Page,
  text: Schema.String
}) {}
