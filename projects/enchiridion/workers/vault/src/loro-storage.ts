// @enchiridion/worker-vault — Loro isolation layer.
//
// Every direct call into `loro-crdt` lives here, and nowhere else in this
// worker, per the task's isolation requirement: if the WASM package turns
// out not to be usable in some deployment context, this is the one file
// that needs a replacement body, not a redesign of `doc-store.ts`/
// `vault-do.ts`.
//
// VERIFICATION NOTE (read before adding a `TODO(verify-loro-api)` tag to
// something that doesn't need one): every `loro-crdt` call below was
// checked against the ACTUAL installed package in this sandbox —
// `node_modules/loro-crdt@1.13.7`'s real `bundler/loro_wasm.d.ts` (the
// generated wasm-bindgen type declarations, not hand-written docs) — and
// exercised against the real WASM module under `bun test` (see
// `loro-storage.test.ts`; nothing here is mocked). Where a comment cites
// "loro_wasm.d.ts", that's this file at that installed version, at the
// line/JSDoc example actually read. Mirrors `LoroEngine.swift`'s API
// choices 1:1 where a Swift equivalent exists, noted per call.
//
// VERSION LOCKSTEP (plan Risk #1) — ACTUALLY VERIFIED, not assumed: an
// earlier revision of this comment (and of package.json, which pinned
// `^1.13.9`) asserted "same Rust core per plan Risk #1's lockstep-version
// mitigation" without having checked it. That was wrong to state as fact —
// it hadn't been verified. It has now:
//   - `loro-swift`'s published tag `1.13.3` (the exact pin in
//     apps/swift/Package.swift) is a Swift-binding-layer version number,
//     NOT the Rust core version — its own `loro-swift/Cargo.lock` (the file
//     that pins what actually got compiled into the shipped
//     `loroFFI.xcframework` binary) resolves `loro-ffi`/`loro-internal`/
//     `loro` all at core version **1.13.7**, from crates.io.
//   - The `loro-dev/loro` monorepo releases its Rust core and its
//     JS/WASM (`loro-crdt`) package in lockstep under one shared version
//     number by construction: `loro-crdt@1.13.7`'s published npm metadata
//     has `gitHead` `664687f38119a5637dbbb53c742954ad96e41c8f`, and fetching
//     `crates/loro-wasm/Cargo.toml` at that exact commit shows the
//     `loro-wasm` crate's own `version` field is literally `"1.13.7"`,
//     depending on `loro-internal` as a same-workspace path dependency —
//     i.e. `loro-crdt`'s npm version number IS the core version it wraps,
//     not a coincidentally-similar independent counter. (Cross-checked the
//     same way for `1.13.9`: its npm `gitHead` exactly matches the
//     `loro-dev/loro` repo's own `rust-pre-release@1.13.9` tag commit.)
//   - Therefore `loro-crdt@1.13.7` (exact, no caret — see package.json) is
//     the version that shares loro-swift 1.13.3's actual compiled core.
//     `^1.13.9` (the prior pin) would have resolved to a *newer*, unpinned
//     core than what's in the shipped Swift binary — a silent two-patch
//     drift the caret range could re-introduce on any future `bun install`,
//     exactly the failure mode "pin the exact same Rust-core version"
//     exists to prevent.
//   - Confidence: HIGH. This is a direct git-commit/Cargo.lock match, not
//     an inference from release dates or changelog prose. The real
//     cross-language fixture test proving these two pinned versions
//     actually exchange bytes correctly lives in
//     `loro-swift-interop.test.ts` (round-trips real `loro-swift`-exported
//     snapshot bytes through this file's own `LoroPageDoc.fromSnapshot`,
//     and vice versa) — that test, not this comment, is what actually gates
//     future version bumps per Risk #1's "CI round-trip golden test gates
//     every bump" mitigation.
//
// Cloudflare Workers compatibility: `loro-crdt`'s `bundler` build contains
// an explicit Cloudflare Workers compatibility patch in its `loro_wasm.js`
// glue — originally confirmed at `node_modules/loro-crdt@1.13.9/bundler/
// loro_wasm.js`, comment: "See https://github.com/loro-dev/loro/issues/440
// ... Without this patch, Cloudflare Worker would raise issue like:
// 'Uncaught TypeError: wasm2.__wbindgen_start is not a function'" — i.e.
// the package ships a Workers-specific code path (`import * as rawWasm from
// "./loro_wasm_bg.wasm"`, a native Workers-runtime `.wasm` module import,
// no bundler plugin required in `wrangler`'s modules-format build).
// Re-confirmed present at the now-pinned `loro-crdt@1.13.7` too (same
// patch comment in that version's `bundler/loro_wasm.js`, and its
// `package.json` `exports["./bundler"]` has the identical no-`"browser"`-
// branch shape checked below) — the version-lockstep downgrade from
// `^1.13.9` to exact `1.13.7` (see this file's VERSION LOCKSTEP note above)
// does not reintroduce the wrangler-bundling bug this section documents.
//
// CORRECTED BY REAL `wrangler dev` INTEGRATION TESTING (P0 exit drill —
// see the drill script's report): the import below used to be the bare
// specifier `"loro-crdt"`. That resolves fine under `bun test` (Bun's
// default export conditions are `["import", "bun", "default", "node"]` —
// no `"browser"` — so plain `"loro-crdt"` picks `exports["."].import` ->
// `bundler/index.js`, matching the paragraph above). It does NOT resolve
// the same way under `wrangler dev`/`wrangler deploy`: wrangler's
// esbuild-based bundler includes `"browser"` in its resolve condition set,
// and `loro-crdt`'s `package.json` `exports["."]` lists `"browser"` BEFORE
// `"import"`/`"node"`/`"default"`, so the bare specifier resolved to
// `browser/index.js` instead — a build that loads its WASM via
// `XMLHttpRequest` (not implemented in workerd) and `new URL("./loro_wasm_
// bg.wasm", import.meta.url)` (which throws `TypeError: Invalid URL
// string` under workerd's module-registry `import.meta.url`, since there's
// no synchronous-XHR fallback to catch it first). This crashed the DO at
// import time — before any request — with exactly that error, confirmed
// by inspecting `wrangler deploy --dry-run --outdir=...`'s bundled output.
// Importing the explicit `"loro-crdt/bundler"` subpath below sidesteps the
// condition-ordering entirely (that subpath's `exports` entry has no
// `"browser"` branch at all), so the correct Workers-compatible build loads
// regardless of which conditions the bundler passes. `bun test` still
// passes with this change (subpath resolves to the identical file Bun was
// already loading via the bare specifier's `"import"` condition).
//
// Peer ID: every `LoroDoc` needs a peer identity for its ops' causal IDs.
// We let Loro generate a random one per DO instance (the default — no
// `setPeerId` call) rather than deriving one from anything meaningful,
// because peer IDs only need to be unique enough to avoid op-ID collisions
// within a doc's lifetime; VaultDO is a single writer for the *server-side*
// replica of each doc (devices are the other peers), so collision risk is
// the standard "trust `crypto`-strength randomness" case, same as
// `loro-swift`'s default (LoroEngine.swift never calls `setPeerId` either).

