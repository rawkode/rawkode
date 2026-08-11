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
const start = async (): Promise<void> => {
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
const restart = async (): Promise<void> => {
  await stop();
  await start();
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
const postControl = (route: string, body: string | Uint8Array) => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return fetch(`${baseURL}/__test/owner-vault-control/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
const signedPrivateInitializeBody = async (): Promise<{
  readonly body: string;
  readonly token: string;
}> => {
  const binding = {
    resource: OwnerVaultDirectoryControlResource.PrivateInitialize,
    path: "/__v2/internal/owner-vault/private-initialize" as const,
    method: "POST" as const,
    canonicalQuery: "" as const,
    bodySHA256: sha256Hex(new TextEncoder().encode(JSON.stringify(privateInit))),
    ...privateInit,
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
    body: JSON.stringify({ capability: signed.value, command: privateInit }),
    token: signed.value,
  };
};
const signedUserBody = async <A extends Readonly<Record<string, unknown>>>(
  path: string,
  command: A,
  jti: string,
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
        ttlSeconds: 60,
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
/** The one committed initialization wire message; replays must reuse these
 * exact bytes because the durable receipt binds the exact signed claims. */
let committedInit: { readonly body: string; readonly ack: string } | undefined;

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
    const challenge = record(await challengeResponse.json());
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
    // The completed receipt replays the rebuilt exact result byte-identically.
    const registrationReplay = await postControl("devices/complete", registerRequest.body);
    expect(registrationReplay.status).toBe(200);
    expect(await registrationReplay.text()).toBe(registeredBytes);

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

    await start();
    // Closed error surfaces remain constant after the hygiene restart.
    const rejected = await postControl("ensure-initialized", '{"capability":1,"command":{}}');
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toBe('{"ok":false}');
  }, 90_000);
});
