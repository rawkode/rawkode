import { strict as assert } from "node:assert";
import { testDatabase } from "./legacy/d1.ts";
import { createAdminApi } from "../integrations/oauth/src/admin.ts";
import { createIntegrationApi } from "../integrations/oauth/src/tokens.ts";
import type { OAuthEnv } from "../integrations/oauth/src/env.ts";

Deno.test("cleanup proof is owner/provider scoped and works without a grant or connected status", async () => {
	const { db, sqlite } = await testDatabase(
		"../../integrations/oauth/migrations",
	);
	const googleCredential =
		"google-cleanup-service-credential-01234567890123456789";
	const githubCredential =
		"github-cleanup-service-credential-01234567890123456789";
	const env: OAuthEnv = {
		DB: db,
		WEBSITE_ORIGIN: "https://e2.example.com",
		TOKEN_KEYRING: {
			get: () =>
				Promise.resolve(
					JSON.stringify({
						active: "test",
						keys: { test: btoa("a".repeat(32)) },
					}),
				),
		},
		GOOGLE_SERVICE_CREDENTIAL: { get: () => Promise.resolve(googleCredential) },
		GITHUB_SERVICE_CREDENTIAL: { get: () => Promise.resolve(githubCredential) },
	};
	try {
		const admin = createAdminApi(env, "alice");
		const google = await admin.createApp({
			name: "Google",
			providerId: "google",
			clientId: "client",
			clientSecret: "secret",
			scopes: ["email"],
		});
		const github = await admin.createApp({
			name: "GitHub",
			providerId: "github",
			clientId: "client",
			clientSecret: "secret",
			scopes: ["read:user"],
		});
		for (
			const [id, app] of [["google-account", google], [
				"github-account",
				github,
			]] as const
		) {
			await db.prepare(
				"INSERT INTO oauth_connections (id,app_id,owner_id,account_id,account_label,scopes,expires_at,created_at) VALUES (?,?,'alice','provider-id','account','[]',NULL,0)",
			).bind(id, app.id).run();
		}
		const api = createIntegrationApi(env, googleCredential);
		assert.equal(
			await api.canDeleteConnection("google-account", "alice"),
			true,
		);
		assert.deepEqual(
			await api.getConnectionForCleanup("google-account", "alice"),
			{
				id: "google-account",
				ownerId: "alice",
				providerId: "google",
				grantVersion: 1,
			},
		);
		assert.equal(await api.canDeleteConnection("google-account", "bob"), false);
		assert.equal(
			await api.canDeleteConnection("github-account", "alice"),
			false,
		);
		assert.equal(await api.canDeleteConnection("missing", "alice"), false);
		assert.deepEqual(await api.listConnections(), []);
		await assert.rejects(
			api.getAccessToken("google-account", ["email"]),
			/not authorized/,
		);
		sqlite.exec("UPDATE oauth_connections SET status = 'reconnect_required'");
		assert.equal(
			await api.canDeleteConnection("google-account", "alice"),
			true,
		);
		assert.equal(
			await createIntegrationApi(env, githubCredential).canDeleteConnection(
				"github-account",
				"alice",
			),
			true,
		);
		await assert.rejects(
			createIntegrationApi(env, "invalid-credential-012345678901234567890")
				.canDeleteConnection("google-account", "alice"),
			/Unauthorized/,
		);
	} finally {
		sqlite.close();
	}
});

Deno.test("cleanup proof rejects a credential rotated while the database lookup was pending", async () => {
	const old = "old-google-cleanup-credential-01234567890123456789";
	let current = old;
	const env = {
		GOOGLE_SERVICE_CREDENTIAL: { get: () => Promise.resolve(current) },
		GITHUB_SERVICE_CREDENTIAL: {
			get: () =>
				Promise.resolve("github-cleanup-credential-01234567890123456789"),
		},
		DB: {
			prepare: () => ({
				bind: () => ({
					first: () => {
						current = "new-google-cleanup-credential-01234567890123456789";
						return Promise.resolve({ allowed: 1 });
					},
				}),
			}),
		},
	} as unknown as OAuthEnv;
	await assert.rejects(
		createIntegrationApi(env, old).canDeleteConnection("connection", "alice"),
		/Unauthorized/,
	);
});
