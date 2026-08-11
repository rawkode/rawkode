// @enchiridion/worker-vault — end-to-end proof that the Gmail
// message-bodies/attachments follow-up task's two server-only GraphQL
// fields (`EmailThread.messages`, `Query.emailSearch`) resolve real data
// through the composed schema. Mirrors `composed-schema.test.ts`'s rigor
// (real write-model RPC + real reprojection + a real `graphql()` execution
// against the actual composed `schema`) for the core-supertag relation
// path; this file covers the SAME schema's Gmail-specific half instead.
//
// The one thing this test CANNOT exercise for real (same limitation
// `composed-schema.test.ts`'s own header documents for the DO-RPC
// boundary): the actual `env.GATEKEEPER_GOOGLE.fetch(...)` Service Binding
// call `./yoga.ts`'s `buildGatekeeperGoogleAccessors` makes — that needs a
// live `wrangler dev`/Miniflare pair of workers this sandbox has no
// network/account access to drive. Instead, `contextFor` below wires
// `ComposedVaultContext.gatekeeperGoogle` to a FAKE `GatekeeperGoogleAccessors`
// that returns canned `EmailMessageDTO[]` data — the same
// "fake the one external boundary, keep everything else real" convention
// `composed-schema.test.ts`'s own header describes for its DO-RPC hop. What
// IS real here: the `EmailThread` page (written via the real write-model
// RPC + real reprojection, exactly like `composed-schema.test.ts`), the
// real composed schema (including `@enchiridion/supertags-email` now being
// a loaded module — `supertag-registry.ts`), the real
// `builder.objectFields`/`builder.queryFields` wiring in
// `composed-schema.ts`, and a real `graphql()` execution end to end.

import { describe, expect, test } from "bun:test";
import { graphql } from "graphql";
import { LoroDoc } from "loro-crdt/bundler";
import { EmailSupertagIDs } from "@enchiridion/supertags-email";
import type { EmailMessageDTO } from "@enchiridion/gatekeeper-google-rpc-contract";
import { initializeSchema } from "../schema";
import { installSupertagRegistryProjection } from "../registry-projection";
import { SqliteStorageAdapter } from "../test-helpers/sqlite-storage-adapter";
import { createOrUpdatePage } from "../vault-write-model";
import {
  getNodeWithFacts,
  getNodesWithFacts,
  getRelationSources,
  getRelationTargets,
  listNodesByTag,
} from "../supertag-accessors";
import { getPage, listPages } from "../query-accessors";
import { schema, type ComposedVaultContext, type GatekeeperGoogleAccessors } from "./composed-schema";

const EMAIL_THREAD = EmailSupertagIDs.emailThread;

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  installSupertagRegistryProjection(sql);
  return sql;
}

function clientUpdateBytes(mutate: (doc: LoroDoc) => void): Uint8Array {
  const doc = new LoroDoc();
  mutate(doc);
  doc.commit();
  return doc.export({ mode: "update" });
}

/** A fake `GatekeeperGoogleAccessors` backed by an in-memory fixture map —
 *  see this file's header for why this is the one faked boundary.
 *  `calls` records every invocation so tests can assert BATCHING (one call
 *  per GraphQL operation, not one per thread — plan Risk #11). */
function fakeGatekeeperGoogle(messagesByThread: Record<string, EmailMessageDTO[]>): GatekeeperGoogleAccessors & {
  getMessagesForThreadsCalls: readonly string[][];
  searchEmailCalls: readonly [string, number | undefined][];
} {
  const getMessagesForThreadsCalls: string[][] = [];
  const searchEmailCalls: [string, number | undefined][] = [];
  return {
    getMessagesForThreadsCalls,
    searchEmailCalls,
    async getMessagesForThreads(threadPageIDs) {
      getMessagesForThreadsCalls.push([...threadPageIDs]);
      const result = new Map<string, EmailMessageDTO[]>();
      for (const id of threadPageIDs) {
        const messages = messagesByThread[id];
        if (messages) result.set(id, messages);
      }
      return result;
    },
    async searchEmail(query, limit) {
      searchEmailCalls.push([query, limit]);
      const all = Object.values(messagesByThread).flat();
      return all.filter((m) => (m.bodyText ?? "").includes(query) || (m.subject ?? "").includes(query)).slice(0, limit ?? all.length);
    },
  };
}

function contextFor(sql: SqliteStorageAdapter, gatekeeperGoogle: GatekeeperGoogleAccessors): ComposedVaultContext {
  return {
    vault: {
      getPage: async (id) => getPage(sql, id),
      listPages: async (options) => listPages(sql, options),
      getNodeWithFacts: async (id) => getNodeWithFacts(sql, id),
      getNodesWithFacts: async (ids) => getNodesWithFacts(sql, ids),
      listNodesByTag: async (tagID, options) => listNodesByTag(sql, tagID, options),
      getRelationTargets: async (relationID, sourceNodeIDs) => {
        const record = Object.fromEntries(getRelationTargets(sql, relationID, sourceNodeIDs));
        return new Map(Object.entries(record));
      },
      getRelationSources: async (relationID, targetNodeIDs) => {
        const record = Object.fromEntries(getRelationSources(sql, relationID, targetNodeIDs));
        return new Map(Object.entries(record));
      },
    },
    gatekeeperGoogle,
  };
}

function makeEmailThreadPage(sql: SqliteStorageAdapter, pageID: string, subject: string): void {
  const bytes = clientUpdateBytes((doc) => {
    doc.getText("title").insert(0, subject);
    doc.getMap("tags").set(EMAIL_THREAD, true);
  });
  const result = createOrUpdatePage(sql, pageID, "free", bytes, Date.now());
  expect(result.applied).toBe(true);
}

