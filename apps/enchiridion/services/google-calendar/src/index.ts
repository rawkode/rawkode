import { WorkerEntrypoint } from "cloudflare:workers";
import { RpcTarget, newWorkersRpcResponse } from "capnweb";
import { connectOAuth, type Connection } from "@enchiridion/oauth-client";
import type { CalendarApi, CalendarEvent } from "@enchiridion/oauth-client/calendar";
import type { CalendarEnv } from "./env";
import { CalendarError, syncCalendar } from "./sync";
import { syncGoogle } from './mirror';
import { scopes, endpoint, googleRequest, authorized } from './google';
import { searchMail, watchMail, receiveMailNotification, mailPeople } from './gmail';
export { GoogleAccount } from './account';

export class CalendarAdminApi extends RpcTarget implements CalendarApi {
  #env: CalendarEnv;
  #owner: string;
  constructor(env: CalendarEnv, owner: string) { super(); this.#env = env; this.#owner = owner; }

  async #run<T>(action: () => Promise<T>) {
    try { return await action(); }
    catch (error) {
      throw new CalendarError(error instanceof CalendarError ? error.message : "Calendar access is unavailable. Check the account connection and service grant.");
    }
  }
  listConnections() {
    return this.#run(async () => {
      using oauth = await connectOAuth(this.#env.OAUTH, this.#env.OAUTH_SERVICE_CREDENTIAL);
      return (await oauth.listConnections()).filter((row) => row.ownerId === this.#owner && row.providerId === "google" && row.status === 'connected');
    });
  }
  async #connection(id: string): Promise<Connection> {
    if (typeof id !== "string") throw new CalendarError("Select a calendar connection.");
    const connection = (await this.listConnections()).find((row) => row.id === id);
    if (!connection) throw new CalendarError("This calendar connection is not authorized.");
    return connection;
  }
  sync(connectionId: string) {
    return this.#run(async () => {
      const connection = await this.#connection(connectionId);
      using oauth = await connectOAuth(this.#env.OAUTH, this.#env.OAUTH_SERVICE_CREDENTIAL);
      return await syncCalendar(this.#env, oauth, connection);
    });
  }
  syncGoogle(connectionId: string) {
    return this.#run(async () => {
      const connection = await this.#connection(connectionId);
      if (this.#env.GOOGLE_ACCOUNTS) {
        await this.#env.GOOGLE_ACCOUNTS.getByName(connection.id).start(connection.id, true);
        return { changed: 0, pending: true, syncedAt: Date.now() };
      }
      using oauth = await connectOAuth(this.#env.OAUTH, this.#env.OAUTH_SERVICE_CREDENTIAL);
      return await syncGoogle(this.#env, oauth, connection);
    });
  }
  listRecords(connectionId: string, collection: string, after = '') {
    return this.#run(async () => {
      const connection = await this.#connection(connectionId);
      if (typeof collection !== 'string' || collection.length > 2100 || !['contacts', 'calendars'].includes(collection) && !collection.startsWith('events:') || typeof after !== 'string' || after.length > 2048) throw new CalendarError('Invalid collection');
      if (!connection.scopes.includes(collection === 'contacts' ? scopes.contacts : scopes.calendars)) throw new CalendarError('Missing Google permissions');
      if (collection.startsWith('events:')) {
        const calendar = await this.#env.DB.prepare("SELECT 1 FROM google_records WHERE connection_id = ? AND collection = 'calendars' AND resource_id = ? AND deleted = 0 AND json_extract(data, '$.accessRole') IN ('reader','writer','owner')").bind(connectionId, collection.slice(7)).first();
        if (!calendar) throw new CalendarError('Calendar is no longer accessible');
      }
      const { results } = await this.#env.DB.prepare('SELECT resource_id, data FROM google_records WHERE connection_id = ? AND collection = ? AND deleted = 0 AND resource_id > ? ORDER BY resource_id LIMIT 101').bind(connectionId, collection, after).all<{ resource_id: string; data: string }>();
      return { records: results.slice(0, 100).map(r => ({ id: r.resource_id, data: JSON.parse(r.data) as Record<string, unknown> })), nextCursor: results.length > 100 ? results[99].resource_id : undefined };
    });
  }
  searchMail(connectionId: string, query: string, pageToken?: string) {
    return this.#run(async () => {
      const connection = await this.#connection(connectionId);
      using oauth = await connectOAuth(this.#env.OAUTH, this.#env.OAUTH_SERVICE_CREDENTIAL);
      return await searchMail(this.#env, oauth, connection, query, pageToken);
    });
  }
  upcoming(connectionId: string, from: string, to: string) {
    return this.#run(async () => {
      const connection = await this.#connection(connectionId);
      if (typeof from !== 'string' || typeof to !== 'string' || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 2 * 86400000) throw new CalendarError('Invalid event window');
      using oauth = await connectOAuth(this.#env.OAUTH, this.#env.OAUTH_SERVICE_CREDENTIAL);
      const calendars = await this.#env.DB.prepare("SELECT resource_id, data FROM google_records WHERE connection_id = ? AND collection = 'calendars' AND deleted = 0 AND json_extract(data, '$.accessRole') IN ('reader','writer','owner') ORDER BY resource_id LIMIT 11").bind(connectionId).all<{ resource_id: string; data: string }>();
      const events: (CalendarEvent & { calendarId: string; calendarName: string })[] = [];
      let partial = calendars.results.length > 10;
      for (const calendar of calendars.results.slice(0, 10)) {
        try {
          // Bounded live expansion handles recurring and moved instances correctly.
          const url = endpoint(this.#env, `/calendar/v3/calendars/${encodeURIComponent(calendar.resource_id)}/events`);
          for (const [key, value] of Object.entries({ timeMin: from, timeMax: to, singleEvents: 'true', orderBy: 'startTime', maxResults: '100' })) url.searchParams.set(key, value);
          const response = await googleRequest(oauth, connection, scopes.calendars, url);
          if (!response.ok) { partial = true; continue; }
          const body = await response.json() as { items?: CalendarEvent[]; nextPageToken?: string };
          partial ||= Boolean(body.nextPageToken);
          for (const event of body.items ?? []) if (event.status !== 'cancelled') events.push({ ...event, calendarId: calendar.resource_id, calendarName: JSON.parse(calendar.data).summary || calendar.resource_id });
        } catch { partial = true; }
      }
      await authorized(oauth, connection, scopes.calendars);
      return { events, partial };
    });
  }
  watchMail(connectionId: string) {
    return this.#run(async () => {
      const connection = await this.#connection(connectionId);
      using oauth = await connectOAuth(this.#env.OAUTH, this.#env.OAUTH_SERVICE_CREDENTIAL);
      return await watchMail(this.#env, oauth, connection);
    });
  }
  mailPeople(connectionId: string, from: string, to: string) {
    return this.#run(async () => {
      const connection = await this.#connection(connectionId);
      using oauth = await connectOAuth(this.#env.OAUTH, this.#env.OAUTH_SERVICE_CREDENTIAL);
      return await mailPeople(this.#env, oauth, connection, from, to);
    });
  }
  mailStatus(connectionId: string) {
    return this.#run(async () => {
      const connection = await this.#connection(connectionId);
      if (!connection.scopes.includes(scopes.gmail)) throw new CalendarError('Missing Gmail permissions');
      return await this.#env.DB.prepare('SELECT expiration, history_id, notified_at FROM gmail_watches WHERE connection_id = ?').bind(connectionId).first<{ expiration: number; history_id: string; notified_at: number | null }>();
    });
  }
  listEvents(connectionId: string) {
    return this.#run(async () => {
      await this.#connection(connectionId);
      const { results } = await this.#env.DB.prepare("SELECT data FROM calendar_events WHERE connection_id = ? ORDER BY COALESCE(json_extract(data, '$.start.dateTime'), json_extract(data, '$.start.date')), event_id LIMIT 500")
        .bind(connectionId).all<{ data: string }>();
      const cursor = await this.#env.DB.prepare("SELECT synced_at FROM calendar_syncs WHERE connection_id = ? AND owner_id = ?").bind(connectionId, this.#owner).first<{ synced_at: number | null }>();
      return { events: results.map((row) => JSON.parse(row.data) as CalendarEvent), syncedAt: cursor?.synced_at ?? null };
    });
  }
}

