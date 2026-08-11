import { Data } from "effect";

/** Closed operation categories. A string enum prevents callers passing a raw string. */
export enum RuntimeOperation {
  CloudflareBinding = "cloudflare.binding",
  ImmutableR2 = "immutable-r2",
  CapabilityCrypto = "capability.crypto",
  P256Crypto = "p256.crypto",
  ManifestCrypto = "manifest.crypto",
  AccessJwks = "access.jwks",
  DurableObject = "durable-object",
  SharedEffect = "runtime.shared-effect",
}

export type RuntimeOperationIdentifier = RuntimeOperation;

const isRuntimeOperation = (value: unknown): value is RuntimeOperation =>
  value === RuntimeOperation.CloudflareBinding ||
  value === RuntimeOperation.ImmutableR2 ||
  value === RuntimeOperation.CapabilityCrypto ||
  value === RuntimeOperation.P256Crypto ||
  value === RuntimeOperation.ManifestCrypto ||
  value === RuntimeOperation.AccessJwks ||
  value === RuntimeOperation.DurableObject ||
  value === RuntimeOperation.SharedEffect;

/** Safe diagnostics crossing the shared runtime boundary. These tagged values
 * intentionally never retain platform causes or user-provided payloads. */
export class RuntimeConfigError extends Data.TaggedError("RuntimeConfigError")<{
  readonly field:
    | "operation.concurrency"
    | "operation.timeoutMs"
    | "operation.retry.maxRetries"
    | "operation.retry.baseDelayMs";
  readonly reason: "must_be_positive" | "must_be_non_negative";
}> {
  constructor(input: {
    readonly field:
      | "operation.concurrency"
      | "operation.timeoutMs"
      | "operation.retry.maxRetries"
      | "operation.retry.baseDelayMs";
    readonly reason: "must_be_positive" | "must_be_non_negative";
  }) {
    if (
      ![
        "operation.concurrency",
        "operation.timeoutMs",
        "operation.retry.maxRetries",
        "operation.retry.baseDelayMs",
      ].includes(input.field) ||
      !["must_be_positive", "must_be_non_negative"].includes(input.reason)
    )
      throw new TypeError("Invalid RuntimeConfigError fields.");
    super({ field: input.field, reason: input.reason });
  }
}

export class ExternalServiceError extends Data.TaggedError("ExternalServiceError")<{
  readonly operation: RuntimeOperationIdentifier;
  readonly retryable: boolean;
}> {
  constructor(input: {
    readonly operation: RuntimeOperationIdentifier;
    readonly retryable: boolean;
  }) {
    if (!isRuntimeOperation(input.operation) || typeof input.retryable !== "boolean")
      throw new TypeError("Invalid ExternalServiceError fields.");
    super({ operation: input.operation, retryable: input.retryable });
  }
}

export class OperationTimeoutError extends Data.TaggedError("OperationTimeoutError")<{
  readonly operation: RuntimeOperationIdentifier;
  readonly timeoutMs: number;
}> {
  constructor(input: {
    readonly operation: RuntimeOperationIdentifier;
    readonly timeoutMs: number;
  }) {
    if (
      !isRuntimeOperation(input.operation) ||
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs <= 0
    )
      throw new TypeError("Invalid OperationTimeoutError fields.");
    super({ operation: input.operation, timeoutMs: input.timeoutMs });
  }
}

export class AdapterContractError extends Data.TaggedError("AdapterContractError")<{
  readonly adapter: "cloudflare-promise" | "unknown-record";
  readonly reason: "not_record";
}> {
  constructor(input: {
    readonly adapter: "cloudflare-promise" | "unknown-record";
    readonly reason: "not_record";
  }) {
    if (
      !(["cloudflare-promise", "unknown-record"] as const).includes(input.adapter) ||
      input.reason !== "not_record"
    )
      throw new TypeError("Invalid AdapterContractError fields.");
    super({ adapter: input.adapter, reason: input.reason });
  }
}

