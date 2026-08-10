import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CanonicalJSON, canonicalJSONStringify, sha256Hex } from "@enchiridion/protocol";
import {
  type OwnerVaultCredentialFenceClaimsInput,
  type OwnerVaultDirectoryControlClaimsInput,
  OwnerVaultDirectoryControlResource,
  type OwnerVaultPrivateInitializeClaimsInput,
  type OwnerVaultSnapshotClaimsInput,
  makeOwnerVaultDirectoryControlKeyRing,
  signOwnerVaultDirectoryControl,
} from "@enchiridion/runtime";
import { Effect, Redacted } from "effect";
import { makeDirectoryInvocation } from "../directory/gateway";
import { VaultV2Config, type VaultV2ConfigInput, makeVaultV2Config } from "../foundation/config";
import {
  InternalCapabilityFactory,
  makeInternalCapabilityFactory,
  makeVersionedIssuerHasher,
  verifiedAccessIssuer,
} from "../foundation/crypto";
import { opaqueAccessSubject } from "../foundation/schemas";

const fixtureAssertion =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImZpeHR1cmUifQ.eyJmaXh0dXJlIjp0cnVlfQ.fixture";

const vaultDirectory = join(import.meta.dir, "..", "..", "..");
const wrangler = join(vaultDirectory, "node_modules", ".bin", "wrangler");

const port = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("no TCP port"));
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });

let process: ReturnType<typeof Bun.spawn> | undefined;
let baseURL = "";
let persistDirectory: string | undefined;
let localPort = 0;
const bootstrap = () =>
  fetch(`${baseURL}/__v2/internal/bootstrap`, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": fixtureAssertion },
  });
const get = (path: string) => fetch(`${baseURL}/${path}`);
const ownerVaultControl = (route: string, body: Uint8Array) => {
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return fetch(`${baseURL}/__test/owner-vault-control/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: copy.buffer,
  });
};
const secret = (value: string): Redacted.Redacted => Redacted.make(value);
const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("test setup invalid");
  return value;
};
const input: VaultV2ConfigInput = {
  access: {
    teamDomain: "team.cloudflareaccess.com",
    jwksURL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    applicationAudience: "fixture-audience",
    jwksCacheTTLSeconds: 60,
    jwksRefreshCooldownSeconds: 10,
    maximumAssertionLifetimeSeconds: 300,
  },
  issuerWriteKey: { keyID: "current", secret: secret("fixture-issuer-current-secret-0123456789") },
  issuerReadKeys: [
    { keyID: "current", secret: secret("fixture-issuer-current-secret-0123456789") },
    { keyID: "prior", secret: secret("fixture-issuer-prior-secret-0123456789") },
  ],
  capabilityKeys: {
    current: {
      keyID: "directory",
      secret: secret("fixture-capability-current-secret-0123456789"),
    },
    prior: [],
  },
  credentialQuota: 8,
};
const invocationJSON = (value: {
  readonly capability: { readonly value: string };
  readonly request: {
    readonly aliases: readonly string[];
    readonly currentAlias: string;
    readonly accessExpiresAt: number;
    readonly operation: string;
  };
}): CanonicalJSON => ({
  capability: { value: value.capability.value },
  request: {
    aliases: [...value.request.aliases],
    currentAlias: value.request.currentAlias,
    accessExpiresAt: value.request.accessExpiresAt,
    operation: value.request.operation,
  },
});
const signedInvocation = async (jti: string, nowSeconds: number, accessExpiresAt: number) => {
  const config = await Effect.runPromise(makeVaultV2Config(input));
  const aliases = await Effect.runPromise(
    makeVersionedIssuerHasher(config.credentialBindingKeys).aliases({
      issuer: required(verifiedAccessIssuer("https://team.cloudflareaccess.com")),
      subject: required(opaqueAccessSubject("fixture-subject")),
    }),
  );
  const capabilities = await Effect.runPromise(
    makeInternalCapabilityFactory.pipe(Effect.provideService(VaultV2Config, config)),
  );
  const invocation = await Effect.runPromise(
    makeDirectoryInvocation(aliases, accessExpiresAt, jti, nowSeconds).pipe(
      Effect.provideService(InternalCapabilityFactory, capabilities),
    ),
  );
  return new TextEncoder().encode(canonicalJSONStringify(invocationJSON(invocation)));
};
const invokeSigned = (body: Uint8Array) => {
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return fetch(`${baseURL}/__test/directory-invocation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: copy.buffer,
  });
};
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const resolutionIdentity = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = Object.fromEntries(Object.entries(value));
  const resolution = root.resolution;
  if (resolution === null || typeof resolution !== "object" || Array.isArray(resolution))
    return undefined;
  const source = Object.fromEntries(Object.entries(resolution));
  return typeof source.ownerID === "string" && typeof source.vaultID === "string"
    ? `${source.ownerID}:${source.vaultID}`
    : undefined;
};
const ownerVaultControlRing = () =>
  makeOwnerVaultDirectoryControlKeyRing({
    current: {
      keyID: "owner-control-current",
      secret: secret("owner-control-current-secret-0123456789-abcdef"),
    },
    prior: [],
    revokedKeyIDs: [],
  });
