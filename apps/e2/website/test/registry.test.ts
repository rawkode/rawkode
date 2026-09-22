import { strict as assert } from "node:assert";
import {
	createCanonicalEntity,
	editorRegistry,
	listCanonicalSupertags,
	searchCanonicalEntities,
} from "../src/editor/registry.ts";
import { canonicalEntityInsertion } from "../src/editor/entityComposer.ts";

Deno.test("integration registry searches return canonical references only", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (_input, init) => {
		const body = JSON.parse(String(init?.body));
		assert.match(body.query, /entities\(query: \$query, rootId: \$rootId/);
		assert.deepEqual(body.variables, { query: "ada", rootId: "base:person" });
		return Promise.resolve(
			Response.json({
				data: {
					me: {
						entities: [{
							id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
							label: "Ada Lovelace",
							bodyDocumentId: "entity:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
							tagIds: ["base:person", "integration:google:contact"],
							rootId: "base:person",
						}],
					},
				},
			}),
		);
	};
	try {
		const people = await editorRegistry.entities.find((entry) =>
			entry.id === "google.people"
		)!.search("ada");
		assert.equal(people.length, 1);
		assert.deepEqual(people[0], {
			version: 1,
			entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			fallbackLabel: "Ada Lovelace",
			displayText: "Ada Lovelace",
			presentation: "mention",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

Deno.test("external insertion accepts canonical references and rejects legacy provider refs", () => {
	const canonical = {
		version: 1 as const,
		entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		fallbackLabel: "Ada Lovelace",
		displayText: "Ada",
		presentation: "mention" as const,
	};
	assert.deepEqual(canonicalEntityInsertion(canonical), canonical);
	assert.throws(() =>
		canonicalEntityInsertion({
			provider: "google",
			kind: "person",
			id: "connection:people/1",
			label: "Ada Lovelace",
		}), /canonical entity/i);
});

Deno.test("canonical editor search forwards the Person scope and cancellation signal", async () => {
	const originalFetch = globalThis.fetch;
	const controller = new AbortController();
	globalThis.fetch = (_input, init) => {
		assert.equal(init?.signal, controller.signal);
		const body = JSON.parse(String(init?.body));
		assert.match(body.query, /entities\(query: \$query, rootId: \$rootId/);
		assert.deepEqual(body.variables, {
			query: "ada",
			rootId: "base:person",
		});
		return Promise.resolve(Response.json({
			data: {
				me: {
					entities: [{
						id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
						label: "Ada Lovelace",
						bodyDocumentId: "entity:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
						tagIds: ["base:person"],
						rootId: "base:person",
					}],
				},
			},
		}));
	};
	try {
		assert.equal(
			(await searchCanonicalEntities(
				"ada",
				"base:person",
				controller.signal,
			))[0]?.label,
			"Ada Lovelace",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

Deno.test("canonical quick-create uses a chosen Supertag and no field values", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (_input, init) => {
		calls++;
		const body = JSON.parse(String(init?.body));
		if (body.query.includes("EditorSupertags")) {
			return Promise.resolve(Response.json({
				data: {
					me: {
						supertags: [{
							id: "base:person",
							name: "Person",
							kind: "base",
							parentId: null,
							rootId: "base:person",
							archived: false,
						}],
					},
				},
			}));
		}
		assert.match(body.query, /createEntity\(input:/);
		assert.deepEqual(body.variables, {
			label: "Grace Hopper",
			tagIds: ["base:person"],
		});
		return Promise.resolve(Response.json({
			data: {
				createEntity: {
					id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
					label: "Grace Hopper",
					bodyDocumentId: "entity:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
					tagIds: ["base:person"],
				},
			},
		}));
	};
	try {
		assert.equal((await listCanonicalSupertags())[0]?.name, "Person");
		assert.equal(
			(await createCanonicalEntity("Grace Hopper", "base:person")).label,
			"Grace Hopper",
		);
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
