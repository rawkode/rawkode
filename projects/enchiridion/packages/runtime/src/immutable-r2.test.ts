import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
  type ImmutableR2NativeBinding,
  type ImmutableR2NativeObject,
  defaultImmutableR2Limits,
  makeImmutableR2Boundary,
} from "./index";

interface Stored {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly etag: string;
  readonly checksum?: ArrayBuffer;
}

const copy = (source: Uint8Array): Uint8Array<ArrayBuffer> => {
  const output = new Uint8Array(source.byteLength);
  output.set(source);
  return output;
};

const makeBinding = (): {
  readonly binding: ImmutableR2NativeBinding;
  readonly stored: Map<string, Stored>;
  readonly conditionalWrites: readonly boolean[];
  readonly requestedSHA256: readonly Uint8Array<ArrayBuffer>[];
} => {
  const stored = new Map<string, Stored>();
  const conditionalWrites: boolean[] = [];
  const requestedSHA256: Uint8Array<ArrayBuffer>[] = [];
  const object = (key: string, value: Stored): ImmutableR2NativeObject => ({
    key,
    etag: value.etag,
    httpEtag: `"${value.etag}"`,
    size: value.bytes.byteLength,
    checksums: value.checksum === undefined ? undefined : { sha256: value.checksum },
  });
  return {
    binding: {
      head: async (key) => {
        const value = stored.get(key);
        return value === undefined ? null : object(key, value);
      },
      get: async (key) => {
        const value = stored.get(key);
        return value === undefined
          ? null
          : {
              ...object(key, value),
              arrayBuffer: async () => copy(value.bytes).buffer,
            };
      },
      put: async (key, bytes, options) => {
        conditionalWrites.push(options.onlyIf.etagDoesNotMatch === "*");
        requestedSHA256.push(copy(new Uint8Array(options.sha256)));
        if (stored.has(key)) return null;
        const checksum = await crypto.subtle.digest("SHA-256", bytes);
        const value = { bytes: copy(bytes), etag: `etag-${stored.size + 1}`, checksum };
        stored.set(key, value);
        return object(key, value);
      },
      list: async ({ prefix, cursor, limit }) => {
        const keys = [...stored.keys()].filter((key) => key.startsWith(prefix)).sort();
        const offset = cursor === undefined ? 0 : Number(cursor);
        const selected = keys.slice(offset, offset + limit);
        const next = offset + selected.length;
        return {
          objects: selected.flatMap((key) => {
            const value = stored.get(key);
            return value === undefined ? [] : [object(key, value)];
          }),
          truncated: next < keys.length,
          cursor: next < keys.length ? String(next) : undefined,
        };
      },
      delete: async (key) => {
        stored.delete(key);
      },
    },
    stored,
    conditionalWrites,
    requestedSHA256,
  };
};

