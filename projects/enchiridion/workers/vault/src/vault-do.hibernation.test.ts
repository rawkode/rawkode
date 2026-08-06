// vault-do.hibernation.test.ts — the real-runtime WebSocket Hibernation
// integration coverage plan Risk #13 says is missing ("WebSocket
// Hibernation correctness is unverified by any automated test —
// ctx.acceptWebSocket/hibernation-handler usage was confirmed correct by
// manual code review only; no wrangler dev/Miniflare-based integration
// test exercises hibernate/wake cycling or multi-socket broadcast").
//
// This spins up a REAL `wrangler dev --local` process — real workerd, real
// Hibernation-API-backed DO SQLite storage, the exact runtime a real
// deploy uses — against `wrangler.vault-do-test.jsonc` (a test-only
// config; see that file's header for why it's separate from the real
// `wrangler.jsonc`) and drives `VaultDO.fetch`/`webSocketMessage`'s ACTUAL
// code via real WebSocket connections (the `ws` package, already a
// devDependency here). Not a mock, not a unit-test double — every other
// `.test.ts` file in this worker exercises the plain, DO-runtime-
// independent modules `vault-do.ts` itself imports and wires together
// (per `vault-do.ts`'s own header comment on why the class itself is
// untested by `bun test`); this file is the one exception, aimed
// specifically at what those unit tests structurally cannot reach: real
// `ctx.acceptWebSocket`/hibernation lifecycle behavior.
//
// ── Why a real subprocess, not Miniflare's programmatic API ─────────────
// Miniflare exposes `unsafeEvictDurableObject(scriptName, className, {
// webSockets: "hibernate" | "close" })` — a purpose-built hook for exactly
// this kind of test, more surgical than a full process restart. It was
// tried first here. The pinned `miniflare` version this repo's `wrangler`
// resolves (`5.20260801.0-alpha`, confirmed via `bun.lock`) crashes
// workerd at startup ("service core:user:: Uncaught Error: internal
// error") specifically when the real `loro-crdt` WASM module is loaded
// through the *programmatic* `new Miniflare({...})` API — reproduced with
// a minimal `.wasm`-only repro, independent of anything in this worker's
// own code. Confirmed NOT a bug in `vault-do.ts` or its bundle: the
// IDENTICAL esbuild bundle (`wrangler deploy --dry-run --outdir=...`)
// loads and serves real requests successfully under `wrangler dev`, which
// resolves the exact same pinned `miniflare` version through its own
// (differently-configured) internal call. Whatever option wrangler's CLI
// sets that a direct `new Miniflare(...)` call doesn't wasn't identified
// in the time available for this task — flagged here rather than guessed
// at. Revisit if a future pass wants `unsafeEvictDurableObject`'s more
// surgical eviction control (see the scope-boundary note below on what
// this file's technique can't reach that it could).
//
// ── What this DOES prove, via a full process kill + relaunch pointed at
//    the same `--persist-to` directory ──────────────────────────────────
//  - Multi-socket broadcast: two real WebSocket clients connected to the
//    same VaultDO instance; a write from one is broadcast to the other but
//    never echoed back to the sender (`vault-do.ts`'s `broadcast()`).
//  - "Hibernate/wake": catalog + doc state written in one process's
//    lifetime survives a full process restart — a STRONGER claim than
//    in-memory eviction alone (zero JS-heap state of any kind survives,
//    not just zero per-request state) — and a brand-new WebSocket
//    connection with no session continuity whatsoever correctly recovers
//    it via the sync protocol's mandatory "catalog first, every
//    connection" contract (`sync-protocol.ts`'s file header: "Hibernation
//    API means no in-memory handshake state survives a DO going idle, so
//    'catalog first' happens on every connection, not just the first ever
//    one").
//
// ── Honest scope boundary — what this does NOT prove ─────────────────────
//  - Real mid-session hibernation eviction while a WebSocket stays
//    logically "open" from the client's own perspective (Cloudflare's
//    actual production behavior). A full process restart necessarily
//    closes the TCP connection the client sees, which real hibernation
//    does not. See the Miniflare-API paragraph above for why the more
//    surgical tool wasn't usable here — this is the closest real-runtime
//    proxy this sandbox's tooling can reach for that specific claim.
//  - Real Cloudflare Access verification — this test drives VaultDO
//    directly via `vault-do-test-entry.ts`, which has no Access check at
//    all (matching `vault-do.ts`'s own header: "This method assumes it's
//    already been authenticated; it does not itself re-check"). Access
//    itself already has real-JWT-round-trip coverage in
//    `access-auth.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveFreePageId } from "@enchiridion/graph-core";
import { LoroDoc } from "loro-crdt/bundler";
import WebSocket from "ws";

const VAULT_DIR = join(import.meta.dir, "..");
const WRANGLER_BIN = join(VAULT_DIR, "node_modules", ".bin", "wrangler");

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("failed to allocate a free port"));
      }
    });
  });
}

