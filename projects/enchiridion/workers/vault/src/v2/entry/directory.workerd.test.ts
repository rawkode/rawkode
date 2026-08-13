import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanonicalJSON,
  canonicalJSONStringify,
  decodeClientWebSocketFrame,
  decodeDeviceRegisterRequest,
  decodeMutationRequest,
  deviceChallengeProofSigningPayload,
  mutationCommandSHA256,
  protocolVersion,
  sha256Hex,
  signedDeviceRequestSigningPayload,
  syncChangeSigningPayload,
} from "@enchiridion/protocol";
import {
  CapabilityAudience,
  CapabilityAuthority,
  CapabilityMethod,
  type OwnerVaultCredentialFenceClaimsInput,
  type OwnerVaultDirectoryControlClaimsInput,
  OwnerVaultDirectoryControlResource,
  type OwnerVaultPrivateInitializeClaimsInput,
  type OwnerVaultSnapshotReceiptLeaseV1ClaimsInput,
  type OwnerVaultSocketAdmissionClaimsInput,
  makeOwnerVaultDirectoryControlKeyRing,
  makeOwnerVaultSocketAdmissionKeyRing,
  ownerVaultSocketAdmissionHeader,
  p256P1363ToCanonicalLowSDer,
  signOwnerVaultDirectoryControl,
  signOwnerVaultSocketAdmission,
} from "@enchiridion/runtime";
import { Effect, Redacted } from "effect";
import WebSocket from "ws";
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
type SocketFault = "accept-failure" | "early-callback" | "finalize-loss" | "prepared-loss";
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
const ownerVaultUser = (route: string, body: Uint8Array) => {
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
const ownerVaultSocketAdmissionRing = () =>
  makeOwnerVaultSocketAdmissionKeyRing({
    current: {
      keyID: "socket-current",
      secret: secret("socket-admission-current-secret-0123456789-abcdef"),
    },
    prior: [],
    revokedKeyIDs: [],
  });
const owner = "owner-workerd-fixture";
const vault = "vault-workerd-fixture";
const digest = "A".repeat(43);
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
const signedOwnerVaultUserBody = async <A extends Readonly<Record<string, unknown>>>(
  path: string,
  command: A,
  jti: string,
): Promise<Uint8Array> => {
  const config = await Effect.runPromise(makeVaultV2Config(input));
  const capabilities = await Effect.runPromise(
    makeInternalCapabilityFactory.pipe(Effect.provideService(VaultV2Config, config)),
  );
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const signed = await Effect.runPromise(
    capabilities.signer.sign(
      {
        audience: CapabilityAudience.OwnerVault,
        authority: CapabilityAuthority.OwnerVault,
        method: CapabilityMethod.POST,
        path,
        canonicalQuery: "",
        bodySHA256: sha256Hex(new TextEncoder().encode(JSON.stringify(command))),
        ownerID: owner,
        vaultID: vault,
        credentialEpoch: 1,
        generationEpoch: 2,
        jti,
        ttlSeconds: 60,
      },
      nowSeconds,
    ),
  );
  return new TextEncoder().encode(JSON.stringify({ capability: signed.value, command }));
};
const base64 = (bytes: Uint8Array): string => {
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return btoa(output);
};
const p256Device = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = base64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  return {
    publicKey,
    sign: async (message: Uint8Array): Promise<string> => {
      const canonicalMessage = new Uint8Array(message.byteLength);
      canonicalMessage.set(message);
      const raw = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          canonicalMessage,
        ),
      );
      const signature = p256P1363ToCanonicalLowSDer(raw);
      if (signature === undefined) throw new Error("P-256 test signature was invalid");
      return base64(signature);
    },
  };
};
const signedSocketAdmission = async (
  deviceID = "socket-device-workerd-0001",
  suffix = "0001",
  options: { readonly sessionSuffix?: string; readonly ttlSeconds?: number } = {},
): Promise<{ readonly capability: string; readonly expiresAtMilliseconds: number }> => {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const ring = await Effect.runPromise(ownerVaultSocketAdmissionRing());
  const sessionSuffix = options.sessionSuffix ?? suffix;
  const ttlSeconds = options.ttlSeconds ?? 60;
  const input = {
    ownerID: owner,
    vaultID: vault,
    generationEpoch: 2,
    routingEpoch: 1,
    credentialEpoch: 1,
    controlEpoch: 1,
    securityFloor: 1,
    deviceID,
    sessionID: `socket-session-workerd-${sessionSuffix}`,
    operationID: `socket-operation-workerd-${suffix}`,
    jti: `socket-admission-jti-workerd-${suffix}`,
    method: "GET" as const,
    canonicalQuery: "",
    bodySHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    upgradeNonce: "AAAAAAAAAAAAAAAAAAAAAA",
    ttlSeconds,
  } satisfies OwnerVaultSocketAdmissionClaimsInput;
  const signed = await Effect.runPromise(signOwnerVaultSocketAdmission(input, ring, nowSeconds));
  return {
    capability: signed.value,
    expiresAtMilliseconds: (nowSeconds + ttlSeconds) * 1_000,
  };
};
const socketUpgradeStatus = (
  capability: string,
  headers: Record<string, string> = {},
): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(`${baseURL}/__test/owner-vault-socket`, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        [ownerVaultSocketAdmissionHeader]: capability,
        ...headers,
      },
    });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 101);
    });
    request.once("error", reject);
    request.end();
  });

