import { Effect } from "effect";
import { RequestBodyError } from "./errors";

export interface BoundedRequestBodyConfiguration {
  readonly maximumBytes: number;
  readonly requiredContentType?: string;
  readonly requireContentLength?: boolean;
}

interface FixedConfiguration {
  readonly maximumBytes: number;
  readonly requiredContentType: string | undefined;
  readonly requireContentLength: boolean;
}

interface RequestSnapshot {
  readonly method: string;
  readonly bodyUsed: boolean;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: { readonly get: (name: string) => string | null };
}

const failure = (reason: RequestBodyError["reason"]): RequestBodyError =>
  new RequestBodyError({ reason });

const copyBytes = (source: Uint8Array): Uint8Array<ArrayBuffer> => {
  const output = new Uint8Array(source.byteLength);
  output.set(source);
  return output;
};

const snapshotConfiguration = (value: unknown): FixedConfiguration | undefined => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const { maximumBytes, requiredContentType, requireContentLength } = source;
    if (
      typeof maximumBytes !== "number" ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 0 ||
      (requiredContentType !== undefined &&
        (typeof requiredContentType !== "string" ||
          requiredContentType.length === 0 ||
          requiredContentType.length > 128 ||
          !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(requiredContentType))) ||
      (requireContentLength !== undefined && typeof requireContentLength !== "boolean")
    )
      return undefined;
    return {
      maximumBytes,
      requiredContentType,
      requireContentLength: requireContentLength === true,
    };
  } catch {
    return undefined;
  }
};

const snapshotRequest = (value: unknown): RequestSnapshot | undefined => {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const request = value as {
      readonly method?: unknown;
      readonly bodyUsed?: unknown;
      readonly body?: unknown;
      readonly headers?: unknown;
    };
    const { method, bodyUsed, body, headers } = request;
    if (
      typeof method !== "string" ||
      !/^[A-Z]+$/u.test(method) ||
      typeof bodyUsed !== "boolean" ||
      typeof headers !== "object" ||
      headers === null ||
      typeof (headers as { readonly get?: unknown }).get !== "function" ||
      (body !== null &&
        (typeof body !== "object" ||
          typeof (body as { readonly getReader?: unknown }).getReader !== "function"))
    )
      return undefined;
    return {
      method,
      bodyUsed,
      body: body as ReadableStream<Uint8Array> | null,
      headers: headers as { readonly get: (name: string) => string | null },
    };
  } catch {
    return undefined;
  }
};

const contentLength = (
  headers: RequestSnapshot["headers"],
  required: boolean,
): Effect.Effect<number | undefined, RequestBodyError> =>
  Effect.try({
    try: (): unknown => headers.get("content-length"),
    catch: () => failure("request_malformed"),
  }).pipe(
    Effect.flatMap((raw) => {
      if (raw === null)
        return required
          ? Effect.fail(failure("content_length_required"))
          : Effect.succeed(undefined);
      if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(raw))
        return Effect.fail(failure("content_length_invalid"));
      const parsed = Number(raw);
      return Number.isSafeInteger(parsed)
        ? Effect.succeed(parsed)
        : Effect.fail(failure("content_length_invalid"));
    }),
  );

/** Ledgered native stream read; all chunks are copied and bounded before return. */
const readBounded = async (
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  declaredLength: number | undefined,
): Promise<Uint8Array<ArrayBuffer>> => {
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw failure("request_malformed");
      const copied = copyBytes(next.value);
      if (copied.byteLength > maximumBytes - length) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the primary bounded verdict and discard cleanup causes.
        }
        throw failure("body_too_large");
      }
      chunks.push(copied);
      length += copied.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A hostile structural stream cannot replace a closed outcome.
    }
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (declaredLength !== undefined && length !== declaredLength)
    throw failure("content_length_mismatch");
  return output;
};

/**
 * Claims one inbound Request body and returns an owned bounded byte copy.
 * The returned Effect is intentionally single-claim: re-running the same
 * value cannot re-read a Request stream, including under concurrent execution.
 */
export const readBoundedRequestBody = (
  request: Request,
  configuration: BoundedRequestBodyConfiguration,
): Effect.Effect<Uint8Array<ArrayBuffer>, RequestBodyError> => {
  const fixed = snapshotConfiguration(configuration);
  let claimed = false;
  return Effect.suspend(() => {
    if (fixed === undefined) return Effect.fail(failure("invalid_configuration"));
    if (claimed) return Effect.fail(failure("body_already_claimed"));
    claimed = true;
    const snapshot = snapshotRequest(request);
    if (snapshot === undefined) return Effect.fail(failure("request_malformed"));
    if (snapshot.bodyUsed || snapshot.body === null)
      return Effect.fail(failure("body_unavailable"));
    return contentLength(snapshot.headers, fixed.requireContentLength).pipe(
      Effect.flatMap((declaredLength) => {
        if (declaredLength !== undefined && declaredLength > fixed.maximumBytes)
          return Effect.fail(failure("body_too_large"));
        if (fixed.requiredContentType === undefined) return Effect.succeed(declaredLength);
        return Effect.try({
          try: () => snapshot.headers.get("content-type"),
          catch: () => failure("request_malformed"),
        }).pipe(
          Effect.flatMap((actual) =>
            actual === fixed.requiredContentType
              ? Effect.succeed(declaredLength)
              : Effect.fail(failure("content_type_invalid")),
          ),
        );
      }),
      Effect.flatMap((declaredLength) =>
        Effect.tryPromise({
          try: () =>
            readBounded(
              snapshot.body as ReadableStream<Uint8Array>,
              fixed.maximumBytes,
              declaredLength,
            ),
          catch: (cause) =>
            cause instanceof RequestBodyError ? cause : failure("request_malformed"),
        }),
      ),
    );
  });
};
