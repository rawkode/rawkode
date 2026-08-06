// VaultPagePusher.swift
// EnchiridionImporter
//
// The "push" half of the importer pipeline (plan P1 task: "call VaultDO's
// `createOrUpdatePage` RPC with the resulting doc bytes"). VaultDO's write-
// model RPC methods (`workers/vault/src/vault-write-model.ts`,
// `createOrUpdatePage`/`applyInboundDocBytes`) are Durable Object RPC
// methods, callable only from inside the Workers runtime (another
// Worker/DO holding a `DurableObjectStub`) — `workers/vault/src/index.ts`
// exposes NO plain-HTTP route that calls them directly (confirmed by
// reading that file: the only routes are `/graphql`, `/blobs/*`, `/sync`,
// and a `/dev/admin/*` block gated off by default). The one real,
// production HTTP-reachable surface a page's bytes can travel over is the
// `/sync` WebSocket — VaultDO's Hibernation-API handler there decodes
// `EnchiridionSync.SyncProtocolMessage` frames and calls straight into
// `applyInboundCatalogEntries`/`applyInboundDocBytes`
// (`vault-write-model.ts`), which is functionally `createOrUpdatePage`'s
// same write path (both: import bytes, touch `modifiedAt`, persist the
// delta, reproject).
//
// So THIS is the real integration point: the importer behaves as a sync
// client, exactly like a device would — `.catalogDiff` (registers the
// page's docType/createdAt) followed by `.docFullSnapshot` (the full
// re-encoded doc). Sending a full snapshot rather than exchanging version
// vectors first is always correct for an importer: from VaultDO's
// perspective, a page it has never seen before is exactly the plan's
// "device in a drawer" case (`computeDocSyncResponse`'s `needsFullSnapshotFor`
// branch) — the natural way to introduce a page's full history in one frame.
//
// `EnchiridionSync.VaultSyncClient` (apps/swift/Sources/EnchiridionSync/
// VaultSyncClient.swift) already implements the real client-side transport
// (URLSessionWebSocketTask, Access service-token headers, catalog-first
// handshake) — reused here directly, not reimplemented, so the importer
// speaks the exact same wire protocol production devices do.
import EnchiridionCore
import EnchiridionSync
import Foundation

/// One page's catalog registration, independent of the wire encoding —
/// `VaultSyncPusher` builds the real `EnchiridionSync.CatalogEntry` from
/// this.
public struct VaultCatalogEntry: Sendable {
  public var pageID: PageID
  public var docType: String
  public var createdAt: Date
  public var updatedAt: Date
  public var tombstoned: Bool

  public init(pageID: PageID, docType: String, createdAt: Date, updatedAt: Date, tombstoned: Bool = false) {
    self.pageID = pageID
    self.docType = docType
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.tombstoned = tombstoned
  }
}

/// What `VaultImporter` needs from a transport that can push one page into
/// a vault — narrow enough that tests substitute `RecordingVaultPagePusher`
/// for a live WebSocket without any conditional-compilation or mocking
/// framework.
public protocol VaultPagePushing: Sendable {
  func push(catalogEntry: VaultCatalogEntry, documentSnapshot: Data) async throws
}

/// Real transport: pushes a page into a running vault worker over its
/// production sync protocol. See this file's header for why `/sync`
/// (not a bespoke HTTP endpoint) is the correct integration point.
///
/// Pointing this at a vault instance:
///   - **Local `wrangler dev`**: run `wrangler dev` from
///     `projects/enchiridion/workers/vault`, then pass
///     `vaultURL: URL(string: "ws://127.0.0.1:8787/sync")!`. NOTE (read
///     `access-auth.ts` before assuming this "just works" locally):
///     `verifyAccessRequest` returns 401/500 for ANY request missing a
///     valid `Cf-Access-Jwt-Assertion` header, INCLUDING when
///     `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` are simply unset in a local
///     `wrangler dev` run (that's a 500, "Access auth is not configured on
///     this worker", not a bypass) — `wrangler dev` alone does not put
///     requests through real Cloudflare Access. Getting `/sync` reachable
///     locally therefore needs one of: (a) a `cloudflared access` tunnel
///     that fronts the local dev server with real Access (see
///     `workers/vault/ACCESS_SETUP.md`), or (b) a temporary, LOCAL-ONLY
///     change to `access-auth.ts`/`index.ts` to skip the check for a dev
///     flag (NOT done by this importer — `workers/vault` is read-only
///     reference for this task; that change belongs to whoever owns local
///     dev ergonomics for that worker). Until one of those exists, exercise
///     this importer's real network path with a hand-rolled
///     `URLSessionWebSocketTask` test against a trivial local echo server,
///     or trust the decode/re-encode/ledger unit tests (which don't need a
///     live server at all) plus a manual smoke test once Access is wired.
///   - **Real deployment**: `vaultURL: URL(string:
///     "wss://<your-vault-hostname>/sync")!`, with a real per-device Access
///     service-token pair (Zero Trust dashboard → Access → Service Auth) as
///     `accessCredential`.
public actor VaultSyncPusher: VaultPagePushing {
  private let client: VaultSyncClient

  public init(client: VaultSyncClient) {
    self.client = client
  }

  /// Convenience: builds a `VaultSyncClient` for `vaultURL` and connects it
  /// (sends the catalog-first `.catalogRequest` handshake) before returning.
  public static func connect(
    vaultURL: URL,
    accessCredential: @escaping @Sendable () async -> AccessServiceTokenCredential
  ) async -> VaultSyncPusher {
    let client = VaultSyncClient(vaultURL: vaultURL, accessCredential: accessCredential)
    await client.connect()
    return VaultSyncPusher(client: client)
  }

  public func push(catalogEntry: VaultCatalogEntry, documentSnapshot: Data) async throws {
    let wireEntry = CatalogEntry(
      pageID: catalogEntry.pageID,
      docType: catalogEntry.docType,
      createdAt: catalogEntry.createdAt,
      tombstoned: catalogEntry.tombstoned,
      updatedAt: catalogEntry.updatedAt
    )
    try await client.send(.catalogDiff(entries: [wireEntry]))
    try await client.send(.docFullSnapshot(pageID: catalogEntry.pageID, bytes: documentSnapshot))
  }

  public func disconnect() async {
    await client.disconnect()
  }
}

/// In-memory fake transport — used by tests, and by the CLI's `--dry-run`
/// mode (see main.swift) to preview what an import run would push without
/// opening a network connection.
public actor RecordingVaultPagePusher: VaultPagePushing {
  public struct PushedPage: Equatable, Sendable {
    public var pageID: PageID
    public var docType: String
    public var documentSnapshot: Data
  }

  public private(set) var pushes: [PushedPage] = []

  public init() {}

  public func push(catalogEntry: VaultCatalogEntry, documentSnapshot: Data) async throws {
    pushes.append(
      PushedPage(pageID: catalogEntry.pageID, docType: catalogEntry.docType, documentSnapshot: documentSnapshot)
    )
  }
}
