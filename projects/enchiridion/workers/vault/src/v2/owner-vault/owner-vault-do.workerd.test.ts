import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deviceChallengeProofSigningPayload,
  protocolVersion,
  sha256Hex,
} from "@enchiridion/protocol";
import {
  CapabilityAudience,
  CapabilityAuthority,
  CapabilityMethod,
  OwnerVaultDirectoryControlResource,
  type OwnerVaultPrivateInitializeClaimsInput,
  type OwnerVaultRestoreReceiptLeaseV1ClaimsInput,
  type OwnerVaultSnapshotReceiptLeaseV1ClaimsInput,
  type OwnerVaultSocketAdmissionClaimsInput,
  type OwnerVaultSourceSnapshotPublicationV1,
  makeOwnerVaultDirectoryControlKeyRing,
  makeOwnerVaultSocketAdmissionKeyRing,
  ownerVaultSocketAdmissionHeader,
  p256P1363ToCanonicalLowSDer,
  signOwnerVaultDirectoryControl,
  signOwnerVaultSocketAdmission,
} from "@enchiridion/runtime";
import { Effect, Redacted } from "effect";
import WebSocket from "ws";
import {
  type OwnerVaultFloorSyncCommand,
  type OwnerVaultInitializationCommand,
  signOwnerVaultFloorSync,
  signOwnerVaultInitialization,
} from "../directory/lifecycle";
import { VaultV2Config, type VaultV2ConfigInput, makeVaultV2Config } from "../foundation/config";
import {
  makeDirectoryControlCapabilityFactory,
  makeInternalCapabilityFactory,
} from "../foundation/crypto";
import { ownerVaultControlOperationLeaseMilliseconds } from "./control-operation";

const vaultDirectory = join(import.meta.dir, "..", "..", "..");
const wrangler = join(vaultDirectory, "node_modules", ".bin", "wrangler");
const fixtureAssertion =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImZpeHR1cmUifQ.eyJmaXh0dXJlIjp0cnVlfQ.fixture";
const manifestPrivateKeyBase64 =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnqgn2CchsOl0SE25sbl1fSF4GeFyIyhcGXfmk+nORRihRANCAARgDj/LiRqx4+xQpW1yKXYVWEGHCg+4hJxT4PbHMBrFWthHzkiAYKYvic295OBVCfvBwjOQEZVKtWmC+t+IMFbF";

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

let child: ReturnType<typeof Bun.spawn> | undefined;
let baseURL = "";
let persistDirectory: string | undefined;
let logDirectory: string | undefined;
let localPort = 0;
const logFiles: string[] = [];

const ready = () => fetch(`${baseURL}/__owner_vault_do_ready__`);
const c2CapacityTrace = (
  method: "GET" | "POST" | "DELETE" = "GET",
  target: "source" | "restore-target" | "capacity-restore-target" = "source",
) =>
  fetch(`${baseURL}/__test/c2-capacity-trace`, {
    method,
    headers: target === "source" ? {} : { "x-enchiridion-owner-vault-test-target": target },
  });
const start = async (
  options: {
    readonly c2RecoveryAccessTrap?: boolean;
    readonly c2CapacityAccessTrace?: boolean;
  } = {},
): Promise<void> => {
  baseURL = `http://127.0.0.1:${localPort}`;
  const stdoutPath = join(logDirectory ?? tmpdir(), `wrangler-stdout-${logFiles.length}.log`);
  const stderrPath = join(logDirectory ?? tmpdir(), `wrangler-stderr-${logFiles.length + 1}.log`);
  logFiles.push(stdoutPath, stderrPath);
  child = Bun.spawn(
    [
      wrangler,
      "dev",
      "--config=src/v2/owner-vault/wrangler.owner-vault-workerd-test.jsonc",
      `--port=${localPort}`,
      "--local",
      `--persist-to=${persistDirectory}`,
      "--show-interactive-dev-session=false",
      ...(options.c2RecoveryAccessTrap
        ? ["--var", "ENCHIRIDION_V2_C2_TEST_RECOVERY_ACCESS_TRAP=enabled"]
        : []),
      ...(options.c2CapacityAccessTrace
        ? ["--var", "ENCHIRIDION_V2_C2_TEST_CAPACITY_ACCESS_TRACE=enabled"]
        : []),
    ],
    {
      cwd: vaultDirectory,
      stdin: "ignore",
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await ready()).ok) return;
    } catch {
      // Workerd has not bound its local port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("OwnerVault DO Workerd fixture did not start");
};
const stop = async (): Promise<void> => {
  const running = child as ReturnType<typeof Bun.spawn> | undefined;
  if (running === undefined) return;
  running.kill();
  await running.exited;
  child = undefined;
};
const restart = async (
  options: {
    readonly c2RecoveryAccessTrap?: boolean;
    readonly c2CapacityAccessTrace?: boolean;
  } = {},
): Promise<void> => {
  await stop();
  await start(options);
};

