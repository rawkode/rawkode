# AthenaeumDomain

A Swift package mirroring `apps/athenaeum/packages/domain/src`'s `effect/Schema` entities, RPC
wire schemas, and the `RpcErrorEnvelope`/`DomainError` pair — per the plan's "Repo/package layout":

> `native/AthenaeumDomain/` — Swift package mirroring `domain/` types (hand-synced; CI schema-diff check)

Hand-synced, not generated: every type in `Sources/AthenaeumDomain/*.swift` is a manually written
`Codable` Swift `struct`/`enum` whose JSON wire shape matches the TS `effect/Schema` definition it
mirrors exactly (same field names, same optional-field-omission behavior, same tagged-union
discriminant shapes). Builds and runs on macOS/iOS/watchOS with zero external dependencies
(Foundation only) — same discipline as `AthenaeumRPC`, for the same reason: this package's RPC
input/output types are what `AthenaeumRPC`'s watchOS-compatible transport carries.

## Building and testing

```sh
swift build
swift test
```

Tests decode real fixture JSON (`Tests/AthenaeumDomainTests/Fixtures/*.json`) produced by calling
`@athenaeum/domain`'s actual `Schema.encodeSync` from a Node/TS script — not hand-guessed JSON —
so a round trip validates this package's Codable mirrors against the real TS encoder's output.

## Regenerating fixtures

If `packages/domain/src` changes, regenerate fixtures against the rebuilt package:

```sh
cd ../../packages/domain && node_modules/.bin/tsc   # rebuild dist/ from current src/
cd ../../native/AthenaeumDomain/scripts
node scripts/generate-fixtures.ts   # or: node --experimental-strip-types generate-fixtures.ts
```

`generate-fixtures.ts` and `schema-diff.ts` both import `effect/Schema` and `@athenaeum/domain`'s
built `dist/`. Since these scripts live outside `packages/domain`'s own directory, Node's ESM
bare-specifier resolution needs a `node_modules` symlink alongside them pointing at
`packages/domain/node_modules` (already `.gitignore`d, not a real install of its own):

```sh
cd scripts
ln -sfn ../../../packages/domain/node_modules node_modules
```

## CI schema-diff check

```sh
cd scripts
node schema-diff.ts
```

Compares every mirrored TS `Schema.Class`'s field-name set (via its real runtime `.fields`
property) against the corresponding Swift `struct`'s stored-property names, extracted from
`Sources/AthenaeumDomain/*.swift` by a small brace-depth-aware scan (not a full Swift parser —
deliberately modest, per the plan's own risk #7 framing: "even a field-name-set diff catches the
most common drift"). Exits non-zero with a clear per-type diff on any mismatch — verified against
a live, deliberately-introduced field-name mismatch during development (see git history), not
just a design that was never actually run against real drift.

**Known limitations** (printed by the tool itself on every run, not just here):
- Field *types* aren't compared, only field-name sets.
- `ViewPredicate`/`FieldRef` (view-spec.ts) and `DomainError` are TS `Schema.Union`/tagged-variant
  shapes, not `Schema.Class` — not covered by this tool; their Swift mirrors are hand-verified
  against the TS union's discriminant+payload shape instead (see `ViewSpec.swift`'s and
  `RpcError.swift`'s own doc comments).
- TS `Schema.Literal` unions (`RelationCardinality`, `GraphIssueKind`, `SyncOperation`,
  `ViewRenderMode`, `GraphViewName`) aren't diffed automatically — a case added on one side only
  surfaces as a runtime decode failure, not at check time.
- `EntityId`/`IsoDateTimeString`/`WorkspaceEpoch` (branded scalars, no fields) are out of scope by
  construction.

## Relationship to `AthenaeumRPC`

`AthenaeumRPC` (built in the earlier "Decisions" stage, before this package existed) has its own
small, narrower `RPCNode`/`RPCPage`/`RPCEdge`/... structs and `AthenaeumDomainError` enum,
hand-mirrored directly against `packages/domain/src` at the time since no Swift domain package
existed yet. This package (`AthenaeumDomain`) is now the intended canonical source for those
types; having `AthenaeumRPC` depend on `AthenaeumDomain` instead of its own local mirror is a
natural follow-up but is **not done by this change** — this stage's scope was building
`AthenaeumDomain` itself, not modifying `AthenaeumRPC`.
