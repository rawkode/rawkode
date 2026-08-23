import {
  LEDGER_COMMAND_VERSION,
  LEDGER_MESSAGE_DERIVATION_VERSION,
  LedgerCommand,
  createNodeCommitMessage
} from "@athenaeum/domain"
import * as Schema from "effect/Schema"

/** Workspace-local transitional ledger. This is not an authority service and is intentionally
 * not a separate Durable Object: it shares WorkspaceDO SQLite so its command, receipt and the
 * existing projections can commit in one `transactionSync` scope. */
export interface CreateNodeLedgerCommand {
  readonly requestIdentity: string
  readonly requestId: string
  readonly fingerprint: string
  readonly workspaceId: string
  readonly principal: string
  readonly policy: string
  readonly title: string
  readonly payload: unknown
  readonly createdAt: string
}

export interface StoredLedgerReceipt {
  readonly fingerprint: string
  readonly output: unknown
}

export class LedgerConflict extends Error {}

export const ledgerFingerprint = (command: Omit<CreateNodeLedgerCommand, "fingerprint" | "requestId" | "requestIdentity" | "createdAt">): string => {
  // A stable non-cryptographic fingerprint is sufficient for same-DO idempotency conflict
  // detection; it is not presented as a security primitive.
  const source = JSON.stringify({
    version: LEDGER_COMMAND_VERSION,
    type: "createNode",
    workspaceId: command.workspaceId,
    principal: command.principal,
    policy: command.policy,
    message: createNodeCommitMessage(command.title),
    payload: command.payload
  })
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export class LedgerService {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ledger_commands (
      requestIdentity TEXT PRIMARY KEY, requestId TEXT NOT NULL, fingerprint TEXT NOT NULL,
      version TEXT NOT NULL, type TEXT NOT NULL, workspaceId TEXT NOT NULL, principal TEXT NOT NULL,
      capability TEXT NOT NULL, policy TEXT NOT NULL, messageDerivationVersion TEXT NOT NULL,
      message TEXT NOT NULL, payload TEXT NOT NULL, createdAt TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS ledger_receipts (
      requestIdentity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, output TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS ledger_outbox_intents (
      requestIdentity TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL
    )`)
  }

  existing(requestIdentity: string, fingerprint: string): StoredLedgerReceipt | undefined {
    const row = this.sql.exec<{ fingerprint: string; output: string }>(
      "SELECT fingerprint, output FROM ledger_receipts WHERE requestIdentity = ?", requestIdentity
    ).toArray()[0]
    if (row === undefined) return undefined
    if (row.fingerprint !== fingerprint) throw new LedgerConflict("request identity was already used for a different command")
    return { fingerprint: row.fingerprint, output: JSON.parse(row.output) }
  }

  append(command: CreateNodeLedgerCommand): void {
    // Decode the exact persisted shape before INSERT. The schema is the compatibility contract
    // for immutable records, not merely a read-side assertion in tests.
    const persisted = Schema.decodeUnknownSync(LedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "createNode",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: LEDGER_MESSAGE_DERIVATION_VERSION,
      message: createNodeCommitMessage(command.title),
      payload: command.payload,
      createdAt: command.createdAt
    })
    this.sql.exec(
      `INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      command.requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type,
      persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy, persisted.messageDerivationVersion,
      persisted.message, JSON.stringify(persisted.payload), persisted.createdAt
    )
  }

  appendOutboxIntent(requestIdentity: string, nodeId: string): void {
    this.sql.exec("INSERT INTO ledger_outbox_intents (requestIdentity, kind, payload) VALUES (?, ?, ?)",
      requestIdentity, "sync-feed", JSON.stringify({ nodeId }))
  }

  receipt(requestIdentity: string, fingerprint: string, output: unknown): void {
    this.sql.exec("INSERT INTO ledger_receipts (requestIdentity, fingerprint, output) VALUES (?, ?, ?)",
      requestIdentity, fingerprint, JSON.stringify(output))
  }
}
