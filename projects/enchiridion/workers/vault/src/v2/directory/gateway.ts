/** @enchiridion/effect-module */
import { CapabilityAudience, CapabilityAuthority, CapabilityMethod } from "@enchiridion/runtime";
import { Effect } from "effect";
import { type CredentialBindingAliases, InternalCapabilityFactory } from "../foundation/crypto";
import { isCanonicalDirectoryAlias } from "./invariants";
import { directoryRequestFingerprint } from "./service";
import {
  type DirectoryInvocation,
  type DirectoryWireRequest,
  directoryCapabilityPath,
  directoryOperation,
} from "./types";

const maxAliases = 3;

export class DirectoryGatewayError extends Error {
  readonly _tag = "DirectoryGatewayError";
  constructor(readonly reason: "invalid_aliases" | "invalid_time" | "capability_unavailable") {
    super(reason);
  }
}

const validAliases = (value: CredentialBindingAliases): boolean =>
  value.ordered.length >= 1 &&
  value.ordered.length <= maxAliases &&
  value.ordered[0]?.digest === value.current.digest &&
  value.ordered[0]?.current === true &&
  value.ordered.every(
    (entry, index) =>
      entry.version === "v2" &&
      isCanonicalDirectoryAlias(entry.digest) &&
      (index === 0 ? entry.current : !entry.current),
  ) &&
  new Set(value.ordered.map((entry) => entry.digest)).size === value.ordered.length;

/**
 * Worker-side internal RPC construction. The input aliases are clone-safe opaque HMAC values;
 * neither Access issuer nor subject survives this boundary. The exact body is capability-bound.
 */
export const makeDirectoryInvocation = (
  aliases: CredentialBindingAliases,
  accessExpiresAt: number,
  jti: string,
  nowSeconds: number,
): Effect.Effect<DirectoryInvocation, DirectoryGatewayError, InternalCapabilityFactory> => {
  if (
    !validAliases(aliases) ||
    !Number.isSafeInteger(accessExpiresAt) ||
    !Number.isSafeInteger(nowSeconds) ||
    accessExpiresAt <= nowSeconds
  )
    return Effect.fail(new DirectoryGatewayError("invalid_aliases"));
  const request: DirectoryWireRequest = {
    aliases: aliases.ordered.map((entry) => entry.digest),
    currentAlias: aliases.current.digest,
    accessExpiresAt,
    operation: directoryOperation,
  };
  const bodySHA256 = directoryRequestFingerprint(request);
  if (bodySHA256 === undefined) return Effect.fail(new DirectoryGatewayError("invalid_aliases"));
  return Effect.flatMap(InternalCapabilityFactory, (capabilities) =>
    capabilities.signer
      .sign(
        {
          audience: CapabilityAudience.Directory,
          authority: CapabilityAuthority.Directory,
          method: CapabilityMethod.POST,
          path: directoryCapabilityPath,
          canonicalQuery: "",
          bodySHA256,
          credentialEpoch: 0,
          generationEpoch: 0,
          jti,
          ttlSeconds: Math.min(60, accessExpiresAt - nowSeconds),
        },
        nowSeconds,
      )
      .pipe(
        Effect.map((capability) => ({ capability, request })),
        Effect.mapError(() => new DirectoryGatewayError("capability_unavailable")),
      ),
  );
};
