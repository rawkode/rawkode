// @enchiridion/worker-vault — WebSocket sync protocol wire types.
//
// ============================================================================
// WIRE PROTOCOL SPEC — read this before touching the Swift side.
// ============================================================================
//
// This mirrors `SyncProtocolMessage` from the Swift sync package
// (apps/swift/Sources/EnchiridionSync/SyncProtocolMessage.swift) message-
// for-message and field-for-field, so both ends of the WebSocket speak the
// exact same JSON shape. If you change one side, change the other, or the
// two ends silently stop understanding each other's frames (there is no
// version negotiation in this protocol — see "Known gaps" below).
//
// Six message types, JSON-encoded, one per WebSocket text/binary frame,
// discriminated by a `type` field:
//
//   { "type": "catalogRequest" }
//     Sent by a device on connect (and on every reconnect — Hibernation
//     API means no in-memory handshake state survives a DO going idle, so
//     "catalog first" happens on every connection, not just the first
//     ever one). No payload.
//
//   { "type": "catalogDiff", "entries": CatalogEntry[] }
//     The reply to `catalogRequest`: entries the recipient is missing or
//     has stale. SERVER BEHAVIOR NOTE (a real design decision, not implied
//     by the Swift side, which only defines the message shape): because
//     `catalogRequest` carries no version/cursor, VaultDO answers with its
//     ENTIRE current catalog (including tombstoned entries) rather than
//     attempting a true incremental diff server-side — the plan's
//     "devices diff it against their local catalog to discover pages
//     created elsewhere" describes the DEVICE doing the diffing (against
//     its own local catalog) once it has the server's full list, not the
//     server computing a diff against per-device state it doesn't
//     durably track. `catalog.ts`'s `diffCatalog()` is generic enough to
//     run in either direction if a future revision adds a client-supplied
//     cursor.
//
//   { "type": "docVersionVector", "pageID": string, "versionVector": base64 }
//     One side's current version vector for a specific doc (Loro-encoded
//     bytes, base64 in JSON — see "Encoding" below). Exchanging these in
//     both directions is how each side learns what the other is missing;
//     there is no separate "subscribe" message.
//
//   { "type": "docUpdate", "pageID": string, "bytes": base64 }
//     Ops the sender has that the recipient's last-known version vector
//     didn't include — the reply to a peer's `docVersionVector`.
//
//   { "type": "docFullSnapshot", "pageID": string, "bytes": base64 }
//     Sent instead of `docUpdate` when the recipient's version vector
//     predates the sender's compaction horizon (the "device in a drawer"
//     case) — an explicit message type, not inferred from payload shape.
//
//   { "type": "tombstone", "pageID": string, "undelete": boolean }
//     Live notification that a page was deleted (`undelete: false`) or
//     explicitly undeleted (`undelete: true`) — pushed proactively to
//     connected peers when it happens, distinct from a page's tombstoned
//     state simply appearing in a bulk `catalogDiff` (which is how a peer
//     that was offline when the deletion happened finds out instead).
//
// Encoding
// --------
// - `PageID` is a bare JSON string (Swift: `PageID` is
//   `RawRepresentable` over `String` with no custom `Codable`
//   implementation, so the compiler-synthesized conformance encodes it as
//   a single string value, NOT `{"rawValue": "..."}` — verified by reading
//   apps/swift/Sources/EnchiridionCore/Identity.swift).
// - `Data` fields (`versionVector`, `bytes`) are base64 strings — Swift
//   `Foundation.Data`'s default `Codable` conformance (used unmodified by
//   `VaultSyncClient`'s plain `JSONEncoder()`/`JSONDecoder()`,
//   apps/swift/Sources/EnchiridionSync/VaultSyncClient.swift:134,204) is
//   base64.
//
// KNOWN INTEROP GAP — flagged for the Swift-sync-agent and the review pass,
// not silently worked around: `CatalogEntry.createdAt` is a Swift `Date`.
// `VaultSyncClient` uses a plain, un-configured `JSONEncoder`/`JSONDecoder`
// (no `.dateEncodingStrategy` override), whose DEFAULT for `Date` is
// `.deferredToDate` — Foundation's `Date.init(from:)`/`encode(to:)` encode
// a bare `Double` of SECONDS SINCE THE COCOA REFERENCE DATE (2001-01-01),
// NOT Unix epoch milliseconds. This TS side decodes/encodes `createdAt`
// (and every other epoch-millisecond field in this file —
// `CatalogEntry.updatedAt` has no Swift equivalent at all yet, see below)
// as `number` = Unix epoch MILLISECONDS, matching `catalog.ts`'s
// `CatalogEntry` and every other epoch timestamp already in this worker.
// These two encodings are NOT compatible as-is. This must be resolved
// before the two sides are wired together for real — either the Swift
// side adds `.dateEncodingStrategy = .millisecondsSince1970` to both the
// encoder and decoder it uses for `SyncProtocolMessage`, or this side
// switches to Cocoa-reference-seconds. Left as `number`
// (epoch-milliseconds) here because that's the convention the rest of
// this worker (`catalog.ts`, `doc-store.ts`, `projection.ts`) already
// uses throughout, and because the fix is a one-line encoder/decoder
// config change on whichever side needs to move — NOT flagged with
// `TODO(verify-loro-api)` (this isn't a Loro API uncertainty) but called
// out here explicitly per the task's instruction to document the wire
// shape clearly for both the Swift agent and the review pass.
//
// Known gaps (P0, not fixed here — noted so they're not mistaken for
// oversights):
// - No protocol version field. A future incompatible change needs one;
//   not needed yet with exactly one implementation on each side.
// - `CatalogEntry` here carries `updatedAt` (see `catalog.ts`'s doc
//   comment on why last-tombstone-wins needs it); the Swift
//   `CatalogEntry` struct (SyncProtocolMessage.swift:38-50) does not yet
//   have this field. Needs adding on the Swift side before real
//   catalog-diff traffic flows, or `diffCatalog`'s staleness comparison
//   has nothing to compare against for entries synced from a device.

