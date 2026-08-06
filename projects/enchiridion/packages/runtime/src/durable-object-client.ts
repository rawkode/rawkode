import { Effect } from "effect";
import { DurableObjectInvocationError } from "./errors";

/** Structural Cloudflare types: deliberately narrow, but assignable from workers-types. */
export interface DurableObjectIdNative {
  readonly toString: () => string;
}

export interface DurableObjectStubNative {
  readonly fetch: (request: Request) => Promise<Response>;
}

export interface DurableObjectNamespaceNative {
  readonly idFromName: (name: string) => DurableObjectIdNative;
  readonly get: (id: DurableObjectIdNative) => DurableObjectStubNative;
}

export type DurableObjectInvocationMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface FixedDurableObjectInvocationConfiguration {
  /** A configuration-owned shard name; request input cannot select a different DO. */
  readonly name: string;
  readonly method: DurableObjectInvocationMethod;
  /** A configuration-owned origin-relative endpoint, with no query or fragment. */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly expectedStatus: number;
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
}

export interface DurableObjectInvocationResponse {
  readonly status: number;
  /** A defensive copy. The platform response buffer is never retained. */
  readonly body: Uint8Array<ArrayBuffer>;
}

export interface FixedDurableObjectClient {
  /** The only native DO invocation exposed to callers. */
  readonly invoke: (
    body: Uint8Array<ArrayBuffer>,
  ) => Effect.Effect<DurableObjectInvocationResponse, DurableObjectInvocationError>;
}

const failure = (reason: DurableObjectInvocationError["reason"]): DurableObjectInvocationError =>
  new DurableObjectInvocationError({ reason });

const copyBytes = (source: Uint8Array): Uint8Array<ArrayBuffer> => {
  const output = new Uint8Array(source.byteLength);
  output.set(source);
  return output;
};

const validHeaderName = (name: string): boolean => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name);

interface FixedConfiguration {
  readonly name: string;
  readonly method: DurableObjectInvocationMethod;
  readonly path: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly expectedStatus: number;
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
}

const canonicalPath = (path: string): boolean => {
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/u.test(path)) return false;
  if (path.includes("//")) return false;
  try {
    const parsed = new URL(path, "https://durable-object.invalid");
    return (
      parsed.origin === "https://durable-object.invalid" &&
      parsed.pathname === path &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
};

/** Exact-decodes configuration before any namespace or Request interaction. */
const snapshotConfiguration = (value: unknown): FixedConfiguration | undefined => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const {
      name,
      method,
      path,
      headers,
      expectedStatus,
      maximumRequestBytes,
      maximumResponseBytes,
    } = source;
    if (
      typeof name !== "string" ||
      typeof method !== "string" ||
      typeof path !== "string" ||
      typeof expectedStatus !== "number" ||
      typeof maximumRequestBytes !== "number" ||
      typeof maximumResponseBytes !== "number" ||
      !Number.isInteger(expectedStatus) ||
      !Number.isSafeInteger(maximumRequestBytes) ||
      !Number.isSafeInteger(maximumResponseBytes) ||
      name.length === 0 ||
      name.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/u.test(name) ||
      !["GET", "POST", "PUT", "DELETE"].includes(method) ||
      !canonicalPath(path) ||
      expectedStatus < 100 ||
      expectedStatus > 599 ||
      maximumRequestBytes < 0 ||
      maximumResponseBytes < 0
    )
      return undefined;
    if (
      headers !== undefined &&
      (typeof headers !== "object" || headers === null || Array.isArray(headers))
    )
      return undefined;
    const headerEntries = headers === undefined ? [] : Object.entries(headers);
    const headerNames = new Set<string>();
    if (headerEntries.length > 16) return undefined;
    const checkedHeaders: Array<[string, string]> = [];
    for (const [headerName, headerValue] of headerEntries) {
      const folded = headerName.toLowerCase();
      if (
        !validHeaderName(headerName) ||
        typeof headerValue !== "string" ||
        headerValue.length > 512 ||
        /[\r\n]/u.test(headerValue) ||
        headerNames.has(folded)
      )
        return undefined;
      headerNames.add(folded);
      checkedHeaders.push([headerName, headerValue]);
    }
    return {
      name,
      method: method as DurableObjectInvocationMethod,
      path,
      headers: checkedHeaders,
      expectedStatus,
      maximumRequestBytes,
      maximumResponseBytes,
    };
  } catch {
    return undefined;
  }
};

