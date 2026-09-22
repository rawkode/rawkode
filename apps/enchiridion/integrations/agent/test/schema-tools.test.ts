import { strict as assert } from "node:assert";
import { createVoiceTaskTools } from "../src/task-tools.ts";
import type { VoiceTaskBinding } from "../src/task-tools.ts";
const context = { toolCallId: "schema", messages: [], context: {} };
const field = {
	id: "field:test",
	tagId: "tag:test",
	key: "stage",
	label: "Stage",
	type: "enum" as const,
	cardinality: "single" as const,
	required: false,
	options: ["Idea"],
	archived: false,
};
const make = (fail: boolean | string = false) => {
	const writes: unknown[] = [];
	const api = {
		[Symbol.dispose]() {},
		getTag: () =>
			Promise.resolve({
				tag: {
					id: "tag:test",
					name: "Projects",
					kind: "user",
					revision: 7,
					archived: false,
				},
				fields: [{
					...field,
					originTagId: field.tagId,
					inherited: false,
					privateMetadata: "hidden",
				}],
			}),
		defineField: (input: unknown, provenance: unknown) => {
			writes.push({ input, provenance });
			if (fail) {
				return Promise.reject(
					new Error(typeof fail === "string" ? fail : "timeout"),
				);
			}
			return Promise.resolve({ ...field, privateMetadata: "hidden" });
		},
		updateField: (input: unknown, provenance: unknown) => {
			writes.push({ input, provenance });
			return Promise.resolve(field);
		},
	};
	const tools = createVoiceTaskTools({
		binding: {
			admin: (owner: string) => {
				assert.equal(owner, "access:alice");
				return Promise.resolve(api);
			},
		} as unknown as VoiceTaskBinding,
		owner: "access:alice",
		signal: new AbortController().signal,
		check: () => Promise.resolve(),
		isCurrent: () => Promise.resolve(true),
	});
	return { tools, writes };
};
Deno.test("voice reads revision and field metadata without leaking unknown properties", async () => {
	const { tools } = make();
	const response = await tools.supertagFields.execute!(
		{ tagId: "tag:test" },
		context,
	);
	assert.equal(
		(response as { result: { tag: { revision: number } } }).result.tag.revision,
		7,
	);
	assert.ok(!JSON.stringify(response).includes("hidden"));
});
Deno.test("voice schema writes preserve revision and verified provenance", async () => {
	const { tools, writes } = make();
	const create = {
		tagId: "tag:test",
		expectedTagRevision: 7,
		key: "stage",
		label: "Stage",
		type: "enum" as const,
		cardinality: "single" as const,
		options: ["Idea"],
	};
	const response = await tools.supertagFieldCreate.execute!(create, context);
	assert.ok(!JSON.stringify(response).includes("hidden"));
	await tools.supertagFieldUpdate.execute!({
		id: field.id,
		tagId: field.tagId,
		expectedTagRevision: 8,
		label: "Progress",
		defaultValue: null,
	}, context);
	assert.equal(writes.length, 2);
	assert.equal(
		(writes[0] as { provenance: { actor: string } }).provenance.actor,
		"access:alice",
	);
	assert.deepEqual((writes[0] as { input: unknown }).input, create);
});
Deno.test("uncertain schema write blocks later writes through the shared tool boundary", async () => {
	const { tools, writes } = make(true);
	const response = await tools.supertagFieldCreate.execute!({
		tagId: field.tagId,
		expectedTagRevision: 7,
		key: "stage",
		label: "Stage",
		type: "text",
		cardinality: "single",
	}, context);
	assert.equal((response as { outcome: string }).outcome, "unknown");
	await assert.rejects(
		() =>
			tools.taskCreate.execute!(
				{ title: "Must not happen" },
				context,
			) as Promise<unknown>,
		/uncertain/,
	);
	assert.equal(writes.length, 1);
});

Deno.test("schema revision conflicts are explicit, never successful mutations", async () => {
	const { tools } = make("Tag revision conflict");
	const result = await tools.supertagFieldCreate.execute!({
		tagId: field.tagId,
		expectedTagRevision: 7,
		key: "stage",
		label: "Stage",
		type: "text",
		cardinality: "single",
	}, context);
	assert.equal(
		(result as { result: { outcome: string } }).result.outcome,
		"conflict",
	);
});

Deno.test("voice creates delegated web-link Supertag with owner provenance and strips private fields", async () => {
	const writes: { input: unknown; provenance: unknown }[] = [];
	const api = {
		[Symbol.dispose]() {},
		createUserTag: (
			input: { name: string; parentId: string },
			provenance: unknown,
		) => {
			writes.push({ input, provenance });
			return Promise.resolve({
				id: "tag:links",
				...input,
				kind: "user",
				rootId: "base:document",
				revision: 1,
				archived: false,
				privateMetadata: "hidden",
			});
		},
	};
	const tools = createVoiceTaskTools({
		owner: "access:alice",
		signal: new AbortController().signal,
		check: () => Promise.resolve(),
		isCurrent: () => Promise.resolve(true),
		binding: {
			admin: (owner: string) => {
				assert.equal(owner, "access:alice");
				return Promise.resolve(api);
			},
		} as unknown as VoiceTaskBinding,
	});
	const result = await tools.supertagCreate.execute!({
		name: "Web links",
		parentId: "base:document",
	}, context);
	assert.equal(writes.length, 1);
	assert.deepEqual(writes[0].input, {
		name: "Web links",
		parentId: "base:document",
	});
	assert.equal(
		(writes[0].provenance as { actor: string }).actor,
		"access:alice",
	);
	assert.equal(
		(result as { result: { tag: { revision: number } } }).result.tag.revision,
		1,
	);
	assert.ok(!JSON.stringify(result).includes("hidden"));
	await assert.rejects(() =>
		tools.supertagCreate.execute!(
			{
				name: "Links",
				parentId: "base:document",
				owner: "access:bob",
			} as never,
			context,
		) as Promise<unknown>
	);
	assert.equal(writes.length, 1);
});

Deno.test("uncertain Supertag creation blocks another create and revoked sessions cannot create", async () => {
	let writes = 0;
	const api = {
		[Symbol.dispose]() {},
		createUserTag: () => {
			writes++;
			return Promise.reject(new Error("Lost reply"));
		},
	};
	const binding = {
		admin: () => Promise.resolve(api),
	} as unknown as VoiceTaskBinding;
	const tools = createVoiceTaskTools({
		owner: "access:alice",
		binding,
		signal: new AbortController().signal,
		check: () => Promise.resolve(),
		isCurrent: () => Promise.resolve(true),
	});
	const input = { name: "Web links", parentId: "base:document" };
	const result = await tools.supertagCreate.execute!(input, context);
	assert.equal((result as { outcome: string }).outcome, "unknown");
	await assert.rejects(
		() => tools.supertagCreate.execute!(input, context) as Promise<unknown>,
		/uncertain/,
	);
	assert.equal(writes, 1);
	const revoked = createVoiceTaskTools({
		owner: "access:alice",
		binding,
		signal: new AbortController().signal,
		check: () => Promise.reject(new Error("Revoked")),
		isCurrent: () => Promise.resolve(false),
	});
	await assert.rejects(
		() => revoked.supertagCreate.execute!(input, context) as Promise<unknown>,
		/Revoked/,
	);
	assert.equal(writes, 1);
});