const owner = "owner-do-workerd-fixture-0001";
const vault = "vault-do-workerd-fixture-0001";
const secret = (value: string): Redacted.Redacted => Redacted.make(value);
const configInput: VaultV2ConfigInput = {
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
const directoryControlSigner = async () => {
  const config = await Effect.runPromise(makeVaultV2Config(configInput));
  const factory = await Effect.runPromise(
    makeDirectoryControlCapabilityFactory.pipe(Effect.provideService(VaultV2Config, config)),
  );
  return factory.signer;
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

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const postControl = (
  route: string,
  body: string | Uint8Array,
  target: "source" | "restore-target" | "capacity-restore-target" = "source",
) => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return fetch(`${baseURL}/__test/owner-vault-control/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(target === "source" ? {} : { "x-enchiridion-owner-vault-test-target": target }),
    },
    body: copy.buffer,
  });
};

const initCommand: OwnerVaultInitializationCommand = {
  ownerID: owner,
  vaultID: vault,
  generationEpoch: 2,
  operationID: "ensure-init-op-do-workerd-0001",
  credentialEpoch: 1,
  routingEpoch: 1,
  controlEpoch: 1,
  initDigest: sha256Hex(new TextEncoder().encode("owner-vault-do-workerd-init")),
};
const floorCommand: OwnerVaultFloorSyncCommand = {
  ownerID: owner,
  vaultID: vault,
  generationEpoch: 2,
  operationID: "floor-sync-op-do-workerd-0001",
  credentialEpoch: 1,
  routingEpoch: 1,
  controlEpoch: 1,
  floorSyncDigest: sha256Hex(new TextEncoder().encode("owner-vault-do-workerd-floor")),
};
const signedInitializationBody = async (
  command: OwnerVaultInitializationCommand,
): Promise<{ readonly body: string; readonly token: string }> => {
  const signer = await directoryControlSigner();
  const signed = await Effect.runPromise(
    signOwnerVaultInitialization(
      signer,
      command,
      command.operationID,
      Math.floor(Date.now() / 1_000),
    ),
  );
  return { body: JSON.stringify({ capability: signed.value, command }), token: signed.value };
};
const signedFloorSyncBody = async (
  command: OwnerVaultFloorSyncCommand,
): Promise<{ readonly body: string; readonly token: string }> => {
  const signer = await directoryControlSigner();
  const signed = await Effect.runPromise(
    signOwnerVaultFloorSync(signer, command, command.operationID, Math.floor(Date.now() / 1_000)),
  );
  return { body: JSON.stringify({ capability: signed.value, command }), token: signed.value };
};

const digest = "A".repeat(43);
const privateInit = {
  ownerID: owner,
  vaultID: vault,
  generationEpoch: 2,
  routingEpoch: 1,
  credentialEpoch: 1,
  controlEpoch: 1,
  securityFloor: 1,
  operationID: "private-initialize-do-op-0001",
  jti: "private-initialize-do-jti-0001",
  sourceGeneration: 1,
  targetGeneration: 2,
  allocationID: "allocation-do-workerd-0001",
  initID: "init-do-workerd-target-0001",
  backupID: "backup-do-workerd-source-0001",
  manifestDigest: digest,
} as const;
type PrivateInitializeCommand = Omit<
  OwnerVaultPrivateInitializeClaimsInput,
  "ttlSeconds" | "resource" | "path" | "method" | "canonicalQuery" | "bodySHA256"
>;
type SnapshotCommand = Omit<
  OwnerVaultSnapshotReceiptLeaseV1ClaimsInput,
  "ttlSeconds" | "resource" | "path" | "method" | "canonicalQuery" | "bodySHA256"
>;
type RestoreCommand = Omit<
  OwnerVaultRestoreReceiptLeaseV1ClaimsInput,
  "ttlSeconds" | "resource" | "path" | "method" | "canonicalQuery" | "bodySHA256"
>;

const signedPrivateInitializeBody = async (
  command: PrivateInitializeCommand = privateInit,
): Promise<{
  readonly body: string;
  readonly token: string;
}> => {
  const binding = {
    resource: OwnerVaultDirectoryControlResource.PrivateInitialize,
    path: "/__v2/internal/owner-vault/private-initialize" as const,
    method: "POST" as const,
    canonicalQuery: "" as const,
    bodySHA256: sha256Hex(new TextEncoder().encode(JSON.stringify(command))),
    ...command,
  } satisfies Omit<OwnerVaultPrivateInitializeClaimsInput, "ttlSeconds">;
  const ring = await Effect.runPromise(ownerVaultControlRing());
  const signed = await Effect.runPromise(
    signOwnerVaultDirectoryControl(
      { ...binding, ttlSeconds: 60 },
      ring,
      Math.floor(Date.now() / 1_000),
    ),
  );
  return {
    body: JSON.stringify({ capability: signed.value, command }),
    token: signed.value,
  };
};
const signedSnapshotBody = async (
  command: SnapshotCommand,
): Promise<{
  readonly body: string;
  readonly token: string;
}> => {
  const binding = {
    resource: OwnerVaultDirectoryControlResource.SnapshotReceiptLeaseV1,
    path: "/__v2/internal/owner-vault/snapshot-receipt-lease-v1" as const,
    method: "POST" as const,
    canonicalQuery: "" as const,
    bodySHA256: sha256Hex(new TextEncoder().encode(JSON.stringify(command))),
    ...command,
  } satisfies Omit<OwnerVaultSnapshotReceiptLeaseV1ClaimsInput, "ttlSeconds">;
  const signed = await Effect.runPromise(
    signOwnerVaultDirectoryControl(
      { ...binding, ttlSeconds: 60 },
      await Effect.runPromise(ownerVaultControlRing()),
      Math.floor(Date.now() / 1_000),
    ),
  );
  return { body: JSON.stringify({ capability: signed.value, command }), token: signed.value };
};
const signedRestoreBody = async (
  command: RestoreCommand,
): Promise<{
  readonly body: string;
  readonly token: string;
}> => {
  const binding = {
    resource: OwnerVaultDirectoryControlResource.RestoreReceiptLeaseV1,
    path: "/__v2/internal/owner-vault/restore-receipt-lease-v1" as const,
    method: "POST" as const,
    canonicalQuery: "" as const,
    bodySHA256: sha256Hex(new TextEncoder().encode(JSON.stringify(command))),
    ...command,
  } satisfies Omit<OwnerVaultRestoreReceiptLeaseV1ClaimsInput, "ttlSeconds">;
  const signed = await Effect.runPromise(
    signOwnerVaultDirectoryControl(
      { ...binding, ttlSeconds: 60 },
      await Effect.runPromise(ownerVaultControlRing()),
      Math.floor(Date.now() / 1_000),
    ),
  );
  return { body: JSON.stringify({ capability: signed.value, command }), token: signed.value };
};
const signedUserBody = async <A extends Readonly<Record<string, unknown>>>(
  path: string,
  command: A,
  jti: string,
  ttlSeconds = 60,
): Promise<{ readonly body: string; readonly token: string }> => {
  const config = await Effect.runPromise(makeVaultV2Config(configInput));
  const capabilities = await Effect.runPromise(
    makeInternalCapabilityFactory.pipe(Effect.provideService(VaultV2Config, config)),
  );
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
        ttlSeconds,
      },
      Math.floor(Date.now() / 1_000),
    ),
  );
  return { body: JSON.stringify({ capability: signed.value, command }), token: signed.value };
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
  deviceID: string,
  suffix: string,
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
    sessionID: `socket-session-do-workerd-${sessionSuffix}`,
    operationID: `socket-operation-do-workerd-${suffix}`,
    jti: `socket-admission-jti-do-wk-${suffix}`,
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
    socket.once("close", (code) => reject(new Error(`socket closed before challenge: ${code}`)));
  });
const socketClose = (socket: WebSocket): Promise<number> =>
  new Promise((resolve) => socket.once("close", (code) => resolve(code)));
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Bearers observed by this suite, scanned against storage and logs at the end. */
const observedBearers: string[] = [fixtureAssertion, manifestPrivateKeyBase64];
let acceptedSocketToken: string | undefined;
let userCapabilityToken: string | undefined;
/** P06-R: the challenge minted under a short-TTL receipt whose slot the
 * durable alarm reaps; the challenge row itself keeps its later deadline. */
let shortReceiptChallengeID: string | undefined;
/** The one committed initialization wire message; replays must reuse these
 * exact bytes because the durable receipt binds the exact signed claims. */
let committedInit: { readonly body: string; readonly ack: string } | undefined;
let c2CapacitySeed:
  | {
      readonly manifestDigest: string;
      readonly sourceSnapshotPublication: OwnerVaultSourceSnapshotPublicationV1;
      readonly backupID: string;
      readonly initID: string;
      readonly allocationID: string;
    }
  | undefined;

beforeAll(async () => {
  localPort = await port();
  persistDirectory = mkdtempSync(join(tmpdir(), "enchiridion-owner-vault-do-workerd-"));
  logDirectory = mkdtempSync(join(tmpdir(), "enchiridion-owner-vault-do-logs-"));
  await start();
}, 60_000);

afterAll(async () => {
  await stop();
  if (persistDirectory !== undefined) rmSync(persistDirectory, { recursive: true, force: true });
  if (logDirectory !== undefined) rmSync(logDirectory, { recursive: true, force: true });
  // Wrangler places its generated bundle beside the test-only config; never leave it in source.
  rmSync(join(import.meta.dir, ".wrangler"), { recursive: true, force: true });
});

describe("v2 OwnerVault DO on Workerd", () => {
  test("commits ensure-initialized and sync-floors acknowledgements byte-identically across a restart", async () => {
    const init = await signedInitializationBody(initCommand);
    observedBearers.push(init.token);
    const first = await postControl("ensure-initialized", init.body);
    expect(first.status).toBe(200);
    const initAck = await first.text();
    expect(record(JSON.parse(initAck))?.durableReceipt).toEqual(expect.any(String));

    const floor = await signedFloorSyncBody(floorCommand);
    observedBearers.push(floor.token);
    const floorFirst = await postControl("sync-floors", floor.body);
    expect(floorFirst.status).toBe(200);
    const floorAck = await floorFirst.text();
    expect(record(JSON.parse(floorAck))?.durableReceipt).toEqual(expect.any(String));

    // Same-process replays return the durable acknowledgement bytes.
    expect(await (await postControl("ensure-initialized", init.body)).text()).toBe(initAck);
    expect(await (await postControl("sync-floors", floor.body)).text()).toBe(floorAck);

    await restart();

    // A fresh isolate replays both acknowledgements from durable storage only.
    const initReplay = await postControl("ensure-initialized", init.body);
    expect(initReplay.status).toBe(200);
    expect(await initReplay.text()).toBe(initAck);
    const floorReplay = await postControl("sync-floors", floor.body);
    expect(floorReplay.status).toBe(200);
    expect(await floorReplay.text()).toBe(floorAck);
    committedInit = { body: init.body, ack: initAck };
  }, 90_000);

  test("rejects smuggled, mistyped, and duplicate-member lifecycle envelopes at decode, before verification", async () => {
    // Control experiment: the well-formed command with an unverifiable
    // capability reaches verification and fails closed there instead.
    const wellFormed = JSON.stringify({
      capability: "not-a-directory-capability",
      command: { ...initCommand, operationID: "ensure-init-op-do-workerd-0002" },
    });
    const verified = await postControl("ensure-initialized", wellFormed);
    expect(verified.status).toBe(403);
    expect(await verified.text()).toBe('{"ok":false}');

    // A smuggled extra member fails the exact key set before any verify.
    const smuggled = JSON.stringify({
      capability: "not-a-directory-capability",
      command: { ...initCommand, smuggled: true },
    });
    const smuggledResponse = await postControl("ensure-initialized", smuggled);
    expect(smuggledResponse.status).toBe(400);
    expect(await smuggledResponse.text()).toBe('{"ok":false}');

    // A mistyped epoch fails typeof narrowing; RegExp coercion cannot admit it.
    const mistyped = JSON.stringify({
      capability: "not-a-directory-capability",
      command: { ...initCommand, generationEpoch: "2" },
    });
    const mistypedResponse = await postControl("ensure-initialized", mistyped);
    expect(mistypedResponse.status).toBe(400);
    expect(await mistypedResponse.text()).toBe('{"ok":false}');

    // A missing member fails the exact key set.
    const { initDigest: _dropped, ...missingMember } = initCommand;
    const missing = JSON.stringify({
      capability: "not-a-directory-capability",
      command: missingMember,
    });
    const missingResponse = await postControl("ensure-initialized", missing);
    expect(missingResponse.status).toBe(400);
    expect(await missingResponse.text()).toBe('{"ok":false}');

    // Duplicate members are a noncanonical encoding and fail the strict parser.
    const duplicate = `{"capability":"not-a-directory-capability","command":{"ownerID":"${owner}","ownerID":"${owner}","vaultID":"${vault}","generationEpoch":2,"operationID":"ensure-init-op-do-workerd-0003","credentialEpoch":1,"routingEpoch":1,"controlEpoch":1,"initDigest":"${initCommand.initDigest}"}}`;
    const duplicateResponse = await postControl("ensure-initialized", duplicate);
    expect(duplicateResponse.status).toBe(400);
    expect(await duplicateResponse.text()).toBe('{"ok":false}');

    // Floor-sync applies the same exact envelope decode.
    const floorSmuggled = JSON.stringify({
      capability: "not-a-directory-capability",
      command: { ...floorCommand, smuggled: true },
    });
    const floorSmuggledResponse = await postControl("sync-floors", floorSmuggled);
    expect(floorSmuggledResponse.status).toBe(400);
    expect(await floorSmuggledResponse.text()).toBe('{"ok":false}');

    // None of the rejected envelopes disturbed the committed acknowledgement.
    if (committedInit === undefined) throw new Error("initialization was not committed");
    const replay = await postControl("ensure-initialized", committedInit.body);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(committedInit.ack);
  }, 45_000);

  test("releases sockets through the audited terminal callbacks and reaps expiry by alarm, idempotently", async () => {
    // P06-03a control plane: floors and authority are required by admission.
    const privateInitialize = await signedPrivateInitializeBody();
    observedBearers.push(privateInitialize.token);
    const initialized = await postControl("private-initialize", privateInitialize.body);
    expect(initialized.status).toBe(200);

    // Real P02 onboarding through the production namespace: challenge then
    // signed registration, both bound by user OwnerVault capabilities.
    const device = await p256Device();
    const challengeCommand = {
      protocolVersion,
      devicePublicKey: device.publicKey,
      challengeAudience: "owner-vault-device-onboarding",
    } as const;
    const challengeRequest = await signedUserBody(
      "/__v2/internal/owner-vault/devices/challenge",
      challengeCommand,
      "device-challenge-cap-do-0001",
    );
    userCapabilityToken = challengeRequest.token;
    observedBearers.push(challengeRequest.token);
    const challengeResponse = await postControl("devices/challenge", challengeRequest.body);
    expect(challengeResponse.status).toBe(200);
    const challengeBytes = await challengeResponse.text();
    const challenge = record(JSON.parse(challengeBytes));
    if (
      challenge === undefined ||
      typeof challenge.challengeID !== "string" ||
      typeof challenge.challengeBase64 !== "string" ||
      typeof challenge.expiresAt !== "number"
    )
      throw new Error("P02 challenge response was malformed");
    // A lost terminal response must replay the canonical committed receipt
    // after an isolate restart, without minting another P02 challenge.
    await restart();
    const challengeReplay = await postControl("devices/challenge", challengeRequest.body);
    expect(challengeReplay.status).toBe(200);
    expect(await challengeReplay.text()).toBe(challengeBytes);
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
      idempotencyKey: "device-registration-do-workerd-0001",
    } as const;
    const registerRequest = await signedUserBody(
      "/__v2/internal/owner-vault/devices/complete",
      registerCommand,
      "device-complete-cap-do-0001",
    );
    observedBearers.push(registerRequest.token);
    const registration = await postControl("devices/complete", registerRequest.body);
    if (registration.status !== 200)
      throw new Error(
        `P02 registration failed: ${registration.status} ${await registration.text()}`,
      );
    const registeredBytes = await registration.text();
    const registered = record(JSON.parse(registeredBytes));
    if (registered === undefined || typeof registered.deviceID !== "string")
      throw new Error("P02 registration response was malformed");
    // The completed receipt survives a second restart and replays byte-identically.
    await restart();
    const registrationReplay = await postControl("devices/complete", registerRequest.body);
    expect(registrationReplay.status).toBe(200);
    expect(await registrationReplay.text()).toBe(registeredBytes);

    // P06-R: a short-TTL capability receipt claimed at this internal dispatch
    // site arms the durable alarm at its exact signed expiry, and the alarm
    // reaps the receipt slot while the unconsumed challenge row remains for
    // its own later deadline. The exact storage evidence is asserted by the
    // final fingerprint test after workerd flushes every durable write.
    const shortDevice = await p256Device();
    const shortCommand = {
      protocolVersion,
      devicePublicKey: shortDevice.publicKey,
      challengeAudience: "owner-vault-device-onboarding",
    } as const;
    const shortRequest = await signedUserBody(
      "/__v2/internal/owner-vault/devices/challenge",
      shortCommand,
      "device-challenge-cap-short-01",
      3,
    );
    observedBearers.push(shortRequest.token);
    const shortResponse = await postControl("devices/challenge", shortRequest.body);
    expect(shortResponse.status).toBe(200);
    const shortChallenge = record(await shortResponse.json());
    if (shortChallenge === undefined || typeof shortChallenge.challengeID !== "string")
      throw new Error("short-TTL challenge response was malformed");
    shortReceiptChallengeID = shortChallenge.challengeID;
    await wait(4_500);
    // Only alarm reclamation of the expired receipt, its JTI row, and its
    // expiry-index entry can admit a second capability bearing the same JTI
    // as a fresh claim; an unreclaimed slot replays as a conflict instead.
    const reusedJtiRequest = await signedUserBody(
      "/__v2/internal/owner-vault/devices/challenge",
      shortCommand,
      "device-challenge-cap-short-01",
    );
    observedBearers.push(reusedJtiRequest.token);
    const reusedResponse = await postControl("devices/challenge", reusedJtiRequest.body);
    expect(reusedResponse.status).toBe(200);
    const reusedChallenge = record(await reusedResponse.json());
    if (reusedChallenge === undefined || typeof reusedChallenge.challengeID !== "string")
      throw new Error("reused-JTI challenge response was malformed");
    expect(reusedChallenge.challengeID).not.toBe(shortReceiptChallengeID);

    // Abrupt peer termination reaches the DO terminal callback, which now
    // decodes the attachment inside the audited boundary Effect. Release must
    // free the durable session so the same session ID is admissible again.
    const abrupt = await signedSocketAdmission(registered.deviceID, "abrupt-0001", {
      sessionSuffix: "abrupt-reuse-0001",
    });
    observedBearers.push(abrupt.capability);
    const { socket: abruptSocket } = await openOwnerVaultSocket(abrupt.capability);
    const abruptClose = socketClose(abruptSocket);
    abruptSocket.terminate();
    expect(await abruptClose).toBe(1006);
    await wait(300);
    const reuse = await signedSocketAdmission(registered.deviceID, "abrupt-retry-0001", {
      sessionSuffix: "abrupt-reuse-0001",
    });
    observedBearers.push(reuse.capability);
    const { socket: reuseSocket, challenge: reuseChallenge } = await openOwnerVaultSocket(
      reuse.capability,
    );
    acceptedSocketToken = reuse.capability;
    expect(typeof reuseChallenge.challengeBase64).toBe("string");
    const reuseClose = socketClose(reuseSocket);
    reuseSocket.terminate();
    await reuseClose;
    await wait(300);

    // An expiring admission is reaped by the rewritten alarm callback with the
    // durable 4408 close; the client-side close echo then drives the terminal
    // callback against already-released state, which must be an idempotent
    // no-op that leaves admission counts consistent.
    const expiring = await signedSocketAdmission(registered.deviceID, "expiry-0001", {
      sessionSuffix: "expiry-reuse-0001",
      ttlSeconds: 1,
    });
    observedBearers.push(expiring.capability);
    const { socket: expiringSocket } = await openOwnerVaultSocket(expiring.capability);
    const expiringClose = socketClose(expiringSocket);
    expect(await expiringClose).toBe(4408);
    await wait(300);
    const afterExpiry = await signedSocketAdmission(registered.deviceID, "expiry-retry-0001", {
      sessionSuffix: "expiry-reuse-0001",
    });
    observedBearers.push(afterExpiry.capability);
    const { socket: afterExpirySocket } = await openOwnerVaultSocket(afterExpiry.capability);
    const afterExpiryClose = socketClose(afterExpirySocket);
    afterExpirySocket.terminate();
    await afterExpiryClose;

    // The lifecycle acknowledgement survives the socket traffic unchanged.
    if (committedInit === undefined) throw new Error("initialization was not committed");
    const replay = await postControl("ensure-initialized", committedInit.body);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(committedInit.ack);
  }, 90_000);

  test("replays C2 snapshot and restore terminal evidence at the real route without live access", async () => {
    // Create both terminal receipts through the deployable DO first. The
    // source registration supplies a real snapshot inventory; no test route
    // writes control evidence or archive state directly.
    const sourceInitialize = await signedPrivateInitializeBody();
    observedBearers.push(sourceInitialize.token);
    expect((await postControl("private-initialize", sourceInitialize.body)).status).toBe(200);

    const device = await p256Device();
    const challengeCommand = {
      protocolVersion,
      devicePublicKey: device.publicKey,
      challengeAudience: "owner-vault-device-onboarding",
    } as const;
    const challengeRequest = await signedUserBody(
      "/__v2/internal/owner-vault/devices/challenge",
      challengeCommand,
      "c2-access-trace-device-challenge-0001",
    );
    observedBearers.push(challengeRequest.token);
    const challengeResponse = await postControl("devices/challenge", challengeRequest.body);
    expect(challengeResponse.status).toBe(200);
    const challenge = record(JSON.parse(await challengeResponse.text()));
    if (
      challenge === undefined ||
      typeof challenge.challengeID !== "string" ||
      typeof challenge.challengeBase64 !== "string" ||
      typeof challenge.expiresAt !== "number"
    )
      throw new Error("C2 access-trace challenge response was malformed");
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
    const registrationRequest = await signedUserBody(
      "/__v2/internal/owner-vault/devices/complete",
      {
        challengeProof: {
          ...proof,
          signature: await device.sign(deviceChallengeProofSigningPayload(proof)),
        },
        idempotencyKey: "c2-access-trace-device-registration-0001",
      },
      "c2-access-trace-device-complete-0001",
    );
    observedBearers.push(registrationRequest.token);
    const registration = await postControl("devices/complete", registrationRequest.body);
    expect(registration.status).toBe(200);

    const snapshotCommand = {
      ownerID: owner,
      vaultID: vault,
      generationEpoch: 2,
      routingEpoch: 1,
      credentialEpoch: 1,
      controlEpoch: 1,
      securityFloor: 1,
      operationID: "c2-access-trace-snapshot-op-0001",
      jti: "c2-access-trace-snapshot-jti-0001",
      backupID: "c2-access-trace-backup-0001",
      sourceGeneration: 2,
      sourceRoutingEpoch: 1,
      sourceCredentialEpoch: 1,
      sourceControlEpoch: 1,
      sourceSecurityFloor: 1,
    } satisfies SnapshotCommand;
    const snapshotRequest = await signedSnapshotBody(snapshotCommand);
    observedBearers.push(snapshotRequest.token);
    const snapshotResponse = await postControl("snapshot", snapshotRequest.body);
    if (snapshotResponse.status !== 200)
      throw new Error(
        `C2 snapshot failed: ${snapshotResponse.status} ${await snapshotResponse.text()}`,
      );
    const snapshotTerminal = await snapshotResponse.text();
    const snapshot = record(JSON.parse(snapshotTerminal));
    if (
      snapshot === undefined ||
      typeof snapshot.manifestDigest !== "string" ||
      snapshot.sourceSnapshotPublication === null ||
      typeof snapshot.sourceSnapshotPublication !== "object"
    )
      throw new Error("C2 snapshot response was malformed");
    const publication = snapshot.sourceSnapshotPublication as OwnerVaultSourceSnapshotPublicationV1;

    const targetInitialize = await signedPrivateInitializeBody({
      ownerID: owner,
      vaultID: vault,
      generationEpoch: 3,
      routingEpoch: 1,
      credentialEpoch: 1,
      controlEpoch: 1,
      securityFloor: 1,
      operationID: "c2-access-trace-target-init-op-0001",
      jti: "c2-access-trace-target-init-jti-0001",
      sourceGeneration: 2,
      targetGeneration: 3,
      allocationID: "c2-access-trace-allocation-0001",
      initID: "c2-access-trace-target-init-id-0001",
      backupID: snapshotCommand.backupID,
      manifestDigest: snapshot.manifestDigest,
    });
    observedBearers.push(targetInitialize.token);
    expect(
      (await postControl("private-initialize", targetInitialize.body, "restore-target")).status,
    ).toBe(200);

    const restoreCommand = {
      ownerID: owner,
      vaultID: vault,
      generationEpoch: 3,
      routingEpoch: 1,
      credentialEpoch: 1,
      controlEpoch: 1,
      securityFloor: 1,
      operationID: "c2-access-trace-restore-op-0001",
      jti: "c2-access-trace-restore-jti-0001",
      allocationID: "c2-access-trace-allocation-0001",
      initID: "c2-access-trace-target-init-id-0001",
      sourceGeneration: 2,
      targetGeneration: 3,
      backupID: snapshotCommand.backupID,
      manifestDigest: snapshot.manifestDigest,
      sourceSnapshotPublication: publication,
    } satisfies RestoreCommand;
    const restoreRequest = await signedRestoreBody(restoreCommand);
    observedBearers.push(restoreRequest.token);
    const restoreResponse = await postControl("restore", restoreRequest.body, "restore-target");
    if (restoreResponse.status !== 200)
      throw new Error(
        `C2 restore failed: ${restoreResponse.status} ${await restoreResponse.text()}`,
      );
    const restoreTerminal = await restoreResponse.text();
    c2CapacitySeed = {
      manifestDigest: snapshot.manifestDigest,
      sourceSnapshotPublication: publication,
      backupID: snapshotCommand.backupID,
      initID: restoreCommand.initID,
      allocationID: restoreCommand.allocationID,
    };

    const deployableEntry = readFileSync(join(vaultDirectory, "src/v2/entry/index.ts"), "utf8");
    expect(deployableEntry).not.toContain("ENCHIRIDION_V2_C2_TEST_RECOVERY_ACCESS_TRAP");
    expect(deployableEntry).not.toContain("c2RecoveryAccessTrap");
    expect(deployableEntry).not.toContain("c2-capacity-seed");
    expect(deployableEntry).not.toContain("ENCHIRIDION_V2_C2_TEST_CAPACITY_ACCESS_TRACE");
    expect(deployableEntry).not.toContain("c2CapacityAccessTrace");

    // Restart into fixture-only access traps. A terminal 200 now proves the actual DO
    // route did not call the control verifier, provider graph, manifest
    // verifier/signer, archive/R2 binding, page/object scan, or reconstruction.
    await restart({ c2RecoveryAccessTrap: true });
    const snapshotCompleted = await postControl("snapshot", snapshotRequest.body);
    expect(snapshotCompleted.status).toBe(200);
    expect(await snapshotCompleted.text()).toBe(snapshotTerminal);
    const restoreCompleted = await postControl("restore", restoreRequest.body, "restore-target");
    expect(restoreCompleted.status).toBe(200);
    expect(await restoreCompleted.text()).toBe(restoreTerminal);

    // At the lease boundary completed-read is unavailable; the same trapped
    // route therefore reaches recoverExpired and uses only fixed C2 rows and
    // their closed evidence beneath the signed 60-second deadline.
    await wait(ownerVaultControlOperationLeaseMilliseconds + 500);
    const snapshotRecovered = await postControl("snapshot", snapshotRequest.body);
    expect(snapshotRecovered.status).toBe(200);
    expect(await snapshotRecovered.text()).toBe(snapshotTerminal);
    const restoreRecovered = await postControl("restore", restoreRequest.body, "restore-target");
    expect(restoreRecovered.status).toBe(200);
    expect(await restoreRecovered.text()).toBe(restoreTerminal);
  }, 120_000);

  test("rejects full C2 snapshot and restore cohorts before any R2/archive or restore-import call", async () => {
    const deployableEntry = readFileSync(join(vaultDirectory, "src/v2/entry/index.ts"), "utf8");
    expect(deployableEntry).not.toContain("c2-capacity-seed");
    expect(deployableEntry).not.toContain("ENCHIRIDION_V2_C2_TEST_CAPACITY_ACCESS_TRACE");
    expect(deployableEntry).not.toContain("c2CapacityAccessTrace");
    if (c2CapacitySeed === undefined) {
      // Isolated invocation establishes its own normal source snapshot/proof;
      // the later capacity rejection requests still take the real C2 routes.
      const sourceInitialize = await signedPrivateInitializeBody({
        ...privateInit,
        operationID: "c2-capacity-source-init-op-0001",
        jti: "c2-capacity-source-init-jti-0001",
        initID: "c2-capacity-source-init-id-0001",
      });
      observedBearers.push(sourceInitialize.token);
      expect((await postControl("private-initialize", sourceInitialize.body)).status).toBe(200);
      const device = await p256Device();
      const challengeCommand = {
        protocolVersion,
        devicePublicKey: device.publicKey,
        challengeAudience: "owner-vault-device-onboarding",
      } as const;
      const challengeRequest = await signedUserBody(
        "/__v2/internal/owner-vault/devices/challenge",
        challengeCommand,
        "c2-capacity-source-device-challenge-0001",
      );
      observedBearers.push(challengeRequest.token);
      const challengeResponse = await postControl("devices/challenge", challengeRequest.body);
      expect(challengeResponse.status).toBe(200);
      const challenge = record(JSON.parse(await challengeResponse.text()));
      if (
        challenge === undefined ||
        typeof challenge.challengeID !== "string" ||
        typeof challenge.challengeBase64 !== "string" ||
        typeof challenge.expiresAt !== "number"
      )
        throw new Error("C2 capacity source challenge response was malformed");
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
      const registration = await signedUserBody(
        "/__v2/internal/owner-vault/devices/complete",
        {
          challengeProof: {
            ...proof,
            signature: await device.sign(deviceChallengeProofSigningPayload(proof)),
          },
          idempotencyKey: "c2-capacity-source-device-registration-0001",
        },
        "c2-capacity-source-device-complete-0001",
      );
      observedBearers.push(registration.token);
      expect((await postControl("devices/complete", registration.body)).status).toBe(200);
      const snapshotCommand = {
        ownerID: owner,
        vaultID: vault,
        generationEpoch: 2,
        routingEpoch: 1,
        credentialEpoch: 1,
        controlEpoch: 1,
        securityFloor: 1,
        operationID: "c2-capacity-source-snapshot-op-0001",
        jti: "c2-capacity-source-snapshot-jti-0001",
        backupID: "c2-capacity-source-backup-0001",
        sourceGeneration: 2,
        sourceRoutingEpoch: 1,
        sourceCredentialEpoch: 1,
        sourceControlEpoch: 1,
        sourceSecurityFloor: 1,
      } satisfies SnapshotCommand;
      const snapshotRequest = await signedSnapshotBody(snapshotCommand);
      observedBearers.push(snapshotRequest.token);
      const snapshotResponse = await postControl("snapshot", snapshotRequest.body);
      expect(snapshotResponse.status).toBe(200);
      const snapshot = record(JSON.parse(await snapshotResponse.text()));
      if (
        snapshot === undefined ||
        typeof snapshot.manifestDigest !== "string" ||
        snapshot.sourceSnapshotPublication === null ||
        typeof snapshot.sourceSnapshotPublication !== "object"
      )
        throw new Error("C2 capacity source snapshot response was malformed");
      c2CapacitySeed = {
        manifestDigest: snapshot.manifestDigest,
        sourceSnapshotPublication:
          snapshot.sourceSnapshotPublication as OwnerVaultSourceSnapshotPublicationV1,
        backupID: snapshotCommand.backupID,
        initID: "unused-capacity-source-init-id",
        allocationID: "unused-capacity-source-allocation-id",
      };
    }
    if (c2CapacitySeed === undefined) throw new Error("C2 capacity seed was not committed");
    // Fill all 64 slots with fixture-only closed C2 terminals, then issue
    // fresh real routes against an already-full cohort.
    await restart();
    const capacityTargetInitialize = await signedPrivateInitializeBody({
      ownerID: owner,
      vaultID: vault,
      generationEpoch: 4,
      routingEpoch: 1,
      credentialEpoch: 1,
      controlEpoch: 1,
      securityFloor: 1,
      operationID: "c2-capacity-target-init-op-0001",
      jti: "c2-capacity-target-init-jti-0001",
      sourceGeneration: 2,
      targetGeneration: 4,
      allocationID: "c2-capacity-target-allocation-0001",
      initID: "c2-capacity-target-init-id-0001",
      backupID: c2CapacitySeed.backupID,
      manifestDigest: c2CapacitySeed.manifestDigest,
    });
    observedBearers.push(capacityTargetInitialize.token);
    expect(
      (
        await postControl(
          "private-initialize",
          capacityTargetInitialize.body,
          "capacity-restore-target",
        )
      ).status,
    ).toBe(200);
    const seeded = await postControl("c2-capacity-seed", "{}", "capacity-restore-target");
    expect(seeded.status).toBe(200);
    expect(await seeded.text()).toBe('{"ok":true}');
    // Restart after fixture-only setup, then reset immediately before the two
    // traced real requests. No setup route can contribute to their counters.
    await restart();
    expect((await c2CapacityTrace("POST", "capacity-restore-target")).status).toBe(200);
    const snapshot = await signedSnapshotBody({
      ownerID: owner,
      vaultID: vault,
      generationEpoch: 4,
      routingEpoch: 1,
      credentialEpoch: 1,
      controlEpoch: 1,
      securityFloor: 1,
      operationID: "c2-capacity-snapshot-rejected-0001",
      jti: "c2-capacity-snapshot-rejected-jti-0001",
      backupID: "c2-capacity-snapshot-rejected-0001",
      sourceGeneration: 4,
      sourceRoutingEpoch: 1,
      sourceCredentialEpoch: 1,
      sourceControlEpoch: 1,
      sourceSecurityFloor: 1,
    } satisfies SnapshotCommand);
    observedBearers.push(snapshot.token);
    const snapshotRejected = await postControl(
      "snapshot",
      snapshot.body,
      "capacity-restore-target",
    );
    expect(snapshotRejected.status).toBe(403);
    expect(await snapshotRejected.text()).toBe('{"ok":false}');

    const restore = await signedRestoreBody({
      ownerID: owner,
      vaultID: vault,
      generationEpoch: 4,
      routingEpoch: 1,
      credentialEpoch: 1,
      controlEpoch: 1,
      securityFloor: 1,
      operationID: "c2-capacity-restore-rejected-0001",
      jti: "c2-capacity-restore-rejected-jti-0001",
      allocationID: c2CapacitySeed.allocationID,
      initID: "c2-capacity-target-init-id-0001",
      sourceGeneration: 2,
      targetGeneration: 4,
      backupID: c2CapacitySeed.backupID,
      manifestDigest: c2CapacitySeed.manifestDigest,
      sourceSnapshotPublication: c2CapacitySeed.sourceSnapshotPublication,
    } satisfies RestoreCommand);
    observedBearers.push(restore.token);
    const restoreRejected = await postControl("restore", restore.body, "capacity-restore-target");
    expect(restoreRejected.status).toBe(403);
    expect(await restoreRejected.text()).toBe('{"ok":false}');
    const trace = record(await (await c2CapacityTrace("GET", "capacity-restore-target")).json());
    if (trace === undefined) throw new Error("C2 capacity trace response was malformed");
    // Both real routes were traced after fixture-only setup and received the
    // closed capacity response.
    expect(trace.routes).toBe(2);
    expect(trace.controlVerify).toBe(2);
    expect(trace.manifestKeys).toBe(1);
    expect(trace.liveAccess).toBe(0);
    expect(trace.restoreStorage).toBe(0);
    expect((await c2CapacityTrace("DELETE", "capacity-restore-target")).status).toBe(200);
  }, 120_000);

  test("persists only fingerprints: no capability bearer, socket bearer, private key, or Access JWT reaches storage or logs", async () => {
    if (persistDirectory === undefined) throw new Error("persist directory missing");
    if (acceptedSocketToken === undefined || userCapabilityToken === undefined)
      throw new Error("bearer fixtures were not captured");
    // Stop Workerd so every durable write is flushed to the persist directory.
    await stop();
    const files = readdirSync(persistDirectory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(0);
    const storageDump = files.map((file) => readFileSync(file, "latin1")).join(" ");
    const logDump = logFiles.map((file) => readFileSync(file, "latin1")).join(" ");

    for (const bearer of observedBearers) {
      expect(storageDump.includes(bearer)).toBe(false);
      expect(logDump.includes(bearer)).toBe(false);
    }
    // The durable evidence is the SHA-256 fingerprint, never the bearer.
    const socketFingerprint = sha256Hex(new TextEncoder().encode(acceptedSocketToken));
    const userTokenFingerprint = sha256Hex(new TextEncoder().encode(userCapabilityToken));
    expect(storageDump.includes(socketFingerprint)).toBe(true);
    expect(storageDump.includes(userTokenFingerprint)).toBe(true);

    // P06-R: the challenge row minted under the alarm-reaped short-TTL
    // receipt still awaits its own later deadline in durable storage.
    if (shortReceiptChallengeID === undefined)
      throw new Error("short-TTL challenge fixture was not captured");
    expect(storageDump.includes(shortReceiptChallengeID)).toBe(true);

    await start();
    // Closed error surfaces remain constant after the hygiene restart.
    const rejected = await postControl("ensure-initialized", '{"capability":1,"command":{}}');
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toBe('{"ok":false}');
  }, 90_000);
});