export class TelemetryInputRejectedError extends Data.TaggedError("TelemetryInputRejectedError")<{
  readonly reason: "invalid_event" | "unsafe_attribute";
}> {
  constructor(input: { readonly reason: "invalid_event" | "unsafe_attribute" }) {
    if (!(["invalid_event", "unsafe_attribute"] as const).includes(input.reason))
      throw new TypeError("Invalid TelemetryInputRejectedError fields.");
    super({ reason: input.reason });
  }
}

export class CapabilityConfigurationError extends Data.TaggedError("CapabilityConfigurationError")<{
  readonly reason:
    | "invalid_key_id"
    | "invalid_secret"
    | "duplicate_key_id"
    | "duplicate_secret"
    | "too_many_prior_keys"
    | "key_ring_overlap";
}> {
  constructor(input: {
    readonly reason:
      | "invalid_key_id"
      | "invalid_secret"
      | "duplicate_key_id"
      | "duplicate_secret"
      | "too_many_prior_keys"
      | "key_ring_overlap";
  }) {
    if (
      !(
        [
          "invalid_key_id",
          "invalid_secret",
          "duplicate_key_id",
          "duplicate_secret",
          "too_many_prior_keys",
          "key_ring_overlap",
        ] as const
      ).includes(input.reason)
    )
      throw new TypeError("Invalid CapabilityConfigurationError fields.");
    super({ reason: input.reason });
  }
}

export class CapabilitySigningError extends Data.TaggedError("CapabilitySigningError")<{
  readonly reason: "crypto_failed" | "invalid_claims";
}> {
  constructor(input: { readonly reason: "crypto_failed" | "invalid_claims" }) {
    if (!(["crypto_failed", "invalid_claims"] as const).includes(input.reason))
      throw new TypeError("Invalid CapabilitySigningError fields.");
    super({ reason: input.reason });
  }
}

export class CapabilityVerificationError extends Data.TaggedError("CapabilityVerificationError")<{
  readonly reason:
    | "malformed_token"
    | "signature_invalid"
    | "unknown_or_stale_key"
    | "claims_invalid"
    | "binding_mismatch"
    | "expired"
    | "not_yet_valid";
}> {
  constructor(input: {
    readonly reason:
      | "malformed_token"
      | "signature_invalid"
      | "unknown_or_stale_key"
      | "claims_invalid"
      | "binding_mismatch"
      | "expired"
      | "not_yet_valid";
  }) {
    if (
      !(
        [
          "malformed_token",
          "signature_invalid",
          "unknown_or_stale_key",
          "claims_invalid",
          "binding_mismatch",
          "expired",
          "not_yet_valid",
        ] as const
      ).includes(input.reason)
    )
      throw new TypeError("Invalid CapabilityVerificationError fields.");
    super({ reason: input.reason });
  }
}

export class WorkerBoundaryError extends Data.TaggedError("WorkerBoundaryError")<{
  readonly reason: "handler_failed" | "invalid_response";
}> {
  constructor(input: { readonly reason: "handler_failed" | "invalid_response" }) {
    if (!(["handler_failed", "invalid_response"] as const).includes(input.reason))
      throw new TypeError("Invalid WorkerBoundaryError fields.");
    super({ reason: input.reason });
  }
}

/** Safe failures at the one Durable Object callback and storage Promise seam. */
export class DurableObjectBoundaryError extends Data.TaggedError("DurableObjectBoundaryError")<{
  readonly operation:
    | "block_concurrency_while"
    | "fetch_callback"
    | "websocket_message_callback"
    | "alarm_callback"
    | "storage_get"
    | "storage_put"
    | "storage_delete"
    | "storage_get_alarm"
    | "storage_set_alarm"
    | "storage_delete_alarm"
    | "storage_transaction";
  readonly reason: "callback_failed" | "platform_failed";
}> {
  constructor(input: {
    readonly operation:
      | "block_concurrency_while"
      | "fetch_callback"
      | "websocket_message_callback"
      | "alarm_callback"
      | "storage_get"
      | "storage_put"
      | "storage_delete"
      | "storage_get_alarm"
      | "storage_set_alarm"
      | "storage_delete_alarm"
      | "storage_transaction";
    readonly reason: "callback_failed" | "platform_failed";
  }) {
    if (
      !(
        [
          "block_concurrency_while",
          "fetch_callback",
          "websocket_message_callback",
          "alarm_callback",
          "storage_get",
          "storage_put",
          "storage_delete",
          "storage_get_alarm",
          "storage_set_alarm",
          "storage_delete_alarm",
          "storage_transaction",
        ] as const
      ).includes(input.operation) ||
      !(["callback_failed", "platform_failed"] as const).includes(input.reason)
    )
      throw new TypeError("Invalid DurableObjectBoundaryError fields.");
    super({ operation: input.operation, reason: input.reason });
  }
}

