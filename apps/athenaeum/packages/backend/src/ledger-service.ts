import {
  ACCEPT_CHAT_FORK_MESSAGE_DERIVATION_VERSION,
  LEDGER_COMMAND_VERSION,
  LEDGER_MESSAGE_DERIVATION_VERSION,
  LedgerCommand,
  acceptChatForkCommitMessage,
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

  /** Records a chat-fork acceptance as the command type promised by the public routing manifest.
   * The immutable proposal rationale is included in the commit message so the ledger explains why
   * the edit was accepted, while the proposal identity remains the replay key. */
  appendAcceptedChatFork(command: {
    readonly proposalId: string; readonly nodeId: string; readonly workspaceId: string; readonly principal: string; readonly policy: string
    readonly rationale: string; readonly provenance: unknown; readonly input: unknown; readonly result: unknown; readonly createdAt: string
  }): void {
    const requestIdentity = `chat-fork:${command.proposalId}`
    const fingerprint = `chat-fork:${command.proposalId}`
    if (this.existing(requestIdentity, fingerprint) !== undefined) return
    const message = `${acceptChatForkCommitMessage(command.proposalId, command.nodeId)} Reason: ${command.rationale.trim()}`
    const persisted = Schema.decodeUnknownSync(LedgerCommand)({
      version: LEDGER_COMMAND_VERSION, requestId: command.proposalId, fingerprint, type: "acceptChatFork",
      workspaceId: command.workspaceId, principal: command.principal, capability: "build", policy: command.policy,
      messageDerivationVersion: ACCEPT_CHAT_FORK_MESSAGE_DERIVATION_VERSION, message,
      payload: { provenance: command.provenance, input: command.input, result: command.result }, createdAt: command.createdAt
    })
    this.sql.exec(
      `INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type, persisted.workspaceId,
      persisted.principal, persisted.capability, persisted.policy, persisted.messageDerivationVersion, persisted.message,
      JSON.stringify(persisted.payload), persisted.createdAt
    )
    this.receipt(requestIdentity, fingerprint, command.result)
  }

  /** The proposal path has caller-supplied rationale and provenance; unlike createNode it never
   * manufactures a message from a title. Kept here so the audit command/receipt shares the DO's
   * existing durable ledger tables and idempotency key. */
  appendAcceptedPageProposal(command: {
    readonly proposalId: string; readonly workspaceId: string; readonly principal: string; readonly policy: string
    readonly rationale: string; readonly provenance: unknown; readonly input: unknown; readonly result: unknown; readonly createdAt: string
  }): void {
    const requestIdentity = `page-proposal:${command.proposalId}`
    const fingerprint = `page-proposal:${command.proposalId}`
    if (this.existing(requestIdentity, fingerprint) !== undefined) return
    const persisted = Schema.decodeUnknownSync(LedgerCommand)({
      version: LEDGER_COMMAND_VERSION, requestId: command.proposalId, fingerprint, type: "acceptPageProposal",
      workspaceId: command.workspaceId, principal: command.principal, capability: "build", policy: command.policy,
      messageDerivationVersion: "caller-rationale.v1", message: command.rationale,
      payload: { provenance: command.provenance, input: command.input, result: command.result }, createdAt: command.createdAt
    })
    this.sql.exec(
      `INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type, persisted.workspaceId,
      persisted.principal, persisted.capability, persisted.policy, persisted.messageDerivationVersion, persisted.message,
      JSON.stringify(persisted.payload), persisted.createdAt
    )
    this.receipt(requestIdentity, fingerprint, command.result)
  }
}
