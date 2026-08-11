// Test-only. NOT shipped to the Worker bundle — only `*.test.ts` files
// import this. A fake cross-script `VAULT` Durable Object binding
// (`vault-client.ts`) that records every `createOrUpdatePage`/
// `tombstonePage` call in-memory instead of talking to a real VaultDO —
// this worker's tests care about WHAT this worker would have pushed to
// vault, not vault's own behavior (that's `workers/vault`'s own test
// suite's job).

import type { VaultClientEnv, VaultDOStub } from "../vault-client";

export interface CreateOrUpdateCall {
  pageID: string;
  docType: string;
  updateBytesBase64: string;
}

export interface FakeVaultRecorder {
  env: VaultClientEnv;
  createOrUpdateCalls: CreateOrUpdateCall[];
  tombstoneCalls: string[];
}

export interface FakeVaultEnvOptions {
  /** 1-indexed: the Nth `createOrUpdatePage` call whose `docType` is
   *  `"calendarMaterializedEvent"` throws instead of succeeding (person
   *  pushes are never made to fail by this option). Used by
   *  `calendar-ingest.test.ts`'s poison-pill-isolation tests to simulate
   *  one event's materialization write failing mid-batch, per
   *  `calendar-ingest.ts`'s "CURSOR-AFTER-MATERIALIZATION + POISON-PILL
   *  ISOLATION" contract. */
  failEventPushIndex?: number;
  /** Same shape as `failEventPushIndex`, for `docType === "emailThread"`
   *  pushes — used by `gmail-ingest.test.ts`'s poison-pill-isolation tests
   *  (`gmail-ingest.ts`'s "CURSOR-AFTER-BATCH + POISON-PILL ISOLATION"
   *  contract, mirroring Calendar's). A separate counter/option from
   *  `failEventPushIndex` so a test can fail Gmail's Nth push without
   *  coincidentally also matching Calendar's counter (they're independent
   *  worker paths that could, in principle, both push in the same test if
   *  one ever exercised both — kept independent defensively). */
  failEmailThreadPushIndex?: number;
}

export function createFakeVaultEnv(options: FakeVaultEnvOptions = {}): FakeVaultRecorder {
  const createOrUpdateCalls: CreateOrUpdateCall[] = [];
  const tombstoneCalls: string[] = [];
  let eventPushCount = 0;
  let emailThreadPushCount = 0;

  const stub: VaultDOStub = {
    async createOrUpdatePage(pageID, docType, updateBytesBase64) {
      if (docType === "calendarMaterializedEvent") {
        eventPushCount += 1;
        if (options.failEventPushIndex === eventPushCount) {
          throw new Error(`simulated VaultDO failure on event push #${eventPushCount} (page ${pageID})`);
        }
      }
      if (docType === "emailThread") {
        emailThreadPushCount += 1;
        if (options.failEmailThreadPushIndex === emailThreadPushCount) {
          throw new Error(`simulated VaultDO failure on emailThread push #${emailThreadPushCount} (page ${pageID})`);
        }
      }
      createOrUpdateCalls.push({ pageID, docType, updateBytesBase64 });
      return { applied: true };
    },
    async tombstonePage(pageID) {
      tombstoneCalls.push(pageID);
      return { tombstoned: true };
    },
  };

  const namespace = {
    idFromName: (_name: string) => ({ toString: () => "fake-vault-do-id" }),
    get: (_id: unknown) => stub,
  };

  return {
    env: { VAULT: namespace as unknown as VaultClientEnv["VAULT"] },
    createOrUpdateCalls,
    tombstoneCalls,
  };
}
