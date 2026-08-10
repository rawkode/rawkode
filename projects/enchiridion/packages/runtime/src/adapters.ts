import { Effect, Either, Redacted, Schema } from "effect";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type {
  AccessJwksSession,
  AccessJwksSessionConfiguration,
  AccessJwtVerificationRequest,
  VerifiedAccessJwt,
} from "./access-jwt";
import {
  AccessJwtVerificationError,
  AdapterContractError,
  BlobR2Error,
  DurableObjectBoundaryError,
  ExternalServiceError,
  ImmutableR2Error,
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
    id: "p256-webcrypto",
    boundary: "Web Crypto P-256 SPKI import, ECDSA P1363 verification, and random bytes",
    owner: "@enchiridion/runtime",
    audit:
      "Only canonical validated SPKI and fixed-width P1363 signatures reach subtle.verify; platform causes and cryptographic bytes never enter diagnostics.",
  },
  {
    id: "immutable-r2",
    boundary: "Cloudflare R2 conditional object, read, list and exact delete Promises",
    owner: "@enchiridion/runtime",
    audit:
      "Only put with etagDoesNotMatch '*' is exposed publicly; keys, byte counts and list results are structurally bounded before workers receive them.",
  },
  {
    id: "blob-r2",
    boundary: "Cloudflare R2 conditional blob object, exact bounded read and exact delete Promises",
    owner: "@enchiridion/runtime",
    audit:
      "The Blob contract exposes no list, prefix, bulk, stream or overwrite operation; keys, sizes and returned metadata are bounded before workers receive them.",
  },
  {
    id: "manifest-p256-webcrypto",
    boundary: "Web Crypto PKCS#8 import and P-256 manifest ECDSA signing",
    owner: "@enchiridion/runtime",
    audit:
      "Redacted PKCS#8 bytes enter Web Crypto only; signing results are normalized to canonical low-S DER before serialization and no key or platform cause enters diagnostics.",
  },
  {
    id: "worker-outer-boundary",
    boundary: "Effect worker handler completion to the Cloudflare Promise fetch contract",
    owner: "@enchiridion/runtime",
    audit:
      "Only a fixed safe 500 response crosses an untyped defect; no cause or request data is serialized.",
  },
  {
    id: "access-jose-jwks",
    boundary: "JOSE RemoteJWKSet and jwtVerify native Promise API for Cloudflare Access",
    owner: "@enchiridion/runtime",
    audit:
      "The adapter permits only RS256 verification against a configured HTTPS JWKS URL; all causes and token data are discarded in favour of closed safe errors.",
  },
  {
    id: "durable-object-callback-storage",
    boundary:
      "Durable Object blockConcurrencyWhile, fetch/WebSocket/alarm callbacks, and state.storage Promises",
    owner: "@enchiridion/runtime",
    audit:
      "Callback defects and rejected native storage Promises become a closed operation/reason error; payloads, attachment data, and platform causes never cross the seam. The transaction-outcome adapter uses a per-call private rollback sentinel so a schema-decoded domain failure can be returned without exposing a native Promise rejection.",
  },
  {
    id: "durable-object-fixed-http",
    boundary: "Cloudflare DurableObjectNamespace fixed-name stub.fetch and bounded response stream",
    owner: "@enchiridion/runtime",
    audit:
      "The client fixes the namespace name, method, path, headers, expected status and byte caps before invocation; rejected platform causes, response headers and response bodies never enter diagnostics.",
  },
  {
    id: "request-body-stream",
    boundary: "Worker Request structural access and one bounded ReadableStream body claim",
    owner: "@enchiridion/runtime",
    audit:
      "The adapter exact-decodes static limits before reading, claims a request body once, copies chunks before return, and discards stream, getter, and cleanup causes in favour of closed errors.",
  },
] as const;

export type CloudflareAdapterID = (typeof cloudflareAdapterLedger)[number]["id"];

/** Bound module-global keysets so a Worker request-level Layer cannot defeat
 * JWKS caching. A forced kid-miss refresh replaces only its one issuer entry. */
const joseJwksSessions = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const maximumJoseJwksSessions = 16;

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

