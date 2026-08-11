#!/usr/bin/env bun
// DEV-ONLY TOOLING — NOT part of the production API surface.
//
// The P0 exit-drill (plan §Verification, /Users/rawkode/.claude/plans/
// cheeky-greeting-lampson.md): "edit a page on macOS offline → reconnect →
// doc lands in VaultDO → projection row queryable via a GraphQL query
// hitting vault's own /graphql endpoint directly (Access-protected, no
// gateway hop); kill the DO, replay from storage, projections rebuild
// identically; attach an image → appears in R2 → downloads on a second
// device."
//
// This script drives that scenario against a REAL, RUNNING `wrangler dev`
// instance of this worker (real Miniflare/workerd-simulated DO + R2, real
// `loro-crdt` doc bytes, real Cloudflare Access JWT verification against a
// real signed token) — not a unit test double. See the drill's final
// report (task output) for what this proves vs. what's still unverified
// (a real Cloudflare Access edge, a real R2 bucket, and the actual Swift
// app were NOT exercised — only this worker's own HTTP/WS surface was).
//
// Prerequisites this script assumes (see this repo's task report for the
// exact commands used to set these up):
//   1. `wrangler dev` running against this worker, with `ACCESS_TEAM_DOMAIN`
//      and `ACCESS_AUD` pointed at a local fake JWKS endpoint (this script
//      does NOT start wrangler dev itself — see the companion
//      `jwks-server-http.ts`/tunnel setup and VAULT_URL/ACCESS_* env vars
//      below).
//   2. A signed test JWT (`Cf-Access-Jwt-Assertion`) minted against that
//      same fake JWKS endpoint's private key — passed in via
//      `ACCESS_TEST_JWT` env var. This mirrors `access-auth.test.ts`'s own
//      technique (real `jose` keypair + `SignJWT`), just pointed at a real
//      HTTP(S) JWKS endpoint reachable from the `wrangler dev` process
//      instead of `access-auth.ts`'s test-only `fetchImpl` escape hatch
//      (which only exists for direct unit-test calls into
//      `verifyAccessRequest`, not for a real HTTP request against a running
//      server) — see access-auth.ts's file header for why a real HTTPS
//      JWKS endpoint is required (the JWKS URL scheme is hardcoded to
//      `https://`, by design, matching real Cloudflare Access).
//
// This script does NOT modify, weaken, or bypass `src/access-auth.ts`'s
// verification logic — every request below carries a real
// `Cf-Access-Jwt-Assertion` header and goes through the exact same
// `verifyAccessRequest` code path a real Cloudflare Access-fronted request
// would.

import { LoroDoc } from "loro-crdt/bundler";
import WebSocket from "ws";
import { deriveBlobId, deriveFreePageId } from "@enchiridion/graph-core";

const VAULT_URL = process.env.VAULT_URL ?? "http://localhost:8787";
const VAULT_WS_URL = VAULT_URL.replace(/^http/, "ws");
const ACCESS_JWT = process.env.ACCESS_TEST_JWT;
const EXTRA_HEADERS = process.env.TUNNEL_BYPASS_HEADER
  ? { "bypass-tunnel-reminder": "true" }
  : {};

if (!ACCESS_JWT) {
  console.error("ACCESS_TEST_JWT env var is required — mint one against the fake JWKS server's key.");
  process.exit(1);
}

const authHeaders = { "Cf-Access-Jwt-Assertion": ACCESS_JWT, ...EXTRA_HEADERS };

