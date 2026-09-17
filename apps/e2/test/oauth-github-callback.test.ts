import { strict as assert } from "node:assert";
import { testDatabase } from "./legacy/d1.ts";
import { createAdminApi } from "../integrations/oauth/src/admin.ts";
import { createIntegrationApi } from "../integrations/oauth/src/tokens.ts";
import {
	bindingCookieName,
	callback,
} from "../integrations/oauth/src/callback.ts";
import { randomSecret, sha256 } from "../integrations/oauth/src/crypto.ts";
import type { OAuthEnv } from "../integrations/oauth/src/env.ts";

[
	{
		expiring: false,
		requested: ["public_repo"],
		granted: ["public_repo", "read:user"],
		required: ["read:user"],
	},
	{
		expiring: true,
		requested: ["public_repo"],
		granted: ["public_repo", "read:user"],
		required: ["read:user"],
	},
	{
		expiring: false,
		requested: ["user"],
		granted: ["user"],
		required: ["read:user"],
	},
	{
		expiring: true,
		requested: ["repo", "public_repo", "user"],
		granted: ["repo", "user"],
		required: ["public_repo", "read:user"],
	},
	{
		expiring: false,
		requested: ["public_repo"],
		granted: ["public_repo", "read:user"],
		required: ["read:user"],
		redirectIdentity: true,
	},
].forEach((
	{ expiring, requested, granted, required, redirectIdentity = false },
) =>
	Deno.test(`GitHub callback protects PKCE state and service grants with ${expiring ? "expiring" : "nonexpiring"} tokens and ${granted.join(",")} scopes${redirectIdentity ? " and rejects identity redirects" : ""}`, async () => {
		const { db, sqlite } = await testDatabase(
			"../../integrations/oauth/migrations",
		);
		let tokenRequests = 0;
		let redirectedRequests = 0;
		let challenge = "";
		const server = Deno.serve({
			hostname: "127.0.0.1",
			port: 0,
			onListen: () => {},
		}, async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/token/github") {
				tokenRequests++;
				const form = await request.formData();
				if (form.get("grant_type") === "refresh_token") {
					assert.equal(form.get("refresh_token"), "github-refresh");
					return Response.json({
						access_token: "github-refreshed",
						token_type: "bearer",
						scope: granted.join(","),
						expires_in: 3600,
						refresh_token: "github-rotated",
					});
				}
				const verifier = form.get("code_verifier");
				assert.equal(typeof verifier, "string");
				const bytes = new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(String(verifier)),
					),
				);
				assert.equal(
					btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
						"/",
						"_",
					).replaceAll("=", ""),
					challenge,
				);
				assert.equal(form.get("client_secret"), "github-secret");
				return Response.json({
					access_token: "github-access",
					token_type: "bearer",
					scope: granted.join(","),
					...(expiring
						? { expires_in: 1, refresh_token: "github-refresh" }
						: {}),
				});
			}
			if (path === "/user/github") {
				assert.equal(
					request.headers.get("Authorization"),
					"Bearer github-access",
				);
				if (redirectIdentity) {
					return new Response(null, {
						status: 302,
						headers: { Location: "/redirected-identity" },
					});
				}
				return Response.json({ id: 12345, login: "octocat" });
			}
			if (path === "/redirected-identity") {
				redirectedRequests++;
				return Response.json({ id: 999, login: "unexpected-target" });
			}
			return new Response("Not found", { status: 404 });
		});
		try {
			const credential = "github-service-credential-01234567890123456789";
			const env: OAuthEnv = {
				DB: db,
				WEBSITE_ORIGIN: "http://localhost:4321",
				LOCAL_PROVIDER_ORIGIN: `http://127.0.0.1:${server.addr.port}`,
				TOKEN_KEYRING: {
					get: () =>
						Promise.resolve(
							JSON.stringify({
								active: "test",
								keys: { test: btoa("a".repeat(32)) },
							}),
						),
				},
				GITHUB_SERVICE_CREDENTIAL: { get: () => Promise.resolve(credential) },
				GOOGLE_SERVICE_CREDENTIAL: {
					get: () =>
						Promise.resolve("unused-google-credential-01234567890123456789"),
				},
			};
			const admin = createAdminApi(env, "owner");
			const app = await admin.createApp({
				name: "GitHub",
				providerId: "github",
				clientId: "github-client",
				clientSecret: "github-secret",
				scopes: requested,
			});
			const binding = randomSecret();
			const started = await admin.beginConnection({
				appId: app.id,
				browserBindingHash: await sha256(binding),
			});
			const authorization = new URL(started.authorizationUrl);
			challenge = authorization.searchParams.get("code_challenge")!;
			assert.equal(
				authorization.searchParams.get("code_challenge_method"),
				"S256",
			);
			assert.equal(authorization.searchParams.has("nonce"), false);
			const url = new URL(app.redirectUri);
			url.search = new URLSearchParams({
				state: authorization.searchParams.get("state")!,
				code: "github-code",
				iss: env.LOCAL_PROVIDER_ORIGIN!,
			}).toString();
			assert.equal((await callback(new Request(url), env)).status, 400);
			assert.equal(tokenRequests, 0);
			const request = new Request(url, {
				headers: {
					Cookie: `${bindingCookieName(started.stateId, false)}=${binding}`,
				},
			});
			const wrongRoute = new Request(
				url.toString().replace("/callback/github", "/callback/google"),
				{ headers: request.headers },
			);
			assert.equal((await callback(wrongRoute, env)).status, 400);
			assert.equal(tokenRequests, 0);
			const response = await callback(request, env);
			if (redirectIdentity) {
				assert.equal(
					response.headers.get("Location"),
					"http://localhost:4321/admin/oauth?result=failed",
				);
				assert.equal(
					redirectedRequests,
					0,
					"bearer token must never reach a redirect target",
				);
				assert.deepEqual(await admin.listConnections(), []);
				return;
			}
			assert.equal(
				response.headers.get("Location"),
				"http://localhost:4321/admin/oauth?result=connected",
			);
			assert.equal((await callback(request, env)).status, 400);
			assert.equal(tokenRequests, 1);
			const [connection] = await admin.listConnections();
			assert.equal(connection.accountId, "12345");
			assert.equal(connection.accountLabel, "octocat");
			assert.equal(connection.expiresAt === null, !expiring);
			const integration = createIntegrationApi(env, credential);
			await assert.rejects(
				integration.getAccessToken(connection.id, required),
				/not authorized/,
			);
			await admin.grantService(connection.id, "integrations-github");
			const token = await integration.getAccessToken(connection.id, [
				"read:user",
			]);
			assert.equal(
				token.accessToken,
				expiring ? "github-refreshed" : "github-access",
			);
			assert.equal(token.expiresAt === null, !expiring);
			assert.equal(tokenRequests, expiring ? 2 : 1);
			assert.deepEqual(token.scopes, granted);
			await assert.rejects(
				integration.getAccessToken(connection.id, ["delete_repo"]),
				/required scopes/,
			);
			await admin.revokeService(connection.id, "integrations-github");
			await assert.rejects(
				integration.getAccessToken(connection.id, required),
				/not authorized/,
			);
			const stored = sqlite.query(
				"SELECT access_token, refresh_token FROM oauth_connections",
			).get()!;
			assert.ok(String(stored.access_token).startsWith("v1.test."));
			assert.equal(stored.refresh_token === null, !expiring);
		} finally {
			await server.shutdown();
			sqlite.close();
		}
	})
);
