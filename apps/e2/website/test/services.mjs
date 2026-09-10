import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

// Test-only provider boundary. This module is never included in deployment.
let accounts = [];
let mirrored = false;
let pendingOwner = "";
const app = {
	id: "managed-google",
	name: "Google",
	providerId: "google",
	scopes: [
		"openid",
		"https://www.googleapis.com/auth/contacts.readonly",
		"https://www.googleapis.com/auth/calendar.readonly",
	],
};
class Accounts extends RpcTarget {
	constructor(owner) {
		super();
		this.owner = owner;
	}
	listApps() {
		return [app];
	}
	listConnections() {
		return accounts.filter((entry) => entry.ownerId === this.owner);
	}
	beginConnection() {
		pendingOwner = this.owner;
		return {
			stateId: "a".repeat(64),
			authorizationUrl: "http://localhost/mock-consent",
		};
	}
	grantService(id, service) {
		const account = accounts.find((entry) =>
			entry.id === id && entry.ownerId === this.owner
		);
		if (!account) throw new Error("Unknown account");
		account.services = [service];
	}
	disconnect(id) {
		if (mirrored) throw new Error("Storage must be removed before credentials");
		accounts = accounts.filter((entry) =>
			!(entry.id === id && entry.ownerId === this.owner)
		);
	}
}
class Google extends RpcTarget {
	constructor(owner) {
		super();
		this.owner = owner;
	}
	listConnections() {
		return accounts.filter((entry) =>
			entry.ownerId === this.owner &&
			entry.services.includes("integrations-google")
		);
	}
	syncGoogle() {
		mirrored = true;
		return { changed: 2, pending: true, syncedAt: Date.now() };
	}
	deleteAccount(id) {
		if (
			!accounts.some((entry) => entry.id === id && entry.ownerId === this.owner)
		) throw new Error("Unknown account");
		mirrored = false;
	}
	listRecords(_id, collection) {
		if (!mirrored || !this.listConnections().length) return { records: [] };
		return {
			records: collection === "contacts"
				? [{
					id: "person",
					data: {
						names: [{ displayName: "Ada Lovelace" }],
						emailAddresses: [{ value: "ada@example.test" }],
					},
				}]
				: collection === "calendars"
				? [{
					id: "primary",
					data: { summary: "Personal", accessRole: "owner" },
				}]
				: [{
					id: "event",
					data: {
						summary: "Design review",
						start: { dateTime: "2026-09-10T12:00:00Z" },
						end: { dateTime: "2026-09-10T13:00:00Z" },
					},
				}],
		};
	}
}
export class OAuthAdmin extends WorkerEntrypoint {
	admin(owner) {
		return new Accounts(owner);
	}
}
export class CalendarAdmin extends WorkerEntrypoint {
	admin(owner) {
		return new Google(owner);
	}
}
export default {
	fetch: (request) => {
		const url = new URL(request.url);
		accounts = [{
			id: "account",
			appId: app.id,
			appName: app.name,
			ownerId: pendingOwner,
			providerId: "google",
			accountLabel: "david@example.test",
			status: "connected",
			services: [],
			scopes: app.scopes,
		}];
		return new Response(null, {
			status: 303,
			headers: { Location: `${url.origin}/admin/oauth?result=connected` },
		});
	},
};
