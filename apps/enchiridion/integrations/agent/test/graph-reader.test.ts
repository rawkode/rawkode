import { strict as assert } from "node:assert";
import { parse, validate } from "graphql";
import { composeSchema } from "../../../api/src/schema.ts";
import { entitiesGraphql } from "../../../core/entities/graphql.ts";
import { documentsGraphql } from "../../../core/documents/graphql.ts";
import { createApiGraphReader, graphReadQueries } from "../src/graph-reader.ts";
const config = {
	WEBSITE_ORIGIN: "https://notes.example",
	ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
	ACCESS_AUDIENCE: "aud",
	ADMIN_EMAILS: "alice@example.com",
};
const identity = { ownerId: "access:alice", email: "alice@example.com" };
const request = new Request(config.WEBSITE_ORIGIN, {
	headers: { "Cf-Access-Jwt-Assertion": "assertion-fixture" },
});
const options = { authenticate: () => Promise.resolve(identity) };
const signal = () => new AbortController().signal;
Deno.test("voice graph fixed queries match deployed schema", () => {
	const { schema } = composeSchema([entitiesGraphql, documentsGraphql]);
	for (const query of Object.values(graphReadQueries)) {
		assert.deepEqual(validate(schema, parse(query)), []);
	}
});
Deno.test("voice graph binds verified owner and strips extra metadata", async () => {
	let calls = 0;
	const read = await createApiGraphReader(request, config, {
		fetch: (req) => {
			calls++;
			assert.equal(
				req.headers.get("Cf-Access-Jwt-Assertion"),
				"assertion-fixture",
			);
			return Promise.resolve(Response.json({
				data: {
					me: {
						id: identity.ownerId,
						entities: [{
							id: "entity",
							label: "Ada",
							rootId: "base:person",
							bodyDocumentId: "entity:ada",
							tagIds: [],
							credential: "must not leave host",
						}],
						token: "private",
					},
				},
			}));
		},
	}, options);
	await assert.rejects(
		() => read("access:bob", "search", { query: "Ada" }, signal()),
		/owner mismatch/,
	);
	await assert.rejects(() =>
		read(identity.ownerId, "search", { query: "Ada", owner: "bob" }, signal())
	);
	assert.equal(calls, 0);
	const result = await read(
		identity.ownerId,
		"search",
		{ query: "Ada" },
		signal(),
	);
	assert.equal(JSON.stringify(result).includes("private"), false);
	assert.equal(JSON.stringify(result).includes("credential"), false);
	assert.equal(calls, 1);
});
Deno.test("voice graph refuses crossowner API response and GraphQL partial errors", async () => {
	for (
		const response of [{ data: { me: { id: "access:bob", entities: [] } } }, {
			data: { me: { id: identity.ownerId, entities: [] } },
			errors: [{ message: "failed" }],
		}]
	) {
		const read = await createApiGraphReader(request, config, {
			fetch: () => Promise.resolve(Response.json(response)),
		}, options);
		await assert.rejects(() =>
			read(identity.ownerId, "search", { query: "Ada" }, signal())
		);
	}
});
Deno.test("voice notes expose plain text only and preserve truncation", async () => {
	const read = await createApiGraphReader(request, config, {
		fetch: () =>
			Promise.resolve(Response.json({
				data: {
					me: {
						id: identity.ownerId,
						document: {
							id: "daily:2026-09-13",
							revision: 1,
							updatedAt: "now",
							note: {
								type: "doc",
								attrs: { secret: "secret" },
								content: [{
									type: "paragraph",
									content: [{
										type: "text",
										text: "a".repeat(9000),
										marks: [{ type: "link", attrs: { href: "sensitive" } }],
									}],
								}],
							},
						},
					},
				},
			})),
	}, options);
	const result = await read(identity.ownerId, "note", {
		id: "daily:2026-09-13",
	}, signal()) as { partial: boolean; document: { text: string } };
	assert.equal(result.partial, true);
	assert.equal(result.document.text.length, 8000);
	assert.equal(JSON.stringify(result).includes("sensitive"), false);
});
Deno.test("voice graph does not dispatch a cancelled request and bounds hung bindings", async () => {
	let calls = 0;
	const read = await createApiGraphReader(request, config, {
		fetch: () => {
			calls++;
			return new Promise(() => {});
		},
	}, { ...options, timeoutMs: 5 });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() =>
		read(identity.ownerId, "search", { query: "a" }, controller.signal)
	);
	assert.equal(calls, 0);
	await assert.rejects(
		() => read(identity.ownerId, "search", { query: "a" }, signal()),
		/deadline/,
	);
});