/** Closed failures at the only cross-Durable-Object HTTP invocation seam.
 * Native causes, response headers, and response bodies never cross this error. */
export class DurableObjectInvocationError extends Data.TaggedError("DurableObjectInvocationError")<{
  readonly reason:
    | "invalid_configuration"
    | "namespace_failed"
    | "stub_failed"
    | "response_malformed"
    | "response_too_large"
    | "unexpected_status";
}> {
  constructor(input: {
    readonly reason:
      | "invalid_configuration"
      | "namespace_failed"
      | "stub_failed"
      | "response_malformed"
      | "response_too_large"
      | "unexpected_status";
  }) {
    if (
      !(
        [
          "invalid_configuration",
          "namespace_failed",
          "stub_failed",
          "response_malformed",
          "response_too_large",
          "unexpected_status",
        ] as const
      ).includes(input.reason)
    )
      throw new TypeError("Invalid DurableObjectInvocationError fields.");
    super({ reason: input.reason });
  }
}

/** Closed failures while claiming and reading one inbound Worker Request body. */
export class RequestBodyError extends Data.TaggedError("RequestBodyError")<{
  readonly reason:
    | "invalid_configuration"
    | "request_malformed"
    | "content_length_required"
    | "content_length_invalid"
    | "content_length_mismatch"
    | "content_type_invalid"
    | "body_unavailable"
    | "body_already_claimed"
    | "body_too_large";
}> {
  constructor(input: {
    readonly reason:
      | "invalid_configuration"
      | "request_malformed"
      | "content_length_required"
      | "content_length_invalid"
      | "content_length_mismatch"
      | "content_type_invalid"
      | "body_unavailable"
      | "body_already_claimed"
      | "body_too_large";
  }) {
    if (
      !(
        [
          "invalid_configuration",
          "request_malformed",
          "content_length_required",
          "content_length_invalid",
          "content_length_mismatch",
          "content_type_invalid",
          "body_unavailable",
          "body_already_claimed",
          "body_too_large",
        ] as const
      ).includes(input.reason)
    )
      throw new TypeError("Invalid RequestBodyError fields.");
    super({ reason: input.reason });
  }
}

/** Safe failure categories for Cloudflare Access JWT/JWKS verification.
 * Neither rejected platform causes nor JWT contents cross this boundary. */
export class AccessJwtVerificationError extends Data.TaggedError("AccessJwtVerificationError")<{
  readonly reason:
    | "invalid_configuration"
    | "invalid_time"
    | "malformed_assertion"
    | "claims_invalid"
    | "signature_invalid"
    | "unknown_key"
    | "jwks_unavailable"
    | "refresh_cooldown";
}> {
  constructor(input: {
    readonly reason:
      | "invalid_configuration"
      | "invalid_time"
      | "malformed_assertion"
      | "claims_invalid"
      | "signature_invalid"
      | "unknown_key"
      | "jwks_unavailable"
      | "refresh_cooldown";
  }) {
    if (
      !(
        [
          "invalid_configuration",
          "invalid_time",
          "malformed_assertion",
          "claims_invalid",
          "signature_invalid",
          "unknown_key",
          "jwks_unavailable",
          "refresh_cooldown",
        ] as const
      ).includes(input.reason)
    )
      throw new TypeError("Invalid AccessJwtVerificationError fields.");
    super(input);
  }
}

