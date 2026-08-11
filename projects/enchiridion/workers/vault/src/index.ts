// Fetch handler for the vault worker — `/sync` and `/graphql` are real
// (routes into VaultDO, see ./vault-do.ts and ./graphql/yoga.ts); every
// other route below is still a stub.
//
// Access verification (plan P0 "Access service-token auth incl. WebSocket
// upgrade", Risk #7/#10): real as of this pass — `/sync`, `/blobs/*`, and
// `/graphql` are each gated by `verifyAccessRequest` (./access-auth.ts)
// before VaultDO (or, for `/graphql`, Yoga) is ever reached. See
// ./access-auth.ts's file header for the full client → Access → origin
// mechanism this checks, and ../ACCESS_SETUP.md for the manual Cloudflare
// dashboard prerequisites this depends on.
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md, plan
// §Backend architecture and §Phasing (P0 task list). Every route below
// throws until its owning P0 task lands, except `/sync` and `/graphql`:
//
//   /graphql              -> REAL as of "P0: vault Pothos+Yoga GraphQL
//                             endpoint (no gateway)" — see plan §"GraphQL
//                             API" and §"Reference implementation" for why
//                             this is a plain Pothos-core + Yoga schema
//                             served directly by this worker, not a
//                             federation-gateway design (that shape was
//                             built once, then reverted after adversarial
//                             review). `./graphql/schema.ts` is the schema
//                             (hand-written for P0, per the task brief —
//                             packages/graphql-composer's real
//                             composePothosConfig() is still P1 scope, see
//                             that package's file header); `./graphql/
//                             yoga.ts` resolves the VaultDO stub and adapts
//                             its typed accessor RPC methods
//                             (getPage/listPages) to what the schema's
//                             resolvers call — never vault.query(), the
//                             separate bounded free-form SQL RPC. No
//                             mutations yet (see schema.ts's file header on
//                             why that's a deliberate P1 punt, not an
//                             oversight). gatekeeper-google's server-only
//                             fields (EmailThread.messages, emailSearch)
//                             ARE wired as of the Gmail message-bodies/
//                             attachments follow-up task — see
//                             ./graphql/composed-schema.ts and
//                             ./graphql/yoga.ts's `GATEKEEPER_GOOGLE`
//                             Service Binding.
//   /schema/manifest.json -> "P1 — pages + supertag core + iOS"
//                             (plan §Supertag module contract: apps fetch
//                             this to render/edit any supertag at runtime)
//   /blobs/*               -> REAL as of "P0: R2 blob routes + nightly
//                             backup export + restore drill": forwarded
//                             into VaultDO's own `fetch()`, same pattern as
//                             `/sync` below — see ./blob-routes.ts's file
//                             header for the PUT/GET route contract.
//                             Access-gated as of "P0: Access service-token
//                             auth" — see ./access-auth.ts.
//   /sync (WS upgrade)    -> REAL as of "P0: VaultDO skeleton — Loro doc
//                             storage + sync protocol": routes into
//                             VaultDO's Hibernation-API handler (see
//                             ./vault-do.ts, ./sync-protocol.ts).
//                             Access-gated as of "P0: Access service-token
//                             auth incl. WebSocket upgrade" (plan Risk #7)
//                             — the check happens before the DO is ever
//                             reached, i.e. before the 101 upgrade
//                             response is returned. See ./access-auth.ts.
//   /enroll/provision      -> REAL as of "P8: device enrollment —
//                             Cloudflare Access Service Token
//                             provisioning": an ALREADY-ENROLLED device
//                             requests a fresh client_id/client_secret
//                             pair for a NEW device, minted via
//                             Cloudflare's real Access Service Token API.
//                             See ./enroll-routes.ts and
//                             ./cloudflare-access-api.ts.
//   /gatekeeper-google/*    -> REAL as of "P8: vault -> gatekeeper-google
//                             HTTP proxy route(s) for the write RPCs"
//                             (plan §Live Backend Connectivity, scope item
//                             1): eight POST routes forwarding an
//                             authenticated device request over REAL
//                             named-entrypoint Service Bindings
//                             (`GATEKEEPER_GOOGLE_CALENDAR_WRITE`/
//                             `GATEKEEPER_GOOGLE_GMAIL_WRITE`, never
//                             `.fetch()`) to gatekeeper-google's
//                             `CalendarWriteModel`/`GmailWriteModel`
//                             `WorkerEntrypoint` RPC methods (Gmail triage,
//                             calendar createEvent/rsvp, sendEmail). See
//                             ./gatekeeper-google-write-routes.ts's file
//                             header for the full route contract and why
//                             this preserves the SAME "no public fetch()
//                             surface into gatekeeper-google" discipline
//                             the `GATEKEEPER_GOOGLE` read binding's own
//                             adversarial-review BLOCKER fix established
//                             (./graphql/yoga.ts's `Env.GATEKEEPER_GOOGLE`
//                             doc comment).
//
// Writes (page mutations) are NOT GraphQL mutations here — per plan
// §"GraphQL & federation" ("Writes are RPC, not GraphQL mutations"), VaultDO's
// own RPC methods (called directly, DO-to-DO or via the DO namespace, not
// through this fetch handler) are vault's write-model, mirroring
// platform/leaderboard's write-model/main.ts WorkerEntrypoint pattern.
//
// VaultDO itself is a real implementation as of "P0: VaultDO skeleton —
// Loro doc storage + sync protocol" — see ./vault-do.ts.

