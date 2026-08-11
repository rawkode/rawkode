/** @enchiridion/effect-module */
import { parseJSONWithoutDuplicateMembers } from "@enchiridion/protocol";
import {
  type DurableObjectNamespaceNative,
  makeFixedDurableObjectClient,
} from "@enchiridion/runtime";
import { Data, Effect } from "effect";

/**
 * The one Directory-to-OwnerVault control transport. Every control invocation
 * is a fixed-shape POST with a bounded JSON body against a configuration-owned
 * shard and path; responses are byte-capped, exact-parsed JSON (duplicate
 * members rejected) surfaced as `unknown` for the caller's exact decoders.
 */
export const ownerVaultControlMaximumRequestBytes = 16_384;
export const ownerVaultControlMaximumResponseBytes = 4_096;

/** Control endpoints are closed lowercase segments; query and fragment cannot appear. */
const controlPath = /^\/v2\/control\/[a-z0-9-]+$/u;
const shardName = /^[A-Za-z0-9._:-]{1,128}$/u;

export class OwnerVaultControlTransportError extends Data.TaggedError(
  "OwnerVaultControlTransportError",
)<{ readonly reason: "invalid_request" | "unavailable" | "response_rejected" }> {}

export interface OwnerVaultControlTarget {
  readonly name: string;
  readonly path: string;
}

const transportFailure = (
  reason:
    | "invalid_configuration"
    | "namespace_failed"
    | "stub_failed"
    | "response_malformed"
    | "response_too_large"
    | "unexpected_status",
): OwnerVaultControlTransportError =>
  new OwnerVaultControlTransportError({
    reason:
      reason === "invalid_configuration"
        ? "invalid_request"
        : reason === "response_malformed" || reason === "response_too_large"
          ? "response_rejected"
          : "unavailable",
  });

/**
 * Invokes one OwnerVault control endpoint through runtime's audited fixed
 * Durable Object client. The request body must be present and bounded; the
 * response is decoded inside Effect and never leaves this seam undecoded.
 */
export const invokeOwnerVaultControl = (
  namespace: DurableObjectNamespaceNative,
  target: OwnerVaultControlTarget,
  requestBody: Uint8Array<ArrayBuffer>,
): Effect.Effect<unknown, OwnerVaultControlTransportError> =>
  Effect.suspend(() => {
    if (
      !shardName.test(target.name) ||
      !controlPath.test(target.path) ||
      requestBody.byteLength === 0 ||
      requestBody.byteLength > ownerVaultControlMaximumRequestBytes
    )
      return Effect.fail(new OwnerVaultControlTransportError({ reason: "invalid_request" }));
    return makeFixedDurableObjectClient(namespace, {
      name: target.name,
      method: "POST",
      path: target.path,
      headers: { "content-type": "application/json" },
      expectedStatus: 200,
      maximumRequestBytes: ownerVaultControlMaximumRequestBytes,
      maximumResponseBytes: ownerVaultControlMaximumResponseBytes,
    })
      .invoke(requestBody)
      .pipe(
        Effect.mapError((error) => transportFailure(error.reason)),
        Effect.flatMap((response) =>
          Effect.try({
            try: () =>
              parseJSONWithoutDuplicateMembers(
                new TextDecoder("utf-8", { fatal: true }).decode(response.body),
              ),
            catch: () => new OwnerVaultControlTransportError({ reason: "response_rejected" }),
          }),
        ),
      );
  });
