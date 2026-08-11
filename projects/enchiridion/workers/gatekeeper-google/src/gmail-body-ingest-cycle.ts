// @enchiridion/worker-gatekeeper-google — reentrancy-guarded, scope-gated
// Gmail body-ingest cycle runner. Mirrors `gmail-ingest-cycle.ts` exactly
// (same in-memory-flag reentrancy guard, same `GMAIL_READONLY_SCOPE`
// pre-check, same "return {skipped: true, reason} instead of throwing when
// not connected/not scoped" contract) — see that file's header for the full
// "why a synchronous in-memory flag is enough" argument, which applies
// unchanged here.

import { GMAIL_READONLY_SCOPE, GoogleOAuthError, type GoogleOAuthConfig } from "./oauth-client";
import { getValidAccessToken as resolveValidAccessToken, GoogleAccountNotConnectedError } from "./token-refresh";
import { hasGrantedScope } from "./token-store";
import { runGmailBodyIngest, type GmailBodyIngestResult } from "./gmail-body-ingest";
import type { FetchLike } from "./gmail-api";
import type { R2BucketLike } from "./r2-types";
import type { SqlExecutor } from "./schema";

export type GmailBodyIngestCycleResult = GmailBodyIngestResult | { skipped: true; reason: string };

export interface GmailBodyIngestCycleDeps {
  sql: SqlExecutor;
  r2: R2BucketLike;
  loadConfig: () => GoogleOAuthConfig;
  now?: () => Date;
  fetchImpl?: FetchLike;
}

/** Creates a reentrancy-guarded, scope-gated body-ingest-cycle runner bound
 *  to one set of deps — hold exactly one instance per `GoogleAccountDO`
 *  (constructed once in the constructor, not per call), same contract as
 *  `createGmailIngestCycleRunner`/`createCalendarIngestCycleRunner`. */
export function createGmailBodyIngestCycleRunner(deps: GmailBodyIngestCycleDeps): () => Promise<GmailBodyIngestCycleResult> {
  let inProgress = false;

  return async function runGmailBodyIngestCycle(): Promise<GmailBodyIngestCycleResult> {
    if (inProgress) {
      return { skipped: true, reason: "gmail body ingest already in progress" };
    }
    inProgress = true;
    try {
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

      return await runGmailBodyIngest({
        sql: deps.sql,
        r2: deps.r2,
        accessToken,
        now,
        fetchImpl: deps.fetchImpl,
      });
    } finally {
      inProgress = false;
    }
  };
}