import type { AccessEnv } from "./access-auth";
import { accessDenyResponse, verifyAccessRequest } from "./access-auth";
import type { CloudflareAccessApiEnv } from "./cloudflare-access-api";
import { handleEnrollProvisionRequest } from "./enroll-routes";
import { type GatekeeperGoogleWriteEnv, handleGatekeeperGoogleWriteRequest } from "./gatekeeper-google-write-routes";
import { handleGraphQLRequest } from "./graphql/yoga";
import type { VaultDO } from "./vault-do";
import { defaultVaultStub } from "./vault-stub";

export { VaultDO } from "./vault-do";

interface Env extends AccessEnv, CloudflareAccessApiEnv, GatekeeperGoogleWriteEnv {
  // Generic parameter added for "P0: vault Pothos+Yoga GraphQL endpoint" —
  // lets ./graphql/yoga.ts's context() call typed RPC methods
  // (getPage/listPages) directly on the resolved DurableObjectStub instead
  // of an untyped one. Structurally identical to the plain
  // `DurableObjectNamespace` every other route here already assumed.
  VAULT_DO: DurableObjectNamespace<VaultDO>;
  BLOBS: R2Bucket;
  // Service Binding to `workers/gatekeeper-google`, added for
  // `EmailThread.messages`/`Query.emailSearch` (see ./graphql/yoga.ts's
  // `Env.GATEKEEPER_GOOGLE` doc comment for the full rationale) — declared
  // here too so `handleGraphQLRequest(request, env)`'s call below
  // typechecks against `./graphql/yoga.ts`'s own `Env`, which requires it.
  GATEKEEPER_GOOGLE: Fetcher;
  // DEV-ONLY — see the `/dev/admin/*` block below. Unset (falsy) in every
  // real `wrangler.jsonc` `vars` block committed to this repo, so these
  // routes 404 by default; a local `wrangler dev --var
  // ENABLE_DEV_ADMIN_ROUTES:true` run is the only way to turn them on.
  ENABLE_DEV_ADMIN_ROUTES?: string;
}

