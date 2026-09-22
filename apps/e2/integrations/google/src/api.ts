import { connectOAuth } from "@e2/oauth-client";
import type { CalendarEnv } from "./env.ts";
import { CalendarError } from "./sync.ts";

/** The private entrypoint checks ownership before routing to account-local storage. */
export const createCalendarAdminApi = (env: CalendarEnv, owner: string) => {
	const listConnections = async () => {
		using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
		return (await oauth.listConnections()).filter((row) =>
			row.ownerId === owner && row.providerId === "google" &&
			row.status === "connected"
		);
	};
	const account = async (id: string) => {
		if (
			typeof id !== "string" ||
			!(await listConnections()).some((row) => row.id === id)
		) {
			throw new CalendarError("This calendar connection is not authorized.");
		}
		return env.GOOGLE_ACCOUNTS.getByName(id);
	};
	return {
		listConnections,
		sync: async (id: string) => (await account(id)).sync(id, owner),
		syncGoogle: async (id: string) => {
			await (await account(id)).start(id, true);
			return { changed: 0, pending: true, syncedAt: Date.now() };
		},
		listRecords: async (id: string, collection: string, after = "") =>
			(await account(id)).listRecords(id, owner, collection, after),
		searchMail: async (id: string, query: string, pageToken?: string) =>
			(await account(id)).searchMail(id, owner, query, pageToken),
		upcoming: async (id: string, from: string, to: string) =>
			(await account(id)).upcoming(id, owner, from, to),
		watchMail: async (id: string) => (await account(id)).watchMail(id, owner),
		mailPeople: async (id: string, from: string, to: string) =>
			(await account(id)).mailPeople(id, owner, from, to),
		mailStatus: async (id: string) => (await account(id)).mailStatus(id, owner),
		listEvents: async (id: string) => (await account(id)).listEvents(id, owner),
		deleteAccount: async (id: string) => {
			using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
			if (!await oauth.getConnectionForCleanup(id, owner)) {
				throw new CalendarError("This calendar connection is not authorized.");
			}
			await env.GOOGLE_ACCOUNTS.getByName(id).deleteAccount(id, owner);
		},
	};
};
