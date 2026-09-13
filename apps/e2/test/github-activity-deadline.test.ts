import { execute, parse } from "graphql";
import { composeSchema } from "../api/src/schema.ts";
import type { GitHubPage } from "@e2/oauth-client/github";
import { strict as assert } from "node:assert";
import type { ApiContext } from "../api/src/context.ts";
import {
	githubGraphql,
	loadGitHubActivity,
	loadGitHubActivityResult,
} from "../integrations/github/graphql.ts";

Deno.test("activity shares a session across pages and returns completed rows when a page hangs", async () => {
	let sessions = 0;
	let consumed = 0;
	let disposed = 0;
	const pages: number[] = [];
	const context = {
		identity: { ownerId: "owner" },
		cache: new Map(),
		consume: () => consumed++,
		env: {
			GITHUB_ADMIN: {
				admin: () => {
					sessions++;
					return Promise.resolve({
						listConnections: () => Promise.resolve([{ id: "account" }]),
						listActivity: (_id: string, page: number) => {
							pages.push(page);
							if (page === 2) return new Promise(() => {});
							return Promise.resolve({
								items: [{
									id: "event",
									type: "IssuesEvent",
									payload: {
										issue: { title: "Retain completed page", number: 1 },
									},
								}],
								nextPage: 2,
							});
						},
						[Symbol.dispose]: () => disposed++,
					});
				},
			},
		},
	} as unknown as ApiContext;
	const started = Date.now();
	const result = await loadGitHubActivity(context, 25);
	assert.ok(Date.now() - started < 300);
	assert.equal(result.length, 1);
	assert.equal(result[0]?.title, "Retain completed page");
	assert.equal(sessions, 2); // One connection listing, one pagination session.
	assert.equal(consumed, 3);
	assert.equal(disposed, 2);
	assert.deepEqual(pages, [1, 2]);
	assert.equal((await loadGitHubActivityResult(context)).partial, true);
	assert.equal(sessions, 2); // Metadata reuses the completed partial result.
});

const sampleEvent = {
	id: "event",
	type: "IssuesEvent",
	created_at: "2026-09-13T12:00:00Z",
	payload: { issue: { title: "Saved partial event", number: 1 } },
};
const activityFixture = (
	readPage: (page: number) => Promise<GitHubPage>,
	listAccounts = () => Promise.resolve([{ id: "account" }]),
) => {
	let pageCalls = 0;
	const context = {
		identity: { ownerId: "owner", email: "owner@example.com" },
		cache: new Map(),
		consume: () => {},
		env: {
			GITHUB_ADMIN: {
				admin: () =>
					Promise.resolve({
						listConnections: listAccounts,
						listActivity: (_id: string, page: number) => {
							pageCalls++;
							return readPage(page);
						},
						[Symbol.dispose]: () => {},
					}),
			},
		},
	} as unknown as ApiContext;
	return { context, calls: () => pageCalls };
};
Deno.test("activity marks provider page errors partial while preserving completed rows", async () => {
	const { context } = activityFixture((page) =>
		page === 1
			? Promise.resolve({ items: [sampleEvent], nextPage: 2 })
			: Promise.reject(new Error("Provider unavailable"))
	);
	const result = await loadGitHubActivityResult(context);
	assert.equal(result.partial, true);
	assert.equal(result.rows[0]?.title, "Saved partial event");
});
Deno.test("activity connection failures and exhausted budgets are partial, empty success is complete", async () => {
	const failure = activityFixture(
		() => Promise.resolve({ items: [], nextPage: null }),
		() => Promise.reject(new Error("Grant unavailable")),
	);
	assert.deepEqual(await loadGitHubActivityResult(failure.context), {
		rows: [],
		partial: true,
	});
	const exhausted = activityFixture(() =>
		Promise.resolve({ items: [], nextPage: null })
	);
	assert.deepEqual(await loadGitHubActivityResult(exhausted.context, 0), {
		rows: [],
		partial: true,
	});
	const noAccounts = activityFixture(
		() => Promise.resolve({ items: [], nextPage: null }),
		() => Promise.resolve([]),
	);
	assert.deepEqual(await loadGitHubActivityResult(noAccounts.context), {
		rows: [],
		partial: false,
	});
	assert.equal(noAccounts.calls(), 0);
	const emptyPage = activityFixture(() =>
		Promise.resolve({ items: [], nextPage: null })
	);
	assert.deepEqual(await loadGitHubActivityResult(emptyPage.context), {
		rows: [],
		partial: false,
	});
});
Deno.test("activity pagination cap marks truncated success partial", async () => {
	const fixture = activityFixture((page) =>
		Promise.resolve({ items: [], nextPage: page + 1 })
	);
	assert.deepEqual(await loadGitHubActivityResult(fixture.context), {
		rows: [],
		partial: true,
	});
	assert.equal(fixture.calls(), 5);
});
Deno.test("GraphQL activity rows and partial metadata share one provider request", async () => {
	const fixture = activityFixture(() =>
		Promise.resolve({ items: [sampleEvent], nextPage: null })
	);
	const { schema, fieldResolver } = composeSchema([githubGraphql, {
		typeDefs: "",
		fields: { "User.today": () => ({ date: "2026-09-13" }) },
	}]);
	const result = await execute({
		schema,
		fieldResolver,
		contextValue: fixture.context,
		document: parse(
			'{ me { today(date: "2026-09-13") { githubActivityPartial githubActivity { title } } } }',
		),
	});
	assert.equal(result.errors, undefined);
	assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
		me: {
			today: {
				githubActivityPartial: false,
				githubActivity: [{ title: "Saved partial event" }],
			},
		},
	});
	assert.equal(fixture.calls(), 1);
});

Deno.test("activity account session failure is partial and keeps another account's rows", async () => {
	let sessions = 0;
	const context = {
		identity: { ownerId: "owner" },
		cache: new Map(),
		consume: () => {},
		env: {
			GITHUB_ADMIN: {
				admin: () => {
					if (++sessions === 3) {
						return Promise.reject(
							new Error("Second account unavailable"),
						);
					}
					return Promise.resolve({
						listConnections: () =>
							Promise.resolve([{ id: "first" }, { id: "second" }]),
						listActivity: () =>
							Promise.resolve({ items: [sampleEvent], nextPage: null }),
						[Symbol.dispose]: () => {},
					});
				},
			},
		},
	} as unknown as ApiContext;
	const result = await loadGitHubActivityResult(context);
	assert.equal(result.partial, true);
	assert.equal(result.rows.length, 1);
	assert.equal(result.rows[0]?.connectionId, "first");
});