export class CalendarAdmin extends WorkerEntrypoint<CalendarEnv> {
  admin(ownerId: string) {
    if (typeof ownerId !== "string" || !ownerId || ownerId.length > 200) throw new CalendarError("Unauthorized.");
    return new CalendarAdminApi(this.env, ownerId);
  }
  async fetch(request: Request) {
    const owner = request.headers.get("X-Enchiridion-Owner");
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (!owner) return new Response("Unauthorized", { status: 401 });
    return newWorkersRpcResponse(request, this.admin(owner));
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/gmail/notifications') {
      using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
      return await receiveMailNotification(request, env, oauth);
    }
    return new URL(request.url).pathname === "/health" ? Response.json({ service: "google-worker", status: "ok" }) : new Response("Not found", { status: 404 });
  },
  async scheduled(_event, env) {
    using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
    for (const connection of await oauth.listConnections()) {
      if (connection.providerId !== "google" || connection.status !== "connected") continue;
      try {
        if (!env.GOOGLE_ACCOUNTS) throw new Error('Missing account coordinator binding');
        await env.GOOGLE_ACCOUNTS.getByName(connection.id).start(connection.id);
      }
      catch { console.error("Calendar sync failed", { connectionId: connection.id }); }
    }
  },
} satisfies ExportedHandler<CalendarEnv>;
