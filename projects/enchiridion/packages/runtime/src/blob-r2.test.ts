import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import type { ImmutableR2NativeBinding } from "./adapters";
import {
  type BlobR2NativeBinding,
  type BlobR2NativeBindingInput,
  defaultBlobR2Limits,
  makeBlobR2Boundary,
  makeBlobR2NativeBinding,
} from "./blob-r2";

const assertBlobR2AuthorityIsNominal = (
  backupImmutableAuthority: ImmutableR2NativeBinding,
): void => {
  // @ts-expect-error Blob authority requires its own nominal adoption boundary.
  const nonassignableBlobAuthority: BlobR2NativeBinding = backupImmutableAuthority;
  void nonassignableBlobAuthority;
};
void assertBlobR2AuthorityIsNominal;

const copy = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const result = new Uint8Array(bytes.byteLength);
  result.set(bytes);
  return result;
};

const binding = (): {
  readonly native: BlobR2NativeBindingInput;
  readonly objects: Map<string, Uint8Array<ArrayBuffer>>;
} => {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const object = async (
    key: string,
    bytes: Uint8Array,
  ): Promise<{
    readonly key: string;
    readonly etag: string;
    readonly httpEtag: string;
    readonly size: number;
    readonly checksums: { readonly sha256: ArrayBuffer };
  }> => ({
    key,
    etag: `etag-${key}`,
    httpEtag: `"etag-${key}"`,
    size: bytes.byteLength,
    checksums: { sha256: await crypto.subtle.digest("SHA-256", copy(bytes)) },
  });
  return {
    objects,
    native: {
      head: async (key) => {
        const bytes = objects.get(key);
        return bytes === undefined ? null : object(key, bytes);
      },
      get: async (key) => {
        const bytes = objects.get(key);
        return bytes === undefined
          ? null
          : {
              ...(await object(key, bytes)),
              arrayBuffer: async () => copy(bytes).buffer,
            };
      },
      put: async (key, bytes) => {
        if (objects.has(key)) return null;
        objects.set(key, copy(bytes));
        return object(key, bytes);
      },
      delete: async (key) => {
        objects.delete(key);
      },
    },
  };
};

describe("Blob R2 boundary", () => {
  test("conditionally creates, snapshots caller bytes, exact-reads and exact-deletes", async () => {
    const source = binding();
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const native: BlobR2NativeBindingInput = {
      ...source.native,
      put: async (key, bytes, options) => {
        entered();
        await releasePromise;
        return source.native.put(key, bytes, options);
      },
    };
    const r2 = makeBlobR2Boundary(makeBlobR2NativeBinding(native));
    const bytes = new Uint8Array([1, 2, 3]);
    const writing = Effect.runPromise(r2.putIfAbsent("blob/one", bytes));
    await enteredPromise;
    bytes.fill(9);
    release();
    await writing;
    expect(source.objects.get("blob/one")).toEqual(new Uint8Array([1, 2, 3]));
    await expect(Effect.runPromise(r2.read("blob/one"))).resolves.toMatchObject({
      key: "blob/one",
      bytes: new Uint8Array([1, 2, 3]),
    });
    await Effect.runPromise(r2.deleteExact("blob/one"));
    expect(await Effect.runPromise(r2.head("blob/one"))).toBeUndefined();
  });

  test("rejects collisions, hostile metadata and oversize bodies without exposing native details", async () => {
    const source = binding();
    const r2 = makeBlobR2Boundary(makeBlobR2NativeBinding(source.native), {
      ...defaultBlobR2Limits,
      maximumObjectBytes: 2,
    });
    await Effect.runPromise(r2.putIfAbsent("blob/one", new Uint8Array([1])));
    const collision = await Effect.runPromiseExit(r2.putIfAbsent("blob/one", new Uint8Array([2])));
    const tooLarge = await Effect.runPromiseExit(
      r2.putIfAbsent("blob/two", new Uint8Array([1, 2, 3])),
    );
    expect(Exit.isFailure(collision)).toBe(true);
    expect(JSON.stringify(collision)).toContain("already_exists");
    expect(JSON.stringify(tooLarge)).toContain("too_large");
    const hostile: BlobR2NativeBindingInput = {
      ...source.native,
      head: async () => ({ key: "other", etag: "leak", size: 1 }),
    };
    const exit = await Effect.runPromiseExit(
      makeBlobR2Boundary(makeBlobR2NativeBinding(hostile)).head("blob/one"),
    );
    expect(JSON.stringify(exit)).toContain("metadata_mismatch");
    expect(JSON.stringify(exit)).not.toContain("other");
  });

  test("requires bounded, canonical checksums before read bytes are copied", async () => {
    const source = binding();
    const missingChecksum: BlobR2NativeBindingInput = {
      ...source.native,
      head: async (key) => ({ key, etag: "etag", size: 1 }),
    };
    const missing = await Effect.runPromiseExit(
      makeBlobR2Boundary(makeBlobR2NativeBinding(missingChecksum)).head("blob/one"),
    );
    expect(JSON.stringify(missing)).toContain("metadata_mismatch");

    const oversizedChecksum: BlobR2NativeBindingInput = {
      ...source.native,
      head: async (key) => ({
        key,
        etag: "etag",
        size: 1,
        checksums: { sha256: new ArrayBuffer(33) },
      }),
    };
    const oversized = await Effect.runPromiseExit(
      makeBlobR2Boundary(makeBlobR2NativeBinding(oversizedChecksum)).head("blob/one"),
    );
    expect(JSON.stringify(oversized)).toContain("metadata_mismatch");

    const hostileGetter: BlobR2NativeBindingInput = {
      ...source.native,
      head: async () => ({
        get key(): string {
          throw new Error("native-secret");
        },
        etag: "etag",
        size: 1,
      }),
    };
    const hostile = await Effect.runPromiseExit(
      makeBlobR2Boundary(makeBlobR2NativeBinding(hostileGetter)).head("blob/one"),
    );
    expect(JSON.stringify(hostile)).toContain("metadata_mismatch");
    expect(JSON.stringify(hostile)).not.toContain("native-secret");
  });
});
