import { Effect } from "effect";
import {
  type BlobR2NativeBinding,
  type BlobR2NativeObject,
  blobR2Delete,
  blobR2Get,
  blobR2Head,
  blobR2ObjectSnapshot,
  blobR2PutIfAbsent,
  blobR2ReadBytes,
  blobR2SHA256,
} from "./adapters";
import { BlobR2Error } from "./errors";

export interface BlobR2Limits {
  readonly maximumKeyBytes: number;
  readonly maximumObjectBytes: number;
}

export const defaultBlobR2Limits: BlobR2Limits = {
  maximumKeyBytes: 1_024,
  maximumObjectBytes: 32 * 1_024 * 1_024,
};

export {
  makeBlobR2NativeBinding,
  type BlobR2NativeBinding,
  type BlobR2NativeBindingInput,
  type BlobR2NativeObject,
} from "./adapters";

export interface BlobR2ObjectMetadata {
  readonly key: string;
  readonly etag: string;
  readonly httpEtag?: string;
  readonly size: number;
  readonly sha256Base64: string;
}

export interface BlobR2Read extends BlobR2ObjectMetadata {
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** Blob storage authority: conditional create, exact inspection/read/delete only. */
export interface BlobR2Boundary {
  readonly putIfAbsent: (
    key: string,
    bytes: Uint8Array,
  ) => Effect.Effect<BlobR2ObjectMetadata, BlobR2Error>;
  readonly head: (key: string) => Effect.Effect<BlobR2ObjectMetadata | undefined, BlobR2Error>;
  readonly read: (key: string) => Effect.Effect<BlobR2Read, BlobR2Error>;
  readonly deleteExact: (key: string) => Effect.Effect<void, BlobR2Error>;
}

const utf8 = new TextEncoder();
const bytesLength = (value: string): number => utf8.encode(value).byteLength;
const copy = (source: Uint8Array): Uint8Array<ArrayBuffer> => {
  const output = new Uint8Array(source.byteLength);
  output.set(source);
  return output;
};
const base64 = (value: Uint8Array): string => btoa(String.fromCharCode(...value));
const validText = (value: string, maximumBytes: number): boolean =>
  value.length > 0 &&
  bytesLength(value) <= maximumBytes &&
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  });
const validKey = (key: string, limits: BlobR2Limits): boolean =>
  validText(key, limits.maximumKeyBytes);
const validLimits = (limits: BlobR2Limits): boolean =>
  Number.isSafeInteger(limits.maximumKeyBytes) &&
  limits.maximumKeyBytes > 0 &&
  Number.isSafeInteger(limits.maximumObjectBytes) &&
  limits.maximumObjectBytes > 0 &&
  limits.maximumObjectBytes < Number.MAX_SAFE_INTEGER;
const fail = <A>(
  operation: BlobR2Error["operation"],
  reason: BlobR2Error["reason"],
): Effect.Effect<A, BlobR2Error> => Effect.fail(new BlobR2Error({ operation, reason }));
const canonicalSHA256 = (value: string): string | undefined => {
  if (value.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) return undefined;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return bytes.byteLength === 32 && base64(bytes) === value ? value : undefined;
  } catch {
    return undefined;
  }
};
const metadata = (
  operation: BlobR2Error["operation"],
  object: BlobR2NativeObject,
  limits: BlobR2Limits,
  expected: {
    readonly key?: string;
    readonly size?: number;
  } = {},
): Effect.Effect<BlobR2ObjectMetadata, BlobR2Error> => {
  const checksum = object.checksums?.sha256;
  const invalidNativeSHA256 = checksum !== undefined && checksum.byteLength !== 32;
  const nativeSHA256 =
    checksum === undefined || invalidNativeSHA256 ? undefined : base64(new Uint8Array(checksum));
  const customSHA256 =
    object.customMetadata?.sha256 === undefined
      ? undefined
      : canonicalSHA256(object.customMetadata.sha256);
  const sha256Base64 = nativeSHA256 ?? customSHA256;
  const customEntries = Object.entries(object.customMetadata ?? {});
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    object.size > limits.maximumObjectBytes ||
    !validKey(object.key, limits) ||
    (expected.key !== undefined && object.key !== expected.key) ||
    !validText(object.etag, 512) ||
    (object.httpEtag !== undefined &&
      (!validText(object.httpEtag, 512) || object.httpEtag !== `"${object.etag}"`)) ||
    invalidNativeSHA256 ||
    customEntries.length > 16 ||
    customEntries.some(([key, value]) => !validText(key, 128) || !validText(value, 512)) ||
    (object.customMetadata?.sha256 !== undefined && customSHA256 === undefined) ||
    (nativeSHA256 !== undefined && customSHA256 !== undefined && nativeSHA256 !== customSHA256) ||
    sha256Base64 === undefined ||
    (expected.size !== undefined && object.size !== expected.size)
  )
    return fail(
      operation,
      object.size > limits.maximumObjectBytes ? "too_large" : "metadata_mismatch",
    );
  return Effect.succeed({
    key: object.key,
    etag: object.etag,
    httpEtag: object.httpEtag,
    size: object.size,
    sha256Base64,
  });
};