/** Audited P-256 Web Crypto seam. Callers must provide already canonical SPKI and P1363 bytes. */
export const verifyP256Ecdsa = (
  canonicalSpki: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
  p1363Signature: Uint8Array<ArrayBuffer>,
): Effect.Effect<boolean, ExternalServiceError> =>
  fromCloudflarePromise(RuntimeOperation.P256Crypto, async () => {
    const key = await crypto.subtle.importKey(
      "spki",
      canonicalSpki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, p1363Signature, message);
  });

/** Audited random boundary. The fixed-size copy prevents callers retaining a mutable platform buffer. */
export const randomP256Bytes32 = (): Effect.Effect<Uint8Array<ArrayBuffer>, ExternalServiceError> =>
  fromCloudflarePromise(RuntimeOperation.P256Crypto, async () => {
    const generated = new Uint8Array(32);
    crypto.getRandomValues(generated);
    const output = new Uint8Array(generated.byteLength);
    output.set(generated);
    return output;
  });

/** Minimal structural R2 view. It deliberately accepts only the one
 * immutable conditional-write form required for signed backup objects. */
export interface ImmutableR2NativeObject {
  readonly key: string;
  readonly etag: string;
  readonly httpEtag?: string;
  readonly size: number;
  readonly checksums?: { readonly sha256?: ArrayBuffer };
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface ImmutableR2NativeObjectBody extends ImmutableR2NativeObject {
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface ImmutableR2NativeBinding {
  readonly head: (key: string) => Promise<ImmutableR2NativeObject | null>;
  readonly get: (
    key: string,
    options: { readonly range: { readonly offset: 0; readonly length: number } },
  ) => Promise<ImmutableR2NativeObjectBody | null>;
  readonly put: (
    key: string,
    value: Uint8Array<ArrayBuffer>,
    options: {
      readonly onlyIf: { readonly etagDoesNotMatch: "*" };
      /** Cloudflare R2's native SHA-256 checksum option. */
      readonly sha256: ArrayBuffer;
    },
  ) => Promise<ImmutableR2NativeObject | null>;
  readonly list: (options: {
    readonly prefix: string;
    readonly cursor?: string;
    readonly limit: number;
  }) => Promise<{
    readonly objects: readonly ImmutableR2NativeObject[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
  readonly delete: (key: string) => Promise<void>;
}

type ImmutableR2Operation = ImmutableR2Error["operation"];

const immutableR2Failure = (
  operation: ImmutableR2Operation,
  reason: ImmutableR2Error["reason"],
): ImmutableR2Error => new ImmutableR2Error({ operation, reason });

/** The sole R2 Promise seam. Public helpers below never expose `put` without
 * the no-overwrite conditional. */
const fromImmutableR2Promise = <A>(
  operation: ImmutableR2Operation,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, ImmutableR2Error> =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => immutableR2Failure(operation, "platform_failed"),
  });

export const immutableR2Head = (
  binding: ImmutableR2NativeBinding,
  key: string,
): Effect.Effect<ImmutableR2NativeObject | null, ImmutableR2Error> =>
  fromImmutableR2Promise("head", () => binding.head(key));

export const immutableR2Get = (
  binding: ImmutableR2NativeBinding,
  key: string,
  maximumBytes: number,
): Effect.Effect<ImmutableR2NativeObjectBody | null, ImmutableR2Error> =>
  fromImmutableR2Promise("read", () =>
    binding.get(key, { range: { offset: 0, length: maximumBytes } }),
  );

export const immutableR2ReadBytes = (
  object: ImmutableR2NativeObjectBody,
): Effect.Effect<Uint8Array<ArrayBuffer>, ImmutableR2Error> =>
  fromImmutableR2Promise("read", () => object.arrayBuffer()).pipe(
    Effect.map((buffer) => {
      const bytes = new Uint8Array(buffer.byteLength);
      bytes.set(new Uint8Array(buffer));
      return bytes;
    }),
  );

export const immutableR2PutIfAbsent = (
  binding: ImmutableR2NativeBinding,
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  sha256: Uint8Array<ArrayBuffer>,
): Effect.Effect<ImmutableR2NativeObject | null, ImmutableR2Error> =>
  // The native binding owns an async boundary. Do not lend it caller-owned
  // buffers: snapshot both the body and checksum before its Promise starts.
  // The copies also prevent a binding retaining and later mutating either
  // buffer from changing anything we validate after the await.
  (() => {
    const bodySnapshot = new Uint8Array(bytes.byteLength);
    bodySnapshot.set(bytes);
    const checksumSnapshot = new Uint8Array(sha256.byteLength);
    checksumSnapshot.set(sha256);
    return fromImmutableR2Promise("put_if_absent", () =>
      binding.put(key, bodySnapshot, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: checksumSnapshot.buffer,
      }),
    );
  })();

export const immutableR2List = (
  binding: ImmutableR2NativeBinding,
  prefix: string,
  cursor: string | undefined,
  limit: number,
): Effect.Effect<
  {
    readonly objects: readonly ImmutableR2NativeObject[];
    readonly truncated: boolean;
    readonly cursor?: string;
  },
  ImmutableR2Error
> => fromImmutableR2Promise("list", () => binding.list({ prefix, cursor, limit }));

export const immutableR2Delete = (
  binding: ImmutableR2NativeBinding,
  key: string,
): Effect.Effect<void, ImmutableR2Error> =>
  fromImmutableR2Promise("delete", () => binding.delete(key));

/** Separate, deliberately non-listable R2 view for Blob authority. */
export interface BlobR2NativeObject {
  readonly key: string;
  readonly etag: string;
  readonly httpEtag?: string;
  readonly size: number;
  readonly checksums?: { readonly sha256?: ArrayBuffer };
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface BlobR2NativeObjectBody extends BlobR2NativeObject {
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface BlobR2NativeBindingInput {
  readonly head: (key: string) => Promise<BlobR2NativeObject | null>;
  readonly get: (
    key: string,
    options: { readonly range: { readonly offset: 0; readonly length: number } },
  ) => Promise<BlobR2NativeObjectBody | null>;
  readonly put: (
    key: string,
    value: Uint8Array<ArrayBuffer>,
    options: {
      readonly onlyIf: { readonly etagDoesNotMatch: "*" };
      readonly sha256: ArrayBuffer;
    },
  ) => Promise<BlobR2NativeObject | null>;
  readonly delete: (key: string) => Promise<void>;
}

const blobR2BindingBrand: unique symbol = Symbol("BlobR2NativeBinding");
/** Nominal capability: an ImmutableR2 native authority cannot be assigned here. */
export interface BlobR2NativeBinding extends BlobR2NativeBindingInput {
  readonly [blobR2BindingBrand]: "BlobR2NativeBinding";
}

export const makeBlobR2NativeBinding = (input: BlobR2NativeBindingInput): BlobR2NativeBinding => ({
  ...input,
  [blobR2BindingBrand]: "BlobR2NativeBinding",
});

const blobR2Promise = <A>(
  operation: BlobR2Error["operation"],
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, BlobR2Error> =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => new BlobR2Error({ operation, reason: "platform_failed" }),
  });

export const blobR2SHA256 = (
  operation: BlobR2Error["operation"],
  bytes: Uint8Array<ArrayBuffer>,
): Effect.Effect<Uint8Array<ArrayBuffer>, BlobR2Error> =>
  blobR2Promise(operation, () => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) => {
      const output = new Uint8Array(digest.byteLength);
      output.set(new Uint8Array(digest));
      return output;
    }),
  );

export const blobR2Head = (
  binding: BlobR2NativeBinding,
  key: string,
): Effect.Effect<BlobR2NativeObject | null, BlobR2Error> =>
  blobR2Promise("head", () => binding.head(key));

export const blobR2Get = (
  binding: BlobR2NativeBinding,
  key: string,
  maximumBytes: number,
): Effect.Effect<BlobR2NativeObjectBody | null, BlobR2Error> =>
  blobR2Promise("read", () => binding.get(key, { range: { offset: 0, length: maximumBytes } }));

export const blobR2ReadBytes = (
  object: BlobR2NativeObjectBody,
  maximumBytes: number,
): Effect.Effect<Uint8Array<ArrayBuffer>, BlobR2Error> =>
  blobR2Promise("read", () => object.arrayBuffer()).pipe(
    Effect.flatMap((buffer) => {
      if (buffer.byteLength > maximumBytes)
        return Effect.fail(new BlobR2Error({ operation: "read", reason: "too_large" }));
      const output = new Uint8Array(buffer.byteLength);
      output.set(new Uint8Array(buffer));
      return Effect.succeed(output);
    }),
  );

export const blobR2PutIfAbsent = (
  binding: BlobR2NativeBinding,
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  sha256: Uint8Array<ArrayBuffer>,
): Effect.Effect<BlobR2NativeObject | null, BlobR2Error> => {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  const checksum = new Uint8Array(sha256.byteLength);
  checksum.set(sha256);
  return blobR2Promise("put_if_absent", () =>
    binding.put(key, body, { onlyIf: { etagDoesNotMatch: "*" }, sha256: checksum.buffer }),
  );
};

export const blobR2Delete = (
  binding: BlobR2NativeBinding,
  key: string,
): Effect.Effect<void, BlobR2Error> => blobR2Promise("delete", () => binding.delete(key));

/** Audited Web Crypto PKCS#8 signing seam for backup manifests. The caller
 * supplies only Redacted material and canonical bytes. */
export const signManifestP256 = (
  privateKeyPKCS8: Redacted.Redacted,
  message: Uint8Array<ArrayBuffer>,
): Effect.Effect<Uint8Array<ArrayBuffer>, ExternalServiceError> =>
  fromCloudflarePromise(RuntimeOperation.ManifestCrypto, async () => {
    const binary = atob(Redacted.value(privateKeyPKCS8));
    const pkcs8 = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, message);
    const output = new Uint8Array(signed.byteLength);
    output.set(new Uint8Array(signed));
    return output;
  });

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const p256Algorithm = (algorithm: {
  readonly name: string;
  readonly namedCurve?: string;
}): boolean => algorithm.name === "ECDSA" && algorithm.namedCurve === "P-256";

