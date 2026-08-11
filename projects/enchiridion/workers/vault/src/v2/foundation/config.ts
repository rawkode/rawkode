/** @enchiridion/effect-module */
import {
  type AccessJwtVerificationError,
  type AccessJwtVerifier,
  type CredentialBindingKeyRing,
  type InternalCapabilityKeyRing,
  layerAccessJwtVerifier,
  makeCredentialBindingKeyRing,
  makeInternalCapabilityKeyRing,
  validateDistinctKeyRings,
} from "@enchiridion/runtime";
import { Context, Data, Effect, Layer, Redacted } from "effect";

export interface AccessAssertionConfigInput {
  readonly teamDomain: string;
  readonly jwksURL: string;
  readonly applicationAudience: string;
  readonly jwksCacheTTLSeconds: number;
  readonly jwksRefreshCooldownSeconds: number;
  readonly maximumAssertionLifetimeSeconds: number;
}

export interface IssuerHmacKey {
  readonly keyID: string;
  readonly secret: Redacted.Redacted;
}

/** Separate from issuer keys: never reuse identity HMAC material for capabilities. */
export interface InternalCapabilityKey {
  readonly keyID: string;
  readonly secret: Redacted.Redacted;
}

export interface InternalCapabilityKeys {
  readonly current: InternalCapabilityKey;
  readonly prior: readonly InternalCapabilityKey[];
}

export interface VaultV2ConfigInput {
  readonly access: AccessAssertionConfigInput;
  readonly issuerWriteKey: IssuerHmacKey;
  /** Includes the current issuer key exactly once, plus bounded retained prior keys. */
  readonly issuerReadKeys: readonly IssuerHmacKey[];
  readonly capabilityKeys: InternalCapabilityKeys;
  readonly credentialQuota: number;
}

export interface AccessAssertionConfig {
  readonly teamDomain: string;
  readonly issuer: string;
  readonly jwksURL: string;
  readonly applicationAudience: string;
  readonly jwksCacheTTLSeconds: number;
  readonly jwksRefreshCooldownSeconds: number;
  readonly maximumAssertionLifetimeSeconds: number;
}

/** Only constructed by `makeVaultV2Config` after all raw input is validated. */
export interface VaultV2Config {
  readonly access: AccessAssertionConfig;
  readonly credentialBindingKeys: CredentialBindingKeyRing;
  readonly internalCapabilityKeys: InternalCapabilityKeyRing;
  readonly credentialQuota: number;
}

export class VaultV2ConfigurationError extends Data.TaggedError("VaultV2ConfigurationError")<{
  readonly reason: "invalid_access" | "invalid_key_material" | "invalid_quota";
}> {}

export const VaultV2Config = Context.GenericTag<VaultV2Config>(
  "@enchiridion/worker-vault/v2/VaultV2Config",
);

const keyID = /^[A-Za-z0-9_-]{1,64}$/u;
const audience = /^[A-Za-z0-9._~-]{1,512}$/u;
const minimumSecretLength = 32;
const maximumPriorKeys = 2;

const safeBoundedInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1 && value <= 3_600;

const cloudflareAccessSuffix = ".cloudflareaccess.com";
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** Canonical ASCII Cloudflare Access team host; no URL spellings are accepted. */
const normalizedTeamDomain = (value: string): string | undefined => {
  if (
    value.length === 0 ||
    value.length > 253 ||
    value !== value.toLowerCase() ||
    !value.endsWith(cloudflareAccessSuffix)
  )
    return undefined;
  const labels = value.split(".");
  if (labels.length !== 3 || labels.some((label) => label.length === 0 || label.length > 63))
    return undefined;
  if (labels.some((label) => !dnsLabel.test(label))) return undefined;
  return value;
};

const validSecret = (secret: Redacted.Redacted): boolean => {
  const value = Redacted.value(secret);
  return value.length >= minimumSecretLength && new Set(value).size >= 8;
};

const validKey = (key: IssuerHmacKey | InternalCapabilityKey): boolean =>
  keyID.test(key.keyID) && validSecret(key.secret);

const invalidAccess = <A>(): Effect.Effect<A, VaultV2ConfigurationError> =>
  Effect.fail(new VaultV2ConfigurationError({ reason: "invalid_access" }));

const invalidKeyMaterial = <A>(): Effect.Effect<A, VaultV2ConfigurationError> =>
  Effect.fail(new VaultV2ConfigurationError({ reason: "invalid_key_material" }));

