import { describe, expect, test } from "bun:test";
import { getGadgetDefinition, listGadgetDefinitions, upsertGadgetDefinition } from "./gadget-definition-store";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function freshDb(): SqliteStorageAdapter {
  const db = new SqliteStorageAdapter();
  initializeSchema(db);
  return db;
}

describe("upsertGadgetDefinition — inline modules shape", () => {
  test("stores and retrieves inline modules, starting at codeVersion 1", () => {
    const db = freshDb();
    const written = upsertGadgetDefinition(
      db,
      { id: "gadget-1", kind: "headless", mainModule: "gadget.js", modules: { "gadget.js": "export class Gadget {}" }, compatibilityDate: "2026-08-01" },
      1000,
    );
    expect(written.codeVersion).toBe(1);
    expect(written.r2Key).toBeNull();

    const read = getGadgetDefinition(db, "gadget-1");
    expect(read).toBeDefined();
    expect(read?.modules).toEqual({ "gadget.js": "export class Gadget {}" });
    expect(read?.r2Key).toBeNull();
    expect(read?.codeVersion).toBe(1);
    expect(read?.compatibilityDate).toBe("2026-08-01");
    expect(read?.createdAt).toBe(1000);
    expect(read?.updatedAt).toBe(1000);
  });

  test("re-registering the same id bumps codeVersion and keeps createdAt stable", () => {
    const db = freshDb();
    upsertGadgetDefinition(db, { id: "gadget-1", kind: "headless", mainModule: "gadget.js", modules: { "gadget.js": "v1" }, compatibilityDate: "2026-08-01" }, 1000);
    const v2 = upsertGadgetDefinition(
      db,
      { id: "gadget-1", kind: "headless", mainModule: "gadget.js", modules: { "gadget.js": "v2" }, compatibilityDate: "2026-08-01" },
      2000,
    );
    expect(v2.codeVersion).toBe(2);
    expect(v2.createdAt).toBe(1000);
    expect(v2.updatedAt).toBe(2000);

    const v3 = upsertGadgetDefinition(
      db,
      { id: "gadget-1", kind: "headless", mainModule: "gadget.js", modules: { "gadget.js": "v3" }, compatibilityDate: "2026-08-01" },
      3000,
    );
    expect(v3.codeVersion).toBe(3);

    const read = getGadgetDefinition(db, "gadget-1");
    expect(read?.modules).toEqual({ "gadget.js": "v3" });
    expect(read?.codeVersion).toBe(3);
  });

  test("a second, distinct gadget id starts its own codeVersion at 1", () => {
    const db = freshDb();
    upsertGadgetDefinition(db, { id: "gadget-1", kind: "headless", mainModule: "a.js", modules: { "a.js": "a" }, compatibilityDate: "2026-08-01" }, 1000);
    upsertGadgetDefinition(db, { id: "gadget-1", kind: "headless", mainModule: "a.js", modules: { "a.js": "a2" }, compatibilityDate: "2026-08-01" }, 2000);
    const other = upsertGadgetDefinition(db, { id: "gadget-2", kind: "ui", mainModule: "b.js", modules: { "b.js": "b" }, compatibilityDate: "2026-08-01" }, 3000);
    expect(other.codeVersion).toBe(1);
  });
});

describe("upsertGadgetDefinition — R2-backed (production) shape", () => {
  test("stores and retrieves an r2Key-pointing definition with modules null", () => {
    const db = freshDb();
    const written = upsertGadgetDefinition(
      db,
      { id: "morning-brief", kind: "headless", mainModule: "index.js", r2Key: "gadgets/morning-brief/abc123.js", compatibilityDate: "2026-08-01" },
      1000,
    );
    expect(written.modules).toBeNull();
    expect(written.r2Key).toBe("gadgets/morning-brief/abc123.js");
    expect(written.codeVersion).toBe(1);

    const read = getGadgetDefinition(db, "morning-brief");
    expect(read?.modules).toBeNull();
    expect(read?.r2Key).toBe("gadgets/morning-brief/abc123.js");
  });

  test("redeploying with a new r2Key bumps codeVersion", () => {
    const db = freshDb();
    upsertGadgetDefinition(db, { id: "morning-brief", kind: "headless", mainModule: "index.js", r2Key: "gadgets/morning-brief/v1.js", compatibilityDate: "2026-08-01" }, 1000);
    const v2 = upsertGadgetDefinition(
      db,
      { id: "morning-brief", kind: "headless", mainModule: "index.js", r2Key: "gadgets/morning-brief/v2.js", compatibilityDate: "2026-08-01" },
      2000,
    );
    expect(v2.codeVersion).toBe(2);
    expect(v2.r2Key).toBe("gadgets/morning-brief/v2.js");
  });

  test("a definition can switch from inline modules to R2-backed across redeploys, still incrementing codeVersion", () => {
    const db = freshDb();
    upsertGadgetDefinition(db, { id: "gadget-1", kind: "headless", mainModule: "gadget.js", modules: { "gadget.js": "inline" }, compatibilityDate: "2026-08-01" }, 1000);
    const promoted = upsertGadgetDefinition(
      db,
      { id: "gadget-1", kind: "headless", mainModule: "gadget.js", r2Key: "gadgets/gadget-1/deadbeef.js", compatibilityDate: "2026-08-01" },
      2000,
    );
    expect(promoted.codeVersion).toBe(2);
    expect(promoted.modules).toBeNull();
    expect(promoted.r2Key).toBe("gadgets/gadget-1/deadbeef.js");
  });
});

describe("upsertGadgetDefinition — exactly-one-of invariant", () => {
  test("rejects a definition with neither modules nor r2Key", () => {
    const db = freshDb();
    expect(() =>
      upsertGadgetDefinition(db, { id: "gadget-1", kind: "headless", mainModule: "gadget.js", compatibilityDate: "2026-08-01" }, 1000),
    ).toThrow(TypeError);
  });

  test("rejects a definition with both modules and r2Key", () => {
    const db = freshDb();
    expect(() =>
      upsertGadgetDefinition(
        db,
        { id: "gadget-1", kind: "headless", mainModule: "gadget.js", modules: { "gadget.js": "x" }, r2Key: "gadgets/gadget-1/x.js", compatibilityDate: "2026-08-01" },
        1000,
      ),
    ).toThrow(TypeError);
  });
});

describe("listGadgetDefinitions", () => {
  test("lists every registered gadget, oldest first, mixing both storage shapes", () => {
    const db = freshDb();
    upsertGadgetDefinition(db, { id: "a", kind: "headless", mainModule: "a.js", modules: { "a.js": "a" }, compatibilityDate: "2026-08-01" }, 1000);
    upsertGadgetDefinition(db, { id: "b", kind: "ui", mainModule: "index.js", r2Key: "gadgets/b/x.js", compatibilityDate: "2026-08-01" }, 2000);

    const all = listGadgetDefinitions(db);
    expect(all.map((d) => d.id)).toEqual(["a", "b"]);
    expect(all[0]?.modules).toEqual({ "a.js": "a" });
    expect(all[1]?.r2Key).toBe("gadgets/b/x.js");
  });
});
