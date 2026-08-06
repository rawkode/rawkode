/** @enchiridion/effect-module */
import type { SignedCapability } from "@enchiridion/runtime";
import type { Effect } from "effect";
import type { DirectoryIdentity } from "../foundation/schemas";

export const directoryCapabilityPath = "/v2/internal/directory/resolve";
export const directoryOperation = "resolve-or-bootstrap";

export interface DirectoryWireRequest {
  readonly aliases: readonly string[];
  readonly currentAlias: string;
  readonly accessExpiresAt: number;
  readonly operation: typeof directoryOperation;
}

export interface DirectoryInvocation {
  readonly capability: SignedCapability;
  readonly request: DirectoryWireRequest;
}

export interface DirectoryResolution extends DirectoryIdentity {
  /** Deterministic, binding-scoped initializer id. It is never derived from Access claims. */
  readonly initID: string;
  readonly activeGeneration: number;
  readonly routingEpoch: number;
  readonly credentialEpoch: number;
}

export interface DirectoryReplay {
  readonly fingerprint: string;
  /** Capability expiry remains the authorization boundary. */
  readonly expiresAt: number;
  /** Replay reservation survives bounded retry/skew after capability expiry. */
  readonly retainUntil: number;
  readonly resolution: DirectoryResolution;
}

export interface DirectoryState {
  readonly aliases: Readonly<Record<string, string>>;
  readonly bindings: Readonly<Record<string, DirectoryResolution>>;
  readonly replays: Readonly<Record<string, DirectoryReplay>>;
}

export interface DirectorySecureRandom {
  /** Returns one opaque identifier for a single domain-separated purpose. */
  readonly identifier: (purpose: "owner" | "vault") => Effect.Effect<string, DirectoryRandomError>;
}

export interface DirectoryRandomError {
  readonly _tag: "DirectoryRandomError";
}