const manifestChallenge = new TextEncoder().encode("enchiridion-backup-manifest-key-pair-v1");

/** Imports then re-exports an exact P-256 SPKI. This prevents accepting a
 * merely DER-shaped key whose Web Crypto algorithm/curve differs at runtime. */
export const validateManifestP256PublicKey = (
  canonicalSpki: Uint8Array<ArrayBuffer>,
): Effect.Effect<void, ExternalServiceError> =>
  fromCloudflarePromise(RuntimeOperation.ManifestCrypto, async () => {
    const key = await crypto.subtle.importKey(
      "spki",
      canonicalSpki,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const exported = new Uint8Array(await crypto.subtle.exportKey("spki", key));
    if (!p256Algorithm(key.algorithm) || !sameBytes(exported, canonicalSpki))
      throw new Error("manifest public key validation failed");
  });

/** Imports the current Redacted PKCS#8 and exact SPKI, confirms canonical
 * exports and proves the pair by a fixed sign/verify challenge before any
 * runtime signer can be constructed. */
export const validateManifestP256KeyPair = (
  privateKeyPKCS8: Redacted.Redacted,
  canonicalSpki: Uint8Array<ArrayBuffer>,
): Effect.Effect<void, ExternalServiceError> =>
  fromCloudflarePromise(RuntimeOperation.ManifestCrypto, async () => {
    const binary = atob(Redacted.value(privateKeyPKCS8));
    const pkcs8 = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const publicKey = await crypto.subtle.importKey(
      "spki",
      canonicalSpki,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const exportedPrivate = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
    const exportedPublic = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
    if (
      !p256Algorithm(privateKey.algorithm) ||
      !p256Algorithm(publicKey.algorithm) ||
      !sameBytes(exportedPrivate, pkcs8) ||
      !sameBytes(exportedPublic, canonicalSpki)
    )
      throw new Error("manifest key export validation failed");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      manifestChallenge,
    );
    if (
      !(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        manifestChallenge,
      ))
    )
      throw new Error("manifest key pair mismatch");
  });

