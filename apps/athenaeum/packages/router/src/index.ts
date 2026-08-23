// Router Worker: forwards `/api/*` to the backend, `/gatekeeper/<name>/*` to whichever
// `GATEKEEPER_*` service binding matches, else static assets.
//
// Phase 5 addition: real `GATEKEEPER_*` service-binding discovery, ported from
// `cloudflare-os/packages/router/src/index.ts` verbatim (per the plan's own "Deployment topology"
// section: "packages/router is a dumb path-prefix proxy — copy the pattern... verbatim: it
// discovers GATEKEEPER_* service bindings by scanning env keys at request time and forwards
// /api/* to the backend, everything else to static assets"). Phase 0 built only the `/api/*` half
// of this (confirmed by reading `router/src/index.ts` before extending it, per this task's own
// instruction) — this stage adds the other half, now that `gatekeeper-google-calendar` is a real,
// bindable Worker (`athenaeum-gatekeeper-google-calendar`, see its own `wrangler.jsonc`).
//
// Routing config IS the binding set (cloudflare-os's own framing, restated here): installing a
// second gatekeeper later means adding one more `GATEKEEPER_*` service binding to
// `wrangler.jsonc` and redeploying this Worker — no code change in this file.
//
// **This Worker deliberately does NOT add its own auth check on the `/gatekeeper/*` forward
// below** (adversarial-review note, not a gap left open): it stays a "dumb path-prefix proxy" by
// design, exactly as this file's own header comment says. The caller-authentication fix lives one
// hop further in — `athenaeum-gatekeeper-google-calendar`'s own `worker.ts` now verifies a
// shared-secret/HMAC credential on every route it serves (`service-caller-auth.ts`), so a request
// forwarded through here with no such credential 401s there regardless of how it arrived. Before
// that fix, this router's unconditional forward WAS part of a real unauthenticated-access path
// (traced in the Phase 5 adversarial review) — flagged here so a future reader doesn't mistake
// this router's continued lack of its own check for the gap still being open.

export interface Env {
  BACKEND: Fetcher;
  /** Present once `web` is built to ../web/dist and wrangler picks up the assets stanza. */
  ASSETS?: Fetcher;
  [key: string]: unknown;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // `GATEKEEPER_GOOGLE_CALENDAR` -> `/gatekeeper/google-calendar` (env-key-name ->
    // path-prefix mapping, identical transform to cloudflare-os's own router: strip the
    // `GATEKEEPER_` prefix, lower-case, underscores -> hyphens).
    for (const key of Object.keys(env)) {
      if (!key.startsWith("GATEKEEPER_")) continue;
      const suffix = key.slice("GATEKEEPER_".length).toLowerCase().replaceAll("_", "-");
      const prefix = `/gatekeeper/${suffix}`;
      if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
        return (env[key] as Fetcher).fetch(req);
      }
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return env.BACKEND.fetch(req);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(req);
    }

    return env.BACKEND.fetch(req);
  },
} satisfies ExportedHandler<Env>;