const validAccess = (input: AccessAssertionConfigInput): AccessAssertionConfig | undefined => {
  const teamDomain = normalizedTeamDomain(input.teamDomain);
  if (
    teamDomain === undefined ||
    !audience.test(input.applicationAudience) ||
    !safeBoundedInteger(input.jwksCacheTTLSeconds) ||
    !safeBoundedInteger(input.jwksRefreshCooldownSeconds) ||
    !safeBoundedInteger(input.maximumAssertionLifetimeSeconds)
  )
    return undefined;
  const issuer = `https://${teamDomain}`;
  const jwksURL = `https://${teamDomain}/cdn-cgi/access/certs`;
  try {
    const configured = new URL(input.jwksURL);
    if (
      configured.protocol !== "https:" ||
      configured.username.length !== 0 ||
      configured.password.length !== 0 ||
      configured.href !== jwksURL
    )
      return undefined;
  } catch {
    return undefined;
  }
  return {
    teamDomain,
    issuer,
    jwksURL,
    applicationAudience: input.applicationAudience,
    jwksCacheTTLSeconds: input.jwksCacheTTLSeconds,
    jwksRefreshCooldownSeconds: input.jwksRefreshCooldownSeconds,
    maximumAssertionLifetimeSeconds: input.maximumAssertionLifetimeSeconds,
  };
};

/**
 * The single production config gate. It validates the exact Access authority,
 * validates minimum-strength Redacted key material, and constructs the runtime
 * key rings before any Vault service receives configuration.
 */
export const makeVaultV2Config = (
  input: VaultV2ConfigInput,
): Effect.Effect<VaultV2Config, VaultV2ConfigurationError> => {
  const access = validAccess(input.access);
  if (access === undefined) return invalidAccess();
  if (!Number.isSafeInteger(input.credentialQuota) || input.credentialQuota < 1)
    return Effect.fail(new VaultV2ConfigurationError({ reason: "invalid_quota" }));
  if (
    !validKey(input.issuerWriteKey) ||
    !input.issuerReadKeys.every(validKey) ||
    !validKey(input.capabilityKeys.current) ||
    !input.capabilityKeys.prior.every(validKey) ||
    input.capabilityKeys.prior.length > maximumPriorKeys
  )
    return invalidKeyMaterial();
  const currentMatches = input.issuerReadKeys.filter(
    (key) => key.keyID === input.issuerWriteKey.keyID,
  );
  const currentReadKey = currentMatches[0];
  if (
    currentMatches.length !== 1 ||
    currentReadKey === undefined ||
    Redacted.value(currentReadKey.secret) !== Redacted.value(input.issuerWriteKey.secret)
  )
    return invalidKeyMaterial();
  return Effect.gen(function* () {
    const credentialBindingKeys = yield* makeCredentialBindingKeyRing({
      current: input.issuerWriteKey,
      prior: input.issuerReadKeys.filter((key) => key.keyID !== input.issuerWriteKey.keyID),
    }).pipe(
      Effect.mapError(() => new VaultV2ConfigurationError({ reason: "invalid_key_material" })),
    );
    const internalCapabilityKeys = yield* makeInternalCapabilityKeyRing(input.capabilityKeys).pipe(
      Effect.mapError(() => new VaultV2ConfigurationError({ reason: "invalid_key_material" })),
    );
    yield* validateDistinctKeyRings(credentialBindingKeys, internalCapabilityKeys).pipe(
      Effect.mapError(() => new VaultV2ConfigurationError({ reason: "invalid_key_material" })),
    );
    return {
      access,
      credentialBindingKeys,
      internalCapabilityKeys,
      credentialQuota: input.credentialQuota,
    };
  });
};

export const layerVaultV2Config = (
  input: VaultV2ConfigInput,
): Layer.Layer<VaultV2Config, VaultV2ConfigurationError> =>
  Layer.effect(VaultV2Config, makeVaultV2Config(input));

/** Production composition: validated config plus the audited runtime Access verifier. */
export const layerVaultV2Foundation = (
  input: VaultV2ConfigInput,
): Layer.Layer<
  VaultV2Config | AccessJwtVerifier,
  VaultV2ConfigurationError | AccessJwtVerificationError
> =>
  Layer.unwrapEffect(
    Effect.map(makeVaultV2Config(input), (config) =>
      Layer.merge(
        Layer.succeed(VaultV2Config, config),
        layerAccessJwtVerifier({
          jwksURL: config.access.jwksURL,
          cacheTTLSeconds: config.access.jwksCacheTTLSeconds,
          refreshCooldownSeconds: config.access.jwksRefreshCooldownSeconds,
        }),
      ),
    ),
  );