/** SHA-256 remains inside the R2 adapter seam so streamed R2 bytes are never
 * trusted solely from platform metadata. */
export const immutableR2SHA256 = (
  bytes: Uint8Array<ArrayBuffer>,
): Effect.Effect<Uint8Array<ArrayBuffer>, ImmutableR2Error> =>
  fromImmutableR2Promise("read", () => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) => {
      const output = new Uint8Array(digest.byteLength);
      output.set(new Uint8Array(digest));
      return output;
    }),
  );

const accessError = (reason: AccessJwtVerificationError["reason"]): AccessJwtVerificationError =>
  new AccessJwtVerificationError({ reason });

const safeAccessClaims = (value: {
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly iat?: number;
  readonly nbf?: number;
  readonly exp?: number;
  readonly sub?: string;
}): VerifiedAccessJwt["claims"] | undefined => {
  const { iss, aud, iat, nbf, exp, sub } = value;
  if (
    typeof iss !== "string" ||
    (typeof aud !== "string" &&
      (!Array.isArray(aud) || !aud.every((entry) => typeof entry === "string"))) ||
    typeof iat !== "number" ||
    typeof nbf !== "number" ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(nbf) ||
    !Number.isSafeInteger(exp) ||
    typeof sub !== "string" ||
    sub.length === 0 ||
    sub.length > 512
  )
    return undefined;
  return { iss, aud, iat, nbf, exp, sub };
};