const owner = "owner-workerd-fixture";
const vault = "vault-workerd-fixture";
const digest = "a".repeat(64);
const privateInit = {
  ownerID: owner,
  vaultID: vault,
  generationEpoch: 2,
  routingEpoch: 1,
  credentialEpoch: 1,
  controlEpoch: 1,
  securityFloor: 1,
  operationID: "private-initialize-op-0001",
  jti: "private-initialize-jti-0001",
  sourceGeneration: 1,
  targetGeneration: 2,
  allocationID: "allocation-workerd-0001",
  initID: "init-workerd-target-0001",
  backupID: "backup-workerd-source-0001",
  manifestDigest: digest,
} as const;
const privateInitializeBinding = (command = privateInit) =>
  ({
    resource: OwnerVaultDirectoryControlResource.PrivateInitialize,
    path: "/__v2/internal/owner-vault/private-initialize" as const,
    method: "POST" as const,
    canonicalQuery: "" as const,
    bodySHA256: sha256Hex(new TextEncoder().encode(JSON.stringify(command))),
    ...command,
  }) satisfies Omit<OwnerVaultPrivateInitializeClaimsInput, "ttlSeconds">;
const signedOwnerVaultControlBody = async <A extends Readonly<Record<string, unknown>>>(
  command: A,
  input: OwnerVaultDirectoryControlClaimsInput,
): Promise<Uint8Array> => {
  const ring = await Effect.runPromise(ownerVaultControlRing());
  const signed = await Effect.runPromise(
    signOwnerVaultDirectoryControl(input, ring, Math.floor(Date.now() / 1_000)),
  );
  return new TextEncoder().encode(JSON.stringify({ capability: signed.value, command }));
};

const start = async (): Promise<void> => {
  baseURL = `http://127.0.0.1:${localPort}`;
  process = Bun.spawn(
    [
      wrangler,
      "dev",
      "--config=src/v2/entry/wrangler.directory-workerd-test.jsonc",
      `--port=${localPort}`,
      "--local",
      `--persist-to=${persistDirectory}`,
      "--show-interactive-dev-session=false",
    ],
    { cwd: vaultDirectory, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await bootstrap()).ok) return;
    } catch {
      // Workerd has not started yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Directory Workerd fixture did not start");
};

beforeAll(async () => {
  localPort = await port();
  persistDirectory = mkdtempSync(join(tmpdir(), "enchiridion-directory-workerd-"));
  await start();
}, 45_000);

afterAll(async () => {
  process?.kill();
  if (process !== undefined) await process.exited;
  if (persistDirectory !== undefined) rmSync(persistDirectory, { recursive: true, force: true });
  // Wrangler places its generated bundle beside the test-only config; never leave it in source.
  rmSync(join(import.meta.dir, ".wrangler"), { recursive: true, force: true });
});

