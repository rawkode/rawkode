import { strict as assert } from "node:assert";
import type { EntitiesApi, ProjectionBatch } from "@e2/entities";
import {
	assertReadOnlyPermissions,
	GitHubRateLimitError,
	githubRequest,
	verifyGitHubWebhook,
} from "../integrations/github/src/app-auth.ts";
import {
	archiveInstallationPage,
	drainGitHubProjectionOutbox,
	githubHasNextPage,
	githubProjection,
	initializeInstallation,
	recordWebhook,
	repositoryPage,
} from "../integrations/github/src/app-mirror.ts";
import type {
	EntitiesAdminBinding,
	GitHubEnv,
	InstallationIdentity,
} from "../integrations/github/src/env.ts";
import {
	beginInstallation,
	claimInstallation,
	installationOwner,
} from "../integrations/github/src/registry.ts";
import type { InstallationDatabase } from "../integrations/github/src/installation-storage.ts";
import { testDatabase } from "./legacy/d1.ts";

const identity: InstallationIdentity = {
	installationId: "42",
	ownerId: "owner-a",
	accountId: "7",
	accountLogin: "octo-org",
	targetType: "Organization",
};

const signature = async (secret: string, body: Uint8Array) => {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return [
		...new Uint8Array(
			await crypto.subtle.sign("HMAC", key, body as BufferSource),
		),
	]
		.map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

Deno.test("GitHub verifies exact webhook bytes before decoding JSON", async () => {
	const secret = "webhook-secret";
	const body = new TextEncoder().encode('{"installation":{"id":42}}');
	const request = new Request("https://example.test/github/webhook", {
		method: "POST",
		headers: {
			"X-Hub-Signature-256": `sha256=${await signature(secret, body)}`,
			"X-GitHub-Delivery": "01234567-89ab-cdef-0123-456789abcdef",
			"X-GitHub-Event": "installation",
		},
		body,
	});
	assert.deepEqual(await verifyGitHubWebhook(request, secret), {
		deliveryId: "01234567-89ab-cdef-0123-456789abcdef",
		event: "installation",
		payload: { installation: { id: 42 } },
	});
	const invalidJson = new TextEncoder().encode("{");
	await assert.rejects(
		verifyGitHubWebhook(
			new Request(request.url, {
				method: "POST",
				headers: {
					...Object.fromEntries(request.headers),
					"X-Hub-Signature-256": "sha256=" + "00".repeat(32),
				},
				body: invalidJson,
			}),
			secret,
		),
		/Invalid webhook signature/,
	);
});

Deno.test("GitHub installation claims are single-use and owner-bound", async () => {
	const { db, sqlite } = await testDatabase(
		"../../integrations/github/migrations",
	);
	try {
		const stateA = await beginInstallation(db, "owner-a", 1_000);
		assert.deepEqual(
			await claimInstallation(db, stateA, {
				installationId: identity.installationId,
				accountId: identity.accountId,
				accountLogin: identity.accountLogin,
				targetType: identity.targetType,
			}, 1_001),
			identity,
		);
		await assert.rejects(
			claimInstallation(db, stateA, identity, 1_002),
			/already used/,
		);
		const stateB = await beginInstallation(db, "owner-b", 2_000);
		await assert.rejects(
			claimInstallation(db, stateB, identity, 2_001),
			/already owned/,
		);
		assert.equal((await installationOwner(db, "42"))?.ownerId, "owner-a");
	} finally {
		sqlite.close();
	}
});

Deno.test("GitHub webhook delivery dedupe does not replay cursor mutations", async () => {
	const { db, sqlite } = await testDatabase(
		"../../integrations/github/account-migrations",
	);
	try {
		const local = db as unknown as InstallationDatabase;
		await initializeInstallation(local, identity);
		const payload = { repository: { id: 9 }, action: "opened" };
		assert.deepEqual(
			await recordWebhook(local, "0123456789abcdef", "issues", payload),
			{ duplicate: false },
		);
		const generation = sqlite.query(
			"SELECT generation FROM github_sync_cursors WHERE kind='issues' AND repository_id='9'",
		).get()?.generation;
		assert.deepEqual(
			await recordWebhook(local, "0123456789abcdef", "issues", payload),
			{ duplicate: true },
		);
		assert.equal(
			sqlite.query(
				"SELECT generation FROM github_sync_cursors WHERE kind='issues' AND repository_id='9'",
			).get()?.generation,
			generation,
		);
		assert.equal(
			sqlite.query(
				"SELECT count(*) AS count FROM github_webhook_deliveries",
			).get()?.count,
			1,
		);
	} finally {
		sqlite.close();
	}
});

Deno.test("GitHub installation deletion archives source observations in bounded pages", async () => {
	const { db, sqlite } = await testDatabase(
		"../../integrations/github/account-migrations",
	);
	try {
		const local = db as unknown as InstallationDatabase;
		await initializeInstallation(local, identity);
		await db.prepare(
			`INSERT INTO github_records
		   (resource_type,resource_id,repository_id,data,source_revision,active,generation)
		   VALUES ('user','U_1','','{}','active:user',1,'generation')`,
		).run();
		await recordWebhook(
			local,
			"fedcba9876543210",
			"installation",
			{ action: "deleted" },
		);
		assert.equal(
			sqlite.query(
				"SELECT status FROM installation_state",
			).get()?.status,
			"deleted",
		);
		assert.deepEqual(await archiveInstallationPage(local, identity), {
			pending: false,
		});
		assert.equal(
			sqlite.query(
				"SELECT deleted FROM github_entity_projection_outbox",
			).get()?.deleted,
			1,
		);
		assert.equal(
			sqlite.query(
				"SELECT active FROM github_records WHERE resource_id='U_1'",
			).get()?.active,
			0,
		);
	} finally {
		sqlite.close();
	}
});

Deno.test("removing repository access tombstones authors no longer observable elsewhere", async () => {
	const { db, sqlite } = await testDatabase(
		"../../integrations/github/account-migrations",
	);
	try {
		const local = db as unknown as InstallationDatabase;
		await initializeInstallation(local, identity);
		await db.batch([
			db.prepare(
				`INSERT INTO github_repositories
			    (id,node_id,owner_login,owner_type,name,full_name,url,private,active,generation,source_revision)
			   VALUES ('9','R_9','octo','User','old','octo/old','https://github.com/octo/old',0,1,'old','active:repo')`,
			),
			db.prepare(
				`INSERT INTO github_records
			    (resource_type,resource_id,repository_id,data,source_revision,active,generation)
			   VALUES ('user','U_1','','{}','active:user',1,'old')`,
			),
			db.prepare(
				`INSERT INTO github_record_repositories
			    (resource_type,resource_id,repository_id) VALUES ('user','U_1','9')`,
			),
		]);
		const cursor = {
			kind: "repositories" as const,
			repository_id: "",
			cursor: "archive",
			generation: "selected-now",
		};
		await repositoryPage(local, {} as GitHubEnv, identity, "", cursor);
		assert.equal(
			sqlite.query(
				"SELECT active FROM github_records WHERE resource_type='user' AND resource_id='U_1'",
			).get()?.active,
			0,
		);
		assert.equal(
			sqlite.query(
				"SELECT deleted FROM github_entity_projection_outbox WHERE resource_type='user'",
			).get()?.deleted,
			1,
		);
		await repositoryPage(local, {} as GitHubEnv, identity, "", cursor);
		assert.equal(
			sqlite.query(
				"SELECT count(*) AS count FROM github_record_repositories",
			).get()?.count,
			0,
		);
		assert.equal(
			sqlite.query("SELECT active FROM github_repositories WHERE id='9'").get()
				?.active,
			0,
		);
	} finally {
		sqlite.close();
	}
});

Deno.test("GitHub projection outbox retries idempotently after a lost acknowledgement", async () => {
	const { db, sqlite } = await testDatabase(
		"../../integrations/github/account-migrations",
	);
	const local = db as unknown as InstallationDatabase;
	try {
		await initializeInstallation(local, identity);
		const projection = await githubProjection("42", "repository", {
			id: 9,
			node_id: "R_9",
			full_name: "octo-org/project",
			html_url: "https://github.com/octo-org/project",
		});
		await db.prepare(
			`INSERT INTO github_entity_projection_outbox
		   (projection_id,resource_type,resource_id,source_revision,tag_id,label,aliases,"values",deleted,created_at)
		   VALUES (?,?,?,?,?,?,?,?,?,?)`,
		).bind(
			projection.projectionId,
			projection.resourceType,
			projection.resourceId,
			projection.sourceRevision,
			projection.tagId,
			projection.label,
			JSON.stringify(projection.aliases),
			JSON.stringify(projection.values),
			0,
			Date.now(),
		).run();
		const received: ProjectionBatch[] = [];
		let fail = true;
		const binding: EntitiesAdminBinding = {
			admin: () =>
				Promise.resolve(
					{
						upsertProjectionBatch: (batch: ProjectionBatch) => {
							received.push(batch);
							return fail
								? Promise.reject(new Error("ack lost"))
								: Promise.resolve({ changed: 0 });
						},
						[Symbol.dispose]() {},
					} as unknown as EntitiesApi & Disposable,
				),
		};
		await assert.rejects(
			drainGitHubProjectionOutbox(local, binding, identity, 1),
			/will retry/,
		);
		assert.equal(
			sqlite.query(
				"SELECT attempts FROM github_entity_projection_outbox",
			).get()?.attempts,
			1,
		);
		fail = false;
		assert.deepEqual(
			await drainGitHubProjectionOutbox(local, binding, identity, 1),
			{ delivered: 1, pending: false },
		);
		assert.equal(received.length, 2);
		assert.deepEqual(received[0], received[1]);
	} finally {
		sqlite.close();
	}
});

Deno.test("GitHub App permissions stay read-only and pagination and backoff are bounded", async () => {
	assert.doesNotThrow(() =>
		assertReadOnlyPermissions({
			metadata: "read",
			issues: "read",
			pull_requests: "read",
			discussions: "read",
			contents: "none",
		})
	);
	assert.throws(() =>
		assertReadOnlyPermissions({
			metadata: "read",
			issues: "write",
			pull_requests: "read",
			discussions: "read",
		}), /read-only/);
	assert.equal(
		githubHasNextPage(
			new Response(null, {
				headers: { Link: '<https://api.github.com/items?page=2>; rel="next"' },
			}),
		),
		true,
	);
	assert.equal(githubHasNextPage(new Response(null)), false);

	const originalFetch = globalThis.fetch;
	globalThis.fetch = () =>
		Promise.resolve(
			new Response(null, {
				status: 429,
				headers: { "Retry-After": "2" },
			}),
		);
	try {
		const started = Date.now();
		await assert.rejects(
			githubRequest({} as GitHubEnv, "/rate-limit", {}),
			(error) =>
				error instanceof GitHubRateLimitError &&
				error.retryAt >= started + 2_000,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

Deno.test("GitHub App observations map stably into every locked integration tag", async () => {
	const fixtures = [
		["user", { id: 1, login: "octocat", avatar_url: "https://images.test/u" }],
		["organization", {
			id: 2,
			login: "octo-org",
			url: "https://github.com/octo-org",
		}],
		["repository", {
			id: 3,
			full_name: "octo-org/repo",
			html_url: "https://github.com/octo-org/repo",
		}],
		["issue", {
			id: 4,
			title: "Issue",
			state: "OPEN",
			url: "https://github.com/i/4",
		}],
		["pullRequest", {
			id: 5,
			title: "PR",
			state: "MERGED",
			url: "https://github.com/p/5",
		}],
		["discussion", {
			id: 6,
			title: "Talk",
			createdAt: "2026-09-10T12:00:00Z",
			url: "https://github.com/d/6",
		}],
	] as const;
	for (const [kind, data] of fixtures) {
		const first = await githubProjection("42", kind, data);
		assert.deepEqual(await githubProjection("42", kind, data), first);
		assert.equal(first.tagId.startsWith("integration:github:"), true);
		assert.equal(first.deleted, false);
		assert.equal(Object.keys(first.values ?? {}).length > 0, true);
	}
});

Deno.test("GitHub App requests reject redirects without forwarding credentials", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (_input, init) => {
		calls++;
		assert.equal(init?.redirect, "manual");
		return Promise.resolve(
			new Response(null, {
				status: 302,
				headers: { Location: "https://untrusted.example/" },
			}),
		);
	};
	try {
		await assert.rejects(
			githubRequest({} as GitHubEnv, "/app", {
				headers: { Authorization: "Bearer test-only" },
			}),
			/redirects are not allowed/,
		);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