const safeAccessHeader = (value: {
  readonly alg?: string;
  readonly typ?: string;
  readonly kid?: string;
}): VerifiedAccessJwt["protectedHeader"] | undefined => {
  if (
    value.alg !== "RS256" ||
    value.typ !== "JWT" ||
    typeof value.kid !== "string" ||
    !/^[A-Za-z0-9._~-]{1,128}$/u.test(value.kid)
  )
    return undefined;
  return { alg: "RS256", typ: "JWT", kid: value.kid };
};

const joseFailure = (cause: unknown): AccessJwtVerificationError => {
  if (cause instanceof joseErrors.JWKSNoMatchingKey) return accessError("unknown_key");
  if (cause instanceof joseErrors.JWKSInvalid) return accessError("jwks_unavailable");
  if (cause instanceof joseErrors.JWSSignatureVerificationFailed)
    return accessError("signature_invalid");
  if (
    cause instanceof joseErrors.JWTClaimValidationFailed ||
    cause instanceof joseErrors.JWTExpired
  )
    return accessError("claims_invalid");
  if (cause instanceof joseErrors.JWSInvalid || cause instanceof joseErrors.JWTInvalid)
    return accessError("malformed_assertion");
  return accessError("jwks_unavailable");
};

/**
 * Sole production JOSE/JWKS seam. `jose` owns HTTP retrieval and cryptographic
 * verification; this adapter discards causes and returns only closed errors.
 */
export const makeJoseAccessJwksSession = (
  configuration: AccessJwksSessionConfiguration,
  forceRefresh: boolean,
): Effect.Effect<AccessJwksSession, AccessJwtVerificationError> =>
  Effect.try({
    try: () => {
      const existing = joseJwksSessions.get(configuration.jwksURL);
      if (forceRefresh) joseJwksSessions.delete(configuration.jwksURL);
      else if (existing !== undefined) return existing;
      if (joseJwksSessions.size >= maximumJoseJwksSessions) {
        for (const oldestURL of joseJwksSessions.keys()) {
          joseJwksSessions.delete(oldestURL);
          break;
        }
      }
      const jwks = createRemoteJWKSet(new URL(configuration.jwksURL), {
        cacheMaxAge: configuration.cacheTTLSeconds * 1_000,
        cooldownDuration: configuration.refreshCooldownSeconds * 1_000,
      });
      joseJwksSessions.set(configuration.jwksURL, jwks);
      return jwks;
    },
    catch: () => accessError("invalid_configuration"),
  }).pipe(
    Effect.map((jwks) => ({
      verify: (
        request: AccessJwtVerificationRequest,
      ): Effect.Effect<VerifiedAccessJwt, AccessJwtVerificationError> =>
        Effect.tryPromise({
          try: () =>
            jwtVerify(request.assertion, jwks, {
              algorithms: ["RS256"],
              issuer: request.issuer,
              audience: request.audience,
              currentDate: new Date(request.nowSeconds * 1_000),
            }),
          catch: joseFailure,
        }).pipe(
          Effect.flatMap(({ protectedHeader, payload }) => {
            const header = safeAccessHeader(protectedHeader);
            const claims = safeAccessClaims(payload);
            return header === undefined ||
              claims === undefined ||
              claims.iat > claims.nbf ||
              claims.nbf > claims.exp
              ? Effect.fail(accessError("claims_invalid"))
              : Effect.succeed({ protectedHeader: header, claims });
          }),
        ),
    })),
  );