/** Safe P-256 boundary failures. DER/SPKI bytes and platform causes never cross this boundary. */
export class P256VerificationError extends Data.TaggedError("P256VerificationError")<{
  readonly reason:
    | "crypto_unavailable"
    | "invalid_input"
    | "invalid_spki"
    | "malformed_signature"
    | "signature_invalid";
}> {
  constructor(input: {
    readonly reason:
      | "crypto_unavailable"
      | "invalid_input"
      | "invalid_spki"
      | "malformed_signature"
      | "signature_invalid";
  }) {
    if (
      !(
        [
          "crypto_unavailable",
          "invalid_input",
          "invalid_spki",
          "malformed_signature",
          "signature_invalid",
        ] as const
      ).includes(input.reason)
    )
      throw new TypeError("Invalid P256VerificationError fields.");
    super(input);
  }
}

/** Safe failures at the immutable R2 boundary. Object names, ETags and platform
 * causes deliberately never cross this error boundary. */
export class ImmutableR2Error extends Data.TaggedError("ImmutableR2Error")<{
  readonly operation: "put_if_absent" | "head" | "read" | "list" | "delete";
  readonly reason:
    | "invalid_key"
    | "invalid_prefix"
    | "invalid_cursor"
    | "invalid_limit"
    | "invalid_body"
    | "not_found"
    | "already_exists"
    | "too_large"
    | "metadata_mismatch"
    | "platform_failed";
}> {
  constructor(input: {
    readonly operation: "put_if_absent" | "head" | "read" | "list" | "delete";
    readonly reason:
      | "invalid_key"
      | "invalid_prefix"
      | "invalid_cursor"
      | "invalid_limit"
      | "invalid_body"
      | "not_found"
      | "already_exists"
      | "too_large"
      | "metadata_mismatch"
      | "platform_failed";
  }) {
    if (
      !(["put_if_absent", "head", "read", "list", "delete"] as const).includes(input.operation) ||
      !(
        [
          "invalid_key",
          "invalid_prefix",
          "invalid_cursor",
          "invalid_limit",
          "invalid_body",
          "not_found",
          "already_exists",
          "too_large",
          "metadata_mismatch",
          "platform_failed",
        ] as const
      ).includes(input.reason)
    )
      throw new TypeError("Invalid ImmutableR2Error fields.");
    super({ operation: input.operation, reason: input.reason });
  }
}

/** Safe failures at the Blob R2 boundary. Blob object names, metadata and
 * platform causes deliberately never cross this error boundary. */
export class BlobR2Error extends Data.TaggedError("BlobR2Error")<{
  readonly operation: "put_if_absent" | "head" | "read" | "delete";
  readonly reason:
    | "invalid_key"
    | "not_found"
    | "already_exists"
    | "too_large"
    | "metadata_mismatch"
    | "platform_failed";
}> {
  constructor(input: {
    readonly operation: "put_if_absent" | "head" | "read" | "delete";
    readonly reason:
      | "invalid_key"
      | "not_found"
      | "already_exists"
      | "too_large"
      | "metadata_mismatch"
      | "platform_failed";
  }) {
    if (
      !(["put_if_absent", "head", "read", "delete"] as const).includes(input.operation) ||
      !(
        [
          "invalid_key",
          "not_found",
          "already_exists",
          "too_large",
          "metadata_mismatch",
          "platform_failed",
        ] as const
      ).includes(input.reason)
    )
      throw new TypeError("Invalid BlobR2Error fields.");
    super({ operation: input.operation, reason: input.reason });
  }
}

/** Manifest signing configuration is independent of all HMAC capability rings. */
export class ManifestKeyRingConfigurationError extends Data.TaggedError(
  "ManifestKeyRingConfigurationError",
)<{
  readonly reason:
    | "invalid_key_id"
    | "invalid_public_key"
    | "invalid_private_key"
    | "key_pair_mismatch"
    | "duplicate_key_id"
    | "too_many_prior_keys"
    | "revoked_key_active";
}> {
  constructor(input: {
    readonly reason:
      | "invalid_key_id"
      | "invalid_public_key"
      | "invalid_private_key"
      | "key_pair_mismatch"
      | "duplicate_key_id"
      | "too_many_prior_keys"
      | "revoked_key_active";
  }) {
    if (
      !(
        [
          "invalid_key_id",
          "invalid_public_key",
          "invalid_private_key",
          "key_pair_mismatch",
          "duplicate_key_id",
          "too_many_prior_keys",
          "revoked_key_active",
        ] as const
      ).includes(input.reason)
    )
      throw new TypeError("Invalid ManifestKeyRingConfigurationError fields.");
    super({ reason: input.reason });
  }
}

