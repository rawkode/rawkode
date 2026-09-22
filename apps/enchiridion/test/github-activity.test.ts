import { strict as assert } from "node:assert";
import {
	createActivityEnricher,
	normalizeGitHubActivity,
} from "../integrations/github/src/activity.ts";

const event = (type: string, payload: Record<string, unknown>) => ({
	id: "event-1",
	type,
	payload,
	repo: { name: "rawkode/rawkode" },
	actor: { login: "rawkode" },
	created_at: "2026-09-12T13:16:00Z",
});
Deno.test("sparse pull request event has number and direct link without generic title", () => {
	const row = normalizeGitHubActivity(
		event("PullRequestEvent", { action: "opened", number: 35 }),
	);
	assert.equal(row?.title, "Pull request #35");
	assert.equal(row?.url, "https://github.com/rawkode/rawkode/pull/35");
	assert.equal(row?.number, 35);
});
Deno.test("issue comments preserve target title, comment excerpt and permalink", () => {
	const row = normalizeGitHubActivity(event("IssueCommentEvent", {
		action: "created",
		issue: {
			number: 35,
			title: "Improve the day timeline",
			pull_request: { url: "api" },
		},
		comment: {
			body: "Looks good\n ship it",
			html_url: "https://github.com/rawkode/rawkode/pull/35#issuecomment-1",
		},
	}));
	assert.equal(row?.kind, "pullRequest");
	assert.equal(row?.title, "Improve the day timeline");
	assert.equal(row?.summary, "Looks good ship it");
	assert.equal(row?.action, "commented");
	assert.equal(
		row?.url,
		"https://github.com/rawkode/rawkode/pull/35#issuecomment-1",
	);
});
Deno.test("merged pull requests and reviews retain specific actions", () => {
	assert.equal(
		normalizeGitHubActivity(
			event("PullRequestEvent", {
				action: "closed",
				pull_request: { number: 35, title: "Ship", merged: true },
			}),
		)?.action,
		"merged",
	);
	assert.equal(
		normalizeGitHubActivity(
			event("PullRequestReviewEvent", {
				action: "submitted",
				pull_request: { number: 35, title: "Ship" },
				review: { state: "approved", body: "Ready" },
			}),
		)?.action,
		"approved",
	);
});
Deno.test("push activity retains branch, commit message and commit link", () => {
	const row = normalizeGitHubActivity(
		event("PushEvent", {
			ref: "refs/heads/main",
			head: "abcdef1234567",
			commits: [{
				sha: "abcdef1234567",
				message: "Fix calendar colors\n\nBody",
			}],
		}),
	);
	assert.equal(row?.title, "Fix calendar colors");
	assert.equal(row?.kind, "commit");
	assert.equal(
		row?.url,
		"https://github.com/rawkode/rawkode/commit/abcdef1234567",
	);
});
Deno.test("missing title hydration is bounded, deduplicated across pages and failure tolerant", async () => {
	const paths: string[] = [];
	const enrich = createActivityEnricher((path) => {
		paths.push(path);
		if (path.endsWith("/2")) return Promise.reject(new Error("Unavailable"));
		return Promise.resolve({
			title: "A useful title",
			number: 1,
			html_url: "https://github.com/rawkode/rawkode/pull/1",
		});
	}, 2);
	const rows = await enrich(
		[1, 1, 2, 3].map((number) =>
			event("PullRequestEvent", { number, action: "opened" })
		),
	);
	assert.equal(paths.length, 2);
	assert.equal(normalizeGitHubActivity(rows[0]!)?.title, "A useful title");
	assert.equal(normalizeGitHubActivity(rows[2]!)?.title, "Pull request #2");
	assert.equal(normalizeGitHubActivity(rows[3]!)?.title, "Pull request #3");
	await enrich([event("PullRequestEvent", { number: 1 })]);
	assert.equal(paths.length, 2);
});
Deno.test("complete payloads and malformed repository names never trigger hydration", async () => {
	let calls = 0;
	const enrich = createActivityEnricher(() => {
		calls++;
		return Promise.resolve({});
	});
	await enrich([
		event("IssuesEvent", { issue: { title: "Existing", number: 1 } }),
		{
			...event("PullRequestEvent", { number: 2 }),
			repo: { name: "../secrets" },
		},
	]);
	assert.equal(calls, 0);
});

Deno.test("hung metadata lookups stop at shared deadline and subsequent pages do not retry", async () => {
	let calls = 0;
	const enrich = createActivityEnricher(
		() => {
			calls++;
			return new Promise(() => {});
		},
		8,
		20,
	);
	const rows = [1, 2, 3].map((number) => event("PullRequestEvent", { number }));
	const started = Date.now();
	const result = await enrich(rows);
	assert.ok(Date.now() - started < 300);
	assert.equal(result.length, 3);
	assert.equal(calls, 2);
	await enrich(rows);
	assert.equal(calls, 2);
});
