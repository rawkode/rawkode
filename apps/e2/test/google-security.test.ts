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
	scopes: [scopes.calendars, scopes.contacts, scopes.gmail],
	status: "connected",
	grantVersion: 1,
	expiresAt: null,
	createdAt: 0,
	services: ["integrations-google"],
};

const createFixture = (connections: Connection[]) => {
	let reads = 0;
	const oauth: OAuthIntegrationApi & Disposable = {
		canDeleteConnection: (id, owner) =>
			Promise.resolve(
				connections.some((row) => row.id === id && row.ownerId === owner),
			),
		getConnectionForCleanup: (id, owner) =>
			Promise.resolve(
				connections.find((row) => row.id === id && row.ownerId === owner) ??
					null,
			),
		listConnections: () => Promise.resolve(connections),
		getAccessToken: () => Promise.reject(new Error("Unexpected token request")),
		[Symbol.dispose]: () => {},
	};
	const env = {
		OAUTH: { authorize: () => Promise.resolve(oauth) },
		OAUTH_SERVICE_CREDENTIAL: { get: () => Promise.resolve("test-credential") },
		DB: {
			prepare: () => {
				reads++;
				throw new Error("Unauthorized cached read");
			},
		},
	} as unknown as AccountEnv;
	return { api: createAccountApi(env, "alice"), reads: () => reads };
};

Deno.test("Google cached APIs reject connections owned by another user before database access", async () => {
	const { api, reads } = createFixture([{ ...connection, ownerId: "bob" }]);
	assert.deepEqual(await api.listConnections(), []);
	await assert.rejects(() => api.listEvents(connection.id), /not authorized/);
	await assert.rejects(
		() => api.listRecords(connection.id, "contacts"),
		/not authorized/,
	);
	await assert.rejects(() => api.mailStatus(connection.id), /not authorized/);
	assert.equal(reads(), 0);
});

Deno.test("Google cached APIs reject removed scopes before database access", async () => {
	const { api, reads } = createFixture([{ ...connection, scopes: [] }]);
	await assert.rejects(
		() => api.listEvents(connection.id),
		/Missing Google permissions/,
	);
	await assert.rejects(
		() =>
			api.upcoming(
				connection.id,
				"2026-09-10T00:00:00.000Z",
				"2026-09-11T00:00:00.000Z",
			),
		/Missing Google permissions/,
	);
	await assert.rejects(
		() => api.listRecords(connection.id, "calendars"),
		/Missing Google permissions/,
	);
	await assert.rejects(
		() => api.listRecords(connection.id, "contacts"),
		/Missing Google permissions/,
	);
	await assert.rejects(
		() => api.listRecords(connection.id, "events:primary"),
		/Missing Google permissions/,
	);
	await assert.rejects(
		() => api.mailStatus(connection.id),
		/Missing Gmail permissions/,
	);
	assert.equal(reads(), 0);
});

Deno.test("Google cached events reject revoked grants and disconnected or different-provider connections", async () => {
	for (
		const connections of [[], [{
			...connection,
			status: "reconnect_required" as const,
		}], [{ ...connection, providerId: "github" }]]
	) {
		const { api, reads } = createFixture(connections);
		await assert.rejects(() => api.listEvents(connection.id), /not authorized/);
		assert.equal(reads(), 0);
	}
});