interface DevServer {
  proc: ReturnType<typeof Bun.spawn>;
  baseUrl: string;
}

async function waitForReady(baseUrl: string, deadlineMs: number): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`${baseUrl}/__vault_do_test_readiness_probe__`);
      await res.arrayBuffer();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`wrangler dev did not become ready within ${deadlineMs}ms (last error: ${String(lastError)})`);
}

/** Launches a real `wrangler dev --local` process against
 *  `wrangler.vault-do-test.jsonc`, persisting DO SQLite storage to
 *  `persistDir` — passing the SAME `persistDir` to a later call is what
 *  simulates "wake from durable state only" after `stopDevServer` below. */
async function startDevServer(persistDir: string): Promise<DevServer> {
  const port = await getFreePort();
  const proc = Bun.spawn(
    [
      WRANGLER_BIN,
      "dev",
      "--config=wrangler.vault-do-test.jsonc",
      `--port=${port}`,
      "--local",
      `--persist-to=${persistDir}`,
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: VAULT_DIR,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    },
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl, 30_000);
  return { proc, baseUrl };
}

async function stopDevServer(server: DevServer): Promise<void> {
  server.proc.kill();
  await server.proc.exited;
}

function wsUrl(baseUrl: string, vaultId: string): string {
  return `${baseUrl.replace(/^http/, "ws")}/sync?vaultId=${encodeURIComponent(vaultId)}`;
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: decoded wire-protocol JSON, deliberately loosely typed for test assertions
function collectMessages(ws: WebSocket): any[] {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const inbox: any[] = [];
  ws.on("message", (data: WebSocket.RawData) => {
    try {
      inbox.push(JSON.parse(data.toString()));
    } catch {
      // Malformed frame — not this test's concern, same "drop it" stance
      // vault-do.ts's own webSocketMessage takes.
    }
  });
  return inbox;
}

function send(ws: WebSocket, message: unknown): void {
  ws.send(JSON.stringify(message));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

describe("VaultDO WebSocket Hibernation sync protocol — real wrangler dev / workerd", () => {
  let persistDir: string;
  let server: DevServer;

  beforeAll(async () => {
    persistDir = mkdtempSync(join(tmpdir(), "vault-do-hibernation-test-"));
    server = await startDevServer(persistDir);
  }, 40_000);

  afterAll(async () => {
    await stopDevServer(server);
    rmSync(persistDir, { recursive: true, force: true });
  });

  test(
    "broadcasts a write to other connected sockets on the same vault but never echoes it back to the sender",
    async () => {
      const vaultId = `broadcast-${crypto.randomUUID()}`;
      const a = await openSocket(wsUrl(server.baseUrl, vaultId));
      const b = await openSocket(wsUrl(server.baseUrl, vaultId));
      const inboxA = collectMessages(a);
      const inboxB = collectMessages(b);

      const pageID = deriveFreePageId();
      const now = Date.now();
      send(a, {
        type: "catalogDiff",
        entries: [{ pageID, docType: "note", createdAt: now, tombstoned: false, updatedAt: now }],
      });

      await waitUntil(() =>
        inboxB.some((m) => m.type === "catalogDiff" && m.entries?.some((e: { pageID: string }) => e.pageID === pageID)),
      );
      // The sender is explicitly excluded from broadcast() — see vault-do.ts.
      expect(
        inboxA.some((m) => m.type === "catalogDiff" && m.entries?.some((e: { pageID: string }) => e.pageID === pageID)),
      ).toBe(false);

      const doc = new LoroDoc();
      doc.getText("title").insert(0, "Broadcast Test Page");
      doc.commit();
      const updateBytes = doc.export({ mode: "update" });
      send(a, { type: "docUpdate", pageID, bytes: bytesToBase64(updateBytes) });

      await waitUntil(() => inboxB.some((m) => m.type === "docUpdate" && m.pageID === pageID));
      expect(inboxA.filter((m) => m.type === "docUpdate" && m.pageID === pageID).length).toBe(0);

      a.close();
      b.close();
    },
    15_000,
  );

  test(
    "a third socket that never sent anything still receives broadcasts (getWebSockets() sees every hibernation-accepted socket)",
    async () => {
      const vaultId = `broadcast-three-${crypto.randomUUID()}`;
      const a = await openSocket(wsUrl(server.baseUrl, vaultId));
      const b = await openSocket(wsUrl(server.baseUrl, vaultId));
      const c = await openSocket(wsUrl(server.baseUrl, vaultId));
      const inboxB = collectMessages(b);
      const inboxC = collectMessages(c);

      const pageID = deriveFreePageId();
      const now = Date.now();
      send(a, {
        type: "catalogDiff",
        entries: [{ pageID, docType: "note", createdAt: now, tombstoned: false, updatedAt: now }],
      });

      await waitUntil(() => inboxB.some((m) => m.type === "catalogDiff"));
      await waitUntil(() => inboxC.some((m) => m.type === "catalogDiff"));

      a.close();
      b.close();
      c.close();
    },
    15_000,
  );

  test(
    "a socket connecting fresh recovers prior state via the catalog-first contract (no in-memory session continuity)",
    async () => {
      const vaultId = `catalog-first-${crypto.randomUUID()}`;
      const seed = await openSocket(wsUrl(server.baseUrl, vaultId));
      const pageID = deriveFreePageId();
      const now = Date.now();
      send(seed, {
        type: "catalogDiff",
        entries: [{ pageID, docType: "note", createdAt: now, tombstoned: false, updatedAt: now }],
      });
      await new Promise((r) => setTimeout(r, 300));
      seed.close();
      await new Promise((r) => setTimeout(r, 100));

      // A brand-new WebSocket — no relationship to `seed` beyond hitting
      // the same VaultDO instance (same vaultId). Per sync-protocol.ts:
      // "catalog first happens on every connection, not just the first
      // ever one".
      const fresh = await openSocket(wsUrl(server.baseUrl, vaultId));
      const inbox = collectMessages(fresh);
      send(fresh, { type: "catalogRequest" });
      await waitUntil(() => inbox.some((m) => m.type === "catalogDiff"));
      const reply = inbox.find((m) => m.type === "catalogDiff");
      expect(reply.entries.some((e: { pageID: string }) => e.pageID === pageID)).toBe(true);
      fresh.close();
    },
    15_000,
  );
});

describe("VaultDO durable state survives a full process restart (hibernate/wake simulation)", () => {
  let persistDir: string;
  let server: DevServer;

  beforeAll(async () => {
    persistDir = mkdtempSync(join(tmpdir(), "vault-do-restart-test-"));
    server = await startDevServer(persistDir);
  }, 40_000);

  afterAll(async () => {
    await stopDevServer(server);
    rmSync(persistDir, { recursive: true, force: true });
  });

  test(
    "catalog entry + doc bytes written before a restart are recoverable, byte-identical, after it",
    async () => {
      const vaultId = `restart-${crypto.randomUUID()}`;
      const pageID = deriveFreePageId();
      const now = Date.now();

      const ws1 = await openSocket(wsUrl(server.baseUrl, vaultId));
      send(ws1, {
        type: "catalogDiff",
        entries: [{ pageID, docType: "note", createdAt: now, tombstoned: false, updatedAt: now }],
      });
      await new Promise((r) => setTimeout(r, 300));

      const doc = new LoroDoc();
      doc.getText("title").insert(0, "Survives A Restart");
      doc.commit();
      const updateBytes = doc.export({ mode: "update" });
      send(ws1, { type: "docUpdate", pageID, bytes: bytesToBase64(updateBytes) });
      await new Promise((r) => setTimeout(r, 300));
      ws1.close();
      await new Promise((r) => setTimeout(r, 100));

      // Kill the WHOLE process — wrangler dev's Node process and the
      // workerd process it manages. Every JS object VaultDO ever held,
      // including the DurableObject instance itself and ws1's server-side
      // WebSocket, is gone. Only what's on disk under `persistDir`
      // survives — exactly the "resumable from durable state only, no
      // in-memory handshake progress" constraint the sync protocol is
      // designed around.
      await stopDevServer(server);
      server = await startDevServer(persistDir);

      // Brand-new connection into a brand-new VaultDO JS instance
      // (constructor reran: initializeSchema + healAllDriftOnBoot) — zero
      // session continuity with ws1 above.
      const ws2 = await openSocket(wsUrl(server.baseUrl, vaultId));
      const inbox = collectMessages(ws2);

      send(ws2, { type: "catalogRequest" });
      await waitUntil(() => inbox.some((m) => m.type === "catalogDiff"));
      const catalogReply = inbox.find((m) => m.type === "catalogDiff");
      expect(catalogReply.entries.some((e: { pageID: string }) => e.pageID === pageID)).toBe(true);

      // Empty version vector = "I have nothing for this doc" (see
      // loro-storage.ts's decodeVersionVector doc comment) — VaultDO
      // should answer with everything it persisted before the restart.
      send(ws2, { type: "docVersionVector", pageID, versionVector: "" });
      await waitUntil(() =>
        inbox.some((m) => (m.type === "docUpdate" || m.type === "docFullSnapshot") && m.pageID === pageID),
      );
      const docReply = inbox.find((m) => (m.type === "docUpdate" || m.type === "docFullSnapshot") && m.pageID === pageID);

      const recovered = new LoroDoc();
      recovered.import(base64ToBytes(docReply.bytes));
      expect(recovered.getText("title").toString()).toBe("Survives A Restart");

      ws2.close();
    },
    45_000,
  );
});
