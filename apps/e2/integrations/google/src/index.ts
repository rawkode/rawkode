import { WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse, RpcTarget } from "capnweb";
import { connectOAuth } from "@e2/oauth-client";
import type { CalendarApi } from "@e2/oauth-client/calendar";
import type { CalendarEnv } from "./env.ts";
import { CalendarError } from "./sync.ts";
import { receiveMailNotification } from "./gmail.ts";
import { createCalendarAdminApi } from "./api.ts";
export { createCalendarAdminApi } from "./api.ts";
export { GoogleAccount } from "./account.ts";

// Cap'n Web exposes prototype methods; state and business logic stay in the factory.
export class CalendarAdminApi extends RpcTarget implements CalendarApi {
	#api: ReturnType<typeof createCalendarAdminApi>;
	constructor(env: CalendarEnv, owner: string) {
		super();
		this.#api = createCalendarAdminApi(env, owner);
	}
	deleteAccount(connectionId: string) {
		return this.#api.deleteAccount(connectionId);
	}
	listConnections() {
		return this.#api.listConnections();
	}
	sync(connectionId: string) {
		return this.#api.sync(connectionId);
	}
	syncGoogle(connectionId: string) {
		return this.#api.syncGoogle(connectionId);
	}
	listRecords(connectionId: string, collection: string, after = "") {
		return this.#api.listRecords(connectionId, collection, after);
	}
	searchMail(connectionId: string, query: string, pageToken?: string) {
		return this.#api.searchMail(connectionId, query, pageToken);
	}
	upcoming(connectionId: string, from: string, to: string) {
		return this.#api.upcoming(connectionId, from, to);
	}
	watchMail(connectionId: string) {
		return this.#api.watchMail(connectionId);
	}
	mailPeople(connectionId: string, from: string, to: string) {
		return this.#api.mailPeople(connectionId, from, to);
	}
	mailStatus(connectionId: string) {
		return this.#api.mailStatus(connectionId);
	}
	listEvents(connectionId: string) {
		return this.#api.listEvents(connectionId);
	}
}

export class CalendarAdmin extends WorkerEntrypoint<CalendarEnv> {
	admin(ownerId: string) {
		if (typeof ownerId !== "string" || !ownerId || ownerId.length > 200) {
			throw new CalendarError("Unauthorized.");
		}
		return new CalendarAdminApi(this.env, ownerId);
	}
	override fetch(request: Request) {
		const owner = request.headers.get("X-E2-Owner");
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}
		if (!owner) return new Response("Unauthorized", { status: 401 });
		return newWorkersRpcResponse(request, this.admin(owner));
	}
}

export default {
	fetch: async (request, env) => {
		if (new URL(request.url).pathname === "/gmail/notifications") {
			using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
			return await receiveMailNotification(request, env, oauth);
		}
		return new URL(request.url).pathname === "/health"
			? Response.json({ service: "integrations-google", status: "ok" })
			: new Response("Not found", { status: 404 });
	},
	scheduled: async (_event, env) => {
		using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
		for (const connection of await oauth.listConnections()) {
			if (
				connection.providerId !== "google" || connection.status !== "connected"
			) continue;
			try {
				if (!env.GOOGLE_ACCOUNTS) {
					throw new Error("Missing account coordinator binding");
				}
				await env.GOOGLE_ACCOUNTS.getByName(connection.id).start(connection.id);
			} catch {
				console.error("Calendar sync failed", { connectionId: connection.id });
			}
		}
	},
} satisfies ExportedHandler<CalendarEnv>;
