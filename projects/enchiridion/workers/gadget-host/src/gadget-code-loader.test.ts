import { describe, expect, test } from "bun:test";
import { GadgetCodeNotFoundError, resolveGadgetModules, type R2LikeBucket } from "./gadget-code-loader";

function fakeBucket(objects: Record<string, string> = {}): R2LikeBucket {
  return {
    async get(key: string) {
      const text = objects[key];
      if (text === undefined) return null;
      return { async text() { return text; } };
    },
  };
}

describe("resolveGadgetModules — inline shape", () => {
  test("returns the definition's inline modules unchanged, never touching the bucket", async () => {
    let bucketCalled = false;
    const bucket: R2LikeBucket = {
      async get() {
        bucketCalled = true;
        return null;
      },
    };
    const modules = await resolveGadgetModules(bucket, { mainModule: "gadget.js", modules: { "gadget.js": "export const x = 1;" }, r2Key: null });
    expect(modules).toEqual({ "gadget.js": "export const x = 1;" });
    expect(bucketCalled).toBe(false);
  });
});

describe("resolveGadgetModules — R2-backed shape", () => {
  test("fetches the object by r2Key and returns it keyed under mainModule", async () => {
    const bucket = fakeBucket({ "gadgets/morning-brief/abc123.js": "export class Gadget {}" });
    const modules = await resolveGadgetModules(bucket, { mainModule: "index.js", modules: null, r2Key: "gadgets/morning-brief/abc123.js" });
    expect(modules).toEqual({ "index.js": "export class Gadget {}" });
  });

  test("throws GadgetCodeNotFoundError when the R2 object is missing", async () => {
    const bucket = fakeBucket({});
    await expect(resolveGadgetModules(bucket, { mainModule: "index.js", modules: null, r2Key: "gadgets/missing/x.js" })).rejects.toThrow(GadgetCodeNotFoundError);
  });
});

describe("resolveGadgetModules — malformed definition", () => {
  test("throws TypeError when neither modules nor r2Key is set", async () => {
    const bucket = fakeBucket({});
    await expect(resolveGadgetModules(bucket, { mainModule: "index.js", modules: null, r2Key: null })).rejects.toThrow(TypeError);
  });
});