export class ManifestSigningError extends Data.TaggedError("ManifestSigningError")<{
  readonly reason: "invalid_bytes" | "invalid_key_configuration" | "crypto_unavailable";
}> {
  constructor(input: {
    readonly reason: "invalid_bytes" | "invalid_key_configuration" | "crypto_unavailable";
  }) {
    if (
      !(["invalid_bytes", "invalid_key_configuration", "crypto_unavailable"] as const).includes(
        input.reason,
      )
    )
      throw new TypeError("Invalid ManifestSigningError fields.");
    super({ reason: input.reason });
  }
}

export class ManifestVerificationError extends Data.TaggedError("ManifestVerificationError")<{
  readonly reason:
    | "invalid_bytes"
    | "malformed_signature"
    | "unknown_or_revoked_key"
    | "signature_invalid"
    | "crypto_unavailable";
}> {
  constructor(input: {
    readonly reason:
      | "invalid_bytes"
      | "malformed_signature"
      | "unknown_or_revoked_key"
      | "signature_invalid"
      | "crypto_unavailable";
  }) {
    if (
      !(
        [
          "invalid_bytes",
          "malformed_signature",
          "unknown_or_revoked_key",
          "signature_invalid",
          "crypto_unavailable",
        ] as const
      ).includes(input.reason)
    )
      throw new TypeError("Invalid ManifestVerificationError fields.");
    super({ reason: input.reason });
  }
}

export type RuntimeError =
  | RuntimeConfigError
  | ExternalServiceError
  | OperationTimeoutError
  | AdapterContractError
  | TelemetryInputRejectedError
  | CapabilityConfigurationError
  | CapabilitySigningError
  | CapabilityVerificationError
  | WorkerBoundaryError
  | DurableObjectBoundaryError
  | DurableObjectInvocationError
  | RequestBodyError
  | AccessJwtVerificationError
  | P256VerificationError
  | ImmutableR2Error
  | ManifestKeyRingConfigurationError
  | ManifestSigningError
  | ManifestVerificationError;

export const isRetryableExternalServiceError = (error: unknown): error is ExternalServiceError =>
  error instanceof ExternalServiceError && error.retryable;

export type RuntimeErrorClassification = RuntimeError["_tag"] | "unclassified";

/** A bounded telemetry classification. Never serialize an Error or its message. */
export const classifyRuntimeError = (error: unknown): RuntimeErrorClassification => {
  if (error instanceof RuntimeConfigError) return "RuntimeConfigError";
  if (error instanceof ExternalServiceError) return "ExternalServiceError";
  if (error instanceof OperationTimeoutError) return "OperationTimeoutError";
  if (error instanceof AdapterContractError) return "AdapterContractError";
  if (error instanceof TelemetryInputRejectedError) return "TelemetryInputRejectedError";
  if (error instanceof CapabilityConfigurationError) return "CapabilityConfigurationError";
  if (error instanceof CapabilitySigningError) return "CapabilitySigningError";
  if (error instanceof CapabilityVerificationError) return "CapabilityVerificationError";
  if (error instanceof WorkerBoundaryError) return "WorkerBoundaryError";
  if (error instanceof DurableObjectBoundaryError) return "DurableObjectBoundaryError";
  if (error instanceof DurableObjectInvocationError) return "DurableObjectInvocationError";
  if (error instanceof RequestBodyError) return "RequestBodyError";
  if (error instanceof AccessJwtVerificationError) return "AccessJwtVerificationError";
  if (error instanceof P256VerificationError) return "P256VerificationError";
  if (error instanceof ImmutableR2Error) return "ImmutableR2Error";
  if (error instanceof ManifestKeyRingConfigurationError)
    return "ManifestKeyRingConfigurationError";
  if (error instanceof ManifestSigningError) return "ManifestSigningError";
  if (error instanceof ManifestVerificationError) return "ManifestVerificationError";
  return "unclassified";
};
