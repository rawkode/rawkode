import { Effect } from "effect";
import {
  type ImmutableR2NativeBinding,
  type ImmutableR2NativeObject,
  immutableR2Delete,
  immutableR2Get,
  immutableR2Head,
  immutableR2List,
  immutableR2PutIfAbsent,
  immutableR2ReadBytes,
  immutableR2SHA256,
} from "./adapters";
import { ImmutableR2Error } from "./errors";

/** Limits deliberately apply before a body or an unbounded page is exposed to
 * backup/restore code. Lower limits may be injected for a particular vault. */
export interface ImmutableR2Limits {
  readonly maximumKeyBytes: number;
  readonly maximumObjectBytes: number;
  readonly maximumCursorBytes: number;
  readonly maximumListPageSize: number;
}

export const defaultImmutableR2Limits: ImmutableR2Limits = {
  maximumKeyBytes: 1_024,
  maximumObjectBytes: 32 * 1_024 * 1_024,
  maximumCursorBytes: 1_024,
  maximumListPageSize: 1_000,
};

export interface ImmutableR2ObjectMetadata {
  readonly key: string;
  readonly etag: string;
  readonly httpEtag?: string;
  readonly size: number;
  /** R2-provided SHA-256 when the binding exposes it; never caller supplied. */
  readonly sha256Base64?: string;
}

export interface ImmutableR2Read extends ImmutableR2ObjectMetadata {
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface ImmutableR2Page {
  readonly objects: readonly ImmutableR2ObjectMetadata[];
  readonly cursor?: string;
  readonly truncated: boolean;
}

/** Immutable R2 service. There is deliberately no general put, delete-prefix,
 * stream, or unbounded read/list operation in this runtime contract. */
export interface ImmutableR2Boundary {
  readonly putIfAbsent: (
    key: string,
    bytes: Uint8Array,
  ) => Effect.Effect<ImmutableR2ObjectMetadata, ImmutableR2Error>;
  readonly head: (
    key: string,
  ) => Effect.Effect<ImmutableR2ObjectMetadata | undefined, ImmutableR2Error>;
  readonly read: (key: string) => Effect.Effect<ImmutableR2Read, ImmutableR2Error>;
  readonly listExactPrefix: (
    prefix: string,
    options?: { readonly cursor?: string; readonly limit?: number },
  ) => Effect.Effect<ImmutableR2Page, ImmutableR2Error>;
  readonly deleteExact: (key: string) => Effect.Effect<void, ImmutableR2Error>;
}

const bytesLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const validKey = (key: string, limits: ImmutableR2Limits): boolean =>
  key.length > 0 &&
  bytesLength(key) <= limits.maximumKeyBytes &&
  [...key].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  });

const failure = <A>(
  operation: ImmutableR2Error["operation"],
  reason: ImmutableR2Error["reason"],
): Effect.Effect<A, ImmutableR2Error> => Effect.fail(new ImmutableR2Error({ operation, reason }));

const validMetadataString = (value: string, maximumBytes: number): boolean =>
  value.length > 0 &&
  bytesLength(value) <= maximumBytes &&
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  });

