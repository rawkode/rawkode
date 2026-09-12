import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

// Test-only provider boundary. This module is never included in deployment.
let dense = false;
const densePeople = Array.from({ length: 23 }, (_, index) => ({
	email: `person${index + 1}@example.test`,
	displayName: [
		"Ada Lovelace",
		"Grace Hopper",
		"Katherine Johnson",
		"Alan Turing",
		"Margaret Hamilton",
		"Edsger Dijkstra",
		"Barbara Liskov",
		"Donald Knuth",
		"Frances Allen",
		"John McCarthy",
		"Radia Perlman",
		"Claude Shannon",
		"Mary Jackson",
		"Ken Thompson",
		"Dorothy Vaughan",
		"Dennis Ritchie",
		"Annie Easley",
		"Tim Berners-Lee",
		"Karen Spärck Jones",
		"James Gosling",
		"Jean Bartik",
		"Guido van Rossum",
		"Sophie Wilson",
	][index],
	responseStatus: "accepted",
}));
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
	upcoming(_id, from, to) {
		if (!mirrored || !this.listConnections().length) {
			return { events: [], partial: false };
		}
		const start = new Date((Date.parse(from) + Date.parse(to)) / 2);
		const end = new Date(start.getTime() + 3_600_000);
		if (dense) {
			const dayStart = Date.parse(from);
			const titles = [
				"Team offsite",
				"Daily planning",
				"Design review",
				"Customer research: onboarding and permissions",
				"Pairing session",
				"Roadmap review",
				"Wrap up",
			];
			const hours = [0, 9, 10, 10.5, 13, 15, 17];
			return {
				events: titles.map((summary, index) => ({
					id: `event-${index}`,
					calendarId: "primary",
					calendarName: "Personal",
					summary,
					start: index === 0 ? { date: start.toISOString().slice(0, 10) } : {
						dateTime: new Date(dayStart + hours[index] * 3600000)
							.toISOString(),
					},
					end: index === 0
						? {
							date: new Date(start.getTime() + 86400000).toISOString().slice(
								0,
								10,
							),
						}
						: {
							dateTime: new Date(dayStart + (hours[index] + 1) * 3600000)
								.toISOString(),
						},
					attendees: index === 0
						? densePeople
						: densePeople.slice(index, index + 4),
				})),
				partial: false,
			};
		}
		return {
			events: [{
				id: "event-today",
				calendarId: "primary",
				calendarName: "Personal",
				summary: "Design review",
				start: { dateTime: start.toISOString() },
				end: { dateTime: end.toISOString() },
				attendees: [{
					email: "ada@example.test",
					displayName: "Ada Lovelace",
					responseStatus: "accepted",
				}],
			}],
			partial: false,
		};
	}
}
class GitHub extends RpcTarget {
	constructor(owner) {
		super();
		this.owner = owner;
	}
	listConnections() {
		return [{
			id: "github-account",
			appId: "github",
			appName: "GitHub",
			ownerId: this.owner,
			providerId: "github",
			accountLabel: "rawkode",
			status: "connected",
			services: ["integrations-github"],
			scopes: ["read:user"],
		}];
	}
	getProfile() {
		return { login: "rawkode", id: 145816 };
	}
	listRepositories() {
		return {
			items: [{
				id: 1,
				name: "rawkode",
				full_name: "rawkode/rawkode",
				html_url: "https://github.com/rawkode/rawkode",
				private: false,
			}],
			nextPage: null,
		};
	}
	listIssues() {
		return { items: [], nextPage: null };
	}
	listPullRequests() {
		return { items: [], nextPage: null };
	}
	listActivity() {
		if (dense) {
			return {
				items: Array.from({ length: 30 }, (_, index) => ({
					id: `activity-${index}`,
					type: index % 4 === 0 ? "PullRequestEvent" : "IssuesEvent",
					created_at: new Date(Date.now() - index * 600000).toISOString(),
					actor: { login: index % 2 ? "rawkode" : "contributor" },
					repo: {
						name: [
							"rawkode/apsides",
							"cuenv/cuenv",
							"rawkode-academy/website",
						][index % 3],
					},
					payload: {
						action: index % 2 ? "opened" : "closed",
						[index % 4 === 0 ? "pull_request" : "issue"]: {
							id: index + 100,
							node_id: `dense-${index}`,
							title: [
								"Improve calendar keyboard navigation",
								"Keep note changes across navigation",
								"Clarify account connection status",
								"Handle overlapping events in the day view",
								"Update documentation links",
							][index % 5] + ` (${index + 1})`,
							html_url: `https://github.com/rawkode/apsides/issues/${
								index + 100
							}`,
						},
					},
				})),
				nextPage: null,
			};
		}
		return {
			items: [{
				id: "github-event-today",
				type: "IssuesEvent",
				created_at: new Date().toISOString(),
				actor: { login: "rawkode" },
				repo: { name: "rawkode/rawkode" },
				payload: {
					action: "opened",
					issue: {
						id: 42,
						node_id: "I_fixture",
						title: "Ship canonical entities",
						html_url: "https://github.com/rawkode/rawkode/issues/42",
					},
				},
			}],
			nextPage: null,
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
export class GitHubAdmin extends WorkerEntrypoint {
	admin(owner) {
		return new GitHub(owner);
	}
}
export default {
	fetch: (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/dense") {
			dense = true;
			return new Response("Dense fixture enabled");
		}
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
