import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";

const migrationConfig = {
	migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
};
import { createDocumentStore, type DocumentDatabase } from "./storage.ts";

const fixture = () => {
	const database = new DatabaseSync(":memory:");
	const db = drizzle({ client: database });
	migrate(db, migrationConfig);
	return {
		database,
		documents: createDocumentStore(db as unknown as DocumentDatabase),
	};
};
const note = (text: string) => ({
	type: "doc",
	content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

Deno.test("large shared notes roundtrip Unicode through bounded chunks and replace atomically", () => {
	const { database, documents } = fixture();
	try {
		const large = note("🌍".repeat(800_000));
		assert.equal(documents.save("large", large, null).ok, true);
		assert.deepEqual(documents.get("large")?.note, large);
		assert.ok(
			Number(
				database.prepare("SELECT count(*) AS count FROM document_chunks").get()
					?.count,
			) > 1,
		);
		assert.equal(
			documents.save("large", note("Small replacement"), 1).ok,
			true,
		);
		assert.equal(
			database.prepare("SELECT count(*) AS count FROM document_chunks").get()
				?.count,
			1,
		);
		assert.deepEqual(documents.get("large")?.note, note("Small replacement"));
	} finally {
		database.close();
	}
});

Deno.test("failed chunk writes roll back metadata and previous document content", () => {
	const { database, documents } = fixture();
	try {
		documents.save("today", note("Preserved"), null);
		database.exec(`
			CREATE TRIGGER fail_document_chunks
			BEFORE INSERT ON document_chunks
			BEGIN SELECT RAISE(ABORT, 'Storage failure'); END
		`);
		assert.throws(() => documents.save("today", note("Lost"), 1));
		assert.equal(documents.get("today")?.revision, 1);
		assert.deepEqual(documents.get("today")?.note, note("Preserved"));
	} finally {
		database.close();
	}
});

Deno.test("reading today's draft does not persist a document, first edit creates revision one", () => {
	const { database, documents } = fixture();
	try {
		assert.equal(documents.get("daily:2026-09-10"), null);
		assert.equal(
			database.prepare("SELECT count(*) AS count FROM documents").get()?.count,
			0,
		);
		const result = documents.save("daily:2026-09-10", note("First edit"), null);
		assert.equal(result.ok, true);
		assert.equal(documents.get("daily:2026-09-10")?.revision, 1);
	} finally {
		database.close();
	}
});

Deno.test("event feeds list instance notes by owner and prefix", () => {
	const { database, documents } = fixture();
	try {
		documents.save(
			"event:connection:series:instance-1",
			note("First meeting"),
			null,
		);
		documents.save(
			"event:connection:series:instance-2",
			note("Second meeting"),
			null,
		);
		documents.save("event:connection:other:instance", note("Other"), null);
		documents.save(
			"event:connection_x:series:instance-3",
			note("Underscore"),
			null,
		);
		documents.save(
			"event:connectionX:series:instance-4",
			note("Other connection"),
			null,
		);
		assert.deepEqual(
			documents.list("event:connection:series:").map(({ id }) => id),
			[
				"event:connection:series:instance-1",
				"event:connection:series:instance-2",
			],
		);
		assert.deepEqual(
			documents.list("event:connection_x:series:").map(({ id }) => id),
			["event:connection_x:series:instance-3"],
		);
	} finally {
		database.close();
	}
});

Deno.test("concurrent revision snapshots cannot overwrite the winning edit", () => {
	const { database, documents } = fixture();
	try {
		documents.save("today", note("Initial"), null);
		const firstSnapshot = documents.get("today")!;
		const secondSnapshot = documents.get("today")!;
		assert.equal(
			documents.save("today", note("Winner"), firstSnapshot.revision).ok,
			true,
		);
		const stale = documents.save(
			"today",
			note("Stale"),
			secondSnapshot.revision,
		);
		assert.deepEqual(stale, { ok: false, conflict: documents.get("today") });
		assert.deepEqual(documents.get("today")?.note, note("Winner"));
		assert.equal(
			documents.save("today", note("Duplicate create"), null).ok,
			false,
		);
		const db = drizzle({ client: database });
		migrate(db, migrationConfig);
		assert.equal(
			createDocumentStore(db as unknown as DocumentDatabase).get("today")
				?.revision,
			2,
		);
	} finally {
		database.close();
	}
});

Deno.test("owner stores isolate same document ID and reject invalid writes", () => {
	const first = fixture();
	const second = fixture();
	try {
		first.documents.save("today", note("Private"), null);
		assert.equal(second.documents.get("today"), null);
		assert.throws(() =>
			second.documents.save("today", { type: "html", content: "unsafe" }, null)
		);
		assert.throws(() =>
			second.documents.save("today", note("Invalid revision"), 0)
		);
		assert.throws(() => second.documents.get("../other"));
		assert.equal(second.documents.get("today"), null);
	} finally {
		first.database.close();
		second.database.close();
	}
});
