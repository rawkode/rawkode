import { strict as assert } from "node:assert";
import type { ApiContext } from "../../api/src/context.ts";
import { todayTaggedPeople } from "./graphql.ts";

Deno.test("tagged people resolves canonical references through active Google sources", async () => {
	const disposed: string[] = [];
	const context = {
		identity: { ownerId: "owner-a" },
		env: {
			DOCUMENTS_ADMIN: {
				admin: () =>
					Promise.resolve({
						get: () =>
							Promise.resolve({
								note: {
									type: "doc",
									content: [{
										type: "entity",
										attrs: {
											entity: {
												version: 1,
												entityId: "00000000-0000-4000-8000-000000000001",
												displayText: "Ada",
												fallbackLabel: "Ada Lovelace",
												presentation: "mention",
											},
										},
									}],
								},
							}),
						[Symbol.dispose]: () => disposed.push("documents"),
					}),
			},
			ENTITIES_ADMIN: {
				admin: () =>
					Promise.resolve({
						getEntitySources: () =>
							Promise.resolve([
								{
									provider: "google",
									connectionId: "connection-a",
									resourceType: "contact",
									resourceId: "people/ada",
								},
								{
									provider: "github",
									connectionId: "installation-a",
									resourceType: "user",
									resourceId: "1",
								},
							]),
						[Symbol.dispose]: () => disposed.push("entities"),
					}),
			},
		},
		cache: new Map(),
		consume: () => undefined,
	} as unknown as ApiContext;

	assert.deepEqual(await todayTaggedPeople(context, "2026-09-10"), [{
		connectionId: "connection-a",
		id: "people/ada",
		label: "Ada",
	}]);
	assert.deepEqual(disposed, ["entities", "documents"]);
});
