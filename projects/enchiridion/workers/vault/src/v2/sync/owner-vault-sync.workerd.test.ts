import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const vaultDirectory = join(import.meta.dir, "..", "..", "..");
const wrangler = join(vaultDirectory, "node_modules", ".bin", "wrangler");
const lowSSignature =
  "MEQCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiAdJE0zr1rutsPCcv5D87CdiwnjOi3YRwWIyupgxSiyew==";
const capability = "test-owner-vault-capability";

const getFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("expected a TCP port"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });

interface WorkerdServer {
  readonly process: ReturnType<typeof Bun.spawn>;
  readonly baseURL: string;
}

const waitForReady = async (baseURL: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/__owner_vault_sync_ready__`);
      if (response.ok) return;
    } catch {
      // Real workerd has not bound its local port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("OwnerVault Workerd did not become ready.");
};

const startWorkerd = async (persistDirectory: string): Promise<WorkerdServer> => {
  const port = await getFreePort();
  const child = Bun.spawn(
    [
      wrangler,
      "dev",
      "--config=wrangler.owner-vault-sync-test.jsonc",
      `--port=${port}`,
      "--local",
      `--persist-to=${persistDirectory}`,
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: vaultDirectory,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    },
  );
  const baseURL = `http://127.0.0.1:${port}`;
  await waitForReady(baseURL);
  return { process: child, baseURL };
};

const stopWorkerd = async (server: WorkerdServer): Promise<void> => {
  server.process.kill();
  await server.process.exited;
};