const safeMetadata = (
  operation: BlobR2Error["operation"],
  object: BlobR2NativeObject,
  limits: BlobR2Limits,
  expected: { readonly key?: string; readonly size?: number } = {},
): Effect.Effect<BlobR2ObjectMetadata, BlobR2Error> =>
  blobR2ObjectSnapshot(operation, object).pipe(
    Effect.flatMap((snapshot) => metadata(operation, snapshot, limits, expected)),
  );

export const makeBlobR2Boundary = (
  binding: BlobR2NativeBinding,
  limits: BlobR2Limits = defaultBlobR2Limits,
): BlobR2Boundary => {
  const configuredLimits: BlobR2Limits = {
    maximumKeyBytes: limits.maximumKeyBytes,
    maximumObjectBytes: limits.maximumObjectBytes,
  };
  const valid = (): boolean => validLimits(configuredLimits);
  return {
    putIfAbsent: (key, bytes) => {
      if (!valid() || !validKey(key, configuredLimits))
        return fail<BlobR2ObjectMetadata>("put_if_absent", "invalid_key");
      if (bytes.byteLength > configuredLimits.maximumObjectBytes)
        return fail<BlobR2ObjectMetadata>("put_if_absent", "too_large");
      const body = copy(bytes);
      return blobR2SHA256("put_if_absent", body).pipe(
        Effect.flatMap((digest) => {
          const checksum = copy(digest);
          return blobR2PutIfAbsent(binding, key, body, checksum).pipe(
            Effect.flatMap((object) => {
              if (object === null)
                return fail<BlobR2ObjectMetadata>("put_if_absent", "already_exists");
              return safeMetadata("put_if_absent", object, configuredLimits, {
                key,
                size: body.byteLength,
              }).pipe(
                Effect.flatMap((result) =>
                  result.sha256Base64 === base64(checksum)
                    ? Effect.succeed(result)
                    : fail<BlobR2ObjectMetadata>("put_if_absent", "metadata_mismatch"),
                ),
              );
            }),
          );
        }),
      );
    },
    head: (key) => {
      if (!valid() || !validKey(key, configuredLimits)) return fail("head", "invalid_key");
      return blobR2Head(binding, key).pipe(
        Effect.flatMap((object) =>
          object === null
            ? Effect.succeed(undefined)
            : safeMetadata("head", object, configuredLimits, { key }),
        ),
      );
    },
    read: (key) => {
      if (!valid() || !validKey(key, configuredLimits))
        return fail<BlobR2Read>("read", "invalid_key");
      return blobR2Head(binding, key).pipe(
        Effect.flatMap((head) => {
          if (head === null) return fail<BlobR2Read>("read", "not_found");
          return safeMetadata("read", head, configuredLimits, { key }).pipe(
            Effect.flatMap((headMetadata) =>
              blobR2Get(binding, key, configuredLimits.maximumObjectBytes + 1).pipe(
                Effect.flatMap((object) => {
                  if (object === null) return fail<BlobR2Read>("read", "not_found");
                  return safeMetadata("read", object, configuredLimits, {
                    key,
                    size: headMetadata.size,
                  }).pipe(
                    Effect.flatMap((bodyMetadata) => {
                      if (
                        bodyMetadata.etag !== headMetadata.etag ||
                        bodyMetadata.httpEtag !== headMetadata.httpEtag ||
                        bodyMetadata.sha256Base64 !== headMetadata.sha256Base64
                      )
                        return fail<BlobR2Read>("read", "metadata_mismatch");
                      return blobR2ReadBytes(object, configuredLimits.maximumObjectBytes).pipe(
                        Effect.flatMap((bytes) => {
                          if (
                            bytes.byteLength !== bodyMetadata.size ||
                            bytes.byteLength > configuredLimits.maximumObjectBytes
                          )
                            return fail<BlobR2Read>("read", "metadata_mismatch");
                          return blobR2SHA256("read", bytes).pipe(
                            Effect.flatMap((digest) =>
                              base64(digest) === bodyMetadata.sha256Base64
                                ? Effect.succeed({ ...bodyMetadata, bytes })
                                : fail<BlobR2Read>("read", "metadata_mismatch"),
                            ),
                          );
                        }),
                      );
                    }),
                  );
                }),
              ),
            ),
          );
        }),
      );
    },
    deleteExact: (key) => {
      if (!valid() || !validKey(key, configuredLimits)) return fail("delete", "invalid_key");
      return blobR2Delete(binding, key);
    },
  };
};
