import { strict as assert } from "node:assert";
import type { ApiContext } from "../api/src/context.ts";
import { loadGitHubActivity } from "../integrations/github/graphql.ts";

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
});
