import { Effect, Redacted } from "effect";
import {
  AdapterContractError,
  ExternalServiceError,
  RuntimeOperation,
  type RuntimeOperationIdentifier,
} from "./errors";

/**
 * The complete audited set of escape hatches from Effect to Cloudflare/unknown
 * values. Add an entry and a focused test before adding an adapter. Runtime and
 * worker modules may not call Promise APIs directly outside these functions.
 */
export const cloudflareAdapterLedger = [
  {
    id: "cloudflare-promise",
    boundary: "Cloudflare binding and Web Platform asynchronous APIs",
    owner: "@enchiridion/runtime",
    audit:
      "Rejected Promises discard their cause; a caller-supplied classifier alone may make them retryable.",
  },
  {
    id: "unknown-record",
    boundary: "JSON or Cloudflare unknown values before structural validation",
    owner: "@enchiridion/runtime",
    audit:
      "No unchecked cast or unknown value crosses this adapter; callers validate required fields.",
  },
  {
    id: "capability-hmac",
    boundary: "Web Crypto HMAC import/sign/verify for internal capabilities",
    owner: "@enchiridion/runtime",
    audit:
      "Redacted key material enters Web Crypto only; failures become a closed typed error upstream.",
  },
  {
    id: "worker-outer-boundary",
    boundary: "Effect worker handler completion to the Cloudflare Promise fetch contract",
    owner: "@enchiridion/runtime",
    audit:
      "Only a fixed safe 500 response crosses an untyped defect; no cause or request data is serialized.",
  },
] as const;

export type CloudflareAdapterID = (typeof cloudflareAdapterLedger)[number]["id"];

export interface PromiseRejectionClassification {
  readonly retryable: boolean;
}

export type PromiseRejectionClassifier = (cause: unknown) => PromiseRejectionClassification;

export const nonRetryableRejection: PromiseRejectionClassifier = () => ({ retryable: false });

/** The only Promise-to-Effect conversion allowed in application code. */
export const fromCloudflarePromise = <A>(
  operation: RuntimeOperationIdentifier,
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
  classifyRejection: PromiseRejectionClassifier = nonRetryableRejection,
): Effect.Effect<A, ExternalServiceError> =>
  Effect.tryPromise({
    try: (signal) => evaluate(signal),
    catch: (cause) =>
      new ExternalServiceError({ operation, retryable: classifyRejection(cause).retryable }),
  });

/** Narrows a JSON/Cloudflare unknown value to an object without an unchecked cast. */
export const unknownRecord = (
  adapter: "unknown-record",
  value: unknown,
): Effect.Effect<Record<string, unknown>, AdapterContractError> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Effect.fail(new AdapterContractError({ adapter, reason: "not_record" }));
  }
  return Effect.succeed(Object.fromEntries(Object.entries(value)));
};

const encodeText = (value: string): Uint8Array<ArrayBuffer> => {
  const source = new TextEncoder().encode(value);
  const output = new Uint8Array(source.byteLength);
  output.set(source);
  return output;
};

/** Audited Web Crypto HMAC seam for compact internal capability tokens. */
export const signCapabilityHmac = (
  secret: Redacted.Redacted,
  payload: string,
): Effect.Effect<Uint8Array<ArrayBuffer>, ExternalServiceError> =>
  fromCloudflarePromise(RuntimeOperation.CapabilityCrypto, async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      encodeText(Redacted.value(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, encodeText(payload));
    const output = new Uint8Array(signed.byteLength);
    output.set(new Uint8Array(signed));
    return output;
  });

/** Audited Web Crypto verification seam; verification is constant-time in the platform. */
export const verifyCapabilityHmac = (
  secret: Redacted.Redacted,
  payload: string,
  signature: Uint8Array<ArrayBuffer>,
): Effect.Effect<boolean, ExternalServiceError> =>
  fromCloudflarePromise(RuntimeOperation.CapabilityCrypto, async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      encodeText(Redacted.value(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify("HMAC", key, signature, encodeText(payload));
  });

export interface WorkerBoundaryContext {
  readonly waitUntil?: (work: Promise<unknown>) => void;
}

export interface WorkerBoundary {
  readonly handle: (
    request: Request,
    environment: unknown,
    context: WorkerBoundaryContext,
  ) => Promise<Response>;
}

/** The one audited Worker outer boundary. Keep all request handling in Effect. */
export const makeWorkerBoundary = (
  handler: (request: Request, environment: unknown) => Effect.Effect<Response>,
): WorkerBoundary => ({
  handle: (request, environment, _context) =>
    Effect.runPromise(
      handler(request, environment).pipe(
        Effect.catchAllCause(() =>
          Effect.succeed(new Response(null, { status: 500, statusText: "Internal Server Error" })),
        ),
      ),
    ),
});