import { LoroDoc, LoroMap, LoroText, VersionVector } from "loro-crdt/bundler";

/** Mirrors `CRDTImportOutcome` (EnchiridionSync/CRDTEngine.swift:72-88) so
 *  the same shape is meaningful on both sides of the wire protocol's
 *  eventual cross-language tests. */
export interface ImportOutcome {
  /** The doc's live state actually changed — reprojection should only run
   *  when this is `true` (an import of bytes the doc already has is a
   *  no-op merge; loro_wasm.d.ts's `ImportStatus.success: Map<PeerID,
   *  CounterSpan>` is empty in that case). */
  changedState: boolean;
  /** Import left ops pending on causal dependencies that haven't arrived
   *  yet (`ImportStatus.pending`, loro_wasm.d.ts:744-747) — the sync layer
   *  should not treat the doc as caught up. */
  hasPendingDependencies: boolean;
}

/** A single Loro document, opened (created empty, or hydrated from stored
 *  snapshot+pending-update bytes) and ready for local mutation, export, and
 *  import. Owns exactly one `LoroDoc` instance — `doc-store.ts` owns the
 *  page-ID keyed collection of these; this module is deliberately
 *  stateless/per-doc rather than holding its own map, so it has nothing to
 *  get out of sync with `doc-store.ts`'s SQLite-backed bookkeeping. */
export class LoroPageDoc {
  private readonly doc: LoroDoc;