/** Mirrors Swift's `CatalogEntry` (SyncProtocolMessage.swift:38-50) plus
 *  the `updatedAt` field noted as a known gap above. */
export interface WireCatalogEntry {
  pageID: string;
  docType: string;
  /** Epoch milliseconds — see the "Known interop gap" note above. */
  createdAt: number;
  tombstoned: boolean;
  /** Not yet in the Swift struct — see "Known gaps" above. */
  updatedAt: number;
}

export type SyncProtocolMessage =
  | { type: "catalogRequest" }
  | { type: "catalogDiff"; entries: WireCatalogEntry[] }
  | { type: "docVersionVector"; pageID: string; versionVector: string }
  | { type: "docUpdate"; pageID: string; bytes: string }
  | { type: "docFullSnapshot"; pageID: string; bytes: string }
  | { type: "tombstone"; pageID: string; undelete: boolean };

export class SyncProtocolDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncProtocolDecodeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new SyncProtocolDecodeError(`expected "${key}" to be a string`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new SyncProtocolDecodeError(`expected "${key}" to be a boolean`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new SyncProtocolDecodeError(`expected "${key}" to be a number`);
  }
  return value;
}

function decodeCatalogEntry(value: unknown): WireCatalogEntry {
  if (!isRecord(value)) {
    throw new SyncProtocolDecodeError("catalog entry must be an object");
  }
  return {
    pageID: requireString(value, "pageID"),
    docType: requireString(value, "docType"),
    createdAt: requireNumber(value, "createdAt"),
    tombstoned: requireBoolean(value, "tombstoned"),
    updatedAt: requireNumber(value, "updatedAt"),
  };
}

/** Parses one incoming WebSocket frame's text/JSON payload into a
 *  `SyncProtocolMessage`. A malformed or unrecognized frame throws
 *  `SyncProtocolDecodeError` — callers (`vault-do.ts`'s
 *  `webSocketMessage`) are expected to catch this and drop the frame
 *  rather than tear down the connection, matching `VaultSyncClient`'s own
 *  stance on malformed frames (VaultSyncClient.swift:203-210: "Malformed
 *  frame from the server: drop it rather than tearing down the connection
 *  — a single bad frame shouldn't cost a resync."). */
export function decodeSyncMessage(raw: string | ArrayBuffer): SyncProtocolMessage {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SyncProtocolDecodeError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new SyncProtocolDecodeError("message must be a JSON object");
  }
  const type = parsed.type;
  switch (type) {
    case "catalogRequest":
      return { type: "catalogRequest" };

    case "catalogDiff": {
      const entriesRaw = parsed.entries;
      if (!Array.isArray(entriesRaw)) {
        throw new SyncProtocolDecodeError('expected "entries" to be an array');
      }
      return { type: "catalogDiff", entries: entriesRaw.map(decodeCatalogEntry) };
    }

    case "docVersionVector":
      return {
        type: "docVersionVector",
        pageID: requireString(parsed, "pageID"),
        versionVector: requireString(parsed, "versionVector"),
      };

    case "docUpdate":
      return {
        type: "docUpdate",
        pageID: requireString(parsed, "pageID"),
        bytes: requireString(parsed, "bytes"),
      };

    case "docFullSnapshot":
      return {
        type: "docFullSnapshot",
        pageID: requireString(parsed, "pageID"),
        bytes: requireString(parsed, "bytes"),
      };

    case "tombstone":
      return {
        type: "tombstone",
        pageID: requireString(parsed, "pageID"),
        undelete: requireBoolean(parsed, "undelete"),
      };

    default:
      throw new SyncProtocolDecodeError(`unrecognized message type: ${String(type)}`);
  }
}

export function encodeSyncMessage(message: SyncProtocolMessage): string {
  return JSON.stringify(message);
}

// --- base64 <-> bytes helpers -------------------------------------------
//
// Workers/Bun both have global `atob`/`btoa` (Web APIs), which is enough
// for base64 <-> binary-string conversion; wrapping it here keeps every
// other module dealing in `Uint8Array` rather than base64 strings.

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch (error) {
    throw new SyncProtocolDecodeError(
      `invalid base64: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
