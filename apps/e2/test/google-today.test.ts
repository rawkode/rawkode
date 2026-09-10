import { strict as assert } from "node:assert";
import type { Connection, OAuthIntegrationApi } from "@e2/oauth-client";
import { createAccountApi } from "../integrations/google/src/account-api.ts";
import type { AccountEnv } from "../integrations/google/src/env.ts";
import { scopes } from "../integrations/google/src/google.ts";

const connection: Connection = {
	id: "google-account",
	ownerId: "alice",
	appId: "google",
	appName: "Google",
	providerId: "google",
	accountId: "alice-google",
	accountLabel: "alice@example.com",
	scopes: [scopes.calendars],
	status: "connected",
	grantVersion: 1,
	expiresAt: null,
	createdAt: 0,
	services: ["integrations-google"],
};

const createApi = (accessRole = "owner") => {
	const oauth: OAuthIntegrationApi & Disposable = {
		canDeleteConnection: () => Promise.resolve(true),
		getConnectionForCleanup: () => Promise.resolve(connection),
		listConnections: () => Promise.resolve([connection]),
		getAccessToken: () => Promise.reject(new Error("Unexpected token request")),
		[Symbol.dispose]: () => {},
	};
	const calendar = {
		resource_id: "calendar",
		data: JSON.stringify({
			summary: "Calendar",
			accessRole,
			timeZone: "America/Los_Angeles",
		}),
	};
	const event = {
		collection: "instances:calendar",
		resource_id: "series_20260910T120000Z",
		data: JSON.stringify({
			id: "series_20260910T120000Z",
			summary: "Weekly meeting",
			start: { dateTime: "2026-09-10T12:00:00Z" },
			end: { dateTime: "2026-09-10T13:00:00Z" },
			recurringEventId: "series",
		}),
		deleted: 0,
	};
	const allDayEvent = {
		collection: "instances:calendar",
		resource_id: "all_day_20260910",
		data: JSON.stringify({
			id: "all_day_20260910",
			summary: "Company holiday",
			start: { date: "2026-09-10" },
			end: { date: "2026-09-11" },
		}),
		deleted: 0,
	};
	const syncs = [
		{ collection: "calendars", synced_at: Date.now(), page_token: null },
		{ collection: "events:calendar", synced_at: Date.now(), page_token: null },
		{
			collection: "instances:calendar",
			synced_at: Date.now(),
			page_token: null,
		},
	];
	const env = {
		OAUTH: { authorize: () => Promise.resolve(oauth) },
		OAUTH_SERVICE_CREDENTIAL: { get: () => Promise.resolve("test-credential") },
		DB: {
			prepare: (sql: string) => ({
				bind: () => ({
					all: () =>
						Promise.resolve({
							results: sql.includes("collection = 'calendars'")
								? [calendar]
								: sql.includes("google_syncs")
								? syncs
								: [event, allDayEvent],
						}),
				}),
			}),
		},
	} as unknown as AccountEnv;
	return createAccountApi(env, "alice");
};

Deno.test("Today reads provider-expanded event instances from storage", async () => {
	const result = await createApi().upcoming(
		connection.id,
		"2026-09-10T00:00:00.000Z",
		"2026-09-11T00:00:00.000Z",
	);
	assert.equal(result.partial, false);
	assert.equal(result.events.length, 2);
	const timed = result.events.find(({ id }) =>
		id === "series_20260910T120000Z"
	);
	const allDay = result.events.find(({ id }) => id === "all_day_20260910");
	assert.equal(timed?.start?.dateTime, "2026-09-10T12:00:00Z");
	assert.equal(allDay?.start?.date, "2026-09-10");
});

Deno.test("Today excludes calendars without event-read access", async () => {
	const result = await createApi("freeBusyReader").upcoming(
		connection.id,
		"2026-09-10T00:00:00.000Z",
		"2026-09-11T00:00:00.000Z",
	);
	assert.deepEqual(result.events, []);
});

Deno.test("Today accepts the full three-day query window", async () => {
	const result = await createApi().upcoming(
		connection.id,
		"2026-09-10T00:00:00.000Z",
		"2026-09-13T00:00:00.000Z",
	);
	assert.equal(result.partial, false);
});
