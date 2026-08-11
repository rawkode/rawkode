// @enchiridion/worker-gatekeeper-google — EmailThread materialization
// orchestration ("P3: Gmail", plan §Google gatekeeper). Mirrors
// `materialization.ts`'s role exactly (see that file's header for the
// general shape this follows): combines normalized-thread data
// (`gmail-materialization.ts`), doc construction
// (`gmail-materialized-doc.ts`), the SHARED local change-detection state
// (`materialization-store.ts` — reused as-is, see this file's own note
// below), the participant quality gate (`gmail-participants-store.ts`),
// and the VaultDO push (`vault-client.ts`) into the one operation
// `gmail-ingest.ts` calls per normalized thread: "materialize this
// EmailThread (and its qualifying participants' Person pages first, since
// the thread doc's edges need their page ids)".
//
// REUSING `calendar_materialization_state` (`materialization-store.ts`)
// FOR EmailThread PAGES TOO: that table is keyed generically by pageID,
// not by anything Calendar-specific (schema.ts's file header already
// describes it this way) — an `email_thread_<digest>` pageID and a
// `calendar_event_<digest>` pageID never collide, so this worker's ALREADY
//-EXISTING per-field-hash + Loro-snapshot bookkeeping applies unchanged.
// This also means a Person page materialized from BOTH a calendar invite
// AND a Gmail thread (same email, hence the SAME deterministic
// `derivePersonPageId` output) shares exactly one state row and one
// causal Loro history — exactly the right behavior, since it's genuinely
// the same graph page either way (see `materialization.ts`'s
// `materializePersonPage`, which this file calls for that reason, not a
// Gmail-specific duplicate).

import { diffChangedFields } from "./calendar-materialization";
import { emailThreadFieldBaselineHashes, type MaterializedThreadFields, type NormalizedParticipant, type NormalizedThread } from "./gmail-materialization";
import { buildEmailThreadDocUpdate } from "./gmail-materialized-doc";
import { PERSON_ORIGIN_GMAIL_CORRESPONDENT } from "./materialized-doc";
import { materializePersonPage } from "./materialization";
import { getMaterializationState, setMaterializationState } from "./materialization-store";
import { qualifyingParticipants } from "./gmail-participants-store";
import { recordThreadMessages } from "./gmail-body-store";
import type { SqlExecutor } from "./schema";
import { pushPageUpdate, type VaultClientEnv } from "./vault-client";

export const EMAIL_THREAD_DOC_TYPE = "emailThread";

export interface MaterializeEmailThreadResult {
  pageID: string;
  applied: boolean;
  /** Person pages materialized for this thread's QUALIFYING participants
   *  only — a non-qualifying participant never appears here (no Person
   *  page was created for them at all, see this file's header and
   *  `gmail-materialization.ts`'s quality-gate writeup). */
  personPageIDs: string[];
}

function dedupeParticipants(thread: NormalizedThread): Map<string, NormalizedParticipant> {
  const byEmail = new Map<string, NormalizedParticipant>();
  for (const participant of [...thread.fromParticipants, ...thread.toParticipants, ...thread.ccParticipants]) {
    if (!byEmail.has(participant.email)) byEmail.set(participant.email, participant);
  }
  return byEmail;
}

/** Materializes one normalized Gmail thread: its qualifying participants
 *  first (`materializePersonPage`, needed for the thread doc's edges),
 *  then the EmailThread page itself, skipping the VaultDO push entirely
 *  when NONE of the thread's owned fields' hashes differ from what this
 *  worker last wrote (same per-field-hash skip `materializeEventOccurrence`
 *  uses), and otherwise only re-touching the fields that actually
 *  changed. */
export async function materializeEmailThread(
  sql: SqlExecutor,
  env: VaultClientEnv,
  thread: NormalizedThread,
  now: Date,
): Promise<MaterializeEmailThreadResult> {
  const participantByEmail = dedupeParticipants(thread);
  const candidateEmails = [...participantByEmail.keys()];
  const qualifying = qualifyingParticipants(sql, candidateEmails);

  const personPageIDs: string[] = [];
  const pageIDByEmail = new Map<string, string>();
  for (const email of qualifying) {
    const participant = participantByEmail.get(email);
    const result = await materializePersonPage(
      sql,
      env,
      { email, displayName: participant?.displayName, origin: PERSON_ORIGIN_GMAIL_CORRESPONDENT },
      now,
    );
    pageIDByEmail.set(email, result.pageID);
    personPageIDs.push(result.pageID);
  }

  const resolveQualifyingPageIDs = (participants: readonly NormalizedParticipant[]): string[] =>
    participants
      .filter((p) => qualifying.has(p.email))
      .map((p) => pageIDByEmail.get(p.email))
      .filter((id): id is string => id !== undefined);

  const fromPageIDs = resolveQualifyingPageIDs(thread.fromParticipants);
  const toPageIDs = resolveQualifyingPageIDs(thread.toParticipants);
  const ccPageIDs = resolveQualifyingPageIDs(thread.ccParticipants);

  const fields: MaterializedThreadFields = {
    subject: thread.subject,
    labels: thread.labels,
    snippet: thread.snippet,
    lastMessageAt: thread.lastMessageAt,
    messageCount: thread.messageCount,
    fromPageIDs,
    toPageIDs,
    ccPageIDs,
  };
  const fieldHashes = await emailThreadFieldBaselineHashes(fields);
  const state = getMaterializationState(sql, thread.pageID);
  const changedFields = diffChangedFields(state?.fieldHashes, fieldHashes);

  // Record the thread's current message-id set REGARDLESS of whether the
  // page write below is applied or skipped (a thread with unchanged owned
  // fields can still have gained a message id this worker hasn't recorded
  // yet — labels/snippet/messageCount changing is what usually signals new
  // mail, but this index write is cheap and idempotent (`INSERT OR IGNORE`
  // per id, `gmail-body-store.ts`), so there's no reason to gate it behind
  // the field-change check at all). This is the ONLY place
  // `gmail_thread_messages` is populated — see that table's schema.ts doc
  // comment for why `gmail-body-ingest.ts`'s catch-up sweep depends on it.
  recordThreadMessages(sql, thread.pageID, thread.threadID, thread.messageIds);

  if (state && changedFields.size === 0) {
    return { pageID: thread.pageID, applied: false, personPageIDs };
  }

  const built = await buildEmailThreadDocUpdate({
    pageID: thread.pageID,
    thread,
    fromPageIDs,
    toPageIDs,
    ccPageIDs,
    changedFields,
    existingSnapshot: state?.docSnapshot,
    now,
  });

  if (built.changed) {
    await pushPageUpdate(env, thread.pageID, EMAIL_THREAD_DOC_TYPE, built.updateBytes);
  }

  setMaterializationState(sql, {
    pageID: thread.pageID,
    fieldHashes,
    docSnapshot: built.snapshotBytes,
    lastSyncedAt: now.getTime(),
  });

  return { pageID: thread.pageID, applied: built.changed, personPageIDs };
}