  private constructor(doc: LoroDoc) {
    this.doc = doc;
  }

  /** A brand-new, empty document. */
  static create(): LoroPageDoc {
    const doc = new LoroDoc();
    configureTextStyles(doc);
    return new LoroPageDoc(doc);
  }

  /** Hydrates a document from a full or shallow snapshot (as produced by
   *  `exportSnapshot`/`exportShallowSnapshot`), per
   *  `LoroDoc.fromSnapshot(bytes)` (loro_wasm.d.ts, `LoroDoc` static
   *  method, documented example: "const loro = LoroDoc.fromSnapshot(bytes);").
   *  Mirrors `LoroEngine`'s `makeConfiguredDocument()` +
   *  `import(bytes:)` combination (LoroEngine.swift:188-194, 149-168) —
   *  `fromSnapshot` is the JS-side equivalent of "create, then import a
   *  snapshot", done in one call. */
  static fromSnapshot(bytes: Uint8Array): LoroPageDoc {
    const doc = LoroDoc.fromSnapshot(bytes);
    configureTextStyles(doc);
    return new LoroPageDoc(doc);
  }

  /** Opens from a stored (snapshot, pending-updates) pair — the shape
   *  `doc-store.ts` persists per page (plan: "latest exported snapshot
   *  bytes + a log of pending update bytes since that snapshot"). Replays
   *  the pending updates on top of the snapshot via `import()`, which
   *  accepts either a snapshot or an update blob and merges it in
   *  (loro_wasm.d.ts:2548, "Import a batch of updates or snapshots" doc on
   *  the sibling `importBatch`; single-update `import` documented at the
   *  same call site LoroEngine.swift:149-168 exercises). */
  static open(snapshot: Uint8Array, pendingUpdates: readonly Uint8Array[]): LoroPageDoc {
    const pageDoc = LoroPageDoc.fromSnapshot(snapshot);
    for (const update of pendingUpdates) {
      pageDoc.doc.import(update);
    }
    return pageDoc;
  }

  /** The full text container named `name` (auto-created empty on first
   *  access, per `LoroDoc.getText`'s documented behavior — loro_wasm.d.ts
   *  line ~2628 doc comment references `doc.getText("text")` with no
   *  separate create step). Mirrors `LoroEngine.applyMutation`'s
   *  `.textInsert`/`.textDelete`/`.textMark` cases
   *  (LoroEngine.swift:216-245), which all go through `doc.getText(id:)`
   *  first. */
  text(name: string): LoroText {
    return this.doc.getText(name);
  }

  /** The map container named `name` (auto-created empty on first access —
   *  same auto-create behavior as `getText`, loro_wasm.d.ts's `getMap`
   *  overload at line 954). Used both for a page's `objectMetadata`
   *  supertag-field map (mirrors `LoroEngine`'s `.mapSet`/`.mapDelete`,
   *  LoroEngine.swift:247-255) and, for the `vault-meta` doc specifically,
   *  the catalog map itself (see `catalog.ts`). */
  map(name: string): LoroMap {
    return this.doc.getMap(name);
  }

  /** Commits the cumulative auto-commit transaction so version-vector/
   *  export calls immediately observe prior local edits — every
   *  `LoroEngine.apply` call ends with an explicit `doc.commit()` for the
   *  identical reason (LoroEngine.swift:96-101, quoting
   *  `LoroDocProtocol.commit()`: "The events will be emitted after a
   *  transaction is committed."). Callers must call this after a batch of
   *  local mutations and before reading `versionVector()`/exporting. */
  commit(): void {
    this.doc.commit();
  }

  /** The version vector of the full oplog — `doc.oplogVersion()`
   *  (loro_wasm.d.ts ~line 1975, "Get the version vector of the latest
   *  known version in OpLog"). Matches `LoroEngine.versionVector(of:)`'s
   *  use of `doc.oplogVv()` (LoroEngine.swift:104-110; the Rust/FFI method
   *  name differs slightly between the Swift UniFFI bindings (`oplogVv`)
   *  and the JS wasm-bindgen bindings (`oplogVersion`), same underlying
   *  concept — "the full set of ops the engine has for this doc"). */
  versionVector(): VersionVector {
    return this.doc.oplogVersion();
  }

