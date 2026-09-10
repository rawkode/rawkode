import { strict as assert } from "node:assert";
import type { Connection, OAuthIntegrationApi } from "@e2/oauth-client";
import type { GitHubActivityApi, GitHubApi } from "@e2/oauth-client/github";
import { createGitHubApi } from "../integrations/github/src/api.ts";

const connection: Connection = {
	id: "github-alice",
	ownerId: "alice",
	appId: "app",
	appName: "GitHub",
	providerId: "github",
	accountId: "123",
	accountLabel: "alice",
	scopes: ["read:user"],
	status: "connected",
	grantVersion: 1,
	expiresAt: null,
	createdAt: 0,
	services: ["integrations-github"],
};

const fixture = (connections = [connection]) => {
	let tokenCalls = 0;
	const requestedScopes: string[][] = [];
	let revoked = false;
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
		listConnections: () => Promise.resolve(revoked ? [] : connections),
		getAccessToken: (_id, requiredScopes) => {
			tokenCalls++;
			requestedScopes.push(requiredScopes);
			return revoked
				? Promise.reject(new Error("Grant revoked"))
				: Promise.resolve({
					accessToken: "secret-token",
					tokenType: "Bearer",
					expiresAt: null,
					scopes: ["read:user"],
				});
		},
		[Symbol.dispose]: () => {},
	};
	const api: GitHubApi & GitHubActivityApi = createGitHubApi({
		OAUTH: {
			authorize: (credential) => {
				assert.equal(credential, "github-service");
				return Promise.resolve(oauth);
			},
		},
		OAUTH_SERVICE_CREDENTIAL: { get: () => Promise.resolve("github-service") },
	}, "alice");
	return {
		api,
		tokenCalls: () => tokenCalls,
		requestedScopes: () => requestedScopes,
		revoke: () => {
			revoked = true;
		},
	};
};

Deno.test("GitHub rejects other owners/providers and invalid repository paths before token access", async () => {
	for (
		const connections of [[], [{ ...connection, ownerId: "bob" }], [{
			...connection,
			providerId: "google",
		}], [{ ...connection, status: "reconnect_required" as const }]]
	) {
		const { api, tokenCalls } = fixture(connections);
		await assert.rejects(api.getProfile(connection.id), /not authorized/);
		assert.equal(tokenCalls(), 0);
	}
	const { api, tokenCalls } = fixture();
	for (
		const repository of [
			"..",
			"repo/../../user",
			"repo?token=bad",
			"repo%2fprivate",
		]
	) {
		await assert.rejects(
			api.listIssues(connection.id, { owner: "alice", repository }),
			/valid GitHub repository/,
		);
	}
	await assert.rejects(api.listRepositories(connection.id, 0), /Page must/);
	assert.equal(tokenCalls(), 0);
});

Deno.test("GitHub reads fixed API routes, protects credentials, and preserves bounded pagination", async () => {
	const { api, tokenCalls, requestedScopes } = fixture();
	const originalFetch = globalThis.fetch;
	const paths: string[] = [];
	globalThis.fetch = (input, init) => {
		const url = new URL(String(input));
		assert.equal(url.origin, "https://api.github.com");
		assert.equal(init?.redirect, "error");
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("Authorization"), "Bearer secret-token");
		assert.equal(headers.get("User-Agent"), "e2-integrations-github");
		paths.push(url.pathname);
		if (url.pathname === "/user") {
			return Promise.resolve(Response.json({ id: 123, login: "alice" }));
		}
		assert.equal(url.searchParams.get("per_page"), "50");
		return Promise.resolve(
			Response.json([{ id: 1 }, {
				id: 2,
				pull_request: { url: "https://github.com" },
			}], {
				headers: { Link: '<https://attacker.example/steal>; rel="next"' },
			}),
		);
	};
	try {
		assert.deepEqual(await api.getProfile(connection.id), {
			id: 123,
			login: "alice",
		});
		assert.equal((await api.listRepositories(connection.id)).nextPage, 2);
		const issues = await api.listIssues(connection.id, {
			owner: "alice",
			repository: "project",
		});
		assert.deepEqual(issues, { items: [{ id: 1 }], nextPage: 2 });
		const activity = await api.listActivity(connection.id);
		assert.deepEqual(activity.items, [{ id: 1 }, {
			id: 2,
			pull_request: { url: "https://github.com" },
		}]);
		assert.equal(
			(await api.listPullRequests(connection.id, {
				owner: "alice",
				repository: "project",
				page: 2,
			})).items.length,
			2,
		);
		assert.deepEqual(paths, [
			"/user",
			"/user/repos",
			"/repos/alice/project/issues",
			"/user",
			"/users/alice/events",
			"/repos/alice/project/pulls",
		]);
		assert.equal(tokenCalls(), 12);
		assert.deepEqual(
			requestedScopes(),
			Array.from({ length: 12 }, () => ["read:user"]),
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

Deno.test("GitHub does not publish results after grant revocation or expose upstream errors", async () => {
	const { api, revoke } = fixture();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => {
		revoke();
		return Promise.resolve(Response.json({ private: true }));
	};
	try {
		await assert.rejects(api.getProfile(connection.id), /revoked/);
	} finally {
		globalThis.fetch = originalFetch;
	}
	const fresh = fixture();
	globalThis.fetch = () =>
		Promise.resolve(
			new Response("secret-token upstream diagnostic", { status: 401 }),
		);
	try {
		await assert.rejects(fresh.api.getProfile(connection.id), {
			message: "Reconnect this GitHub account.",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});
