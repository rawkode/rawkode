import { describe, expect, test } from "bun:test";
import { SupertagRegistry } from "@enchiridion/schema";
import { importedModules } from "./index";

describe("@enchiridion/supertags-imported", () => {
  test("starts empty — no generated modules are committed by this task", () => {
    expect(importedModules).toEqual([]);
  });

  test("an empty module set validates cleanly against SupertagRegistry", () => {
    expect(() => SupertagRegistry.build([...importedModules])).not.toThrow();
  });
});
