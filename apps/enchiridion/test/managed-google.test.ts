import { strict as assert } from "node:assert";
import { testDatabase } from "./legacy/d1.ts";
import { startMockGoogle } from "./legacy/mock-google.ts";
import { createAdminApi } from "../integrations/oauth/src/admin.ts";
import { appSecret, getApp } from "../integrations/oauth/src/apps.ts";
import {
	bindingCookieName,
	callback,
} from "../integrations/oauth/src/callback.ts";
import { randomSecret, sha256 } from "../integrations/oauth/src/crypto.ts";
import { createIntegrationApi } from "../integrations/oauth/src/tokens.ts";
import type { OAuthEnv } from "../integrations/oauth/src/env.ts";

const secret = (value: string) => ({ get: () => Promise.resolve(value) });
const environment = (db: D1Database): OAuthEnv => ({
	DB: db,
	WEBSITE_ORIGIN: "http://localhost:4321",
	TOKEN_KEYRING: secret(
		JSON.stringify({ active: "test", keys: { test: btoa("a".repeat(32)) } }),
	),
	GOOGLE_SERVICE_CREDENTIAL: secret("g".repeat(40)),
	GITHUB_SERVICE_CREDENTIAL: secret("h".repeat(40)),
	GOOGLE_CLIENT_ID: secret("managed-google-client"),
	GOOGLE_CLIENT_SECRET: secret("managed-secret"),
});

Deno.test("managed Google metadata preserves foreign keys without storing credentials and rejects identity replacement", async () => {
	const storage = await testDatabase(
		"../../integrations/oauth/migrations",
	);
	try {
		const env = environment(storage.db);
		const api = createAdminApi(env, "owner");
		const apps = await api.listApps();
		assert.equal(apps[0].id, "google");
		assert.deepEqual(apps[0].scopes, [
			"email",
			"https://www.googleapis.com/auth/calendar.readonly",
			"https://www.googleapis.com/auth/contacts.other.readonly",
			"https://www.googleapis.com/auth/contacts.readonly",
			"https://www.googleapis.com/auth/directory.readonly",
			"https://www.googleapis.com/auth/gmail.readonly",
			"openid",
			"profile",
		]);
		// Existing metadata must adopt requested scopes without changing issued grants.
		await storage.db.prepare(
			"UPDATE oauth_apps SET scopes = ?, name = ? WHERE id = 'google'",
		)
			.bind(JSON.stringify(["openid", "email"]), "Google Calendar").run();
		const authorization = await api.beginConnection({
			appId: "google",
			browserBindingHash: "a".repeat(64),
		});
		assert.deepEqual(
			new URL(authorization.authorizationUrl).searchParams.get("scope")?.split(
				" ",
			),
			apps[0].scopes,
		);
		assert.deepEqual((await api.listApps())[0].scopes, apps[0].scopes);
		assert.equal(
			storage.sqlite.query(
				"SELECT client_secret FROM oauth_apps WHERE id = 'google'",
			).get()?.client_secret,
			"",
		);
		const dynamic = await api.createApp({
			name: "Other",
			providerId: "github",
			clientId: "dynamic",
			clientSecret: "dynamic-secret",
			scopes: ["read:user"],
		});
		assert.equal(
			await appSecret(env, (await getApp(env, dynamic.id))!),
			"dynamic-secret",
		);
		const changed = { ...env, GOOGLE_CLIENT_ID: secret("replacement") };
		await assert.rejects(
			createAdminApi(changed, "owner").listApps(),
			/identity changed/,
		);
		await assert.rejects(
			createAdminApi({ ...env, GOOGLE_CLIENT_SECRET: undefined }, "owner")
				.listApps(),
			/configured together/,
		);
		const removed = {
			...env,
			GOOGLE_CLIENT_ID: undefined,
			GOOGLE_CLIENT_SECRET: undefined,
		};
		assert.equal(await getApp(removed, "google"), null);
		assert.deepEqual(
			(await createAdminApi(removed, "owner").listApps()).map((app) => app.id),
			[dynamic.id],
		);
	} finally {
		storage.sqlite.close();
	}
});

Deno.test("managed Google callback and refresh use the current Secrets Store client secret", async () => {
	const storage = await testDatabase(
		"../../integrations/oauth/migrations",
	);
	const mock = await startMockGoogle(0);
	const originalFetch = globalThis.fetch;
	const submitted: string[] = [];
	globalThis.fetch = (input, init) => {
		if (String(input) === `${mock.origin}/token`) {
			submitted.push(
				new URLSearchParams(init?.body as string).get("client_secret")!,
			);
		}
		return originalFetch(input, init);
	};
	try {
		let currentSecret = "callback-secret";
		const env = {
			...environment(storage.db),
			LOCAL_PROVIDER_ORIGIN: mock.origin,
			GOOGLE_CLIENT_SECRET: { get: () => Promise.resolve(currentSecret) },
		};
		const admin = createAdminApi(env, "owner");
		const browser = randomSecret();
		const start = await admin.beginConnection({
			appId: "google",
			browserBindingHash: await sha256(browser),
		});
		const url = new URL(start.authorizationUrl);
		url.searchParams.set("approve", "yes");
		const approved = await fetch(url, { redirect: "manual" });
		await approved.body?.cancel();
		const completed = await callback(
			new Request(approved.headers.get("location")!, {
				headers: {
					Cookie: `${bindingCookieName(start.stateId, false)}=${browser}`,
				},
			}),
			env,
		);
		assert.match(completed.headers.get("location")!, /result=connected/);
		const connection = (await admin.listConnections())[0];
		await admin.grantService(connection.id, "integrations-google");
		storage.sqlite.exec("UPDATE oauth_connections SET expires_at = 1");
		currentSecret = "rotated-secret";
		const token = await createIntegrationApi(env, "g".repeat(40))
			.getAccessToken(connection.id, [
				"https://www.googleapis.com/auth/calendar.readonly",
			]);
		assert.ok(token.accessToken);
		assert.deepEqual(submitted, ["callback-secret", "rotated-secret"]);
		assert.equal(
			storage.sqlite.query(
				"SELECT client_secret FROM oauth_apps WHERE id = 'google'",
			).get()?.client_secret,
			"",
		);
	} finally {
		globalThis.fetch = originalFetch;
		await mock.server.shutdown();
		storage.sqlite.close();
	}
});
