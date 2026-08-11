// @enchiridion/worker-gatekeeper-google — reentrancy-guarded, scope-gated
// Gmail ingest cycle runner ("P3: Gmail", plan §Google gatekeeper).
//
// Mirrors `calendar-ingest-cycle.ts` EXACTLY for the reentrancy guard (see
// that file's header for the full "why a synchronous in-memory flag is
// enough" argument — it applies unchanged here: a Durable Object runs one
// synchronous span of code without interleaving another call's code
// except at real `await` points, so `if (inProgress) {...} inProgress =
// true` with no `await` between them is race-free). The SAME class of bug
// this guard exists to prevent for Calendar — two overlapping
// `scheduled()` firings both reading the same starting cursor and racing
// on which cursor-write wins — applies identically to Gmail's own cursors
// (`gmail_backfill_state.page_token`/`completed`, `sync_cursors["gmail"]`),
// so Gmail gets the identical fix from the START rather than needing its
// own adversarial-review round to discover it.
//
// ADDITIONALLY SCOPE-GATED (Calendar has no equivalent — Calendar's scope
// was always requested on first connect, per the plan's staged-consent
// ordering "calendar.events -> gmail.readonly -> gmail.send"): before
// doing ANY Gmail work, checks `GoogleAccountDO.hasScope`'s backing
// function (`token-store.ts`'s `hasGrantedScope`) for
// `GMAIL_READONLY_SCOPE`. A user who has connected Calendar but never
// completed the SEPARATE `gmail_readonly` consent stage gets a clean
// `{skipped: true, reason: "..."}` — never a Gmail API call that would
// 403, and never an exception that would make `index.ts`'s `scheduled()`
// treat "Gmail not connected yet" as a cron failure worth alerting on
// (exactly the plan's "cleanly skip (not error)" requirement, and the
// prior task's handoff note it was written against).

import { GMAIL_READONLY_SCOPE, GoogleOAuthError, type GoogleOAuthConfig } from "./oauth-client";
import { getValidAccessToken as resolveValidAccessToken, GoogleAccountNotConnectedError } from "./token-refresh";
import { hasGrantedScope } from "./token-store";
import { runGmailIngest, type GmailIngestResult } from "./gmail-ingest";
import type { FetchLike } from "./gmail-api";
import type { SqlExecutor } from "./schema";
import type { VaultClientEnv } from "./vault-client";

export type GmailIngestCycleResult = GmailIngestResult | { skipped: true; reason: string };

export interface GmailIngestCycleDeps {
  sql: SqlExecutor;
  env: VaultClientEnv;
  /** Called fresh on every cycle attempt — see
   *  `calendar-ingest-cycle.ts`'s identical `loadConfig` doc comment for
   *  why (a `GoogleOAuthConfigError` must be caught at call time, not
   *  construction time). */
  loadConfig: () => GoogleOAuthConfig;
  now?: () => Date;
  fetchImpl?: FetchLike;
}

/** Creates a reentrancy-guarded, scope-gated Gmail ingest-cycle runner
 *  bound to one set of deps (in production, one `GoogleAccountDO`
 *  instance's storage/env). Call from
 *  `GoogleAccountDO.runGmailIngestCycle()`; hold exactly one instance per
 *  DO (constructed once, not per call) — same contract as
 *  `createCalendarIngestCycleRunner`. */
export function createGmailIngestCycleRunner(deps: GmailIngestCycleDeps): () => Promise<GmailIngestCycleResult> {
  let inProgress = false;

  return async function runGmailIngestCycle(): Promise<GmailIngestCycleResult> {
    if (inProgress) {
      return { skipped: true, reason: "gmail ingest already in progress" };
    }
    inProgress = true;
    try {
      // ONE `now` for the whole cycle attempt — same reasoning as
      // `calendar-ingest-cycle.ts`'s identical comment (token-freshness
      // check AND every timestamp `runGmailIngest` itself writes all
      // share this one value).
      const now = (deps.now ?? (() => new Date()))();
      const config = deps.loadConfig();
      let accessToken: string;
      try {
        accessToken = await resolveValidAccessToken({
          sql: deps.sql,
          config,
          now: now.getTime(),
          fetchImpl: deps.fetchImpl,
        });
      } catch (error) {
        if (error instanceof GoogleAccountNotConnectedError || error instanceof GoogleOAuthError) {
          return { skipped: true, reason: error.message };
        }
        throw error;
      }

      if (!hasGrantedScope(deps.sql, GMAIL_READONLY_SCOPE)) {
        return {
          skipped: true,
          reason:
            "Gmail not connected — grant gmail.readonly via /oauth/google/authorize?scope=gmail_readonly&reconnect=true",
        };
      }

      return await runGmailIngest({
        sql: deps.sql,
        env: deps.env,
        accessToken,
        now,
        fetchImpl: deps.fetchImpl,
      });
    } finally {
      inProgress = false;
    }
  };
}
