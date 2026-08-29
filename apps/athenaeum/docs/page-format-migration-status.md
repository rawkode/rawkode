# Page document format status

**As of 2026-08-27:** Athenaeum is Loro-first, not Automerge-free.

Loro is the authority for every new page and for pages that have been explicitly
migrated. Automerge remains a compatibility lane so existing pages and older
clients do not become unreadable while migration is still in progress.

## The three descriptor states

| Descriptor | Authority | Meaning |
| --- | --- | --- |
| `automerge-v1` | Automerge | A pre-migration page. The legacy page row and blob remain authoritative. |
| `loro-v1` + `automerge` witness | Loro | A migrated page. The Automerge metadata is retained as an immutable integrity witness; it is not a second writable authority. |
| `loro-v1` without `automerge` | Loro | A native page created after the format cutover. It has no Automerge source. |

The backend intentionally treats a missing format row as legacy **only when the
legacy page/blob exists**. That fallback is what keeps pre-migration pages
readable; it is not the creation default.

## What uses Loro today

- `createLoroPage` / `ensureLoroPage` create new pages as `loro-v1`.
- The web daily note resolves a Loro descriptor first and renders
  `LoroRichNoteEditor`.
- The native daily note resolves missing pages through the Loro creation route.
- Loro semantic content commits go through the ledgered
  `commitLoroPageContent` RPC with a mutation intent and commit message.
- `migrateLegacyPage` is the only migration write route. The server compares the
  complete Automerge witness, derives a canonical plain-text Loro page, and
  records a digest-only migration receipt in the ledger. The old
  caller-supplied `activateLoroPage` route is disabled.
- Migrated pages are read and written through Loro while their original
  Automerge identity is checked as an immutable witness.

## What is still legacy

- `createPage`, `startPageSync`, and `pageSyncMessage` remain the Automerge RPC
  lane for existing clients and explicitly legacy descriptors.
- The lazily loaded web `RichNoteEditor` is only entered for an explicit
  `automerge-v1` descriptor.
- Native reads legacy pages through the server-owned projection only. The shipped
  Core target does not link Automerge; a local legacy row is a recovery witness,
  and a dirty row fails closed rather than being overwritten by projected text.
- Legacy projections are tagged and persist the same-load Automerge witness
  (`storageVersion`, `docId`, `headsHash`, and `bytesSha256`) before native UI
  presents them: only lossless flat text is exposed; rich or
  oversized documents are reported as migration-required without flattened
  text. Rich-text conversion remains a later migration package.
- Chat `editNote` is format-aware: Loro pages commit through the semantic ledger
  with agent-job provenance, while legacy Automerge pages retain the fork/accept/
  revert compatibility mechanism.
- Existing Automerge pages have not been bulk-migrated. Migration is explicit so
  a partially converted page cannot have two writable authorities.

## Removal gate

Automerge can be removed only after all of the following are true:

1. Existing pages have been migrated (or intentionally archived) and their
   immutable witnesses validate.
2. All active pages and clients use the Loro semantic commit path, including
   chat/agent edits, retry, and conflict recovery; the legacy fork is no longer
   needed by any descriptor.
3. Native rich-text editing has parity with the web Loro editor; the current
   native plain-text subset is not sufficient for removal.
4. Telemetry or an equivalent inventory shows no legacy clients or descriptors
   still using the compatibility RPCs.
5. A release has completed a read-only compatibility window before deleting the
   old decoder, RPCs, and dependencies.

Until that gate is met, removing Automerge would be a data-loss or downgrade
risk, not cleanup.