function notImplemented(route: string, task: string): Response {
  return new Response(
    `not implemented — see task: ${task}\n` +
      `Plan: /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md\n` +
      `Route: ${route}`,
    { status: 501 },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Access verification (plan P0 "Access service-token auth incl.
    // WebSocket upgrade", Risks #7/#10): real as of this pass for every
    // route below that reaches VaultDO or Yoga — see ./access-auth.ts's
    // file header for the mechanism. `/graphql` is checked inside
    // `handleGraphQLRequest` itself (./graphql/yoga.ts) rather than here,
    // so it stays testable as one unit; `/sync` and `/blobs/*` are checked
    // inline below since they call VaultDO directly.

    if (url.pathname === "/graphql") {
      // Real as of "P0: vault Pothos+Yoga GraphQL endpoint" — see this
      // file's header comment above and ./graphql/yoga.ts/./graphql/
      // schema.ts for the schema + DO-stub wiring. `env` is passed through
      // as an extra positional arg per Yoga's documented Cloudflare
      // Workers integration — @whatwg-node/server flat-merges it into the
      // server context `context()` destructures `VAULT_DO` from (see
      // ./graphql/yoga.ts's header for the exact merge mechanics).
      // `handleGraphQLRequest` verifies Access BEFORE calling
      // `yoga.fetch`, including before GraphiQL's GET landing page.
      return handleGraphQLRequest(request, env);
    }

    if (url.pathname === "/schema/manifest.json") {
      // TODO(plan §Supertag module contract): build-time generated from
      // supertag modules in supertags/*, served here for runtime-driven
      // Swift UI (no app rebuild required for a new supertag).
      return notImplemented(url.pathname, "P1 — pages + supertag core + iOS");
    }

    if (url.pathname.startsWith("/blobs/")) {
      // Real as of "P0: R2 blob routes + nightly backup export + restore
      // drill" — forwarded into VaultDO's own `fetch()` the same way
      // `/sync` is below, because the pending-blob-references bookkeeping
      // these routes do (./blob-store.ts) needs this DO's own SQL storage;
      // the R2 byte-transfer itself doesn't need DO-SQLite
      // transactionality, only that bookkeeping does. See
      // ./blob-routes.ts's file header for the full PUT/GET route
      // contract (id validation, server-side hash verification, multipart
      // threshold, dedup).
      //
      // Access-gated as of "P0: Access service-token auth" (Risk #7) —
      // checked here, before VaultDO is ever reached.
      const blobAccess = await verifyAccessRequest(request, env);
      if (!blobAccess.ok) {
        return accessDenyResponse(blobAccess);
      }
      const stub = defaultVaultStub(env);
      return stub.fetch(request);
    }

    if (url.pathname === "/sync") {
      // VaultDO's Hibernation-API sync handler (./vault-do.ts) is real as
      // of this pass — wired here per Cloudflare's standard DO WebSocket
      // pattern: resolve the DO id, forward the still-Upgrade-headered
      // request into `DurableObject.fetch()`, and return whatever it
      // hands back (a 101 Switching Protocols response carrying the
      // client end of the WebSocketPair). See ./vault-do.ts and
      // ./sync-protocol.ts for the real message protocol/logic.
      //
      // Access-gated as of "P0: Access service-token auth incl. WebSocket
      // upgrade" (Risk #7) — checked HERE, before the DO is ever reached
      // and before the 101 upgrade response is returned, matching
      // `/blobs/*` and `/graphql`'s check-first ordering above. Per
      // ./access-auth.ts's file header: Access reads
      // `CF-Access-Client-Id`/`CF-Access-Client-Secret` off the client's
      // WebSocket-upgrade request the same way it does any other HTTPS
      // request, and — on success — forwards this worker the
      // `Cf-Access-Jwt-Assertion` header this checks.
      const syncAccess = await verifyAccessRequest(request, env);
      if (!syncAccess.ok) {
        return accessDenyResponse(syncAccess);
      }
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected a WebSocket upgrade request", { status: 426 });
      }
      const stub = defaultVaultStub(env);
      return stub.fetch(request);
    }

    if (url.pathname === "/enroll/provision") {
      // Real as of "P8: device enrollment — Cloudflare Access Service
      // Token provisioning" (plan §Live Backend Connectivity, "Device
      // auth" paragraph). Access-gated INSIDE `handleEnrollProvisionRequest`
      // itself (./enroll-routes.ts), same as `/graphql`'s
      // `handleGraphQLRequest` above — only an ALREADY-ENROLLED device's
      // valid Access credential can reach the pairing-code/Cloudflare-API
      // logic. See ./enroll-routes.ts's header for the full pairing
      // protocol and why the check has to live there (this route has no
      // DO stub to forward through first, unlike `/sync`/`/blobs/*`).
      return handleEnrollProvisionRequest(request, env);
    }

    if (url.pathname.startsWith("/gatekeeper-google/")) {
      // Real as of "P8: vault -> gatekeeper-google HTTP proxy route(s) for
      // the write RPCs" — see this file's header above and
      // ./gatekeeper-google-write-routes.ts's file header for the full
      // route contract, auth mechanism, and why this is new surface on
      // VAULT (not a new hole in gatekeeper-google). Access-gated INSIDE
      // `handleGatekeeperGoogleWriteRequest` itself, same as
      // `/enroll/provision`/`/graphql` above — this route dispatches on
      // exact pathname across eight distinct RPC calls, so keeping the
      // check inside the one function that owns that dispatch keeps it
      // directly unit-testable without a live fetch-handler test.
      return handleGatekeeperGoogleWriteRequest(request, env);
    }

    // -----------------------------------------------------------------
    // DEV-ONLY DEBUG ROUTES — NOT part of vault's production API surface.
    //
    // Added for the P0 exit-drill (plan §Verification: "kill the DO,
    // replay from storage, projections rebuild identically") —
    // `scripts/p0-exit-drill.ts` calls these to trigger and observe
    // VaultDO's already-real `rebuildProjections`/`rebuildProjectionsStatus`
    // RPC methods (`./vault-do.ts`) from outside the Workers runtime, which
    // has no other way to reach a DO's RPC surface directly (RPC methods
    // are only callable from another Worker/DO holding a
    // `DurableObjectStub`, not over plain HTTP). Gated OFF by default —
    // `ENABLE_DEV_ADMIN_ROUTES` is unset in every `vars` block committed to
    // `wrangler.jsonc`, so these 404 unless a local `wrangler dev --var
    // ENABLE_DEV_ADMIN_ROUTES:true` run explicitly turns them on — and
    // still requires the same Access verification every other route here
    // does, so this is not an auth bypass, only an admin-RPC exposure that
    // should never be reachable in a real deployment.
    if (url.pathname.startsWith("/dev/admin/")) {
      if (env.ENABLE_DEV_ADMIN_ROUTES !== "true") {
        return new Response("not found", { status: 404 });
      }
      const devAccess = await verifyAccessRequest(request, env);
      if (!devAccess.ok) {
        return accessDenyResponse(devAccess);
      }
      const stub = defaultVaultStub(env);

      if (url.pathname === "/dev/admin/rebuild-projections" && request.method === "POST") {
        const result = await stub.rebuildProjections();
        return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/dev/admin/rebuild-projections/status" && request.method === "GET") {
        const result = await stub.rebuildProjectionsStatus();
        return new Response(JSON.stringify(result ?? null), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/dev/admin/storage-telemetry" && request.method === "GET") {
        const result = await stub.storageTelemetry();
        return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  },

  /** Nightly cron (plan §Backend architecture, "Backup / disaster
   *  recovery"; `triggers.crons` in `wrangler.jsonc`, `["0 3 * * *"]` —
   *  03:00 UTC, a quiet hour for a single-user vault). Starts a resumable,
   *  alarm-batched backup export on VaultDO (`./backup.ts`,
   *  `VaultDO.runBackupExport`) and returns immediately — the export
   *  itself continues via the DO's own alarm loop (see `vault-do.ts`'s
   *  `alarm()`), matching `rebuildProjections()`'s existing
   *  start-then-alarm-drives-it shape. `ctx.waitUntil` is NOT needed here:
   *  starting the checkpoint is a single fast RPC call, not the batch work
   *  itself. */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const stub = defaultVaultStub(env);
    await stub.runBackupExport();
  },
};