/** Minimal structural view of a Cloudflare Durable Object transaction. */
export interface DurableObjectTransactionNative {
  readonly get: (key: string) => Promise<unknown | undefined>;
  readonly put: (key: string, value: unknown) => Promise<void>;
  readonly delete: (key: string) => Promise<boolean>;
}

/** Minimal structural view of the Cloudflare Durable Object storage API. */
export interface DurableObjectStorageNative extends DurableObjectTransactionNative {
  readonly getAlarm: () => Promise<number | null>;
  readonly setAlarm: (epochMilliseconds: number) => Promise<void>;
  readonly deleteAlarm: () => Promise<void>;
  readonly transaction: <A>(
    callback: (storage: DurableObjectTransactionNative) => Promise<A>,
  ) => Promise<A>;
}

/** Minimal structural view of the state APIs used by an OwnerVault Durable Object. */
export interface DurableObjectStateNative {
  readonly storage: DurableObjectStorageNative;
  readonly blockConcurrencyWhile: <A>(callback: () => Promise<A>) => Promise<A>;
}

export interface DurableObjectTransaction {
  readonly get: (key: string) => Effect.Effect<unknown | undefined, DurableObjectBoundaryError>;
  readonly put: (key: string, value: unknown) => Effect.Effect<void, DurableObjectBoundaryError>;
  readonly delete: (key: string) => Effect.Effect<boolean, DurableObjectBoundaryError>;
}

/** A closed, serializable result from an atomic Durable Object transaction. */
export type DurableObjectTransactionOutcome<A, E> =
  | { readonly _tag: "success"; readonly value: A }
  | { readonly _tag: "failure"; readonly error: E };

export const durableObjectTransactionSuccess = <A>(
  value: A,
): DurableObjectTransactionOutcome<A, never> => ({ _tag: "success", value });

export const durableObjectTransactionFailure = <E>(
  error: E,
): DurableObjectTransactionOutcome<never, E> => ({ _tag: "failure", error });

/**
 * Produces the exact discriminated schema used at Durable Object transaction
 * boundaries. Callers supply their serializable success and domain-failure
 * schemas; malformed values are never promoted to an outcome.
 */
export const durableObjectTransactionOutcomeSchema = <A, AI, AR, E, EI, ER>(
  value: Schema.Schema<A, AI, AR>,
  error: Schema.Schema<E, EI, ER>,
) =>
  Schema.Union(
    Schema.Struct({ _tag: Schema.Literal("success"), value }),
    Schema.Struct({ _tag: Schema.Literal("failure"), error }),
  );

/** A total, non-throwing decoder for the closed domain failure channel. */
export interface DurableObjectTransactionDomainCodec<E> {
  readonly decode: (value: unknown) => E | undefined;
}

/** Adapts an Effect Schema into the transaction domain-failure codec. */
export const durableObjectTransactionDomainCodec = <E, EI>(
  schema: Schema.Schema<E, EI>,
): DurableObjectTransactionDomainCodec<E> => {
  const decode = Schema.decodeUnknownEither(schema);
  return {
    decode: (value) => {
      const decoded = decode(value);
      return Either.isRight(decoded) ? decoded.right : undefined;
    },
  };
};

