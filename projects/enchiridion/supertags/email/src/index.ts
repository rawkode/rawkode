// @enchiridion/supertags-email — the EmailThread supertag module.
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md, plan §Google
// gatekeeper (Gmail section): "Threads -> EmailThread pages (subject,
// participant edges, labels, snippet), with a participant quality gate —
// Person pages are only auto-created for correspondents you've actually
// exchanged mail with, not every newsletter sender, to avoid graph
// pollution." and "Message bodies stay out of the CRDT graph — bodies in
// gatekeeper DO SQLite, attachments in R2 (same content-addressed scheme),
// served via server-only GraphQL fields (`thread.messages`, `emailSearch`)."
//
// Deliberately NOT on this module: message bodies, or any field that would
// pull Gmail message content into the CRDT graph. `subject`/`snippet` are
// the two Gmail-supplied strings the plan explicitly allows onto the page
// itself (both are metadata Gmail's `threads.list`/`messages.list` already
// return cheaply, not a message body); everything else (full bodies,
// attachments) is server-only per the plan and belongs to a follow-up P3
// ingest task (`workers/gatekeeper-google`), not this module.
//
// The "participant quality gate" (only auto-create Person pages for
// correspondents you've actually exchanged mail with) is ALSO follow-up
// ingest-task logic, not this module's concern — this module just declares
// the `participants`/`from`/`cc` entityReference fields those Person pages
// get referenced through, the same way `supertags/core`'s `event.attendees`
// declares the shape without deciding ingest policy.
//
// Field/relation shape, ported to the module contract used by
// `supertags/core` (see that package's `index.ts` header for the
// conventions followed here: `tag()`/qualified-id helpers, relations wired
// to entityReference fields via `RelationDefinition.property`, select-field
// option ids derived by `f.select()`'s lowercase-hyphen slugification).
//
// Cross-module dependency: this module's `from`/`to`/`cc` fields reference
// `@enchiridion/supertags-core`'s `person` supertag (its own qualified id,
// `dev.rawkode.enchiridion.core.person` — see `CoreSupertagIDs.person`
// re-exported from that package). This is the module-contract's first real
// cross-module `parents`/entityReference dependency exercised outside
// `supertags/core` itself (no other module — `workouts` is still a
// TODO-only skeleton — currently references a `core` supertag), which is
// why `package.json` already lists `@enchiridion/supertags-core` as a
// dependency (see that file) even before this module was implemented.

import { defineSupertagModule, f, type SupertagModule } from "@enchiridion/schema";
import { CoreSupertagIDs } from "@enchiridion/supertags-core";

const MODULE_ID = "dev.rawkode.enchiridion.email";

/** Fully-qualified supertag id for a key declared in this module's
 *  `supertags` — same derivation convention as `supertags/core`'s `tag()`
 *  helper. */
function tag(key: string): string {
  return `${MODULE_ID}.${key}`;
}

const EMAIL_THREAD = tag("emailThread");
const PERSON = CoreSupertagIDs.person;

const supertags: SupertagModule["supertags"] = {
  emailThread: {
    name: "Email Thread",
    symbol: "envelope",
    fields: {
      subject: f.text({ name: "Subject" }),
      // Gmail label ids/names (e.g. "INBOX", "IMPORTANT", a user label's
      // display name) — allowsMultiple because a thread carries a set of
      // labels, not a single one. Kept as plain text (not `select`): the
      // set of possible Gmail labels is per-account and open-ended (users
      // create their own), unlike this module's own closed `select` option
      // sets elsewhere in the codebase (e.g. `core.project.status`).
      labels: f.text({ name: "Labels", allowsMultiple: true }),
      // Gmail's own thread/message snippet (a short plain-text preview),
      // NOT a message body — see this file's header on why bodies never
      // reach this module's fields at all.
      snippet: f.text({ name: "Snippet", isMultiline: true }),
      lastMessageAt: f.dateTime({ name: "Last message at" }),
      messageCount: f.number({ name: "Message count" }),
      // Participant edges. Separate from/to/cc fields (rather than one
      // flattened `participants` field) so each Gmail envelope role stays
      // distinguishable on the page and in queries — matches Gmail's own
      // `From`/`To`/`Cc` header shape, which the ingest task reads
      // per-message before folding into thread-level fields.
      from: f.entityReference([PERSON], { name: "From", allowsMultiple: true }),
      to: f.entityReference([PERSON], { name: "To", allowsMultiple: true }),
      cc: f.entityReference([PERSON], { name: "Cc", allowsMultiple: true }),
    },
  },
};

const relations: NonNullable<SupertagModule["relations"]> = {
  emailThreadFrom: {
    from: [EMAIL_THREAD],
    to: [PERSON],
    forwardName: "from",
    inverseName: "sent threads",
    cardinality: "manyToMany",
    property: { supertagID: EMAIL_THREAD, fieldID: "from" },
  },
  emailThreadTo: {
    from: [EMAIL_THREAD],
    to: [PERSON],
    forwardName: "to",
    inverseName: "received threads",
    cardinality: "manyToMany",
    property: { supertagID: EMAIL_THREAD, fieldID: "to" },
  },
  emailThreadCc: {
    from: [EMAIL_THREAD],
    to: [PERSON],
    forwardName: "cc",
    inverseName: "cc'd threads",
    cardinality: "manyToMany",
    property: { supertagID: EMAIL_THREAD, fieldID: "cc" },
  },
};

export default defineSupertagModule({
  id: MODULE_ID,
  version: 1,
  supertags,
  relations,
});

// Re-exported for tests and downstream consumers (graphql-composer,
// codegen, the future Gmail ingest task) that want the qualified tag/field
// ids without re-deriving them — same convention as
// `supertags/core`'s `CoreSupertagIDs`.
export const EmailSupertagIDs = {
  emailThread: EMAIL_THREAD,
} as const;
