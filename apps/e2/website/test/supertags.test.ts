import { strict as assert } from "node:assert";
import {
	createSupertagClient,
	defineFieldInput,
	type FieldDraft,
} from "../src/lib/supertags.ts";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

Deno.test("Supertag client forwards create and impact mutation guards", async () => {
	const requests: { query: string; variables: Record<string, unknown> }[] = [];
	const client = createSupertagClient((_input, init) => {
		const request = JSON.parse(String(init?.body)) as {
			query: string;
			variables: Record<string, unknown>;
		};
		requests.push(request);
		if (request.query.includes("CreateManagedSupertag")) {
			return Promise.resolve(json({
				data: {
					createUserTag: {
						id: "tag-1",
						name: "Speaker",
						kind: "user",
						parentId: "base:person",
						rootId: "base:person",
						depth: 1,
						revision: 1,
						archived: false,
					},
				},
			}));
		}
		return Promise.resolve(json({
			data: {
				archiveEntityField: {
					tag: { id: "tag-1" },
					fields: [],
					directEntityCount: 0,
					inheritedEntityCount: 0,
					activeChildTagCount: 0,
				},
			},
		}));
	});
	const created = await client.create("Speaker", "base:person");
	assert.equal(created.id, "tag-1");
	await client.archiveField("field-1", 7, 12);
	assert.deepEqual(requests[0]?.variables, {
		name: "Speaker",
		parentId: "base:person",
	});
	assert.deepEqual(requests[1]?.variables, {
		id: "field-1",
		expectedTagRevision: 7,
		expectedValueCount: 12,
	});
});

Deno.test("Supertag client keeps adjacent API error messages actionable", async () => {
	const client = createSupertagClient(() =>
		Promise.resolve(json({ errors: [{ message: "Tag revision conflict" }] }))
	);
	await assert.rejects(
		() => client.rename("tag-1", "Speaker", 2),
		/Tag revision conflict/,
	);
});

Deno.test("field input converts defaults without mutating an unsaved draft", () => {
	const draft: FieldDraft = {
		key: "topics",
		label: "Topics",
		type: "ENUM",
		cardinality: "MULTIPLE",
		required: true,
		options: "Platform, Security\nPlatform",
		defaultValue: "Platform, Security",
		hasDefault: true,
	};
	const before = structuredClone(draft);
	assert.deepEqual(defineFieldInput("tag-1", draft), {
		tagId: "tag-1",
		key: "topics",
		label: "Topics",
		type: "ENUM",
		cardinality: "MULTIPLE",
		required: true,
		options: ["Platform", "Security"],
		defaultValue: {
			text: null,
			number: null,
			boolean: null,
			strings: ["Platform", "Security"],
			numbers: null,
			booleans: null,
		},
	});
	assert.deepEqual(draft, before);
});

Deno.test("field input rejects invalid typed defaults before an API mutation", () => {
	assert.throws(
		() =>
			defineFieldInput("tag-1", {
				key: "score",
				label: "Score",
				type: "NUMBER",
				cardinality: "SINGLE",
				required: false,
				options: "",
				defaultValue: "not a number",
				hasDefault: true,
			}),
		/Check|number/i,
	);
});
