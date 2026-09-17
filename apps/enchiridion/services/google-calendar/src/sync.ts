import type { CalendarEvent } from "@enchiridion/oauth-client/calendar";
import type { OAuthIntegrationApi, Connection } from "@enchiridion/oauth-client";
import type { CalendarEnv } from "./env";
import { calendarEndpoint } from "./env";

interface Cursor { sync_token: string | null; synced_at: number | null }
interface EventPage { items?: CalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }
export class CalendarError extends Error {}

/** Staging keeps a failed page or expired lease from publishing a partial calendar. */
export async function syncCalendar(env: CalendarEnv, oauth: OAuthIntegrationApi, connection: Connection) {
  const id = connection.id;
  const db = env.DB;
  await db.prepare("INSERT OR IGNORE INTO calendar_syncs (connection_id, owner_id) VALUES (?, ?)").bind(id, connection.ownerId).run();
  const run = crypto.randomUUID();
  const cursor = await db.prepare(`UPDATE calendar_syncs SET lease = ?, lease_until = ? WHERE connection_id = ?
    AND (lease_until IS NULL OR lease_until < ?) RETURNING sync_token, synced_at`).bind(run, Date.now() + 120_000, id, Date.now()).first<Cursor>();
  if (!cursor) throw new CalendarError("This calendar is already syncing. Retry shortly.");
  let syncToken = cursor.sync_token;
  let changed = 0;
  try {
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    let restarted = false;
    for (let page = 0; page < 200; page++) {
      const token = await oauth.getAccessToken(id, ["https://www.googleapis.com/auth/calendar.readonly"]);
      const url = new URL(calendarEndpoint(env));
      url.searchParams.set("maxResults", "100");
      url.searchParams.set("showDeleted", "true");
      // Store recurring series and exceptions; expanding unbounded recurrence can never finish.
      url.searchParams.set("singleEvents", "false");
      if (syncToken) url.searchParams.set("syncToken", syncToken);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(15_000), redirect: "manual" });
      if (response.status === 410 && syncToken && !restarted) {
        syncToken = null; pageToken = undefined; restarted = true; changed = 0;
        await db.prepare("DELETE FROM calendar_staging WHERE run_id = ?").bind(run).run();
        continue;
      }
      if (!response.ok) throw new CalendarError(response.status === 401 ? "Google rejected access. Reconnect the account." : "Google Calendar could not be synced. Retry shortly.");
      const body = await response.json() as EventPage;
      if (!Array.isArray(body.items) || body.items.some((event) => !event || typeof event.id !== "string" || !event.id || event.id.length > 1024)) {
        throw new CalendarError("Google returned an invalid events page.");
      }
      if (body.items.length) {
        await db.batch(body.items.map((event) => db.prepare("INSERT OR REPLACE INTO calendar_staging (run_id, event_id, data, cancelled) VALUES (?, ?, ?, ?)")
          .bind(run, event.id, JSON.stringify(event), event.status === "cancelled" ? 1 : 0)));
      }
      changed += body.items.length;
      const renewed = await db.prepare("UPDATE calendar_syncs SET lease_until = ? WHERE connection_id = ? AND lease = ? AND lease_until > ?")
        .bind(Date.now() + 120_000, id, run, Date.now()).run();
      if (!renewed.meta.changes) throw new CalendarError("The sync lease expired. Retry the sync.");
      if (body.nextPageToken) {
        if (typeof body.nextPageToken !== "string" || body.nextPageToken === pageToken) throw new CalendarError("Google returned an invalid page cursor.");
        pageToken = body.nextPageToken;
        continue;
      }
      nextSyncToken = body.nextSyncToken;
      break;
    }
    if (!nextSyncToken || typeof nextSyncToken !== "string") throw new CalendarError("The calendar sync did not finish. Retry shortly.");
    // Recheck authority immediately before publishing the staged data.
    const authorized = (await oauth.listConnections()).some((item) => item.id === id && item.ownerId === connection.ownerId);
    if (!authorized) throw new CalendarError("Calendar access was removed during sync.");
    const now = Date.now();
    const gate = "EXISTS (SELECT 1 FROM calendar_syncs WHERE connection_id = ? AND lease = ? AND lease_until > ?)";
    const result = await db.batch([
      db.prepare(`DELETE FROM calendar_events WHERE connection_id = ? AND ${gate}
        AND (? = 1 OR event_id IN (SELECT event_id FROM calendar_staging WHERE run_id = ? AND cancelled = 1))`)
        .bind(id, id, run, now, syncToken === null ? 1 : 0, run),
      db.prepare(`INSERT INTO calendar_events (connection_id, event_id, data)
        SELECT ?, event_id, data FROM calendar_staging WHERE run_id = ? AND cancelled = 0 AND ${gate}
        ON CONFLICT(connection_id, event_id) DO UPDATE SET data = excluded.data`).bind(id, run, id, run, now),
      db.prepare("UPDATE calendar_syncs SET sync_token = ?, synced_at = ?, lease = NULL, lease_until = NULL WHERE connection_id = ? AND lease = ? AND lease_until > ?")
        .bind(nextSyncToken, now, id, run, now),
    ]);
    if (result[2].meta.changes !== 1) throw new CalendarError("The sync lease expired. Retry the sync.");
    return { changed, syncedAt: now };
  } finally {
    await db.batch([
      db.prepare("DELETE FROM calendar_staging WHERE run_id = ?").bind(run),
      db.prepare("UPDATE calendar_syncs SET lease = NULL, lease_until = NULL WHERE connection_id = ? AND lease = ?").bind(id, run),
    ]);
  }
}