  /** Every op the sender has that `since` doesn't include yet — the sync
   *  protocol's missing-update-streaming payload
   *  (`ExportMode = { mode: "update", from?: VersionVector }`,
   *  loro_wasm.d.ts:635-648). Mirrors `LoroEngine.exportUpdates(of:since:)`
   *  (LoroEngine.swift:112-122, `doc.export(mode: .updates(from: vv))`). */
  exportUpdatesSince(since: VersionVector): Uint8Array {
    return this.doc.export({ mode: "update", from: since });
  }

  /** All ops not yet committed as of `since === undefined`, i.e. the
   *  document's entire history — used when creating a brand-new doc-store
   *  row (nothing to diff against yet). */
  exportAllUpdates(): Uint8Array {
    return this.doc.export({ mode: "update" });
  }

  /** A full-history snapshot — `ExportMode = { mode: "snapshot" }`
   *  (loro_wasm.d.ts:637-639, documented example: "const bytes =
   *  doc.export({ mode: 'snapshot' });"). Mirrors
   *  `LoroEngine.exportSnapshot(of:)` (LoroEngine.swift:124-133). Used for
   *  the plan's nightly R2 backup export and as the persisted "latest
   *  snapshot" row in `doc_snapshots`. */
  exportSnapshot(): Uint8Array {
    return this.doc.export({ mode: "snapshot" });
  }

  /** A snapshot of current state without full edit history —
   *  `ExportMode = { mode: "shallow-snapshot", frontiers }`
   *  (loro_wasm.d.ts:640-643). Mirrors
   *  `LoroEngine.exportShallowSnapshot(of:)` (LoroEngine.swift:135-146),
   *  which frontiers-at `doc.oplogFrontiers()` — "the plan's compaction-
   *  horizon fallback: if a client's VV predates the DO's compaction
   *  horizon, the DO answers with a full snapshot instead of a diff". Used
   *  by `doc-store.ts`'s `compactDoc` to fold the pending-updates log back
   *  into a fresh snapshot row. */
  exportShallowSnapshot(): Uint8Array {
    return this.doc.export({ mode: "shallow-snapshot", frontiers: this.doc.oplogFrontiers() });
  }

  /** Whether a peer at `clientVersionVector` has fallen behind this doc's
   *  compaction horizon — the plan's "if a client's VV predates the DO's
   *  compaction horizon, the DO answers with a full snapshot instead of a
   *  diff (explicit protocol message — the device-in-a-drawer case)".
   *
   *  VERIFIED EMPIRICALLY (not a guess — see the task's investigation):
   *  `doc.export({ mode: "update", from: clientVV })` against a shallow
   *  doc does NOT throw when `clientVV` predates the shallow horizon; it
   *  silently returns bytes that a peer importing them ends up with
   *  `ImportStatus.pending` non-empty and `success` EMPTY (unappliable —
   *  the causal history they'd depend on was discarded by the shallow
   *  export). So this must be checked BEFORE exporting, by comparing
   *  `clientVersionVector` against `doc.shallowSinceVV()`
   *  (loro_wasm.d.ts: "The doc only contains the history since this
   *  version ... This is empty if the doc is not shallow.") via
   *  `VersionVector.compare()` (loro_wasm.d.ts:3877-3882: returns `-1`
   *  when the receiver is behind `other`, `undefined` when concurrent).
   *  Both `-1` (client provably behind the horizon) and `undefined`
   *  (concurrent/disjoint — can't prove the client has full coverage of
   *  the horizon either) are treated as "needs a full snapshot": fail
   *  toward sending more data, never toward silently handing a client
   *  ops it cannot actually apply.
   *
   *  Non-obvious, also verified empirically (`loro-storage.test.ts`):
   *  `shallowSinceVV()` is the version vector at which the RETAINED
   *  (still-replayable) oplog begins, not "the doc's current tip". A
   *  client VV captured immediately before the single edit that becomes
   *  the shallow snapshot's one retained op can come out numerically
   *  EQUAL to the horizon (compare() === 0) rather than behind it — every
   *  earlier op got folded into the snapshot's baseline state, and the
   *  horizon marks exactly where replayable history resumes, which is
   *  exactly where that client already was. That's correctly "not behind"
   *  (an update export from that VV works fine): only a client whose VV
   *  is missing coverage the horizon still requires (e.g. an empty VV, or
   *  one further back than the single retained op) is actually behind. */
  needsFullSnapshotFor(clientVersionVector: VersionVector): boolean {
    if (!this.doc.isShallow()) return false;
    const horizon = this.doc.shallowSinceVV();
    const comparison = clientVersionVector.compare(horizon);
    return comparison === -1 || comparison === undefined;
  }