const canonicalSHA256 = (value: string): string | undefined => {
  if (value.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) return undefined;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return bytes.byteLength === 32 && btoa(String.fromCharCode(...bytes)) === value
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

const metadata = (
  operation: ImmutableR2Error["operation"],
  object: ImmutableR2NativeObject,
  limits: ImmutableR2Limits,
  expected: {
    readonly key?: string;
    readonly size?: number;
    readonly requireSHA256?: boolean;
  } = {},
): Effect.Effect<ImmutableR2ObjectMetadata, ImmutableR2Error> => {
  const checksum = object.checksums?.sha256;
  const nativeSHA256 =
    checksum === undefined ? undefined : btoa(String.fromCharCode(...new Uint8Array(checksum)));
  const customEntries = Object.entries(object.customMetadata ?? {});
  const customSHA256 =
    object.customMetadata?.sha256 === undefined
      ? undefined
      : canonicalSHA256(object.customMetadata.sha256);
  const sha256Base64 = nativeSHA256 ?? customSHA256;
  if (Number.isSafeInteger(object.size) && object.size > limits.maximumObjectBytes)
    return failure(operation, "too_large");
  if (
    !validKey(object.key, limits) ||
    (expected.key !== undefined && object.key !== expected.key) ||
    !validMetadataString(object.etag, 512) ||
    (object.httpEtag !== undefined && !validMetadataString(object.httpEtag, 512)) ||
    (object.httpEtag !== undefined && object.httpEtag !== `"${object.etag}"`) ||
    (checksum !== undefined && checksum.byteLength !== 32) ||
    customEntries.length > 16 ||
    customEntries.some(
      ([key, value]) => !validMetadataString(key, 128) || !validMetadataString(value, 512),
    ) ||
    (object.customMetadata?.sha256 !== undefined && customSHA256 === undefined) ||
    (nativeSHA256 !== undefined && customSHA256 !== undefined && nativeSHA256 !== customSHA256) ||
    (expected.requireSHA256 === true && sha256Base64 === undefined) ||
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    (expected.size !== undefined && object.size !== expected.size)
  )
    return failure(operation, "metadata_mismatch");
  return Effect.succeed(
    sha256Base64 === undefined
      ? { key: object.key, etag: object.etag, httpEtag: object.httpEtag, size: object.size }
      : {
          key: object.key,
          etag: object.etag,
          httpEtag: object.httpEtag,
          size: object.size,
          sha256Base64,
        },
  );
};

const copy = (source: Uint8Array): Uint8Array<ArrayBuffer> => {
  const output = new Uint8Array(source.byteLength);
  output.set(source);
  return output;
};

const validLimits = (limits: ImmutableR2Limits): boolean =>
  [
    limits.maximumKeyBytes,
    limits.maximumObjectBytes,
    limits.maximumCursorBytes,
    limits.maximumListPageSize,
  ].every((value) => Number.isSafeInteger(value) && value > 0);

export const makeImmutableR2Boundary = (
  binding: ImmutableR2NativeBinding,
  limits: ImmutableR2Limits = defaultImmutableR2Limits,
): ImmutableR2Boundary => {
  const putIfAbsent: ImmutableR2Boundary["putIfAbsent"] = (key, bytes) => {
    if (!validLimits(limits) || !validKey(key, limits))
      return failure<ImmutableR2ObjectMetadata>("put_if_absent", "invalid_key");
    if (bytes.byteLength > limits.maximumObjectBytes)
      return failure<ImmutableR2ObjectMetadata>("put_if_absent", "too_large");
    // Capture at the public boundary, before any Effect may await native I/O.
    // Callers may reuse/mutate their byte buffer as soon as this method returns.
    const submittedBytes = copy(bytes);
    return immutableR2SHA256(submittedBytes).pipe(
      Effect.flatMap((expectedSHA256) =>
        immutableR2PutIfAbsent(binding, key, submittedBytes, expectedSHA256).pipe(
          Effect.flatMap((object) => {
            if (object === null)
              return failure<ImmutableR2ObjectMetadata>("put_if_absent", "already_exists");
            return metadata("put_if_absent", object, limits, {
              key,
              size: submittedBytes.byteLength,
              requireSHA256: true,
            }).pipe(
              Effect.flatMap((returned) =>
                returned.sha256Base64 === btoa(String.fromCharCode(...expectedSHA256))
                  ? Effect.succeed(returned)
                  : failure<ImmutableR2ObjectMetadata>("put_if_absent", "metadata_mismatch"),
              ),
            );
          }),
        ),
      ),
    );
  };

  const head: ImmutableR2Boundary["head"] = (key) => {
    if (!validLimits(limits) || !validKey(key, limits)) return failure("head", "invalid_key");
    return immutableR2Head(binding, key).pipe(
      Effect.flatMap((object) =>
        object === null ? Effect.succeed(undefined) : metadata("head", object, limits, { key }),
      ),
    );
  };

  const read: ImmutableR2Boundary["read"] = (key) => {
    if (!validLimits(limits) || !validKey(key, limits))
      return failure<ImmutableR2Read>("read", "invalid_key");
    return immutableR2Head(binding, key).pipe(
      Effect.flatMap((headObject) => {
        if (headObject === null) return failure<ImmutableR2Read>("read", "not_found");
        return metadata("read", headObject, limits, { key }).pipe(
          Effect.flatMap((headMetadata) => {
            if (headMetadata.size > limits.maximumObjectBytes)
              return failure<ImmutableR2Read>("read", "too_large");
            return immutableR2Get(binding, key, limits.maximumObjectBytes + 1).pipe(
              Effect.flatMap((body) => {
                if (body === null) return failure<ImmutableR2Read>("read", "not_found");
                return metadata("read", body, limits, { key, size: headMetadata.size }).pipe(
                  Effect.flatMap((bodyMetadata) => {
                    if (
                      bodyMetadata.key !== headMetadata.key ||
                      bodyMetadata.etag !== headMetadata.etag ||
                      bodyMetadata.size !== headMetadata.size
                    )
                      return failure<ImmutableR2Read>("read", "metadata_mismatch");
                    if (headMetadata.sha256Base64 !== bodyMetadata.sha256Base64)
                      return failure<ImmutableR2Read>("read", "metadata_mismatch");
                    return immutableR2ReadBytes(body).pipe(
                      Effect.flatMap((bytes) =>
                        bytes.byteLength !== bodyMetadata.size ||
                        bytes.byteLength > limits.maximumObjectBytes
                          ? failure<ImmutableR2Read>("read", "metadata_mismatch")
                          : bodyMetadata.sha256Base64 === undefined
                            ? Effect.succeed<ImmutableR2Read>({ ...bodyMetadata, bytes })
                            : immutableR2SHA256(bytes).pipe(
                                Effect.flatMap((sha256) =>
                                  bodyMetadata.sha256Base64 === btoa(String.fromCharCode(...sha256))
                                    ? Effect.succeed<ImmutableR2Read>({ ...bodyMetadata, bytes })
                                    : failure<ImmutableR2Read>("read", "metadata_mismatch"),
                                ),
                              ),
                      ),
                    );
                  }),
                );
              }),
            );
          }),
        );
      }),
    );
  };

  const listExactPrefix: ImmutableR2Boundary["listExactPrefix"] = (prefix, options = {}) => {
    const limit = options.limit ?? limits.maximumListPageSize;
    if (!validLimits(limits) || !validKey(prefix, limits))
      return failure<ImmutableR2Page>("list", "invalid_prefix");
    if (
      options.cursor !== undefined &&
      (options.cursor.length === 0 || bytesLength(options.cursor) > limits.maximumCursorBytes)
    )
      return failure<ImmutableR2Page>("list", "invalid_cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maximumListPageSize)
      return failure<ImmutableR2Page>("list", "invalid_limit");
    return immutableR2List(binding, prefix, options.cursor, limit).pipe(
      Effect.flatMap((page) => {
        if (
          page.objects.length > limit ||
          (page.cursor !== undefined &&
            (page.cursor.length === 0 || bytesLength(page.cursor) > limits.maximumCursorBytes)) ||
          (!page.truncated && page.cursor !== undefined) ||
          (page.truncated && page.cursor === undefined)
        )
          return failure<ImmutableR2Page>("list", "metadata_mismatch");
        return Effect.all(page.objects.map((object) => metadata("list", object, limits))).pipe(
          Effect.flatMap((objects) =>
            objects.every((object) => object.key.startsWith(prefix))
              ? Effect.succeed<ImmutableR2Page>({
                  objects,
                  cursor: page.cursor,
                  truncated: page.truncated,
                })
              : failure<ImmutableR2Page>("list", "metadata_mismatch"),
          ),
        );
      }),
    );
  };

  const deleteExact: ImmutableR2Boundary["deleteExact"] = (key) => {
    if (!validLimits(limits) || !validKey(key, limits)) return failure("delete", "invalid_key");
    return immutableR2Delete(binding, key);
  };

  return { putIfAbsent, head, read, listExactPrefix, deleteExact };
};