interface NativeResponseSnapshot {
  readonly status: number;
  readonly headers: { readonly get: (name: string) => string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

/** Extracts untrusted structural response fields once, with all access guarded. */
const snapshotResponse = (value: unknown): NativeResponseSnapshot | undefined => {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const response = value as {
      readonly status?: unknown;
      readonly headers?: unknown;
      readonly body?: unknown;
    };
    const { status, headers, body } = response;
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      typeof headers !== "object" ||
      headers === null ||
      typeof (headers as { readonly get?: unknown }).get !== "function" ||
      (body !== null &&
        (typeof body !== "object" ||
          typeof (body as { readonly getReader?: unknown }).getReader !== "function"))
    )
      return undefined;
    return {
      status,
      headers: headers as { readonly get: (name: string) => string | null },
      body: body as ReadableStream<Uint8Array> | null,
    };
  } catch {
    return undefined;
  }
};

const contentLengthExceeds = (response: NativeResponseSnapshot, maximumBytes: number): boolean => {
  const raw = response.headers.get("content-length");
  if (raw === null) return false;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) return true;
  const length = Number(raw);
  return !Number.isSafeInteger(length) || length > maximumBytes;
};

/** The ledgered native read. It bounds streamed bytes before returning them. */
const readBoundedResponse = async (
  response: NativeResponseSnapshot,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  if (contentLengthExceeds(response, maximumBytes)) throw failure("response_too_large");
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw failure("response_malformed");
      const copied = copyBytes(next.value);
      if (copied.byteLength > maximumBytes - length) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-size verdict; cleanup causes are not diagnostic data.
        }
        throw failure("response_too_large");
      }
      chunks.push(copied);
      length += copied.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A hostile structural stream cannot replace the primary bounded verdict.
    }
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

/**
 * Builds one fixed-target HTTP client for a Cloudflare Durable Object. Request
 * method, path, headers, expected status, and size caps are construction-time
 * configuration; callers can supply only a bounded byte payload.
 */
export const makeFixedDurableObjectClient = (
  namespace: DurableObjectNamespaceNative,
  configuration: FixedDurableObjectInvocationConfiguration,
): FixedDurableObjectClient => {
  const fixedConfiguration = snapshotConfiguration(configuration);
  return {
    invoke: (body) =>
      Effect.suspend(() => {
        if (fixedConfiguration === undefined || !(body instanceof Uint8Array))
          return Effect.fail(failure("invalid_configuration"));
        const requestBody = Effect.try({
          try: () => copyBytes(body),
          catch: () => failure("invalid_configuration"),
        });
        return requestBody.pipe(
          Effect.filterOrFail(
            (copied) => copied.byteLength <= fixedConfiguration.maximumRequestBytes,
            () => failure("invalid_configuration"),
          ),
          Effect.flatMap((boundedBody) =>
            Effect.try({
              try: () => namespace.idFromName(fixedConfiguration.name),
              catch: () => failure("namespace_failed"),
            }).pipe(
              Effect.flatMap((id) =>
                Effect.try({
                  try: () => namespace.get(id),
                  catch: () => failure("stub_failed"),
                }),
              ),
              Effect.flatMap((stub) =>
                Effect.try({
                  try: () => {
                    const headers = new Headers(
                      fixedConfiguration.headers.map(([name, value]) => [name, value]),
                    );
                    return new Request(`https://durable-object.invalid${fixedConfiguration.path}`, {
                      method: fixedConfiguration.method,
                      headers,
                      body:
                        fixedConfiguration.method === "GET" ||
                        fixedConfiguration.method === "DELETE"
                          ? undefined
                          : boundedBody,
                      redirect: "error",
                    });
                  },
                  catch: () => failure("invalid_configuration"),
                }).pipe(
                  Effect.flatMap((request) =>
                    Effect.tryPromise({
                      try: () => stub.fetch(request),
                      catch: () => failure("stub_failed"),
                    }),
                  ),
                ),
              ),
              Effect.flatMap((response) => {
                const snapshot = snapshotResponse(response);
                if (snapshot === undefined) return Effect.fail(failure("response_malformed"));
                if (snapshot.status !== fixedConfiguration.expectedStatus)
                  return Effect.fail(failure("unexpected_status"));
                return Effect.tryPromise({
                  try: () => readBoundedResponse(snapshot, fixedConfiguration.maximumResponseBytes),
                  catch: (cause) =>
                    cause instanceof DurableObjectInvocationError
                      ? cause
                      : failure("response_malformed"),
                }).pipe(
                  Effect.map((responseBody) => ({ status: snapshot.status, body: responseBody })),
                );
              }),
            ),
          ),
        );
      }),
  };
};