const openSocket = (
  baseURL: string,
  capability = "test-owner-vault-capability",
): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseURL.replace(/^http/u, "ws")}/v2/sync`, {
      headers: { "Enchiridion-Internal-Capability": capability },
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });

const nextJSON = (socket: WebSocket): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        const value: unknown = JSON.parse(data.toString());
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          reject(new Error("expected JSON object"));
          return;
        }
        resolve(Object.fromEntries(Object.entries(value)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });

const closed = (socket: WebSocket): Promise<{ readonly code: number }> =>
  new Promise((resolve) => socket.once("close", (code) => resolve({ code })));

const changeFrame = (
  accepted: Record<string, unknown>,
  frameID: string,
  overrides: Readonly<Record<string, unknown>> = {},
) => ({
  type: "syncChange",
  protocolVersion: 2,
  vaultID: "vault-1",
  deviceID: "device-1",
  authEpoch: 4,
  credentialEpoch: 2,
  generationEpoch: 3,
  sessionNonce: "AAAAAAAAAAAAAAAAAAAAAA",
  assertionExpiresAt: accepted.assertionExpiresAt,
  changeID: `change-${frameID.slice(0, 2)}`,
  causalVersion: 1,
  frameID,
  signingPayloadVersion: 1,
  payloadBase64: "AA==",
  deviceSignature: lowSSignature,
  ...overrides,
});

const hello = async (
  socket: WebSocket,
  resumeToken?: string,
): Promise<{
  readonly challenge: Record<string, unknown>;
  readonly accepted: Record<string, unknown>;
}> => {
  const challenge = await nextJSON(socket);
  if (
    challenge.type !== "serverHelloChallenge" ||
    typeof challenge.connectionNonce !== "string" ||
    typeof challenge.authEpoch !== "number"
  )
    throw new Error("expected a bounded server-first hello challenge");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 2,
      connectionNonce: challenge.connectionNonce,
      ...(resumeToken === undefined ? {} : { resumeToken }),
      deviceID: "device-1",
      authEpoch: challenge.authEpoch,
      deviceSignature: lowSSignature,
    }),
  );
  return { challenge, accepted: await nextJSON(socket) };
};

let server: WorkerdServer | undefined;
const persistDirectory = mkdtempSync(join(tmpdir(), "enchiridion-owner-vault-sync-"));

beforeAll(async () => {
  server = await startWorkerd(persistDirectory);
}, 45_000);

afterAll(async () => {
  if (server !== undefined) await stopWorkerd(server);
  rmSync(persistDirectory, { recursive: true, force: true });
});

describe("OwnerVault v2 sync on real Workerd hibernation callbacks", () => {
  test("rejects an unauthorised upgrade before accepting a socket", async () => {
    if (server === undefined) throw new Error("test server unavailable");
    const response = await fetch(`${server.baseURL}/v2/sync`, {
      headers: { Upgrade: "websocket", "Enchiridion-Internal-Capability": "invalid" },
    });
    expect(response.status).toBe(401);
  });

  test("decodes the active hibernation attachment after Hello and ACKs a post-Hello callback", async () => {
    if (server === undefined) throw new Error("test server unavailable");
    const malformed = await openSocket(server.baseURL);
    const malformedClosed = closed(malformed);
    malformed.send('{"type":"hello","type":"hello"}');
    expect((await malformedClosed).code).toBe(4400);

    const socket = await openSocket(server.baseURL);
    const { accepted } = await hello(socket);
    expect(accepted.type).toBe("helloAccepted");
    expect(accepted.sessionNonce).toBe("AAAAAAAAAAAAAAAAAAAAAA");
    expect(accepted.generationEpoch).toBe(3);

    const frame = {
      type: "syncChange",
      protocolVersion: 2,
      vaultID: "vault-1",
      deviceID: "device-1",
      authEpoch: 4,
      credentialEpoch: 2,
      generationEpoch: 3,
      sessionNonce: "AAAAAAAAAAAAAAAAAAAAAA",
      assertionExpiresAt: accepted.assertionExpiresAt,
      changeID: "change-1",
      causalVersion: 1,
      frameID: "AQEBAQEBAQEBAQEBAQEBAQ",
      signingPayloadVersion: 1,
      payloadBase64: "AA==",
      deviceSignature: lowSSignature,
    };
    socket.send(JSON.stringify(frame));
    expect(await nextJSON(socket)).toMatchObject({
      type: "syncAcknowledged",
      changeID: "change-1",
    });
    socket.send(JSON.stringify(frame));
    expect(await nextJSON(socket)).toMatchObject({
      type: "syncAcknowledged",
      changeID: "change-1",
    });
    socket.close();
  }, 45_000);

  test("uses the DO alarm to close an idle active socket at its millisecond assertion expiry", async () => {
    if (server === undefined) throw new Error("test server unavailable");
    const socket = await openSocket(server.baseURL, "test-owner-vault-capability-2");
    await hello(socket);
    const close = closed(socket);
    expect((await close).code).toBe(4408);
  }, 45_000);

  test("prunes eight expired idle sockets before admitting a valid upgrade", async () => {
    if (server === undefined) throw new Error("test server unavailable");
    const expiredSockets: WebSocket[] = [];
    for (let index = 11; index <= 18; index += 1) {
      const socket = await openSocket(server.baseURL, `test-owner-vault-capability-${index}`);
      await hello(socket);
      expiredSockets.push(socket);
    }
    const expiryCloses = expiredSockets.map(closed);
    expect((await Promise.all(expiryCloses)).every(({ code }) => code === 4408)).toBe(true);
    const valid = await openSocket(server.baseURL, "test-owner-vault-capability-19");
    const { challenge } = await hello(valid);
    expect(challenge.type).toBe("serverHelloChallenge");
    valid.close();
  }, 45_000);

  test("fences cross-owner upgrades and closes a stale auth epoch", async () => {
    if (server === undefined) throw new Error("test server unavailable");
    const conflict = await fetch(`${server.baseURL}/v2/sync`, {
      headers: {
        Upgrade: "websocket",
        "Enchiridion-Internal-Capability": "test-owner-vault-capability-4",
      },
    });
    expect(conflict.status).toBe(409);

    const stale = await openSocket(server.baseURL, "test-owner-vault-capability-3");
    const { accepted } = await hello(stale);
    const staleClose = closed(stale);
    stale.send(
      JSON.stringify({
        type: "syncChange",
        protocolVersion: 2,
        vaultID: "vault-1",
        deviceID: "device-1",
        authEpoch: 5,
        credentialEpoch: 2,
        generationEpoch: 3,
        sessionNonce: "AAAAAAAAAAAAAAAAAAAAAA",
        assertionExpiresAt: accepted.assertionExpiresAt,
        changeID: "stale",
        causalVersion: 1,
        frameID: "AwMDAwMDAwMDAwMDAwMDAw",
        signingPayloadVersion: 1,
        payloadBase64: "AA==",
        deviceSignature: lowSSignature,
      }),
    );
    expect((await staleClose).code).toBe(4400);
  }, 45_000);

  test("applies per-session rate backpressure and closes stale credential, generation, and nonce frames", async () => {
    if (server === undefined) throw new Error("test server unavailable");
    const rate = await openSocket(server.baseURL, "test-owner-vault-capability-5");
    const { accepted: rateAccepted } = await hello(rate);
    const exactReplay = changeFrame(rateAccepted, "BAQEBAQEBAQEBAQEBAQEBA");
    rate.send(JSON.stringify(exactReplay));
    await nextJSON(rate);
    rate.send(JSON.stringify(exactReplay));
    await nextJSON(rate);
    const rateClose = closed(rate);
    rate.send(JSON.stringify(exactReplay));
    rate.send(JSON.stringify(exactReplay));
    expect((await rateClose).code).toBe(4429);

    const cases: readonly [string, Readonly<Record<string, unknown>>][] = [
      ["test-owner-vault-capability-6", { credentialEpoch: 3 }],
      ["test-owner-vault-capability-7", { generationEpoch: 4 }],
      ["test-owner-vault-capability-8", { sessionNonce: "AQEBAQEBAQEBAQEBAQEBAQ" }],
    ];
    for (const [capability, overrides] of cases) {
      const socket = await openSocket(server.baseURL, capability);
      const { accepted } = await hello(socket);
      const close = closed(socket);
      socket.send(JSON.stringify(changeFrame(accepted, "BwcHBwcHBwcHBwcHBwcHBw", overrides)));
      expect((await close).code).toBe(4400);
    }
  }, 45_000);

  test("rotates a hashed resume token and replays an immutable receipt after a real Workerd restart", async () => {
    if (server === undefined) throw new Error("test server unavailable");
    const initial = await openSocket(server.baseURL, "test-owner-vault-capability-9");
    const { accepted: initialAccepted } = await hello(initial);
    expect(typeof initialAccepted.resumeToken).toBe("string");
    const frame = changeFrame(initialAccepted, "CQkJCQkJCQkJCQkJCQkJCQ");
    initial.send(JSON.stringify(frame));
    expect(await nextJSON(initial)).toMatchObject({
      type: "syncAcknowledged",
      changeID: "change-CQ",
    });
    const initialClosed = closed(initial);
    initial.close();
    expect((await initialClosed).code).toBe(1000);
    await stopWorkerd(server);
    server = await startWorkerd(persistDirectory);

    const conflict = await fetch(`${server.baseURL}/v2/sync`, {
      headers: {
        Upgrade: "websocket",
        "Enchiridion-Internal-Capability": "test-owner-vault-capability-4",
      },
    });
    expect(conflict.status).toBe(409);

    const resumed = await openSocket(server.baseURL, "test-owner-vault-capability-10");
    const { accepted: resumedAccepted } = await hello(resumed, String(initialAccepted.resumeToken));
    expect(resumedAccepted.type).toBe("helloAccepted");
    expect(resumedAccepted.resumeToken).not.toBe(initialAccepted.resumeToken);
    expect(resumedAccepted.sessionNonce).toBe(initialAccepted.sessionNonce);
    resumed.send(JSON.stringify(frame));
    expect(await nextJSON(resumed)).toMatchObject({
      type: "syncAcknowledged",
      changeID: "change-CQ",
    });
    const mismatchClose = closed(resumed);
    resumed.send(JSON.stringify({ ...frame, payloadBase64: "AQ==" }));
    expect((await mismatchClose).code).toBe(4400);
  }, 45_000);
});