export interface DurableObjectStorage extends DurableObjectTransaction {
  /** Reads the scheduled alarm epoch from Cloudflare storage, or null when absent. */
  readonly getAlarm: () => Effect.Effect<number | null, DurableObjectBoundaryError>;
  /** Schedules one Cloudflare Durable Object alarm at an epoch-millisecond deadline. */
  readonly setAlarm: (epochMilliseconds: number) => Effect.Effect<void, DurableObjectBoundaryError>;
  /** Deletes the currently scheduled Cloudflare Durable Object alarm. */
  readonly deleteAlarm: () => Effect.Effect<void, DurableObjectBoundaryError>;
  /** The only storage read/modify/write primitive: the callback is native-transaction atomic. */
  readonly transaction: <A, E>(
    work: (storage: DurableObjectTransaction) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, DurableObjectBoundaryError>;
  /**
   * Atomically commits a success or rolls back a schema-decoded domain failure.
   * Native storage failures remain DurableObjectBoundaryError and never enter
   * the domain failure channel.
   */
  readonly transactionOutcome: <A, E>(
    domainFailure: DurableObjectTransactionDomainCodec<E>,
    work: (storage: DurableObjectTransaction) => Effect.Effect<A, E | DurableObjectBoundaryError>,
  ) => Effect.Effect<DurableObjectTransactionOutcome<A, E>, DurableObjectBoundaryError>;
}

export interface DurableObjectCallbacks {
  /** Constructor-only durable initialization; serializes startup before requests. */
  readonly blockConcurrencyWhile: <E>(
    work: Effect.Effect<void, E>,
  ) => Effect.Effect<void, DurableObjectBoundaryError>;
  /** The only Effect-to-Promise bridge for a Durable Object fetch callback. */
  readonly fetch: <A, E>(work: Effect.Effect<A, E>) => Promise<A>;
  /** The only Effect-to-Promise bridge for a Durable Object WebSocket message callback. */
  readonly webSocketMessage: <A, E>(work: Effect.Effect<A, E>) => Promise<A>;
  /** The only Effect-to-Promise bridge for a Durable Object alarm callback. */
  readonly alarm: <E>(work: Effect.Effect<void, E>) => Promise<void>;
}

export interface DurableObjectBoundary {
  readonly storage: DurableObjectStorage;
  readonly callbacks: DurableObjectCallbacks;
}

type DurableObjectOperation = DurableObjectBoundaryError["operation"];

const durableObjectFailure = (
  operation: DurableObjectOperation,
  reason: DurableObjectBoundaryError["reason"],
): DurableObjectBoundaryError => new DurableObjectBoundaryError({ operation, reason });

/**
 * Converts an already-provided Effect to the Cloudflare callback Promise shape.
 * Errors and defects are replaced by a closed error so callers can apply their
 * fixed HTTP/WebSocket response or close-code policy without seeing a cause.
 */
const durableObjectCallbackPromise = <A, E>(
  operation: DurableObjectOperation,
  work: Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    work.pipe(
      Effect.catchAllCause(() => Effect.fail(durableObjectFailure(operation, "callback_failed"))),
    ),
  );

/** The audited native Durable Object Promise-to-Effect conversion. */
const fromDurableObjectPromise = <A>(
  operation: DurableObjectOperation,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, DurableObjectBoundaryError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      cause instanceof DurableObjectBoundaryError
        ? cause
        : durableObjectFailure(operation, "platform_failed"),
  });

const makeDurableObjectTransaction = (
  native: DurableObjectTransactionNative,
): DurableObjectTransaction => ({
  get: (key) => fromDurableObjectPromise("storage_get", () => native.get(key)),
  put: (key, value) => fromDurableObjectPromise("storage_put", () => native.put(key, value)),
  delete: (key) => fromDurableObjectPromise("storage_delete", () => native.delete(key)),
});

/**
 * This value is private to one transaction invocation. Cloudflare rolls back
 * a transaction only when its native callback rejects, so it deliberately
 * crosses that callback as a rejection and is recovered by object identity in
 * the same closure. It is not exported, contains only schema-accepted domain
 * data, and cannot be confused across concurrent calls because each call owns
 * a fresh instance.
 */
class DurableObjectTransactionRollback<E> {
  constructor(readonly outcome: DurableObjectTransactionOutcome<never, E>) {}
}

/** Executes the sole native rollback bridge for a serializable domain failure. */
const durableObjectTransactionOutcome = <A, E>(
  native: DurableObjectStorageNative,
  domainFailure: DurableObjectTransactionDomainCodec<E>,
  work: (storage: DurableObjectTransaction) => Effect.Effect<A, E | DurableObjectBoundaryError>,
): Effect.Effect<DurableObjectTransactionOutcome<A, E>, DurableObjectBoundaryError> => {
  /**
   * A reusable Effect may be run concurrently. `suspend` allocates the
   * rollback side channel for each execution rather than for the one Effect
   * value, so a later execution cannot overwrite another execution's sentinel.
   */
  return Effect.suspend(() => {
    let rollback: DurableObjectTransactionRollback<E> | undefined;
    return Effect.tryPromise({
      try: () =>
        native.transaction(async (transaction) => {
          const result = await Effect.runPromise(
            Effect.either(work(makeDurableObjectTransaction(transaction))),
          );
          if (Either.isRight(result)) return durableObjectTransactionSuccess(result.right);
          if (result.left instanceof DurableObjectBoundaryError) throw result.left;
          let decoded: E | undefined;
          try {
            decoded = domainFailure.decode(result.left);
          } catch {
            throw durableObjectFailure("storage_transaction", "callback_failed");
          }
          if (decoded === undefined)
            throw durableObjectFailure("storage_transaction", "callback_failed");
          rollback = new DurableObjectTransactionRollback(durableObjectTransactionFailure(decoded));
          throw rollback;
        }),
      catch: (cause) => {
        if (cause === rollback && rollback !== undefined) return rollback;
        return cause instanceof DurableObjectBoundaryError
          ? cause
          : durableObjectFailure("storage_transaction", "platform_failed");
      },
    }).pipe(
      Effect.catchAll((failure) =>
        failure instanceof DurableObjectTransactionRollback
          ? Effect.succeed(failure.outcome)
          : Effect.fail(failure),
      ),
    );
  });
};

