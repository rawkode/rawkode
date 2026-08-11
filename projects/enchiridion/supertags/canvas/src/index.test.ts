import { describe, expect, test } from "bun:test";
import { SupertagRegistry } from "@enchiridion/schema";
import canvasModule, { CanvasSupertagIDs } from "./index";

describe("dev.rawkode.enchiridion.canvas — registry validation", () => {
  test("SupertagRegistry.build([canvasModule]) succeeds with no validation errors", () => {
    expect(() => SupertagRegistry.build([canvasModule])).not.toThrow();
  });

  test("declares exactly the canvasPage supertag", () => {
    const registry = SupertagRegistry.build([canvasModule]);
    const canvasIds = registry
      .allSupertags()
      .map((s) => s.id)
      .filter((id) => id.startsWith(canvasModule.id));
    expect(canvasIds).toEqual([CanvasSupertagIDs.canvasPage]);
  });

  test("declares no relations (a canvas page has no entityReference fields)", () => {
    const registry = SupertagRegistry.build([canvasModule]);
    const canvasRelations = registry.allRelations().filter((r) => r.id.startsWith(canvasModule.id));
    expect(canvasRelations).toHaveLength(0);
  });
});

describe("CanvasPage field shape", () => {
  test("declares width, height — no more, no less (task brief: 'minimal fields ... NOT the stroke data itself')", () => {
    const registry = SupertagRegistry.build([canvasModule]);
    const canvasPage = registry.getSupertag(CanvasSupertagIDs.canvasPage);
    expect(canvasPage).toBeDefined();

    const fields = canvasPage!.fields;
    expect(Object.keys(fields).sort()).toEqual(["height", "width"]);

    expect(fields.width?.type).toBe("number");
    expect(fields.height?.type).toBe("number");
  });

  test("no field allows multiple values (one width/height per canvas page)", () => {
    const registry = SupertagRegistry.build([canvasModule]);
    const canvasPage = registry.getSupertag(CanvasSupertagIDs.canvasPage)!;
    for (const [key, definition] of Object.entries(canvasPage.fields)) {
      expect(definition.allowsMultiple, `${key}.allowsMultiple`).toBeFalsy();
    }
  });

  test("no entityReference field exists on this module", () => {
    const registry = SupertagRegistry.build([canvasModule]);
    const canvasPage = registry.getSupertag(CanvasSupertagIDs.canvasPage)!;
    for (const [key, definition] of Object.entries(canvasPage.fields)) {
      expect(definition.type, key).not.toBe("entityReference");
    }
  });

  test("no field on this supertag is named/shaped like a blob/content reference — stroke/shape data and its blob id live outside supertag properties entirely (see index.ts header)", () => {
    const registry = SupertagRegistry.build([canvasModule]);
    const canvasPage = registry.getSupertag(CanvasSupertagIDs.canvasPage)!;
    const fieldNames = Object.keys(canvasPage.fields);
    for (const forbidden of ["content", "blob", "blobId", "strokes", "elements", "thumbnail"]) {
      expect(fieldNames, forbidden).not.toContain(forbidden);
    }
  });
});
