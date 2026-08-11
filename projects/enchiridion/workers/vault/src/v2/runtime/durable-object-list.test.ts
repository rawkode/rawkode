import { describe, expect, test } from "bun:test";

/**
 * TEST-ONLY bounded Durable Object storage enumeration fixture.
 *
 * This helper has no production consumer; it lives inside the test module so
 * it stays outside the deployable Effect boundary. Cloudflare returns values
 * with `storage.list()`.  The limit therefore has to be sized for the largest
 * registered physical row, not just for key memory.  64 x 1.1 MiB leaves
 * substantial headroom below a 128 MiB isolate limit.
 */
const maximumDurableObjectListPageEntries = 64;

interface DurableObjectStorageListNative {
  readonly list: (options: {
    readonly prefix: string;
    readonly startAfter?: string;
    readonly limit: number;
  }) => Promise<ReadonlyMap<string, unknown>>;
}

interface DurableObjectStorageKeyPage {
  readonly entries: readonly (readonly [key: string, value: unknown])[];
  /** Pass this as `startAfter` for the next page; absent means the final page. */
  readonly nextStartAfter?: string;
}

class DurableObjectListError extends Error {
  constructor(readonly reason: "invalid_request" | "native_failure" | "invalid_response") {
    super(`durable_object_list_${reason}`);
  }
}

const validPrefix = (value: string): boolean => value.length > 0 && value.length <= 256;

/**
 * Reads one ordered, bounded page.  This intentionally does not offer an
 * unbounded convenience iterator: callers must make their own checkpointing
 * and cancellation decisions between pages.
 */
const listDurableObjectStoragePage = async (
  storage: DurableObjectStorageListNative,
  input: { readonly prefix: string; readonly startAfter?: string; readonly limit: number },
): Promise<DurableObjectStorageKeyPage> => {
  if (
    !validPrefix(input.prefix) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > maximumDurableObjectListPageEntries ||
    (input.startAfter !== undefined &&
      (!input.startAfter.startsWith(input.prefix) || input.startAfter.length > 512))
  )
    throw new DurableObjectListError("invalid_request");

  let native: ReadonlyMap<string, unknown>;
  try {
    native = await storage.list(input);
  } catch {
    throw new DurableObjectListError("native_failure");
  }
  if (!(native instanceof Map) || native.size > input.limit)
    throw new DurableObjectListError("invalid_response");

  const entries = [...native.entries()];
  let previous = input.startAfter;
  for (const [key] of entries) {
    if (
      typeof key !== "string" ||
      !key.startsWith(input.prefix) ||
      key.length > 512 ||
      (previous !== undefined && key <= previous)
    )
      throw new DurableObjectListError("invalid_response");
    previous = key;
  }
  return {
    entries,
    ...(entries.length === input.limit ? { nextStartAfter: entries.at(-1)?.[0] } : {}),
  };
};

describe("bounded Durable Object list", () => {
  test("caps pages and produces a checkpoint only for a full page", async () => {
    const page = await listDurableObjectStoragePage(
      { list: async () => new Map([["v2.ov/device/a", { payload: true }]]) },
      { prefix: "v2.ov/", limit: 1 },
    );
    expect(page.nextStartAfter).toBe("v2.ov/device/a");
    await expect(
      listDurableObjectStoragePage(
        { list: async () => new Map() },
        {
          prefix: "v2.ov/",
          limit: maximumDurableObjectListPageEntries + 1,
        },
      ),
    ).rejects.toMatchObject({
      reason: "invalid_request",
    } satisfies Partial<DurableObjectListError>);
  });

  test("fails closed for unordered, oversized, and rejected native pages", async () => {
    await expect(
      listDurableObjectStoragePage(
        {
          list: async () =>
            new Map([
              ["v2.ov/z", 1],
              ["v2.ov/a", 2],
            ]),
        },
        { prefix: "v2.ov/", limit: 2 },
      ),
    ).rejects.toMatchObject({
      reason: "invalid_response",
    } satisfies Partial<DurableObjectListError>);
    await expect(
      listDurableObjectStoragePage(
        { list: async () => Promise.reject(new Error("platform")) },
        { prefix: "v2.ov/", limit: 1 },
      ),
    ).rejects.toMatchObject({ reason: "native_failure" } satisfies Partial<DurableObjectListError>);
  });
});
