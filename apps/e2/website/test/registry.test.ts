import { strict as assert } from "node:assert";
import { editorRegistry } from "../src/editor/registry.ts";

Deno.test("editor references keep provider identities within the note limit", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (_input, init) => {
		const body = JSON.parse(String(init?.body));
		assert.match(body.query, /googlePeople/);
		return Promise.resolve(
			Response.json({
				data: {
					me: {
						googlePeople: [{
							id: "people/" + "x".repeat(2_048),
							connectionId: "connection",
							displayName: "Long identity",
							emails: ["long@example.com"],
						}],
					},
				},
			}),
		);
	};
	try {
		const people = await editorRegistry.entities.find((entry) =>
			entry.id === "google.people"
		)!.search("long");
		assert.equal(people.length, 1);
		assert.ok(people[0]!.id.length <= 480);
		assert.match(people[0]!.id, /^connection:/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
