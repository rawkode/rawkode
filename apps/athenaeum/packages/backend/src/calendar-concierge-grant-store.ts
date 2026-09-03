/** Durable issuer-owned records for the calendar concierge job capability. */
import type { SqlStorage } from "@cloudflare/workers-types"
import { canonicalJsonBytes, sha256HexSync } from "@athenaeum/domain"
import {
  resolveCalendarConciergeGrant,
  type CalendarConciergeGrantV1,
  type OpaqueCalendarConciergeGrantToken
} from "./calendar-concierge-job-capability.js"

export const CALENDAR_CONCIERGE_GRANT_STORE_VERSION = "athenaeum.calendar-concierge-grant-store.v1" as const

const tokenDigest = (token: string): string => sha256HexSync(canonicalJsonBytes({
  version: CALENDAR_CONCIERGE_GRANT_STORE_VERSION,
  token
}))

const opaque = (token: string): OpaqueCalendarConciergeGrantToken => token as unknown as OpaqueCalendarConciergeGrantToken

export interface IssuedCalendarConciergeGrant {
  readonly grant: CalendarConciergeGrantV1
  readonly token: OpaqueCalendarConciergeGrantToken
}

/**
 * SQLite stores only the token digest and immutable grant record. The raw capability token is
 * returned to the in-process executor and is never persisted or exposed through an RPC surface.
 * A later invocation (including after DO eviction) receives a fresh token/grant record.
 */
export class DurableCalendarConciergeGrantStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS calendar_concierge_grants (
      grantId TEXT PRIMARY KEY,
      tokenDigest TEXT NOT NULL UNIQUE,
      grantJson TEXT NOT NULL,
      issuedAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      consumedAt TEXT
    )`)
    sql.exec("CREATE INDEX IF NOT EXISTS calendar_concierge_grants_expiry ON calendar_concierge_grants (expiresAt)")
  }

  issue(grant: CalendarConciergeGrantV1): IssuedCalendarConciergeGrant {
    const immutable = resolveCalendarConciergeGrant(grant)
    const token = `ccg_${crypto.randomUUID()}_${crypto.randomUUID()}`
    this.sql.exec(
      `INSERT INTO calendar_concierge_grants
        (grantId, tokenDigest, grantJson, issuedAt, expiresAt)
       VALUES (?, ?, ?, ?, ?)`,
      immutable.grantId,
      tokenDigest(token),
      JSON.stringify(immutable),
      immutable.issuedAt,
      immutable.expiresAt
    )
    return { grant: immutable, token: opaque(token) }
  }

  resolve(token: OpaqueCalendarConciergeGrantToken): CalendarConciergeGrantV1 | undefined {
    const raw = token as unknown as string
    if (typeof raw !== "string" || raw.trim().length === 0) return undefined
    const row = this.sql.exec<{ grantJson: string }>(
      "SELECT grantJson FROM calendar_concierge_grants WHERE tokenDigest = ?",
      tokenDigest(raw)
    ).toArray()[0]
    if (row === undefined) return undefined
    return resolveCalendarConciergeGrant(JSON.parse(row.grantJson))
  }

  isConsumed(grantId: string): boolean {
    return this.sql.exec("SELECT 1 FROM calendar_concierge_grants WHERE grantId = ? AND consumedAt IS NOT NULL", grantId).toArray().length > 0
  }

  consume(grantId: string, token: OpaqueCalendarConciergeGrantToken, now = new Date()): boolean {
    const raw = token as unknown as string
    const result = this.sql.exec(
      "UPDATE calendar_concierge_grants SET consumedAt = ? WHERE grantId = ? AND tokenDigest = ? AND consumedAt IS NULL",
      now.toISOString(),
      grantId,
      tokenDigest(raw)
    )
    return result.rowsWritten === 1
  }
}
