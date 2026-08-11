import { describe, expect, test } from "bun:test";
import {
  DurableObjectListError,
  listDurableObjectStoragePage,
  maximumDurableObjectListPageEntries,
} from "./durable-object-list";

describe("bounded Durable Object list", () => {
  test("caps pages and produces a checkpoint only for a full page", async () => {
    const page = await listDurableObjectStoragePage(
      { list: async () => new Map([["v2.ov/device/a", { payload: true }]]) },
      { prefix: "v2.ov/", limit: 1 },
    );
    expect(page.nextStartAfter).toBe("v2.ov/device/a");
    await expect(
      listDurableObjectStoragePage({ list: async () => new Map() }, {
        prefix: "v2.ov/",
        limit: maximumDurableObjectListPageEntries + 1,
      }),
    ).rejects.toMatchObject({ reason: "invalid_request" } satisfies Partial<DurableObjectListError>);
  });

  test("fails closed for unordered, oversized, and rejected native pages", async () => {
    await expect(
      listDurableObjectStoragePage(
        { list: async () => new Map([["v2.ov/z", 1], ["v2.ov/a", 2]]) },
        { prefix: "v2.ov/", limit: 2 },
      ),
    ).rejects.toMatchObject({ reason: "invalid_response" } satisfies Partial<DurableObjectListError>);
    await expect(
      listDurableObjectStoragePage(
        { list: async () => Promise.reject(new Error("platform")) },
        { prefix: "v2.ov/", limit: 1 },
      ),
    ).rejects.toMatchObject({ reason: "native_failure" } satisfies Partial<DurableObjectListError>);
  });
});
