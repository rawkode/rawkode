import { strict as assert } from "node:assert";
import { parse, validate } from "graphql";
import { composeSchema } from "../../../api/src/schema.ts";
import { githubGraphql } from "../../github/graphql.ts";
import { googleGraphql } from "../../google/graphql.ts";
import {
	createApiDayReader,
	dayBounds,
	dayBriefingQueries,
} from "../src/day-reader.ts";
import { createDayCapabilities } from "../src/capabilities.ts";
const config = {
	WEBSITE_ORIGIN: "https://notes.example",
	ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
	ACCESS_AUDIENCE: "aud",
	ADMIN_EMAILS: "alice@example.com",
};
const request = () =>
	new Request(config.WEBSITE_ORIGIN, {
		headers: { "Cf-Access-Jwt-Assertion": "verified-assertion-fixture" },
	});
const identity = { ownerId: "access:alice", email: "alice@example.com" };
const options = {
	authenticate: () => Promise.resolve(identity),
	clock: () => new Date("2026-09-13T12:00:00Z"),
};
const envelope = (date = "2026-03-29", timeZone = "Europe/London") => ({
	data: {
		me: {
			id: identity.ownerId,
			today: {
				date,
				...dayBounds(date, timeZone),
				googleEventsPartial: false,
				githubActivityPartial: true,
				googleEvents: [{
					id: "event",
					connectionId: "google-connection",
					calendarId: "calendar",
					summary: "All day planning",
					start: date,
					end: "2026-03-30",
					htmlLink: "https://calendar.google.com/event",
					internalCredential: "secret",
				}],
				githubActivity: [{
					id: "activity",
					connectionId: "github-connection",
					title: "Fix editor",
					action: "opened",
					url: "https://github.com/owner/repo/pull/1",
					internalCredential: "secret",
				}],
			},
		},
	},
});
Deno.test("day query validates against the real integration schema", () => {
	for (const query of Object.values(dayBriefingQueries)) {
		assert.deepEqual(
			validate(
				composeSchema([googleGraphql, githubGraphql]).schema,
				parse(query),
			),
			[],
		);
	}
});
Deno.test("IANA civil day boundaries cover DST short/long days and reject nonexistent dates", () => {
	assert.deepEqual(dayBounds("2026-03-29", "Europe/London"), {
		from: "2026-03-29T00:00:00Z",
		to: "2026-03-29T23:00:00Z",
	});
	assert.deepEqual(dayBounds("2026-10-25", "Europe/London"), {
		from: "2026-10-24T23:00:00Z",
		to: "2026-10-26T00:00:00Z",
	});
	assert.throws(
		() => dayBounds("2011-12-30", "Pacific/Apia"),
		/does not exist/,
	);
	assert.throws(() => dayBounds("2026-02-30", "Europe/London"));
});
Deno.test("real GraphQL adapter fixes origin/assertion, preserves all-day and section uncertainty", async () => {
	let calls = 0;
	const reader = await createApiDayReader(request(), config, {
		fetch: async (outgoing) => {
			calls++;
			assert.equal(outgoing.url, "https://notes.example/api/graphql");
			assert.equal(
				outgoing.headers.get("Cf-Access-Jwt-Assertion"),
				"verified-assertion-fixture",
			);
			assert.equal(outgoing.headers.get("Origin"), config.WEBSITE_ORIGIN);
			assert.equal(outgoing.redirect, "manual");
			const body = await outgoing.json() as Record<string, unknown>;
			assert.ok(
				Object.values(dayBriefingQueries).includes(body.query as string),
			);
			assert.deepEqual(body.variables, {
				date: "2026-03-29",
				from: "2026-03-29T00:00:00Z",
				to: "2026-03-29T23:00:00Z",
			});
			return Response.json(envelope());
		},
	}, options);
	const capability = createDayCapabilities(identity.ownerId, "grant", {
		readDay: reader,
		currentGrant: () =>
			Promise.resolve({
				ownerID: identity.ownerId,
				grantID: "grant",
				expiresAt: Date.now() + 60_000,
				allowsDayBriefing: true,
			}),
	});
	const result = await capability.briefing({
		date: "2026-03-29",
		timeZone: "Europe/London",
	});
	assert.equal(calls, 2);
	assert.equal(result.events[0]?.allDay, true);
	assert.equal(result.events[0]?.start, "2026-03-29T00:00:00Z");
	assert.equal(result.events[0]?.end, "2026-03-29T23:00:00Z");
	assert.equal(result.partial, true);
	assert.equal(result.sections?.github.partial, true);
	assert.equal(result.sections?.calendar.partial, false);
	assert.equal(result.sections?.calendar.sourceFreshness, "unknown");
	assert.equal(result.fetchedAt, "2026-09-13T12:00:00.000Z");
	assert.equal(result.sources[0]?.id, result.events[0]?.id);
	assert.ok(!JSON.stringify(result).includes("secret"));
	assert.ok(!JSON.stringify(result).includes("assertion"));
});
Deno.test("day reader denies unauthenticated factory, foreign owner and foreign GraphQL identity", async () => {
	let calls = 0;
	const api = {
		fetch: () => {
			calls++;
			const value = envelope();
			value.data.me.id = "access:bob";
			return Promise.resolve(Response.json(value));
		},
	};
	await assert.rejects(
		createApiDayReader(request(), config, api, {
			authenticate: () => Promise.resolve(null),
		}),
		/Unauthorized/,
	);
	const reader = await createApiDayReader(request(), config, api, options);
	await assert.rejects(
		reader(
			"access:bob",
			{ date: "2026-03-29", timeZone: "Europe/London" },
			new AbortController().signal,
		),
		/owner mismatch/,
	);
	assert.equal(calls, 0);
	await assert.rejects(
		reader(
			identity.ownerId,
			{ date: "2026-03-29", timeZone: "Europe/London" },
			new AbortController().signal,
		),
		/owner mismatch/,
	);
});
Deno.test("GraphQL errors and missing completion metadata cannot appear as an empty complete day", async () => {
	for (
		const body of [{
			...envelope(),
			errors: [{ message: "private provider error" }],
		}, {
			data: {
				me: {
					id: identity.ownerId,
					today: {
						date: "2026-03-29",
						...dayBounds("2026-03-29", "Europe/London"),
						googleEvents: [],
						githubActivity: [],
					},
				},
			},
		}]
	) {
		const reader = await createApiDayReader(request(), config, {
			fetch: () => Promise.resolve(Response.json(body)),
		}, options);
		const result = await reader(identity.ownerId, {
			date: "2026-03-29",
			timeZone: "Europe/London",
		}, new AbortController().signal);
		assert.equal(result.partial, true);
		assert.equal(result.sections?.calendar.status, "unavailable");
		assert.equal(result.sections?.github.status, "unavailable");
		assert.equal(result.sections?.github.observedAt, undefined);
	}
});
const input = { date: "2026-03-29", timeZone: "Europe/London" };
Deno.test("fast calendar survives never-resolving GitHub within the source budget", async () => {
	let aborted = false;
	const reader = await createApiDayReader(request(), config, {
		fetch: async (outgoing) => {
			const { query } = await outgoing.json() as { query: string };
			if (query === dayBriefingQueries.calendar) {
				return Response.json(envelope());
			}
			outgoing.signal.addEventListener("abort", () => {
				aborted = true;
			});
			return new Promise(() => {});
		},
	}, { ...options, sourceTimeoutMs: 20, timeoutMs: 500 });
	const start = Date.now();
	const result = await reader(
		identity.ownerId,
		input,
		new AbortController().signal,
	);
	assert.ok(Date.now() - start < 300);
	assert.equal(aborted, true);
	assert.equal(result.events.length, 1);
	assert.equal(result.partial, true);
	assert.equal(result.sections?.calendar.status, "available");
	assert.equal(result.sections?.calendar.partial, false);
	assert.equal(result.sections?.github.status, "unavailable");
	assert.equal(result.sections?.github.partial, true);
	assert.equal(result.sections?.github.observedAt, undefined);
});
Deno.test("foreign owner or revoked access rejects even after another source succeeds", async () => {
	for (const failure of ["owner", "permission"]) {
		const reader = await createApiDayReader(request(), config, {
			fetch: async (outgoing) => {
				const { query } = await outgoing.json() as { query: string };
				if (query === dayBriefingQueries.calendar) {
					return Response.json(envelope());
				}
				if (failure === "permission") {
					return new Response(null, { status: 403 });
				}
				const value = envelope();
				value.data.me.id = "access:bob";
				return Response.json(value);
			},
		}, options);
		await assert.rejects(
			reader(identity.ownerId, input, new AbortController().signal),
			/owner mismatch|permission changed/,
		);
	}
});
Deno.test("caller cancellation aborts both requests and rejects the entire briefing", async () => {
	let aborted = 0;
	const controller = new AbortController();
	const reader = await createApiDayReader(request(), config, {
		fetch: (outgoing) => {
			outgoing.signal.addEventListener("abort", () => {
				aborted++;
			});
			return new Promise(() => {});
		},
	}, options);
	const pending = reader(identity.ownerId, input, controller.signal);
	controller.abort();
	await assert.rejects(pending, /cancelled/);
	assert.equal(aborted, 2);
});
Deno.test("oversized bodies and wrong source date retain uncertainty without exposing rows", async () => {
	for (const kind of ["oversized", "date"]) {
		const reader = await createApiDayReader(request(), config, {
			fetch: () => {
				const value = envelope();
				value.data.me.today.date = "2026-03-28";
				return Promise.resolve(
					kind === "oversized"
						? new Response("x".repeat(270_000))
						: Response.json(value),
				);
			},
		}, options);
		const result = await reader(
			identity.ownerId,
			input,
			new AbortController().signal,
		);
		assert.equal(result.partial, true);
		assert.equal(result.events.length, 0);
		assert.equal(result.github.length, 0);
		assert.equal(result.sections?.calendar.status, "unavailable");
	}
});

Deno.test("successful empty sources produce a complete day with observed sections", async () => {
	const value = envelope();
	value.data.me.today.googleEvents = [];
	value.data.me.today.githubActivity = [];
	value.data.me.today.githubActivityPartial = false;
	const reader = await createApiDayReader(request(), config, {
		fetch: () => Promise.resolve(Response.json(value)),
	}, options);
	const result = await reader(
		identity.ownerId,
		input,
		new AbortController().signal,
	);
	assert.equal(result.partial, false);
	assert.equal(result.sections?.calendar.status, "available");
	assert.equal(result.sections?.github.status, "available");
	assert.equal(
		result.sections?.github.observedAt,
		options.clock().toISOString(),
	);
	assert.deepEqual(result.events, []);
	assert.deepEqual(result.github, []);
});
