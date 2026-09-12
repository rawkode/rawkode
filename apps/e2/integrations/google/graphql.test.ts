import { strict as assert } from "node:assert";
import type { ApiContext } from "../../api/src/context.ts";
import { googleGraphql, todayTaggedPeople } from "./graphql.ts";

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

Deno.test("Today GraphQL carries calendar colors without inventing a missing color", async () => {
	const api = {
		listConnections: () => Promise.resolve([{ id: "calendar-account" }]),
		upcoming: () =>
			Promise.resolve({
				partial: false,
				events: [
					{
						id: "colored",
						summary: "Meeting",
						calendarId: "work",
						calendarName: "Work",
						calendarColor: "#Ab12Ef",
					},
					{
						id: "missing",
						summary: "Meeting",
						calendarId: "other",
						calendarName: "Other",
					},
					{
						id: "invalid",
						summary: "Meeting",
						calendarId: "other",
						calendarName: "Other",
						calendarColor: "red",
					},
				],
			}),
		[Symbol.dispose]: () => {},
	};
	const context = {
		identity: { ownerId: "owner" },
		env: { GOOGLE_ADMIN: { admin: () => Promise.resolve(api) } },
		cache: new Map(),
		consume: () => {},
	} as unknown as ApiContext;
	const result = await googleGraphql.fields["Today.googleEvents"](
		{ date: "2026-09-12" },
		{},
		context,
	) as { id: string; calendarColor: string | null }[];
	assert.deepEqual(
		result.map(({ id, calendarColor }) => ({ id, calendarColor })),
		[
			{ id: "colored", calendarColor: "#Ab12Ef" },
			{ id: "missing", calendarColor: null },
			{ id: "invalid", calendarColor: null },
		],
	);
});
