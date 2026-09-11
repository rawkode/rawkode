import { strict as assert } from "node:assert";
import { coversScopes, provider } from "../integrations/oauth/src/providers.ts";
import { createTokenVault } from "../integrations/oauth/src/crypto.ts";
import type { OAuthEnv } from "../integrations/oauth/src/env.ts";

const env = { WEBSITE_ORIGIN: "https://e2.example.com" } as OAuthEnv;

Deno.test("GitHub authorization is PKCE OAuth with a separate identity endpoint", () => {
	const github = provider("github", env);
	assert.equal(github.server.issuer, "https://github.com/login/oauth");
	assert.equal(
		github.server.authorization_endpoint,
		"https://github.com/login/oauth/authorize",
	);
	assert.equal(
		github.server.token_endpoint,
		"https://github.com/login/oauth/access_token",
	);
	assert.equal(github.server.jwks_uri, undefined);
	assert.equal(github.identityEndpoint, "https://api.github.com/user");
	assert.equal(
		github.redirectUri,
		"https://e2.example.com/oauth/callback/github",
	);
	assert.deepEqual(github.validateScopes(["repo", "read:user", "repo"]), [
		"read:user",
		"repo",
	]);
	assert.throws(() => github.validateScopes(["repo user"]));
});

Deno.test("provider selection and development overrides fail closed", () => {
	assert.throws(() => provider("unknown", env));
	assert.throws(() =>
		provider("github", {
			...env,
			LOCAL_PROVIDER_ORIGIN: "http://localhost:8790",
		})
	);
	assert.throws(() =>
		provider("github", {
			...env,
			WEBSITE_ORIGIN: "http://localhost:4321",
			LOCAL_PROVIDER_ORIGIN: "https://evil.example",
		})
	);
	assert.deepEqual(
		provider("google", env).validateScopes([
			"https://www.googleapis.com/auth/calendar.readonly",
		]),
		["email", "https://www.googleapis.com/auth/calendar.readonly", "openid"],
	);
});

Deno.test("credential vault authenticates row context and supports old encryption keys", async () => {
	const old = btoa(
		String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
	);
	const fresh = btoa(
		String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
	);
	const keys = { old, fresh };
	const vault = createTokenVault({
		TOKEN_KEYRING: {
			get: () => Promise.resolve(JSON.stringify({ active: "old", keys })),
		},
	});
	const encrypted = await vault.encrypt("credential", "connection:one:access");
	const rotated = createTokenVault({
		TOKEN_KEYRING: {
			get: () => Promise.resolve(JSON.stringify({ active: "fresh", keys })),
		},
	});
	assert.equal(
		await rotated.decrypt(encrypted, "connection:one:access"),
		"credential",
	);
	await assert.rejects(rotated.decrypt(encrypted, "connection:two:access"));
	assert.ok(
		(await rotated.encrypt("new", "app:one:secret")).startsWith("v1.fresh."),
	);
});

Deno.test("GitHub scope coverage follows documented implication without widening other providers or reversing grants", () => {
	assert.equal(
		coversScopes("github", ["user"], [
			"read:user",
			"user:email",
			"user:follow",
		]),
		true,
	);
	assert.equal(
		coversScopes("github", ["repo"], [
			"public_repo",
			"repo:status",
			"repo_deployment",
			"repo:invite",
			"security_events",
		]),
		true,
	);
	assert.equal(coversScopes("github", ["public_repo"], ["repo"]), false);
	assert.equal(coversScopes("github", ["read:user"], ["user"]), false);
	assert.equal(
		coversScopes("github", ["repo"], ["delete_repo", "workflow"]),
		false,
	);
	assert.equal(
		coversScopes("google", ["user", "repo"], ["read:user", "public_repo"]),
		false,
	);
	assert.equal(
		coversScopes("github", ["admin:org"], ["write:org", "read:org"]),
		true,
	);
	assert.equal(coversScopes("github", ["read:org"], ["write:org"]), false);
});
