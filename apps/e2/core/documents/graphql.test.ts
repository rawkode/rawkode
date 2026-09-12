import { strict as assert } from "node:assert";
import { execute, parse } from "graphql";
import { composeSchema } from "../../api/src/schema.ts";
import { type ApiEnv, createContext } from "../../api/src/context.ts";
import { documentsGraphql } from "./graphql.ts";

Deno.test("capture feed uses verified owner and rejects broader prefixes", async () => {
	const calls: unknown[][] = [];
	const env = {
		DOCUMENTS_ADMIN: {
			admin: (owner: string) =>
				Promise.resolve({
					list: (prefix: string, limit: number) => {
						calls.push([owner, prefix, limit]);
						return Promise.resolve([]);
					},
					[Symbol.dispose]: () => {},
				}),
		},
	} as unknown as ApiEnv;
	const { schema, fieldResolver } = composeSchema([documentsGraphql]);
	const run = (prefix: string, ownerId: string) =>
		execute({
			schema,
			fieldResolver,
			document: parse(
				`query Feed($prefix: String!) { me { documentFeed(prefix: $prefix, limit: 100) { id } } }`,
			),
			variableValues: { prefix },
			contextValue: createContext(env, {
				ownerId,
				email: "verified@example.test",
			}),
		});
	assert.equal((await run("capture:", "access:alice")).errors, undefined);
	assert.equal((await run("capture:", "access:bob")).errors, undefined);
	assert.deepEqual(calls, [["access:alice", "capture:", 100], [
		"access:bob",
		"capture:",
		100,
	]]);
	for (
		const prefix of ["", "capture", "capture:%", "capture:alice:", "daily:"]
	) {
		assert.ok((await run(prefix, "access:alice")).errors?.length, prefix);
	}
	assert.equal(
		calls.length,
		2,
		"Rejected prefixes must never open a document service",
	);
});