  /** Merges remote `bytes` (an update or snapshot — Loro distinguishes by
   *  content) into this doc. Mirrors `LoroEngine.importBytes`
   *  (LoroEngine.swift:148-168); `ImportStatus.success`/`.pending` are
   *  `Map<PeerID, CounterSpan>` (loro_wasm.d.ts:744-747), so "did anything
   *  change" is "is the success map non-empty", matching
   *  `!status.success.isEmpty` on the Swift side. */
  importBytes(bytes: Uint8Array): ImportOutcome {
    const status = this.doc.import(bytes);
    return {
      changedState: status.success.size > 0,
      hasPendingDependencies: status.pending !== null && status.pending.size > 0,
    };
  }

  /** Read-only introspection for reprojection (`projection.ts`) — the
   *  plain string contents of a text container. Reprojection reads
   *  container state, never mutates it (mutation only happens via
   *  `text()`/`map()` from write-model RPC handlers), so this narrow
   *  accessor is enough; a general "give me the whole doc" JSON dump is
   *  deliberately not exposed here (P1's effective-schema resolution work
   *  will need a real typed accessor per supertag field, not a generic
   *  blob). */
  textContent(name: string): string {
    return this.doc.getText(name).toString();
  }

  /** Read-only introspection for reprojection: a plain-value snapshot of a
   *  map container (`LoroMap.getShallowValue()`, loro_wasm.d.ts ~line
   *  2833 — nested containers come back as container-ID strings, not
   *  resolved recursively, which is exactly what a flat supertag-field map
   *  needs). */
  mapShallowValue(name: string): Record<string, unknown> {
    return this.doc.getMap(name).getShallowValue() as Record<string, unknown>;
  }
}

/** Decodes version-vector bytes as produced by `VersionVector.encode()`
 *  (loro_wasm.d.ts:3867) / the wire protocol's `docVersionVector.
 *  versionVector` field — mirrors `LoroEngine.decodeVersionVector`
 *  (LoroEngine.swift:292-301, `VersionVector.decode(bytes:)`). An empty
 *  `Uint8Array` decodes to the "start of time" vector (equivalent to `new
 *  VersionVector(undefined)`), used when a peer has no prior state for a
 *  doc at all. */
export function decodeVersionVector(bytes: Uint8Array): VersionVector {
  if (bytes.length === 0) {
    return new VersionVector(undefined);
  }
  return VersionVector.decode(bytes);
}

export function encodeVersionVector(vv: VersionVector): Uint8Array {
  return vv.encode();
}

/** The empty version vector — "this peer has never seen this doc" — used
 *  as the `since` argument for a first-ever export and as the stored
 *  version-vector for a page that only has pending updates queued (no
 *  snapshot taken yet). */
export function emptyVersionVector(): VersionVector {
  return new VersionVector(undefined);
}

/** Fixed vocabulary of rich-text mark keys this module configures Loro to
 *  accept, mirroring `LoroEngine.MarkStyle` (LoroEngine.swift:53-69) so a
 *  mark applied on one platform round-trips through the other without a
 *  `StyleConfigMissing`-equivalent error. `configTextStyle` documented at
 *  loro_wasm.d.ts ~line 2103 ("You need to config it if you use rich text
 *  `mark` method... you need to config the `expand` property of each
 *  style"). Kept here (not exported) because it's an implementation detail
 *  of how every doc gets configured, not part of this module's public
 *  surface — callers apply marks by key name via `text()`, they don't
 *  need to know the expand-behavior table. */
const MARK_STYLES: Record<string, "before" | "after" | "none" | "both"> = {
  bold: "after",
  italic: "after",
  underline: "after",
  strikethrough: "after",
  code: "none",
  pageReference: "none",
};

function configureTextStyles(doc: LoroDoc): void {
  const styles: Record<string, { expand: "before" | "after" | "none" | "both" }> = {};
  for (const [key, expand] of Object.entries(MARK_STYLES)) {
    styles[key] = { expand };
  }
  doc.configTextStyle(styles);
}

export type { LoroDoc, LoroMap, LoroText, VersionVector } from "loro-crdt/bundler";