describe("v2 fixed-shard CredentialDirectory RPC on Workerd", () => {
  test("converges concurrent current/prior aliases through the production Access gateway", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => bootstrap()));
    const bodies = await Promise.all(results.map((item) => item.json()));
    expect(results.every((item) => item.ok)).toBe(true);
    expect(bodies.every((body) => record(body)?.ok === true)).toBe(true);
    expect(bodies[0]).toMatchObject({ ok: true });
    const identities = bodies.map(resolutionIdentity);
    expect(new Set(identities).size).toBe(1);
    const first = await (await bootstrap()).json();
    const second = await (await bootstrap()).json();
    expect(record(first)?.ok).toBe(true);
    expect(record(second)?.ok).toBe(true);
    expect(second).toEqual(first);
  }, 45_000);

  test("replays byte-identical signed DO input across relaunch and rejects altered bytes sharing its JTI", async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const jti = "relaunch-exact-jti-000001";
    const body = await signedInvocation(jti, nowSeconds, nowSeconds + 60);
    const before = await invokeSigned(body);
    expect(before.status).toBe(200);
    const first = await before.json();
    process?.kill();
    if (process !== undefined) await process.exited;
    process = undefined;
    await start();
    const after = await invokeSigned(body);
    expect(after.status).toBe(200);
    expect(JSON.stringify(await after.json())).toBe(JSON.stringify(first));
    const altered = await signedInvocation(jti, nowSeconds, nowSeconds + 59);
    expect((await invokeSigned(altered)).status).toBe(503);
  }, 45_000);

  test("rejects missing or malformed Access assertions before Directory invocation", async () => {
    const missing = await fetch(`${baseURL}/__v2/internal/bootstrap`, { method: "POST" });
    const malformed = await fetch(`${baseURL}/__v2/internal/bootstrap`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
    });
    expect(missing.status).toBe(503);
    expect(malformed.status).toBe(503);
  });

  test("retains the same fixed-shard binding across a Workerd relaunch", async () => {
    const before = await (await bootstrap()).json();
    expect(record(before)?.ok).toBe(true);
    process?.kill();
    if (process !== undefined) await process.exited;
    process = undefined;
    await start();
    const after = await (await bootstrap()).json();
    expect(record(after)?.ok).toBe(true);
    expect(resolutionIdentity(after)).toBe(resolutionIdentity(before));
  }, 45_000);

  test("commits an exact private-init receipt across a restart and fences before returning", async () => {
    const initBody = await signedOwnerVaultControlBody(privateInit, {
      ...privateInitializeBinding(),
      ttlSeconds: 60,
    });
    const first = await ownerVaultControl("private-initialize", initBody);
    expect(first.status).toBe(200);
    const acknowledgement = await first.json();
    expect(record(acknowledgement)?.durableReceipt).toEqual(expect.any(String));

    process?.kill();
    if (process !== undefined) await process.exited;
    process = undefined;
    await start();
    const replay = await ownerVaultControl("private-initialize", initBody);
    expect(replay.status).toBe(200);
    expect(JSON.stringify(await replay.json())).toBe(JSON.stringify(acknowledgement));

    const snapshot = {
      ownerID: owner,
      vaultID: vault,
      generationEpoch: 2,
      routingEpoch: 1,
      credentialEpoch: 1,
      controlEpoch: 1,
      securityFloor: 1,
      operationID: "snapshot-operation-id-0001",
      jti: "snapshot-control-jti-0001",
      backupID: "backup-workerd-source-0001",
      sourceGeneration: 2,
      sourceRoutingEpoch: 1,
      sourceCredentialEpoch: 1,
      sourceControlEpoch: 1,
      sourceSecurityFloor: 1,
    } as const;
    const snapshotBinding = {
      resource: OwnerVaultDirectoryControlResource.Snapshot,
      path: "/__v2/internal/owner-vault/snapshot" as const,
      method: "POST" as const,
      canonicalQuery: "" as const,
      bodySHA256: sha256Hex(new TextEncoder().encode(JSON.stringify(snapshot))),
      ...snapshot,
    } satisfies Omit<OwnerVaultSnapshotClaimsInput, "ttlSeconds">;
    const snapshotBody = await signedOwnerVaultControlBody(snapshot, {
      ...snapshotBinding,
      ttlSeconds: 60,
    });
    const firstPin = await ownerVaultControl("snapshot", snapshotBody);
    expect(firstPin.status).toBe(200);
    const secondPin = await ownerVaultControl("snapshot", snapshotBody);
    expect(secondPin.status).toBe(200);
    expect(JSON.stringify(await secondPin.json())).toBe(
      JSON.stringify(await firstPin.clone().json()),
    );

    const fence = {
      ownerID: owner,
      vaultID: vault,
      generationEpoch: 2,
      routingEpoch: 2,
      credentialEpoch: 2,
      controlEpoch: 1,
      securityFloor: 1,
      operationID: "credential-fence-op-0001",
      jti: "credential-fence-jti-0001",
      expectedCredentialEpoch: 1,
      expectedRoutingEpoch: 1,
      expectedControlEpoch: 1,
      expectedSecurityFloor: 1,
      raisedCredentialEpoch: 2,
      raisedRoutingEpoch: 2,
    } as const;
    const fenceBinding = {
      resource: OwnerVaultDirectoryControlResource.CredentialFence,
      path: "/__v2/internal/owner-vault/credential-fence" as const,
      method: "POST" as const,
      canonicalQuery: "" as const,
      bodySHA256: sha256Hex(new TextEncoder().encode(JSON.stringify(fence))),
      ...fence,
    } satisfies Omit<OwnerVaultCredentialFenceClaimsInput, "ttlSeconds">;
    const fenceResponse = await ownerVaultControl(
      "credential-fence",
      await signedOwnerVaultControlBody(fence, { ...fenceBinding, ttlSeconds: 60 }),
    );
    expect(fenceResponse.status).toBe(200);
    const fenced = await fenceResponse.json();
    expect(record(fenced)?.durableReceipt).toEqual(expect.any(String));
    const fenceReplay = await ownerVaultControl(
      "credential-fence",
      await signedOwnerVaultControlBody(fence, { ...fenceBinding, ttlSeconds: 60 }),
    );
    expect(fenceReplay.status).toBe(200);
    expect(JSON.stringify(await fenceReplay.json())).toBe(JSON.stringify(fenced));
  }, 45_000);
});