const openOwnerVaultSocket = (
  capability: string,
): Promise<{ readonly socket: WebSocket; readonly challenge: Readonly<Record<string, unknown>> }> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseURL.replace(/^http/u, "ws")}/__test/owner-vault-socket`, {
      headers: { [ownerVaultSocketAdmissionHeader]: capability },
    });
    socket.once("message", (data) => {
      try {
        const challenge = record(JSON.parse(data.toString()));
        if (challenge === undefined) return reject(new Error("socket challenge was not an object"));
        resolve({ socket, challenge });
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
    socket.once("close", (code) => reject(new Error(`socket closed before response: ${code}`)));
  });
const nextSocketJSON = (socket: WebSocket): Promise<Readonly<Record<string, unknown>>> =>
  new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        const decoded = record(JSON.parse(data.toString()));
        if (decoded === undefined) return reject(new Error("socket message was not an object"));
        resolve(decoded);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
    socket.once("close", (code, reason) =>
      reject(new Error(`socket closed before acknowledgement: ${code} ${reason.toString()}`)),
    );
  });
const socketClose = (socket: WebSocket): Promise<number> =>
  new Promise((resolve) => socket.once("close", (code) => resolve(code)));
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const start = async (socketFault?: SocketFault): Promise<void> => {
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
      ...(socketFault === undefined
        ? []
        : ["--var", `ENCHIRIDION_V2_OWNER_VAULT_SOCKET_TEST_FAULT:${socketFault}`]),
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

const restart = async (socketFault?: SocketFault): Promise<void> => {
  // `start` assigns the module-scoped child asynchronously, which TypeScript
  // cannot infer through its body at each test call site.
  const running = process as ReturnType<typeof Bun.spawn> | undefined;
  if (running === undefined) throw new Error("Directory Workerd fixture was not running");
  running.kill();
  await running.exited;
  process = undefined;
  await start(socketFault);
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
    await restart();
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

    // This exercises the real fixed internal WebSocket relay. A correctly
    // signed ovsa1 token still cannot create a pair until its device is
    // durably registered; bearer-like headers are rejected even earlier.
    const socketCapability = await signedSocketAdmission();
    expect(await socketUpgradeStatus(socketCapability.capability)).toBe(401);
    expect(
      await socketUpgradeStatus(socketCapability.capability, { Authorization: "Bearer forbidden" }),
    ).toBe(400);
    expect((await fetch(`${baseURL}/__v2/internal/owner-vault/socket`)).status).toBe(404);

    process?.kill();
    if (process !== undefined) await process.exited;
    process = undefined;
    await start();
    const replay = await ownerVaultControl("private-initialize", initBody);
    expect(replay.status).toBe(200);
    expect(JSON.stringify(await replay.json())).toBe(JSON.stringify(acknowledgement));

    // The fixture crosses the production OwnerVault namespace only.  It
    // creates a real P-256 key, obtains a P02 challenge, and completes the
    // signed registration before C2 is allowed to snapshot its device row.
    const device = await p256Device();
    const challengeCommand = {
      protocolVersion,
      devicePublicKey: device.publicKey,
      challengeAudience: "owner-vault-device-onboarding",
    } as const;
    const challengeResponse = await ownerVaultUser(
      "devices/challenge",
      await signedOwnerVaultUserBody(
        "/__v2/internal/owner-vault/devices/challenge",
        challengeCommand,
        "device-challenge-capability-0001",
      ),
    );
    expect(challengeResponse.status).toBe(200);
    const challenge = record(await challengeResponse.json());
    expect(challenge).toMatchObject({ protocolVersion });
    if (
      challenge === undefined ||
      typeof challenge.challengeID !== "string" ||
      typeof challenge.challengeBase64 !== "string" ||
      typeof challenge.expiresAt !== "number"
    )
      throw new Error("P02 challenge response was malformed");
    const proof = {
      protocolVersion,
      challengeID: challenge.challengeID,
      challengeAudience: challengeCommand.challengeAudience,
      challengeBase64: challenge.challengeBase64,
      expiresAt: challenge.expiresAt,
      nonce: "AQEBAQEBAQEBAQEBAQEBAQ",
      devicePublicKey: device.publicKey,
      signature: "",
    };
    const registerCommand = {
      challengeProof: {
        ...proof,
        signature: await device.sign(deviceChallengeProofSigningPayload(proof)),
      },
      idempotencyKey: "device-registration-workerd-0001",
    } as const;
    expect(() => decodeDeviceRegisterRequest(registerCommand)).not.toThrow();
    const registerBody = await signedOwnerVaultUserBody(
      "/__v2/internal/owner-vault/devices/complete",
      registerCommand,
      "device-complete-capability-0001",
    );
    const registration = await ownerVaultUser("devices/complete", registerBody);
    if (registration.status !== 200)
      throw new Error(
        `P02 registration failed: ${registration.status} ${await registration.text()}`,
      );
    const registered = record(await registration.json());
    if (registered === undefined || typeof registered.deviceID !== "string")
      throw new Error("P02 registration response was malformed");
    const registrationReplay = await ownerVaultUser("devices/complete", registerBody);
    expect(registrationReplay.status).toBe(200);
    expect(JSON.stringify(await registrationReplay.json())).toBe(JSON.stringify(registered));

    const mutationCommand = {
      type: "mutation" as const,
      operationID: "opaque-append-operation-0001",
      deviceID: registered.deviceID,
      sourceKind: "http" as const,
      payloadSHA256: sha256Hex(new Uint8Array([1])),
      payloadBase64: "AQ==",
      causalVersion: 0,
    };
    const issuedAt = Date.now();
    const unsignedMutationEnvelope = {
      protocolVersion,
      method: "POST" as const,
      canonicalPath: "/v2/mutations",
      canonicalQuery: "",
      bodySHA256: mutationCommandSHA256(mutationCommand),
      requestID: "opaque-append-request-0001",
      idempotencyKey: "opaque-append-idempotency-0001",
      ownerID: owner,
      vaultID: vault,
      generationEpoch: 2,
      actorDeviceID: registered.deviceID,
      authEpoch: 1,
      credentialEpoch: 1,
      issuedAt,
      expiresAt: issuedAt + 60_000,
      nonce: "AgICAgICAgICAgICAgICAg",
      deviceSignature: "",
    };
    const mutationRequest = {
      envelope: {
        ...unsignedMutationEnvelope,
        deviceSignature: await device.sign(
          signedDeviceRequestSigningPayload(unsignedMutationEnvelope),
        ),
      },
      command: mutationCommand,
    } as const;
    expect(() => decodeMutationRequest(mutationRequest)).not.toThrow();
    const appendBody = await signedOwnerVaultUserBody(
      "/__v2/internal/owner-vault/append",
      mutationRequest,
      "opaque-append-capability-0001",
    );
    const append = await ownerVaultUser("append", appendBody);
    expect(append.status).toBe(200);
    expect(await append.json()).toMatchObject({
      protocolVersion,
      operationID: mutationCommand.operationID,
      logSequence: 1,
    });
    const appendReplay = await ownerVaultUser("append", appendBody);
    expect(appendReplay.status).toBe(200);
    expect(await appendReplay.json()).toMatchObject({ logSequence: 1 });

    // These cases retain the production OwnerVault DO and namespace. The
    // test-only constructor fault is configured by Workerd, never by a
    // request, so each failure exercises a durable socket-saga boundary.
    expect(
      await socketUpgradeStatus(
        (await signedSocketAdmission(registered.deviceID, "socket-baseline-0001")).capability,
      ),
    ).toBe(101);
    await restart("accept-failure");
    expect(
      await socketUpgradeStatus(
        (await signedSocketAdmission(registered.deviceID, "accept-failure-0001")).capability,
      ),
    ).toBe(503);
    await restart();
    expect(
      await socketUpgradeStatus(
        (await signedSocketAdmission(registered.deviceID, "accept-retry-0001")).capability,
      ),
    ).toBe(101);

    await restart("finalize-loss");
    expect(
      await socketUpgradeStatus(
        (await signedSocketAdmission(registered.deviceID, "finalize-loss-0001")).capability,
      ),
    ).toBe(503);
    await restart();
    expect(
      await socketUpgradeStatus(
        (await signedSocketAdmission(registered.deviceID, "finalize-retry-0001")).capability,
      ),
    ).toBe(101);

    // A crash after PREPARED owns neither a live pair nor unbounded quota. On
    // a fresh isolate the persisted alarm reaps the expired receipt/session,
    // allowing a newly signed operation to reuse that exact session ID.
    await restart("prepared-loss");
    expect(
      await socketUpgradeStatus(
        (
          await signedSocketAdmission(registered.deviceID, "prepared-loss-0001", {
            sessionSuffix: "prepared-reuse-0001",
            ttlSeconds: 1,
          })
        ).capability,
      ),
    ).toBe(503);
    await restart();
    await wait(1_500);
    expect(
      await socketUpgradeStatus(
        (
          await signedSocketAdmission(registered.deviceID, "prepared-retry-0001", {
            sessionSuffix: "prepared-reuse-0001",
          })
        ).capability,
      ),
    ).toBe(101);

    // An abrupt peer termination reaches the DO terminal callback. Whether
    // Workerd reports it as close or error, release is idempotent and the
    // exact session identifier can be admitted by a later signed operation.
    const abruptAdmission = await signedSocketAdmission(registered.deviceID, "abrupt-0001", {
      sessionSuffix: "abrupt-reuse-0001",
    });
    const { socket: abruptSocket } = await openOwnerVaultSocket(abruptAdmission.capability);
    const abruptClose = socketClose(abruptSocket);
    abruptSocket.terminate();
    expect(await abruptClose).toBe(1006);
    await wait(200);
    expect(
      await socketUpgradeStatus(
        (
          await signedSocketAdmission(registered.deviceID, "abrupt-retry-0001", {
            sessionSuffix: "abrupt-reuse-0001",
          })
        ).capability,
      ),
    ).toBe(101);

    // A registered device can now reach the real socket admission saga. The
    // test relay does not host a WebSocket implementation or seed state.
    expect(
      await socketUpgradeStatus((await signedSocketAdmission(registered.deviceID)).capability),
    ).toBe(101);

    // The PREPARED receipt is a single durable compare-and-claim. Concurrent
    // copies of a byte-identical admission capability cannot manufacture two
    // pairs or consume quota twice: exactly one creator reaches 101 and the
    // other observes its durable replay receipt.
    const concurrentAdmission = await signedSocketAdmission(registered.deviceID, "0003");
    expect(
      (
        await Promise.all([
          socketUpgradeStatus(concurrentAdmission.capability),
          socketUpgradeStatus(concurrentAdmission.capability),
        ])
      ).sort((left, right) => left - right),
    ).toEqual([101, 409]);

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
      resource: OwnerVaultDirectoryControlResource.SnapshotReceiptLeaseV1,
      path: "/__v2/internal/owner-vault/snapshot-receipt-lease-v1" as const,
      method: "POST" as const,
      canonicalQuery: "" as const,
      bodySHA256: sha256Hex(new TextEncoder().encode(JSON.stringify(snapshot))),
      ...snapshot,
    } satisfies Omit<OwnerVaultSnapshotReceiptLeaseV1ClaimsInput, "ttlSeconds">;
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

    // The injected callback runs after `acceptWebSocket` but before the
    // normal finalizer. Its first frame must be discarded: the subsequent
    // valid typed P02 frame remains the second append, not a third one.
    await restart("early-callback");

    // The next callback is decoded through the typed P02 frame codec, bound
    // to the persisted CSPRNG challenge/session nonce, and appended through
    // the durable receipt/log authority rather than a test-only mutation.
    const liveAdmission = await signedSocketAdmission(registered.deviceID, "0002");
    const { socket, challenge: socketChallenge } = await openOwnerVaultSocket(
      liveAdmission.capability,
    );
    if (typeof socketChallenge.challengeBase64 !== "string")
      throw new Error("OwnerVault socket did not return its persisted challenge nonce");
    const unsignedSyncChange = {
      type: "syncChange" as const,
      protocolVersion,
      vaultID: vault,
      deviceID: registered.deviceID,
      authEpoch: 1,
      credentialEpoch: 1,
      generationEpoch: 2,
      sessionNonce: socketChallenge.challengeBase64,
      assertionExpiresAt: liveAdmission.expiresAtMilliseconds,
      operationID: "socket-sync-operation-0001",
      sourceKind: "websocket" as const,
      payloadSHA256: sha256Hex(new Uint8Array([2])),
      causalVersion: 1,
      observedHighWater: 1,
      frameID: "AwMDAwMDAwMDAwMDAwMDAw",
      signingPayloadVersion: 1 as const,
      payloadBase64: "Ag==",
      deviceSignature: "",
    };
    const syncChange = {
      ...unsignedSyncChange,
      deviceSignature: await device.sign(syncChangeSigningPayload(unsignedSyncChange)),
    };
    expect(() => decodeClientWebSocketFrame(syncChange)).not.toThrow();
    socket.send(JSON.stringify(syncChange));
    expect(await nextSocketJSON(socket)).toMatchObject({
      type: "syncAcknowledged",
      protocolVersion,
      operationID: syncChange.operationID,
      logSequence: 2,
    });

    // A callback reloads its durable attachment/receipt before decoding a
    // frame. A correctly signed frame with a different binding nonce must
    // close rather than being attributed to the accepted socket.
    const wrongNonceAdmission = await signedSocketAdmission(registered.deviceID, "0004");
    const { socket: wrongNonceSocket } = await openOwnerVaultSocket(wrongNonceAdmission.capability);
    const unsignedWrongNonce = {
      ...unsignedSyncChange,
      sessionNonce: "BAQEBAQEBAQEBAQEBAQEBA",
      operationID: "socket-sync-operation-0002",
      frameID: "BAQEBAQEBAQEBAQEBAQEBA",
    };
    const wrongNonceFrame = {
      ...unsignedWrongNonce,
      deviceSignature: await device.sign(syncChangeSigningPayload(unsignedWrongNonce)),
    };
    const wrongNonceClose = socketClose(wrongNonceSocket);
    wrongNonceSocket.send(JSON.stringify(wrongNonceFrame));
    expect(await wrongNonceClose).toBe(4401);
    const fencedSocketClose = socketClose(socket);

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
    const fenceBody = await signedOwnerVaultControlBody(fence, {
      ...fenceBinding,
      ttlSeconds: 60,
    });
    const fenceResponse = await ownerVaultControl("credential-fence", fenceBody);
    expect(fenceResponse.status).toBe(200);
    const fenced = await fenceResponse.json();
    expect(record(fenced)?.durableReceipt).toEqual(expect.any(String));
    // Fence persistence happens before the best-effort live socket close;
    // the open hibernating socket receives the durable revocation close.
    expect(await fencedSocketClose).toBe(4401);
    const fenceReplay = await ownerVaultControl("credential-fence", fenceBody);
    expect(fenceReplay.status).toBe(200);
    expect(JSON.stringify(await fenceReplay.json())).toBe(JSON.stringify(fenced));

    await restart();
    // Attachment storage contains only durable identifiers/nonce/expiry. A
    // restart cannot revive its old capability or session after the fence.
    expect(await socketUpgradeStatus(liveAdmission.capability)).toBe(401);
    const fencedRestartReplay = await ownerVaultControl("credential-fence", fenceBody);
    expect(fencedRestartReplay.status).toBe(200);
    expect(JSON.stringify(await fencedRestartReplay.json())).toBe(JSON.stringify(fenced));
  }, 45_000);
});
