# Native Loro boundary

Athenaeum has replaced Automerge for new and migrated page authority, but the
repository is not yet Automerge-free. The web and backend still need to read
pre-migration `automerge-v1` pages, and older clients still speak the legacy
sync RPCs. The native app therefore treats the two formats differently:

- Loro pages use the native replica, semantic commit path, and ledgered
  provenance already implemented in `AthenaeumCore`.
- Legacy pages are a compatibility projection. Native may display the server's
  flattened text, but it must not originate Automerge bytes or mutate the
  legacy document locally.
- Migration is a server-owned operation. It must compare the descriptor's
  exact Automerge witness, derive the Loro candidate on the server, validate
  semantic equivalence, and record the migration in the ledger before native
  resumes editing through Loro.

## Current gap

The native cutover is now complete for the shipped targets: `AthenaeumCore` and
`AthenaeumAppUI` no longer link `automerge-swift`, and the macOS/iOS products
contain only the Loro runtime. The old duplicate `_rust_eh_personality` linker
failure is therefore gone; the native legacy editor and its Automerge tests are
not part of the shipped dependency graph. The exact source and link audits are
recorded in `native/AthenaeumCore/LEGACY_AUTOMERGE_VERIFIER.md`.

What remains is the repository-wide compatibility window, not a native runtime
choice:

1. Existing `automerge-v1` pages still need to be migrated or intentionally
   archived, with their immutable witnesses validated.
2. All active clients and agent/chat edits must use the Loro semantic commit
   path; the legacy fork and compatibility RPCs must have no live consumers.
3. Native rich-text editing still needs parity with the web Loro editor before
   the old decoder and legacy RPCs can be deleted.
4. Telemetry (or an equivalent inventory) must show that no legacy clients or
   descriptors remain before a read-only compatibility release window.

The complete repository-wide removal gate lives in
`docs/page-format-migration-status.md`.