describe("composed schema — EmailThread.messages / Query.emailSearch (server-only Gmail fields)", () => {
  test("EmailThread.messages resolves real stored messages for a real materialized page", async () => {
    const sql = makeSql();
    makeEmailThreadPage(sql, "email_thread_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Project kickoff");

    const messagesByThread: Record<string, EmailMessageDTO[]> = {
      email_thread_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: [
        {
          id: "m1",
          threadPageID: "email_thread_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          from: "alex@example.com",
          to: "david@rawkode.academy",
          subject: "Project kickoff",
          bodyText: "Hey, following up on this...",
          receivedAt: 1754470800000,
          attachments: [{ blobID: "blob_" + "a".repeat(64), filename: "agenda.pdf", mimeType: "application/pdf", size: 1024 }],
        },
      ],
    };
    const fake = fakeGatekeeperGoogle(messagesByThread);

    const result = await graphql({
      schema,
      source: `
        query {
          emailThread(id: "email_thread_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
            id
            messages {
              id
              from
              subject
              bodyText
              receivedAt
              attachments {
                blobId
                filename
                mimeType
                size
              }
            }
          }
        }
      `,
      contextValue: contextFor(sql, fake),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      emailThread: {
        id: "email_thread_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        messages: [
          {
            id: "m1",
            from: "alex@example.com",
            subject: "Project kickoff",
            bodyText: "Hey, following up on this...",
            receivedAt: 1754470800000,
            attachments: [{ blobId: "blob_" + "a".repeat(64), filename: "agenda.pdf", mimeType: "application/pdf", size: 1024 }],
          },
        ],
      },
    });
  });

  test("EmailThread.messages resolves to [] (never null/error) for a thread with no stored messages yet", async () => {
    const sql = makeSql();
    makeEmailThreadPage(sql, "email_thread_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "No bodies ingested yet");
    const fake = fakeGatekeeperGoogle({});

    const result = await graphql({
      schema,
      source: `query { emailThread(id: "email_thread_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") { id messages { id } } }`,
      contextValue: contextFor(sql, fake),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      emailThread: { id: "email_thread_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", messages: [] },
    });
  });

  test("EmailThread.messages batches ONE gatekeeperGoogle call across multiple threads in the same query (plan Risk #11)", async () => {
    const sql = makeSql();
    makeEmailThreadPage(sql, "email_thread_cccccccccccccccccccccccccccccccccccccccc", "Thread C");
    makeEmailThreadPage(sql, "email_thread_dddddddddddddddddddddddddddddddddddddddd", "Thread D");

    const messagesByThread: Record<string, EmailMessageDTO[]> = {
      email_thread_cccccccccccccccccccccccccccccccccccccccc: [
        {
          id: "mc",
          threadPageID: "email_thread_cccccccccccccccccccccccccccccccccccccccc",
          subject: "C",
          receivedAt: 1,
          attachments: [],
        },
      ],
      email_thread_dddddddddddddddddddddddddddddddddddddddd: [
        {
          id: "md",
          threadPageID: "email_thread_dddddddddddddddddddddddddddddddddddddddd",
          subject: "D",
          receivedAt: 2,
          attachments: [],
        },
      ],
    };
    const fake = fakeGatekeeperGoogle(messagesByThread);

    const result = await graphql({
      schema,
      source: `
        query {
          c: emailThread(id: "email_thread_cccccccccccccccccccccccccccccccccccccccc") { messages { id } }
          d: emailThread(id: "email_thread_dddddddddddddddddddddddddddddddddddddddd") { messages { id } }
        }
      `,
      contextValue: contextFor(sql, fake),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      c: { messages: [{ id: "mc" }] },
      d: { messages: [{ id: "md" }] },
    });
    // ONE batched call carrying both thread ids — not two separate calls.
    expect(fake.getMessagesForThreadsCalls).toHaveLength(1);
    expect(new Set(fake.getMessagesForThreadsCalls[0])).toEqual(
      new Set([
        "email_thread_cccccccccccccccccccccccccccccccccccccccc",
        "email_thread_dddddddddddddddddddddddddddddddddddddddd",
      ]),
    );
  });

  test("Query.emailSearch finds a message by body content and coexists with the rest of the merged schema", async () => {
    const sql = makeSql();
    makeEmailThreadPage(sql, "email_thread_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "Budget review");

    const messagesByThread: Record<string, EmailMessageDTO[]> = {
      email_thread_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee: [
        {
          id: "me1",
          threadPageID: "email_thread_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          subject: "Budget review",
          bodyText: "Please review the Q1 budget spreadsheet before Friday.",
          receivedAt: 10,
          attachments: [],
        },
        {
          id: "me2",
          threadPageID: "email_thread_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          subject: "Unrelated newsletter",
          bodyText: "Weekly newsletter content with nothing relevant.",
          receivedAt: 20,
          attachments: [],
        },
      ],
    };
    const fake = fakeGatekeeperGoogle(messagesByThread);

    const result = await graphql({
      schema,
      source: `query { emailSearch(query: "budget") { id subject } }`,
      contextValue: contextFor(sql, fake),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ emailSearch: [{ id: "me1", subject: "Budget review" }] });

    // The SAME merged schema still answers a Page query for the same
    // underlying node, proving emailSearch composed onto the schema
    // without disturbing anything else (mirrors composed-schema.test.ts's
    // own point 5).
    const pageResult = await graphql({
      schema,
      source: `query { page(id: "email_thread_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") { id kind } }`,
      contextValue: contextFor(sql, fake),
    });
    expect(pageResult.errors).toBeUndefined();
    expect(pageResult.data).toEqual({
      page: { id: "email_thread_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", kind: "free" },
    });
  });
});
