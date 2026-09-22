import { strict as assert } from "node:assert";
import {
	connectOAuth,
	type OAuthIntegrationBinding,
	type SecretBinding,
} from "../packages/oauth-client/src/index.ts";
import { createTokenVault } from "../integrations/oauth/src/crypto.ts";
import { createIntegrationApi } from "../integrations/oauth/src/tokens.ts";
import { createAdminApi } from "../integrations/oauth/src/admin.ts";
import type { OAuthEnv } from "../integrations/oauth/src/env.ts";

const secret = (value: string): SecretBinding => ({
	get: () => Promise.resolve(value),
});
const envWith = (google: SecretBinding): OAuthEnv => ({
	GOOGLE_SERVICE_CREDENTIAL: google,
	GITHUB_SERVICE_CREDENTIAL: secret(
		"github-service-credential-01234567890123456789",
	),
	TOKEN_KEYRING: secret(
		JSON.stringify({ active: "one", keys: { one: btoa("a".repeat(32)) } }),
	),
	WEBSITE_ORIGIN: "https://e2.example.com",
	DB: {
		prepare: () => ({
			bind: () => ({ all: () => Promise.resolve({ results: [] }) }),
		}),
	} as unknown as D1Database,
});

Deno.test("retained OAuth capabilities reread service secrets and reject old credentials after rotation", async () => {
	const old = "old-google-service-credential-01234567890123456789";
	const fresh = "new-google-service-credential-01234567890123456789";
	let current = old;
	const env = envWith({ get: () => Promise.resolve(current) });
	const retained = createIntegrationApi(env, old);
	assert.deepEqual(await retained.listConnections(), []);
	current = fresh;
	await assert.rejects(retained.listConnections(), /Unauthorized integration/);
	assert.deepEqual(
		await createIntegrationApi(env, fresh).listConnections(),
		[],
	);
});

Deno.test("service binding errors and malformed values fail closed without leaking provider errors", async () => {
	const credential = "valid-service-credential-01234567890123456789";
	const unavailable = envWith({
		get: () => Promise.reject(new Error("secret backend sensitive failure")),
	});
	await assert.rejects(
		createIntegrationApi(unavailable, credential).listConnections(),
		/could not complete/,
	);
	await assert.rejects(
		createIntegrationApi(envWith(secret("")), credential).listConnections(),
		/Unauthorized integration/,
	);
	const config = await createAdminApi(unavailable, "owner").getConfiguration();
	assert.deepEqual(config.serviceIds, [
		"integrations-github",
		"integrations-google",
	]);
});

Deno.test("shared OAuth client fetches the current credential before each authorization", async () => {
	let current = "first";
	const received: string[] = [];
	const binding = {
		authorize: (credential: string) => {
			received.push(credential);
			return Promise.resolve({});
		},
	} as unknown as OAuthIntegrationBinding;
	const source = { get: () => Promise.resolve(current) };
	await connectOAuth(binding, source);
	current = "second";
	await connectOAuth(binding, source);
	assert.deepEqual(received, ["first", "second"]);
	await assert.rejects(
		connectOAuth(binding, {
			get: () => Promise.reject(new Error("unavailable")),
		}),
		/unavailable/,
	);
	assert.equal(received.length, 2);
});

Deno.test("retained token vault rotates its active key and decrypts retained historical keys", async () => {
	const keys = { one: btoa("a".repeat(32)), two: btoa("b".repeat(32)) };
	let keyring = JSON.stringify({ active: "one", keys: { one: keys.one } });
	const vault = createTokenVault({
		TOKEN_KEYRING: { get: () => Promise.resolve(keyring) },
	});
	const old = await vault.encrypt("old token", "row:access");
	keyring = JSON.stringify({ active: "two", keys });
	assert.equal(await vault.decrypt(old, "row:access"), "old token");
	assert.ok(
		(await vault.encrypt("new token", "row:access")).startsWith("v1.two."),
	);
	keyring = JSON.stringify({ active: "two", keys: { two: keys.two } });
	await assert.rejects(
		vault.decrypt(old, "row:access"),
		/Unknown encryption key/,
	);
});

Deno.test("token keyrings reject missing, malformed and invalid inactive keys", async () => {
	for (
		const value of [
			"not-json",
			"null",
			"[]",
			"{}",
			JSON.stringify({ active: "missing", keys: {} }),
			JSON.stringify({ active: "one", keys: { one: "short" } }),
			JSON.stringify({
				active: "one",
				keys: { one: btoa("a".repeat(32)), invalid: 42 },
			}),
		]
	) {
		await assert.rejects(
			createTokenVault({ TOKEN_KEYRING: secret(value) }).encrypt(
				"token",
				"row",
			),
		);
	}
	await assert.rejects(
		createTokenVault({
			TOKEN_KEYRING: { get: () => Promise.reject(new Error("unavailable")) },
		}).encrypt("token", "row"),
		/unavailable/,
	);
});