let passCount = 0;
let failCount = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (condition) {
    passCount += 1;
    console.log(`  PASS: ${message}`);
  } else {
    failCount += 1;
    console.error(`  FAIL: ${message}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

async function graphql(query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${VAULT_URL}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log(`P0 exit drill — vault worker at ${VAULT_URL}`);

  // -------------------------------------------------------------------
  // (a) Real WebSocket connection to /sync, Access-authenticated, sends
  //     a catalogDiff (new page's catalog entry) + docUpdate (real Loro
  //     bytes) for a brand-new test page — "edit a page ... → doc lands
  //     in VaultDO".
  // -------------------------------------------------------------------
  section("(a) WebSocket /sync: catalogDiff + docUpdate for a new page");

  const pageID = deriveFreePageId();
  const docType = "note";
  const now = Date.now();
  console.log(`  new pageID = ${pageID}`);

  // Build a REAL Loro doc the same shape the DO's projection.ts reads
  // (title/body LoroText containers) — not a mock payload.
  const doc = new LoroDoc();
  doc.getText("title").insert(0, "P0 Exit Drill Test Page");
  doc.getText("body").insert(
    0,
    "This page was created live by scripts/p0-exit-drill.ts against a running " +
      "wrangler dev instance, to prove the write -> reproject -> GraphQL read " +
      "pipeline end to end, not just via unit-test doubles.",
  );
  doc.commit();
  const fullUpdateBytes = doc.export({ mode: "update" });
  console.log(`  encoded ${fullUpdateBytes.byteLength} bytes of real Loro update ops`);

  const ws = new WebSocket(`${VAULT_WS_URL}/sync`, { headers: authHeaders });

  const wsOpened = await new Promise<boolean>((resolve) => {
    ws.once("open", () => resolve(true));
    ws.once("error", (err) => {
      console.error(`  WebSocket error: ${err}`);
      resolve(false);
    });
    ws.once("unexpected-response", (_req, res) => {
      console.error(`  WebSocket upgrade rejected: HTTP ${res.statusCode}`);
      resolve(false);
    });
  });
  assert(wsOpened, "WebSocket /sync upgrade succeeded with Access headers");
  if (!wsOpened) {
    process.exit(1);
  }

  const inbox: any[] = [];
  ws.on("message", (data) => {
    try {
      inbox.push(JSON.parse(data.toString()));
    } catch {
      // ignore malformed
    }
  });

  function send(message: unknown): void {
    ws.send(JSON.stringify(message));
  }

  // catalogRequest first, matching the real protocol's "catalog first" rule
  // (plan §Backend architecture).
  send({ type: "catalogRequest" });
  await Bun.sleep(300);
  const catalogDiffReplies = inbox.filter((m) => m.type === "catalogDiff");
  assert(catalogDiffReplies.length >= 1, "server answered catalogRequest with a catalogDiff frame");

  // Push this new page's catalog entry — creates the vault-meta entry the
  // DO needs before it will reproject the page's own doc content into
  // graph_nodes (see vault-write-model.ts's applyInboundDocBytes doc
  // comment: "reprojection is skipped until a catalog entry exists").
  send({
    type: "catalogDiff",
    entries: [
      { pageID, docType, createdAt: now, tombstoned: false, updatedAt: now },
    ],
  });
  await Bun.sleep(200);

  // Now push the real doc content as a docUpdate frame — the actual "edit
  // a page" step.
  send({ type: "docUpdate", pageID, bytes: bytesToBase64(fullUpdateBytes) });
  await Bun.sleep(300);

  ws.close();
  await Bun.sleep(100);

  console.log(`  received ${inbox.length} frames from server total`);
  assert(inbox.length > 0, "WebSocket connection stayed open and the server sent frames back (no error teardown)");

  // -------------------------------------------------------------------
  // (b) Query /graphql for the page we just wrote over the wire — proves
  //     write -> reproject -> GraphQL read, live.
  // -------------------------------------------------------------------
  section("(b) GraphQL /graphql: read back the page written over WS");

  // Give the synchronous-reprojection-inside-a-DO-transaction path a beat
  // to settle over the WS round trip (should already be committed by the
  // time applyInboundDocBytes's transactionSync returns, but this script
  // talks over two separate connections/requests, not one).
  await Bun.sleep(200);

  const pageQuery = `query GetPage($id: String!) { page(id: $id) { id kind title createdAt modifiedAt deletedAt } }`;
  const { status: pageStatus, body: pageBody } = await graphql(pageQuery, { id: pageID });
  console.log(`  GraphQL response: ${JSON.stringify(pageBody)}`);
  assert(pageStatus === 200, "GraphQL /graphql responded 200 for page query");
  assert(!pageBody.errors, `GraphQL response has no errors (${JSON.stringify(pageBody.errors ?? [])})`);
  assert(pageBody.data?.page?.id === pageID, "returned page.id matches the pageID written over WS");
  assert(
    pageBody.data?.page?.title === "P0 Exit Drill Test Page",
    `returned page.title matches the Loro doc's title text (got: ${JSON.stringify(pageBody.data?.page?.title)})`,
  );
  assert(pageBody.data?.page?.kind === docType, "returned page.kind matches the docType from the catalogDiff");

  const listQuery = `query { pages(limit: 50) { items { id title } nextCursor } }`;
  const { status: listStatus, body: listBody } = await graphql(listQuery);
  assert(listStatus === 200, "GraphQL pages(...) list query responded 200");
  const listedIds: string[] = (listBody.data?.pages?.items ?? []).map((p: any) => p.id);
  assert(listedIds.includes(pageID), "the new page shows up in pages(...) list results too");

  // -------------------------------------------------------------------
  // (c) Blob upload/download round trip through R2 (Miniflare-simulated).
  // -------------------------------------------------------------------
  section("(c) R2 blob round trip: PUT /blobs/:id then GET /blobs/:id");

  const blobBytes = new TextEncoder().encode(
    `P0 exit drill test blob — a stand-in for an attached image, written at ${new Date().toISOString()}.\n` +
      "Not actually image bytes (no image library needed to prove the R2 content-addressed round trip), " +
      "but real, non-trivial, content-addressed bytes hashed with real SHA-256, same as a real attachment upload would be.",
  );
  const blobID = await deriveBlobId(blobBytes);
  console.log(`  blobID = ${blobID} (${blobBytes.byteLength} bytes)`);

  const putRes = await fetch(`${VAULT_URL}/blobs/${blobID}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", ...authHeaders },
    body: blobBytes,
  });
  const putBody = await putRes.json();
  console.log(`  PUT /blobs/${blobID} -> ${putRes.status} ${JSON.stringify(putBody)}`);
  assert(putRes.status === 201, `blob upload returned 201 (got ${putRes.status})`);
  assert((putBody as any).id === blobID, "upload response echoes the same content-addressed id");

  const getRes = await fetch(`${VAULT_URL}/blobs/${blobID}`, { headers: authHeaders });
  const downloaded = new Uint8Array(await getRes.arrayBuffer());
  console.log(`  GET /blobs/${blobID} -> ${getRes.status}, ${downloaded.byteLength} bytes`);
  assert(getRes.status === 200, `blob download returned 200 (got ${getRes.status})`);
  assert(downloaded.byteLength === blobBytes.byteLength, "downloaded byte length matches uploaded byte length");
  const bytesIdentical = downloaded.every((b, i) => b === blobBytes[i]);
  assert(bytesIdentical, "downloaded bytes are byte-identical to uploaded bytes ('downloads on a second device')");

  // Re-upload the exact same bytes under the same id — dedup path.
  const putAgainRes = await fetch(`${VAULT_URL}/blobs/${blobID}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", ...authHeaders },
    body: blobBytes,
  });
  const putAgainBody = await putAgainRes.json();
  assert(
    putAgainRes.status === 200 && (putAgainBody as any).alreadyExists === true,
    `re-uploading identical bytes dedups (200 + alreadyExists:true; got ${putAgainRes.status} ${JSON.stringify(putAgainBody)})`,
  );

  // -------------------------------------------------------------------
  // (d) "Kill the DO, replay from storage, projections rebuild
  //     identically." A real `wrangler dev` process restart is exercised
  //     separately by the task's shell driver (stop/restart wrangler dev
  //     around this script) — see the drill's report for that half. This
  //     script's own contribution to (d) is the *other* legitimate reading
  //     of the plan's exit test: force a full projection rebuild from
  //     durable doc storage (VaultDO.rebuildProjections(), the same RPC
  //     the plan's "resumable rebuild-projections" design calls for) via a
      // dev-only debug route added for this purpose, then confirm the
  //     rebuilt projection row is byte-identical to what GraphQL returned
  //     in step (b) — proving projections are correctly re-derivable from
  //     doc storage alone, not silently dependent on anything the
  //     synchronous write-path incidentally left lying around.
  // -------------------------------------------------------------------
  section("(d) Rebuild projections from durable storage, re-verify via GraphQL");

  const beforeRebuild = pageBody.data.page;

  const rebuildRes = await fetch(`${VAULT_URL}/dev/admin/rebuild-projections`, {
    method: "POST",
    headers: authHeaders,
  });
  const rebuildBody = await rebuildRes.json();
  console.log(`  POST /dev/admin/rebuild-projections -> ${rebuildRes.status} ${JSON.stringify(rebuildBody)}`);
  assert(rebuildRes.status === 200, `rebuild-projections start responded 200 (got ${rebuildRes.status})`);
  assert((rebuildBody as any).started === true, "rebuild-projections reported started:true");

  // Poll status until it's no longer "running" (alarm-batched, small
  // vault so this should be near-instant, but poll rather than assume).
  let rebuildDone = false;
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    const statusRes = await fetch(`${VAULT_URL}/dev/admin/rebuild-projections/status`, { headers: authHeaders });
    const statusBody = await statusRes.json();
    if ((statusBody as any)?.status !== "running") {
      console.log(`  rebuild-projections status settled: ${JSON.stringify(statusBody)}`);
      rebuildDone = true;
      break;
    }
  }
  assert(rebuildDone, "rebuild-projections completed (status left 'running' within ~5s)");

  const { status: afterStatus, body: afterBody } = await graphql(pageQuery, { id: pageID });
  assert(afterStatus === 200, "post-rebuild GraphQL query responded 200");
  const afterRebuild = afterBody.data?.page;
  console.log(`  post-rebuild page: ${JSON.stringify(afterRebuild)}`);
  assert(
    afterRebuild?.id === beforeRebuild.id &&
      afterRebuild?.kind === beforeRebuild.kind &&
      afterRebuild?.title === beforeRebuild.title &&
      afterRebuild?.createdAt === beforeRebuild.createdAt &&
      afterRebuild?.modifiedAt === beforeRebuild.modifiedAt,
    "rebuilt projection row is identical to the pre-rebuild row (id/kind/title/createdAt/modifiedAt all match)",
  );

  // -------------------------------------------------------------------
  section("Summary");
  console.log(`  ${passCount} assertions passed, ${failCount} failed`);
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Drill script crashed:", error);
  process.exit(1);
});
