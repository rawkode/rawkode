import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"

/**
 * Transitional, workspace-local command ledger contract. It is deliberately a domain contract,
 * not an authority system or a Durable Object of its own: only the Workspace DO derives and
 * persists these records while the broader mutation surface remains direct.
 */
export const LEDGER_COMMAND_VERSION = "athenaeum.workspace-ledger.v1" as const
/**
 * The current public `createNode` input has no caller-provided rationale. This version marks the
 * deterministic, server-derived compatibility placeholder until the full command contract adds
 * required caller/job rationale.
 */
export const LEDGER_MESSAGE_DERIVATION_VERSION = "create-node-title-compat.v1" as const

export const normalizeCreateNodeTitle = (title: string): string => title.trim().replace(/\s+/g, " ")

/**
 * Compatibility-only rationale: the server must not pretend the title is caller intent. Keeping
 * the derivation pure makes explicit-id replays immutable and deterministic; a future full
 * command contract must require caller/job rationale instead of extending this placeholder.
 */
export const createNodeCommitMessage = (title: string): string =>
  `Create node to record ${normalizeCreateNodeTitle(title)}.`

export class LedgerCommand extends Schema.Class<LedgerCommand>("LedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: Schema.String.pipe(Schema.minLength(1)),
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("createNode"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(LEDGER_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Unknown,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class LedgerReceipt extends Schema.Class<LedgerReceipt>("LedgerReceipt")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: Schema.String.pipe(Schema.minLength(1)),
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  commandKey: Schema.String.pipe(Schema.minLength(1)),
  nodeId: EntityId,
  output: Schema.Unknown
}) {}