const makeDurableObjectStorage = (native: DurableObjectStorageNative): DurableObjectStorage => ({
  ...makeDurableObjectTransaction(native),
  getAlarm: () => fromDurableObjectPromise("storage_get_alarm", () => native.getAlarm()),
  setAlarm: (epochMilliseconds) =>
    fromDurableObjectPromise("storage_set_alarm", () => native.setAlarm(epochMilliseconds)),
  deleteAlarm: () => fromDurableObjectPromise("storage_delete_alarm", () => native.deleteAlarm()),
  transaction: (work) =>
    fromDurableObjectPromise("storage_transaction", () =>
      native.transaction((transaction) =>
        durableObjectCallbackPromise(
          "storage_transaction",
          work(makeDurableObjectTransaction(transaction)),
        ),
      ),
    ),
  transactionOutcome: (domainFailure, work) =>
    durableObjectTransactionOutcome(native, domainFailure, work),
});

/**
 * Atomically adopts a value only if the storage key is empty, otherwise checks
 * equivalence against a caller-owned structural decoder. This prevents a
 * Durable Object identity get/put race outside a transaction.
 */
export const adoptDurableObjectValue = <A>(
  storage: DurableObjectStorage,
  key: string,
  candidate: A,
  decode: (value: unknown) => A | undefined,
  equivalent: (left: A, right: A) => boolean,
): Effect.Effect<boolean, DurableObjectBoundaryError> =>
  storage.transaction((transaction) =>
    transaction.get(key).pipe(
      Effect.flatMap((stored) => {
        if (stored === undefined) return transaction.put(key, candidate).pipe(Effect.as(true));
        const decoded = decode(stored);
        return Effect.succeed(decoded !== undefined && equivalent(decoded, candidate));
      }),
    ),
  );

/**
 * The sole Durable Object native callback/storage boundary. Worker code keeps
 * all business logic in Effect, pre-provides dependencies, and maps this
 * closed error to its fixed response/close behavior at the outer caller.
 */
export const makeDurableObjectBoundary = (
  state: DurableObjectStateNative,
): DurableObjectBoundary => {
  const callbacks: DurableObjectBoundary["callbacks"] = {
    blockConcurrencyWhile: (work) =>
      fromDurableObjectPromise("block_concurrency_while", () =>
        state.blockConcurrencyWhile(() =>
          durableObjectCallbackPromise("block_concurrency_while", work),
        ),
      ),
    fetch: (work) => durableObjectCallbackPromise("fetch_callback", work),
    webSocketMessage: (work) => durableObjectCallbackPromise("websocket_message_callback", work),
    alarm: (work) => durableObjectCallbackPromise("alarm_callback", work),
  };
  const boundary: DurableObjectBoundary = {
    storage: makeDurableObjectStorage(state.storage),
    callbacks: Object.freeze(callbacks),
  };
  return Object.freeze(boundary);
};

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
): WorkerBoundary => {
  const boundary: WorkerBoundary = {
    handle: (request, environment, _context) =>
      Effect.runPromise(
        handler(request, environment).pipe(
          Effect.catchAllCause(() =>
            Effect.succeed(
              new Response(null, { status: 500, statusText: "Internal Server Error" }),
            ),
          ),
        ),
      ),
  };
  return Object.freeze(boundary);
};