describe("immutable R2 boundary", () => {
  test("uses only a conditional no-overwrite write and reports collisions without replacing bytes", async () => {
    const native = makeBinding();
    const r2 = makeImmutableR2Boundary(native.binding, {
      ...defaultImmutableR2Limits,
      maximumObjectBytes: 8,
    });
    await Effect.runPromise(r2.putIfAbsent("backups/one", new Uint8Array([1, 2, 3])));
    const collision = await Effect.runPromiseExit(
      r2.putIfAbsent("backups/one", new Uint8Array([9])),
    );
    expect(Exit.isFailure(collision)).toBe(true);
    expect(JSON.stringify(collision)).toContain("already_exists");
    expect(native.stored.get("backups/one")?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(native.conditionalWrites).toEqual([true, true]);
    expect(native.requestedSHA256).toHaveLength(2);
    const firstRequestedSHA256 = native.requestedSHA256[0];
    if (firstRequestedSHA256 === undefined) throw new Error("expected R2 SHA-256 request");
    await expect(crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3]))).resolves.toEqual(
      firstRequestedSHA256.buffer,
    );
  });

  test("snapshots caller bytes before native await and validates R2's requested checksum", async () => {
    const native = makeBinding();
    let enteredPut: (() => void) | undefined;
    let releasePut: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredPut = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const delayed: ImmutableR2NativeBinding = {
      ...native.binding,
      put: async (key, bytes, options) => {
        enteredPut?.();
        await release;
        return native.binding.put(key, bytes, options);
      },
    };
    const r2 = makeImmutableR2Boundary(delayed);
    const callerBytes = new Uint8Array([1, 2, 3]);
    const writing = Effect.runPromise(r2.putIfAbsent("backups/snapshot", callerBytes));
    await entered;
    callerBytes.fill(9);
    releasePut?.();
    await writing;

    expect(native.stored.get("backups/snapshot")?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    const expected = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3])),
    );
    expect(native.requestedSHA256[0]).toEqual(expected);
  });

  test("bounds reads before body access and returns exact object metadata", async () => {
    const native = makeBinding();
    native.stored.set("backups/large", {
      bytes: new Uint8Array(9),
      etag: "etag-large",
    });
    native.stored.set("backups/small", {
      bytes: new Uint8Array([4, 5]),
      etag: "etag-small",
    });
    const r2 = makeImmutableR2Boundary(native.binding, {
      ...defaultImmutableR2Limits,
      maximumObjectBytes: 8,
    });
    const tooLarge = await Effect.runPromiseExit(r2.read("backups/large"));
    expect(Exit.isFailure(tooLarge)).toBe(true);
    expect(JSON.stringify(tooLarge)).toContain("too_large");
    await expect(Effect.runPromise(r2.read("backups/small"))).resolves.toEqual({
      key: "backups/small",
      etag: "etag-small",
      httpEtag: '"etag-small"',
      size: 2,
      bytes: new Uint8Array([4, 5]),
    });
  });

  test("requires nonempty exact prefixes and rejects a native list result outside that prefix", async () => {
    const native = makeBinding();
    native.stored.set("backups/a", { bytes: new Uint8Array([1]), etag: "a" });
    const r2 = makeImmutableR2Boundary(native.binding);
    const emptyPrefix = await Effect.runPromiseExit(r2.listExactPrefix(""));
    expect(Exit.isFailure(emptyPrefix)).toBe(true);
    expect(JSON.stringify(emptyPrefix)).toContain("invalid_prefix");

    const escaping: ImmutableR2NativeBinding = {
      ...native.binding,
      list: async () => ({
        objects: [{ key: "other/a", etag: "other", size: 1 }],
        truncated: false,
      }),
    };
    const escaped = await Effect.runPromiseExit(
      makeImmutableR2Boundary(escaping).listExactPrefix("backups/"),
    );
    expect(Exit.isFailure(escaped)).toBe(true);
    expect(JSON.stringify(escaped)).toContain("metadata_mismatch");
  });

  test("rejects substituted put/head metadata and a digest or truncated-body mismatch", async () => {
    const native = makeBinding();
    const submitted = new Uint8Array([7, 8, 9]);
    const substitution: ImmutableR2NativeBinding = {
      ...native.binding,
      put: async (key, bytes, options) => {
        await native.binding.put(key, bytes, options);
        return {
          key: "backups/substituted",
          etag: "different",
          size: bytes.byteLength,
          checksums: { sha256: await crypto.subtle.digest("SHA-256", bytes) },
        };
      },
    };
    const putExit = await Effect.runPromiseExit(
      makeImmutableR2Boundary(substitution).putIfAbsent("backups/expected", submitted),
    );
    expect(Exit.isFailure(putExit)).toBe(true);
    expect(JSON.stringify(putExit)).toContain("metadata_mismatch");

    const valid = makeBinding();
    await Effect.runPromise(
      makeImmutableR2Boundary(valid.binding).putIfAbsent("backups/read", submitted),
    );
    const substitutedHead: ImmutableR2NativeBinding = {
      ...valid.binding,
      head: async () => ({ key: "backups/other", etag: "other", size: 3 }),
    };
    const headExit = await Effect.runPromiseExit(
      makeImmutableR2Boundary(substitutedHead).head("backups/read"),
    );
    expect(Exit.isFailure(headExit)).toBe(true);
    expect(JSON.stringify(headExit)).toContain("metadata_mismatch");

    const stored = valid.stored.get("backups/read");
    if (stored === undefined) throw new Error("expected stored object");
    valid.stored.set("backups/read", {
      ...stored,
      checksum: new ArrayBuffer(32),
    });
    const digestExit = await Effect.runPromiseExit(
      makeImmutableR2Boundary(valid.binding).read("backups/read"),
    );
    expect(Exit.isFailure(digestExit)).toBe(true);
    expect(JSON.stringify(digestExit)).toContain("metadata_mismatch");

    const truncated: ImmutableR2NativeBinding = {
      ...valid.binding,
      get: async (key, options) => {
        const object = await valid.binding.get(key, options);
        if (object === null) return null;
        return { ...object, arrayBuffer: async () => new Uint8Array([7, 8]).buffer };
      },
    };
    const truncatedExit = await Effect.runPromiseExit(
      makeImmutableR2Boundary(truncated).read("backups/read"),
    );
    expect(Exit.isFailure(truncatedExit)).toBe(true);
    expect(JSON.stringify(truncatedExit)).toContain("metadata_mismatch");
  });
});
