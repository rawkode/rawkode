// @enchiridion/worker-gatekeeper-google — thin client for VaultDO's
// write-model RPC surface, reached over the cross-script Durable Object
// binding configured in wrangler.jsonc (`VAULT`, `script_name:
// "enchiridion-vault"` — see that file's comment for why this is a DO
// binding, not a plain Service Binding).
//
// `VaultDOStub` below is a LOCAL, MINIMAL structural type for the two
// VaultDO RPC methods this worker calls — deliberately not an import of
// `workers/vault/src/vault-do.ts`'s real `VaultDO` class (these are two
// independently deployed workers with no shared RUNTIME package between
// them, same rationale `schema.ts`'s file header documents for duplicating
// `SqlExecutor` rather than importing it). What it no longer does is
// hand-maintain the two methods' parameter/return TYPES: those come from
// `@enchiridion/vault-rpc-contract`, a shared types-only package that
// `workers/vault/src/vault-do.ts`'s real method signatures are ALSO routed
// through (see that package's file header for the full direction-of-truth
// rationale). A future vault signature change — reordered/retyped
// parameters, not just a rename, which Workers RPC already catches by
// failing loudly — now either updates the shared package (and this file
// picks it up for free) or vault's own build breaks first; either way this
// interface can no longer silently drift from VaultDO's real methods the
// way an unlinked hand-written copy could.
//
// The `VAULT` binding itself is typed as a plain, UNPARAMETERIZED
// `DurableObjectNamespace`/`DurableObjectStub` (not
// `DurableObjectNamespace<VaultDOStub>`) — `@cloudflare/workers-types`'
// generic form requires its type parameter to structurally extend
// `DurableObject` (branded with a private `Rpc.DurableObjectBranded`
// symbol), which a plain interface like `VaultDOStub` can never satisfy
// without actually extending that class — importing the real `VaultDO`
// class here would pull in its entire runtime module graph, which is what
// this worker's "no shared runtime package" stance avoids; only its TYPES
// are shared, via `@enchiridion/vault-rpc-contract`.
// `defaultVaultDOStub` below does the narrowing cast once, at the one
// point real RPC calls are dispatched, so every other call site in this
// worker gets a fully-typed stub with no casts of its own.
import type {
  CreateOrUpdatePageParams,
  CreateOrUpdatePageResult,
  TombstonePageParams,
  TombstonePageResult,
} from "@enchiridion/vault-rpc-contract";

export interface VaultDOStub {
  /** Mirrors `VaultDO.createOrUpdatePage` (workers/vault/src/vault-do.ts) —
   *  parameter/return types imported from `@enchiridion/vault-rpc-contract`,
   *  the same types `vault-do.ts`'s real method signature is routed
   *  through. `updateBytesBase64` is a base64-encoded Loro update (or
   *  snapshot) blob — matching the sync protocol's own encoding, per that
   *  method's doc comment ("a client's outbox can reuse the exact same
   *  encoding for both the WebSocket path and this direct RPC path"). This
   *  worker is, in effect, a synthetic "device" for materialized pages —
   *  see `materialized-doc.ts`'s file header. */
  createOrUpdatePage(...args: CreateOrUpdatePageParams): Promise<CreateOrUpdatePageResult>;

  /** Mirrors `VaultDO.tombstonePage` — used when a previously-materialized
   *  calendar event is cancelled/deleted at the provider (see
   *  `calendar-ingest.ts`). */
  tombstonePage(...args: TombstonePageParams): Promise<TombstonePageResult>;
}

export interface VaultClientEnv {
  VAULT: DurableObjectNamespace;
}

/** Resolves the stub for the one VaultDO instance this worker talks to —
 *  `idFromName("default")`, the SAME fixed name
 *  `workers/vault/src/vault-stub.ts`'s `defaultVaultStub` uses, so this
 *  resolves to the identical DO instance a device's `/sync` WebSocket (or
 *  vault's own GraphQL resolvers) talks to. Duplicated rather than
 *  imported for the same cross-worker-independence reason as
 *  `VaultDOStub` above. The cast is type-level narrowing only (see this
 *  file's header) — Workers RPC dispatches by method name/arity over the
 *  wire, not by the caller's static type, so this is safe as long as
 *  `VaultDOStub` stays structurally accurate to VaultDO's real methods. */
export function defaultVaultDOStub(env: VaultClientEnv): VaultDOStub {
  const id = env.VAULT.idFromName("default");
  return env.VAULT.get(id) as unknown as VaultDOStub;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Pushes a materialized page's update bytes into VaultDO. Thin wrapper
 *  over `VaultDOStub.createOrUpdatePage` that does the base64 encoding
 *  every call site would otherwise repeat. */
export async function pushPageUpdate(
  env: VaultClientEnv,
  pageID: string,
  docType: string,
  updateBytes: Uint8Array,
): Promise<CreateOrUpdatePageResult> {
  const stub = defaultVaultDOStub(env);
  return stub.createOrUpdatePage(pageID, docType, bytesToBase64(updateBytes));
}

/** Tombstones a previously-materialized page — see `VaultDOStub.tombstonePage`. */
export async function tombstoneMaterializedPage(env: VaultClientEnv, pageID: string): Promise<TombstonePageResult> {
  const stub = defaultVaultDOStub(env);
  return stub.tombstonePage(pageID);
}
