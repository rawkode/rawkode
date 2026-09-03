# Vault → Workspace rename: finalized plan

Status: **plan only, no code changed yet**. This document is the single source of truth every
following stage must use verbatim — do not re-derive names independently.

Scope root: `apps/athenaeum` (this app only). Nothing outside it — and, within it, the approved
architecture plan under `~/.claude/plans/` and any `MEMORY.md`/`feedback_*.md` memory file are
**not** touched even though they use "vault" terminology; they are historical planning records of
what was decided when.

---

## 1. Naming table (apply case-correctly, everywhere it means the per-vault storage/sharing concept)

| Old | New |
|---|---|
| `Vault` | `Workspace` |
| `vault` | `workspace` |
| `VAULT` | `WORKSPACE` |
| `vaultId` | `workspaceId` |
| `VaultId` | `WorkspaceId` |
| `vault_id` (SQL/wire) | `workspace_id` — **not used**; the codebase's SQL/JSON field is always camelCase `vaultId`, never snake_case `vault_id` (verified: the only underscore form found, `rm_nodes_vaultId`, is an index name, not a column — see §7) |
| `VaultDurableObject` | `WorkspaceDurableObject` |
| `VaultRpcApi` | `WorkspaceRpcApi` |
| `VaultCatalogEntry` | `WorkspaceCatalogEntry` |
| `RPCVaultCatalogEntry` | `RPCWorkspaceCatalogEntry` |
| `requireOwnVault` | `requireOwnWorkspace` |
| `requireRoleForGovernedVault` | `requireRoleForGovernedWorkspace` |
| "governed vault" (prose) | "governed workspace" |
| `VaultMeta` / `makeVaultMetaSingleton` / `vaultMeta` | `WorkspaceMeta` / `makeWorkspaceMetaSingleton` / `workspaceMeta` |
| `initializeVaultOwner` | `initializeWorkspaceOwner` |
| `VaultEpoch` | `WorkspaceEpoch` |
| `VaultServices` | `WorkspaceServices` |
| `VaultCollections` / `makeVaultCollections` | `WorkspaceCollections` / `makeWorkspaceCollections` |
| `vaultsCollectionSchema` | `workspacesCollectionSchema` |
| `CreateVaultInput`/`CreateVaultOutput` | `CreateWorkspaceInput`/`CreateWorkspaceOutput` |
| `ListVaultsInput`/`ListVaultsOutput` | `ListWorkspacesInput`/`ListWorkspacesOutput` |
| `createVault` / `listVaults` (RPC methods + client fns) | `createWorkspace` / `listWorkspaces` |
| `createGovernedVault` / `stubCreateVault` (test helpers) | `createGovernedWorkspace` / `stubCreateWorkspace` |
| `registerVault` | `registerWorkspace` |
| `deriveDefaultVaultId` / `ensureDefaultVault` | `deriveDefaultWorkspaceId` / `ensureDefaultWorkspace` |
| `VaultRPCClient` (Swift) + all `VaultRPCClient+*.swift` extension types | `WorkspaceRPCClient` + `WorkspaceRPCClient+*.swift` |
| `VaultRpcClient`/`VaultRpcClientService` (TS RPC client) | `WorkspaceRpcClient`/`WorkspaceRpcClientService` |
| `VaultSyncClient` / `VaultSyncClientError` | `WorkspaceSyncClient` / `WorkspaceSyncClientError` |
| `LocalVaultStore` / `LocalVaultStoreError` | `LocalWorkspaceStore` / `LocalWorkspaceStoreError` |
| `VaultConfiguration` (Swift, iOS/macOS) | `WorkspaceConfiguration` |
| `WatchVaultConfiguration` (Swift, watchOS) | `WatchWorkspaceConfiguration` |
| `VaultSwitcher` / `VaultSwitcherView` (React + SwiftUI) | `WorkspaceSwitcher` / `WorkspaceSwitcherView` |
| `VaultApi` | `WorkspaceApi` |
| `vaultStub` / `vaultDo` / `vaultDurableObjectStub` / `ownerVaultStub` | `workspaceStub` / `workspaceDo` / `workspaceDurableObjectStub` / `ownerWorkspaceStub` |
| `vaultExports` | `workspaceExports` |
| `vaultUrl` / `vaultURL` | `workspaceUrl` / `workspaceURL` |
| `activeVaultId` / `selectedVaultId` / `requestedVaultId` / `ownVaultId` / `otherVaultId` / `nextVaultId` / `firstVaultId` / `extraVaultId` / `freshVaultId` / `newVaultTitle` / `landingVault` | same prefix/suffix, `Vault`→`Workspace` (`activeWorkspaceId`, `selectedWorkspaceId`, `requestedWorkspaceId`, `ownWorkspaceId`, `otherWorkspaceId`, `nextWorkspaceId`, `firstWorkspaceId`, `extraWorkspaceId`, `freshWorkspaceId`, `newWorkspaceTitle`, `landingWorkspace`) |
| `setActiveVaultId` / `setActiveVaultIdState` | `setActiveWorkspaceId` / `setActiveWorkspaceIdState` |
| `switchVaultConnection` / `setUpConnectedVault` / `setupVaultWithPage` | `switchWorkspaceConnection` / `setUpConnectedWorkspace` / `setupWorkspaceWithPage` |
| `connectToVault` / `connectToVaultWithSocket` / `connectToVaultWithSocketAs` | `connectToWorkspace` / `connectToWorkspaceWithSocket` / `connectToWorkspaceWithSocketAs` |
| `handleSwitchVault` / `onSwitchVault` / `deselectVault` / `selectVault` / `readVault` / `readVaultNodes` | `handleSwitchWorkspace` / `onSwitchWorkspace` / `deselectWorkspace` / `selectWorkspace` / `readWorkspace` / `readWorkspaceNodes` |
| `refreshVaults` / `setVaults` / `isLoadingVaults` / `isCreatingVault` / `catalogVaults` / `listCalendarBindingsForVault` | `refreshWorkspaces` / `setWorkspaces` / `isLoadingWorkspaces` / `isCreatingWorkspace` / `catalogWorkspaces` / `listCalendarBindingsForWorkspace` |
| `reviveVaultCatalogEntry` | `reviveWorkspaceCatalogEntry` |
| `invalidVaultEpoch` / `testVaultEpochAcceptsNonEmpty` / `testVaultEpochRejectsEmpty` | `invalidWorkspaceEpoch` / `testWorkspaceEpochAcceptsNonEmpty` / `testWorkspaceEpochRejectsEmpty` |
| `byVaultId` / `forVaultId` / `vaultIdArg` / `vaultIdTyped` / `vaultIdString` / `vaultIdDefaultsKey` | `byWorkspaceId` / `forWorkspaceId` / `workspaceIdArg` / `workspaceIdTyped` / `workspaceIdString` / `workspaceIdDefaultsKey` |
| `vaultA` / `vaultB` / `vaultsA` / `vaultsB` / `aliceVaultsFirst` / `aliceVaultsSecond` / `aliceVaultsAfterCreate` / `bobVaults` / `bobVaultsAfterAliceCreate` (test fixtures) | `workspaceA` / `workspaceB` / `workspacesA` / `workspacesB` / `aliceWorkspacesFirst` / `aliceWorkspacesSecond` / `aliceWorkspacesAfterCreate` / `bobWorkspaces` / `bobWorkspacesAfterAliceCreate` |
| `testImportingOnAnUngovernedVaultNeedsNoCredential` | `testImportingOnAnUngovernedWorkspaceNeedsNoCredential` |
| `VaultRPCClientLiveTests` / `VaultSyncClientLiveTests` / `LocalVaultStoreTests` | `WorkspaceRPCClientLiveTests` / `WorkspaceSyncClientLiveTests` / `LocalWorkspaceStoreTests` |
| `withVault` | `withWorkspace` |
| `ATHENAEUM_VAULT_ID` (env var) | `ATHENAEUM_WORKSPACE_ID` |
| `--vault <id>` (CLI flag, all Phase2–7 driver CLIs) | `--workspace <id>` |
| `VAULT_COUNT` / `VAULT_ID` / `VAULT_TITLE` / `VAULT_IS_DEFAULT` (CLI stdout labels) | `WORKSPACE_COUNT` / `WORKSPACE_ID` / `WORKSPACE_TITLE` / `WORKSPACE_IS_DEFAULT` |
| `athenaeum.vaultId` (Swift `UserDefaults` key string) | `athenaeum.workspaceId` — safe, see §5 |
| `"athenaeum:vaultId"` (web `localStorage` key string) | `"athenaeum:workspaceId"` — safe, see §5 |
| `?vault=<id>` (web URL query param) | `?workspace=<id>` — safe, see §5 |
| `vault-<id>.sqlite3` (native local file naming pattern) | `workspace-<id>.sqlite3` |
| Route `/api/vault/:vaultId` | Route `/api/workspace/:workspaceId` — see §2 |
| SQL: `rm_nodes.vaultId` column, `rm_nodes_vaultId` index, `graph_nodes.vaultId` view column | `rm_nodes.workspaceId`, `rm_nodes_workspaceId`, `graph_nodes.workspaceId` — see §7 |

### UI copy (user-facing strings — exact before → after)

| File | Before | After |
|---|---|---|
| `packages/web/src/VaultSwitcher.tsx` | `<label htmlFor="vault-switcher-select">Vault</label>` | `<label htmlFor="workspace-switcher-select">Workspace</label>` |
| same | `placeholder="New vault title"` | `placeholder="New workspace title"` |
| same | `{creating ? "Creating…" : "+ New vault"}` | unchanged word "Creating…"; `"+ New vault"` → `"+ New workspace"` |
| same | `<option value={SHARED_LINK_VAULT_ID}>Shared vault (opened via link) — {activeVaultId}</option>` | `<option value={SHARED_LINK_WORKSPACE_ID}>Shared workspace (opened via link) — {activeWorkspaceId}</option>` |
| `packages/web/src/AppShell.tsx` | `<p className="shell-vault-id">vault <code>{activeVaultId}</code></p>` | `<p className="shell-workspace-id">workspace <code>{activeWorkspaceId}</code></p>` |
| `packages/web/src/format-domain-error.ts` | `"This vault doesn't exist (or was deleted)."` | `"This workspace doesn't exist (or was deleted)."` |
| same | `"You don't have access to this vault. If you were removed as a collaborator, ask the owner to re-add you."` | `"You don't have access to this workspace. If you were removed as a collaborator, ask the owner to re-add you."` |
| same | `` `No "${error.gatekeeperKind}" gatekeeper is connected for this vault.` `` | `` `No "${error.gatekeeperKind}" gatekeeper is connected for this workspace.` `` |
| `packages/domain/src/rpc-error.ts` | `` `You do not have access to this vault: ${error.vaultId}` `` | `` `You do not have access to this workspace: ${error.workspaceId}` `` |
| same | `` `Vault not found: ${error.vaultId}` `` | `` `Workspace not found: ${error.workspaceId}` `` |
| same | `` `No "${error.gatekeeperKind}" gatekeeper connected for vault ${error.vaultId}` `` | `` `No "${error.gatekeeperKind}" gatekeeper connected for workspace ${error.workspaceId}` `` |
| `packages/backend/src/index.ts` | `"Not Found — expected /api/vault/:vaultId"` | `"Not Found — expected /api/workspace/:workspaceId"` |

### CSS classes/ids (`packages/web/src/app.css`, `AppShell.css`, `VaultSwitcher.tsx`)

`vault-switcher`, `vault-switcher-select`, `vault-switcher-loading`, `vault-switcher-create` →
`workspace-switcher`, `workspace-switcher-select`, `workspace-switcher-loading`,
`workspace-switcher-create`. `shell-vault-id` → `shell-workspace-id`.

### Special case: `VaultWorkspace` (already-compound name)

`packages/web/src/App.tsx` defines `function VaultWorkspace({ ... })` — the component that mounts
everything depending on a live RPC connection to one vault. A literal mechanical substitution
(`Vault`→`Workspace`) would produce `WorkspaceWorkspace`, a duplicated, nonsensical name.

**Decision: rename `VaultWorkspace` → `Workspace`** (drop the duplicate word), not
`WorkspaceWorkspace`. Rationale: this file's own header comment already calls the pre-`AppShell`
version of this exact view "the single flat `Workspace` page" — `Workspace` is precedented,
in-repo prose for this exact component, and it has no other component of that name to collide
with (confirmed — see §3). Its prop `activeVaultId`/`onSwitchVault` still rename per the table
above (`activeWorkspaceId`/`onSwitchWorkspace`); only the function/JSX tag name itself collapses
to `Workspace` instead of `WorkspaceWorkspace`. This is the one deliberate departure from pure
mechanical substitution in the whole plan, and it needs to be called out explicitly rather than
invented ad hoc by whichever stage touches `App.tsx`.

---

## 2. File renames (old path → new path)

```
packages/web/src/VaultSwitcher.tsx                                          -> packages/web/src/WorkspaceSwitcher.tsx
packages/web/src/vault-id.ts                                                -> packages/web/src/workspace-id.ts
packages/backend/test/user-vault-catalog.test.ts                            -> packages/backend/test/user-workspace-catalog.test.ts
packages/backend/src/vault-ownership.ts                                     -> packages/backend/src/workspace-ownership.ts
packages/backend/src/vault-durable-object.ts                                -> packages/backend/src/workspace-durable-object.ts
native/AthenaeumApp/Sources/AthenaeumAppUI/VaultConfiguration.swift          -> native/AthenaeumApp/Sources/AthenaeumAppUI/WorkspaceConfiguration.swift
native/AthenaeumApp/Sources/AthenaeumAppUI/VaultSwitcherView.swift           -> native/AthenaeumApp/Sources/AthenaeumAppUI/WorkspaceSwitcherView.swift
native/AthenaeumCore/Tests/AthenaeumCoreTests/VaultSyncClientLiveTests.swift -> native/AthenaeumCore/Tests/AthenaeumCoreTests/WorkspaceSyncClientLiveTests.swift
native/AthenaeumCore/Tests/AthenaeumCoreTests/LocalVaultStoreTests.swift     -> native/AthenaeumCore/Tests/AthenaeumCoreTests/LocalWorkspaceStoreTests.swift
native/AthenaeumCore/Sources/AthenaeumCore/VaultSyncClient.swift             -> native/AthenaeumCore/Sources/AthenaeumCore/WorkspaceSyncClient.swift
native/AthenaeumCore/Sources/AthenaeumCore/LocalVaultStore.swift             -> native/AthenaeumCore/Sources/AthenaeumCore/LocalWorkspaceStore.swift
native/AthenaeumRPC/Tests/AthenaeumRPCTests/VaultRPCClientLiveTests.swift    -> native/AthenaeumRPC/Tests/AthenaeumRPCTests/WorkspaceRPCClientLiveTests.swift
native/AthenaeumRPC/Sources/AthenaeumRPC/VaultRPCClient+Graph.swift          -> native/AthenaeumRPC/Sources/AthenaeumRPC/WorkspaceRPCClient+Graph.swift
native/AthenaeumRPC/Sources/AthenaeumRPC/VaultRPCClient+AgentEdit.swift      -> native/AthenaeumRPC/Sources/AthenaeumRPC/WorkspaceRPCClient+AgentEdit.swift
native/AthenaeumRPC/Sources/AthenaeumRPC/VaultRPCClient+Voice.swift          -> native/AthenaeumRPC/Sources/AthenaeumRPC/WorkspaceRPCClient+Voice.swift
native/AthenaeumRPC/Sources/AthenaeumRPC/VaultRPCClient+Workouts.swift       -> native/AthenaeumRPC/Sources/AthenaeumRPC/WorkspaceRPCClient+Workouts.swift
native/AthenaeumRPC/Sources/AthenaeumRPC/VaultRPCClient.swift                -> native/AthenaeumRPC/Sources/AthenaeumRPC/WorkspaceRPCClient.swift
native/AthenaeumRPC/Sources/AthenaeumRPC/VaultRPCClient+Meetings.swift       -> native/AthenaeumRPC/Sources/AthenaeumRPC/WorkspaceRPCClient+Meetings.swift
native/AthenaeumRPC/Sources/AthenaeumRPC/VaultRPCClient+Sharing.swift        -> native/AthenaeumRPC/Sources/AthenaeumRPC/WorkspaceRPCClient+Sharing.swift
native/AthenaeumRPC/Sources/AthenaeumRPC/VaultRPCClient+Calendar.swift       -> native/AthenaeumRPC/Sources/AthenaeumRPC/WorkspaceRPCClient+Calendar.swift
native/watchOS/AthenaeumWatchUI/Sources/AthenaeumWatchUI/WatchVaultConfiguration.swift -> native/watchOS/AthenaeumWatchUI/Sources/AthenaeumWatchUI/WatchWorkspaceConfiguration.swift
```

Use `git mv` for each (preserves history); do not leave both old and new paths present.

No other files need renaming — the remaining ~260 files with "vault" occurrences (see §6) keep
their existing names (e.g. `sharing.ts`, `sharing-rpc.ts`, `index.ts`, `errors.ts`) and only need
in-file identifier/string/comment changes.

---

## 3. Durable Object migration mechanics (`packages/backend/wrangler.jsonc`)

Confirmed via `git log` and `.wrangler` state inspection:

- `git log --oneline --all | grep -i deploy` shows deploy-related commits only for unrelated apps
  in this monorepo (`enchiridion`, `rawkode.dev`, other Cloudflare Workers projects) — **zero**
  deploy commits touch anything under `apps/athenaeum`.
- `packages/backend/.wrangler/` (and `packages/gatekeeper-google-calendar/.wrangler/` if present)
  is listed in `.gitignore` (`apps/athenaeum/.gitignore:14`) and contains only `miniflare`'s local
  simulated Durable Object/R2/cache state from `wrangler dev` runs on this machine — never a real
  Cloudflare account deployment.
- There is no `CLOUDFLARE_ACCOUNT_ID`/deploy workflow, no `wrangler versions`/`wrangler deploy`
  history, and the wrangler.jsonc itself documents (in its own comments) that secrets required for
  a real deployment (`DEV_AUTH_HMAC_SECRET`, `GATEKEEPER_GOOGLE_CALENDAR_CALLER_HMAC_SECRET`, the
  OpenAI keys) are all deliberately unset placeholders, consistent with "this has never actually
  run against production Cloudflare infrastructure."

**Conclusion: safe to rename the class in place.** The existing migration entry:

```jsonc
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["VaultDurableObject", "UserDurableObject"]
  },
  ...
]
```

becomes simply:

```jsonc
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["WorkspaceDurableObject", "UserDurableObject"]
  },
  ...
]
```

No new migration tag (no `renamed_classes: [{ from: "VaultDurableObject", to:
"WorkspaceDurableObject" }]`) is needed. `renamed_classes` exists specifically to let an
**already-deployed** Worker keep talking to the same underlying DO storage instances after a class
rename in source — Cloudflare correlates DO storage by class name across deploys unless told about
a rename. Since `tag: "v1"` has never been applied against a real Cloudflare account (no
deployment ever ran `wrangler deploy` for this Worker), there is no live instance under the old
class name for a bare in-place edit to orphan. Editing the existing `v1` entry's array element is
the correct, minimal, historically-honest change — it does not fabricate a migration tag for a
"before" state that never existed in production.

**Local-dev side effect (document, don't fix here):** any developer's own
`packages/backend/.wrangler/state/v3/do/athenaeum-backend-VaultDurableObject` directory (locally
simulated Durable Object storage from a prior `wrangler dev` run) will not automatically migrate —
miniflare keys local DO storage by class name too. Since this directory is gitignored, ephemeral,
and contains no real data, the correct move (for the implementation stage, not this planning stage)
is simply to delete `packages/backend/.wrangler/` locally after the rename lands and let `wrangler
dev` recreate it fresh. This is a one-line note for the implementer, not a migration to script.

---

## 4. Collision check: is there an unrelated, pre-existing "workspace" concept?

Full case-insensitive search for `workspace` across the app, excluding lines that also mention
`vault` (to isolate uses that predate/are independent of this rename):

**Found, and individually resolved:**

1. **`WorkspaceNotFound` / `WorkspaceAccessDenied`** (`packages/domain/src/errors.ts`) — these
   `Data.TaggedError` classes are **already named for the vault concept**, not a collision: their
   payload is `{ readonly vaultId: string }`, their doc comments describe "the vault does not
   exist" / "the vault exists but the caller has no role," and `rpc-error.ts`/
   `format-domain-error.ts` construct/consume them purely in vault-access contexts. This looks like
   the class names were chosen ahead of this rename (or ported from `cloudflare-os`'s
   `docs/sharing.md`, which itself talks about a `gadget` concept, with `gadget → vault` as "this
   port's uniform substitution" per `sharing.ts`'s header comment). **No rename needed for the
   class names themselves** — they already equal the target name. What DOES need changing: the
   `vaultId` field inside each (→ `workspaceId`), and every comment mentioning "vault"/"multi-vault"
   /the "gadget → vault" substitution note (→ "gadget → workspace", "multi-workspace", etc.), so
   the prose matches the code it describes. Verified while at it: **no separate/different
   `Workspace` error concept exists anywhere else** — grep for `Workspace` outside `errors.ts`,
   `rpc-error.ts`, `format-domain-error.ts`, and their tests turns up nothing.

2. **`VaultWorkspace`** (`packages/web/src/App.tsx`) — not a collision with a different concept;
   it's the vault concept's own top-level view, already half-named `Workspace`. Handled as its own
   special case in §1 (rename target: `Workspace`, not `WorkspaceWorkspace`).

3. **Plain-English "workspace" in comments and the pnpm/npm workspace protocol** — e.g.
   `"@athenaeum/domain": "workspace:*"` in multiple `package.json`s, `pnpm-workspace.yaml`'s
   `"workspaces": {...}` block, and prose like "this workspace has no dependency on
   `@effect/platform`" (meaning "this package/repo," the ordinary monorepo-tooling sense of the
   word) or "a Workspace admin has restricted a scope" (a comment about *Google* Workspace, in a
   Google Calendar OAuth-scope note — a genuinely different, real third-party product name). These
   are a **real, unrelated, pre-existing meaning of "workspace"** and must NOT be touched — they
   don't contain "vault" in any form, so the mechanical Vault→Workspace substitution (which only
   ever matches on `vault`/`Vault`/`VAULT` substrings) will never touch them by construction. Confirmed
   by inspection, not just assumption: every one of these lines was manually checked above and
   contains no `vault` substring.

**Overall conclusion: no genuine naming collision exists.** The only two "Workspace" hits that
relate to this rename (`WorkspaceNotFound`/`WorkspaceAccessDenied`, and `VaultWorkspace`) are both
part of the *same* concept being renamed, not a competing one, and both are resolved above with
documented reasoning. Every other "workspace" hit is the unrelated npm/pnpm-workspace or
Google-Workspace sense and is left untouched.

---

## 5. Bindings, storage keys, query params, file-naming (local-only identifiers)

- **R2 buckets / KV namespaces:** checked every `wrangler.jsonc` in the app
  (`packages/backend`, `packages/gatekeeper-google-calendar`, `packages/router`) for any
  `binding`/`bucket_name`/`kv_namespaces` entry containing "vault." **None exists.** The only R2
  binding is `MEETING_AUDIO` / bucket `athenaeum-meeting-audio` (unrelated to vaults). The only
  binding that needs a name change is the Durable Object **class name** itself
  (`VaultDurableObject` → `WorkspaceDurableObject`, handled via the migrations array, §3) — there
  is no separate binding name to update because both DOs are reached via `ctx.exports`, not an
  explicit `durable_objects` binding block (per the wrangler.jsonc's own comment).

- **Swift `UserDefaults` key `"athenaeum.vaultId"`** and **web `localStorage` key
  `"athenaeum:vaultId"`**: both are per-device/per-browser local identifiers, never transmitted or
  read by the backend, and (per §3) this app has never been deployed/installed by a real user.
  **Decision: rename both** (`"athenaeum.workspaceId"` / `"athenaeum:workspaceId"`) for
  consistency — there is no stale-install/migration concern since nothing has shipped, and leaving
  the storage key mismatched with the surrounding code (`resolveVaultId` becomes
  `resolveWorkspaceId` but keeps reading `"athenaeum.vaultId"`) would be a confusing, purely
  cosmetic inconsistency with zero corresponding benefit.

- **Web URL query param `?vault=<id>`**: same reasoning — **rename to `?workspace=<id>`**. No
  bookmarked/shared links exist in the wild (unreleased app), so there's nothing to keep backward
  compatible with.

- **Native local SQLite file naming** (`vault-<id>.sqlite3`, `VaultConfiguration.localStorePath`):
  **rename to `workspace-<id>.sqlite3`** for the same reason — it's a local Application Support
  path on a developer's own machine, not a shipped format.

---

## 6. Full file list requiring in-place identifier/string/comment changes

(In addition to the renames in §2, which also need their *contents* updated.) Grouped by area —
every file below was confirmed via `rg -l -i vault` (excluding `node_modules`, `.git`, `.build`,
`DerivedData`, `.wrangler`, `dist`, `build`, `xcuserdata`, `.swiftpm`) to actually reference the
per-vault storage/sharing concept, not just a coincidental substring:

**`packages/domain/src/`** — `agent-edit-rpc.ts`, `agent-tools.ts`, `auth.ts`, `bookmark.ts` (+
`.test.ts`), `calendar-event.ts` (+ `.test.ts`), `chat-binding.ts`, `chat-fork-rpc.ts`, `chat.ts` (+
`.test.ts`), `edges-repository.ts`, `errors.ts`, `facts-repository.ts`, `gatekeeper-binding.ts` (+
`.test.ts`), `gatekeeper-rpc.ts` (+ `.test.ts`), `gatekeeper.ts`, `graph-issues-repository.ts`,
`graph-rpc.ts` (+ `.test.ts`), `index.ts`, `meeting-rpc.ts` (+ `.test.ts`), `meeting.ts` (+
`.test.ts`), `model-client.test.ts`, `node.ts` (+ `.test.ts`), `nodes-repository.ts`,
`page-rpc.ts`, `pages-repository.ts`, `realtime-voice.test.ts`, `relation-definitions-repository.ts`,
`rpc-error.ts` (+ `.test.ts`), `rpc.ts`, `search-rpc.ts`, `sharing-rpc.ts` (+ `.test.ts`),
`sharing.ts` (+ `.test.ts`), `sync-rpc.ts`, `sync.ts` (+ `.test.ts`), `tag.ts`,
`tags-repository.ts`, `voice-audio-rpc.ts`, `voice-session-rpc.ts` (+ `.test.ts`),
`voice-session.ts` (+ `.test.ts`), `workout-rpc.ts` (+ `.test.ts`), `workout.ts` (+ `.test.ts`).

**`packages/backend/src/`** — `agent-edit-collections.ts`, `agent-edit-service-live.ts`,
`calendar-collections.ts`, `calendar-gatekeeper-client.ts`, `calendar-oauth-state.ts`,
`calendar-service-live.ts`, `chat-fork-service-live.ts`, `dev-auth.ts`, `edges-repository-live.ts`,
`env.d.ts`, `facts-repository-live.ts`, `fts-probe-durable-object.ts`,
`gatekeeper-service-credential.ts`, `graph-issues-repository-live.ts`, `graph-service-live.ts`,
`index.ts`, `meeting-collections.ts`, `meetings-service-live.ts`, `nodes-repository-live.ts`,
`nodes-subscription.ts`, `notes-service-live.ts`, `read-model.ts`,
`relation-definitions-repository-live.ts`, `rpc-boundary.ts`, `seed-base-tags.ts`,
`sharing-collections.ts`, `sharing-service-live.ts`, `sync-feed-service-live.ts`, `tag-closure.ts`,
`tags-repository-live.ts`, `user-durable-object.ts`, `vault-durable-object.ts` (renamed, §2),
`vault-ownership.ts` (renamed, §2), `views-service-live.ts`, `voice-audio-session.ts`,
`voice-session-collections.ts`, `voice-session-service-live.ts`, `workout-collections.ts`,
`workout-seed.ts`, `workouts-service-live.ts`; plus `package.json`, `wrangler.jsonc`.

**`packages/backend/test/`** — `agent-edit.test.ts`, `calendar-service.test.ts`,
`chat-fork.test.ts`, `dev-auth.test.ts`, `do-recovery.test.ts`, `graph-service.test.ts`,
`live-subscription.test.ts`, `meetings.test.ts`, `notes-service.test.ts`,
`phase1-exit-criteria.test.ts`, `phase4-exit-criteria.test.ts`, `request-response.test.ts`,
`revocation-eviction.test.ts`, `sharing-service.test.ts`, `support.ts`, `sync-feed.test.ts`,
`user-vault-catalog.test.ts` (renamed, §2), `views-search.test.ts`, `voice-audio-session.test.ts`,
`voice-session.test.ts`, `workouts.test.ts`; plus `vitest-setup.ts`, `vitest.config.ts`.

**`packages/gatekeeper-google-calendar/src/`** — `errors.ts`,
`gatekeeper-account-durable-object.ts`, `gatekeeper-account-service-live.ts`,
`gatekeeper-account-service.ts`, `observer-ledger-typed-storage.ts`, `observer-verifier.ts`,
`rpc-boundary.ts`, `token-store-typed-storage.ts`, `worker.ts`.

**`packages/web/src/`** — `app.css`, `App.tsx`, `AppShell.css`, `AppShell.tsx`,
`automerge-page.ts`, `backend-host.ts`, `Backlinks.tsx`, `BookmarksPanel.tsx`,
`calendar-binding-storage.ts`, `CalendarDayView.tsx`, `CalendarOAuthCallback.tsx`,
`CalendarPanel.tsx`, `ChatPanel.tsx`, `DailyNote.tsx`, `dev-session.ts`,
`format-domain-error.ts`, `GraphView.tsx`, `MeetingsPanel.tsx`, `mentions-relation.ts`,
`routes/BookmarksRoute.tsx`, `routes/CalendarRoute.tsx`, `rpc-client.ts`, `rpc-support.ts`,
`runtime.ts`, `SharePanel.tsx`, `sync-feed-client.ts`, `use-effect-query.ts`,
`use-effect-subscription.ts`, `user-rpc-client.ts`, `vault-id.ts` (renamed, §2),
`VaultSwitcher.tsx` (renamed, §2), `WorkoutsPanel.tsx`.

**`native/AthenaeumApp/Sources/AthenaeumAppUI/`** — `AgentEditViewModel.swift`,
`AthenaeumRootView.swift`, `AthenaeumViewModel.swift`, `BookmarksView.swift`,
`CalendarDayView.swift`, `ContentView.swift`, `DevSession.swift`, `SharePanelView.swift`,
`VaultConfiguration.swift` (renamed, §2), `VaultSwitcherView.swift` (renamed, §2),
`VoiceAssistantView.swift`, `VoiceAssistantViewModel.swift`.

**`native/AthenaeumCore/`** — `Package.swift`;
`Sources/AthenaeumCore/LocalVaultStore.swift` (renamed, §2),
`Sources/AthenaeumCore/Meetings/MeetingTranscriptionPipeline.swift`,
`Sources/AthenaeumCore/PageDocumentStore.swift`, `Sources/AthenaeumCore/SQLite3Connection.swift`,
`Sources/AthenaeumCore/SyncSessionHandle.swift`,
`Sources/AthenaeumCore/VaultSyncClient.swift` (renamed, §2),
`Sources/AthenaeumCore/Voice/PCM16.swift`, `Sources/AthenaeumCore/Voice/VoiceAudioStreamer.swift`,
`Sources/AthenaeumCore/Workouts/SyntheticWorkoutDataSource.swift`,
`Sources/AthenaeumCore/Workouts/WorkoutImportBridge.swift`,
`Sources/Phase2ExitCriterionCLI/Phase2Driver.swift`,
`Sources/Phase3ExitCriterionCLI/Phase3Driver.swift`,
`Sources/Phase4ExitCriterionCLI/Phase4Driver.swift`,
`Sources/Phase5ExitCriterionCLI/Phase5Driver.swift`,
`Sources/Phase6ExitCriterionCLI/Phase6Driver.swift`,
`Sources/Phase7ExitCriterionCLI/Phase7Driver.swift`;
`Tests/AthenaeumCoreTests/LocalVaultStoreTests.swift` (renamed, §2),
`Tests/AthenaeumCoreTests/Meetings/MeetingTranscriptionPipelineTests.swift`,
`Tests/AthenaeumCoreTests/PageDocumentStoreTests.swift`,
`Tests/AthenaeumCoreTests/VaultSyncClientLiveTests.swift` (renamed, §2),
`Tests/AthenaeumCoreTests/Voice/VoiceAudioStreamerTests.swift`,
`Tests/AthenaeumCoreTests/Workouts/WorkoutImportBridgeLiveTests.swift`,
`Tests/AthenaeumCoreTests/Workouts/WorkoutImportBridgeTests.swift`.

**`native/AthenaeumDomain/`** — `README.md`, `scripts/generate-fixtures.ts`,
`scripts/schema-diff.ts`; `Sources/AthenaeumDomain/AgentEditRPC.swift`, `Auth.swift`,
`Bookmark.swift`, `CalendarEvent.swift`, `Chat.swift`, `DailyNoteID.swift`, `EntityId.swift`,
`GatekeeperBinding.swift`, `GatekeeperRPC.swift`, `GraphRPC.swift`, `Node.swift`, `NodeRPC.swift`,
`PageRPC.swift`, `RpcError.swift`, `SearchRPC.swift`, `Sharing.swift`, `SharingRPC.swift`,
`Sync.swift`, `SyncRPC.swift`, `Tag.swift`;
`Tests/AthenaeumDomainTests/Fixtures/*.json` (generated — see note below), `RpcErrorTests.swift`,
`ScalarValidationTests.swift`.

**`native/AthenaeumRPC/`** — `Sources/AthenaeumRPC/AthenaeumDomainError.swift`,
`CapnWebBatchClient.swift`, `CapnWebValue.swift`, `DevAuthClient.swift`, `UserRPCClient.swift`,
`VaultRPCClient.swift` (renamed, §2) + all `VaultRPCClient+*.swift` extensions (renamed, §2);
`Tests/AthenaeumRPCTests/CapnWebValueTests.swift`,
`VaultRPCClientLiveTests.swift` (renamed, §2), `VoiceAudioSessionLiveTests.swift`.

**`native/watchOS/`** — `AthenaeumWatchUI/Sources/AthenaeumWatchUI/QuickCaptureClient.swift`,
`WatchVaultConfiguration.swift` (renamed, §2);
`AthenaeumWatchUI/Tests/AthenaeumWatchUITests/QuickCaptureClientLiveTests.swift`;
`docs/watchos-notes.md` — **see §8, doc-scope caveat**.

**`native/docs/decisions.md`** — **see §8, doc-scope caveat**.

**`apps/athenaeum/docs/*.md`** (in explicit scope) — `agent-model-client.md`,
`automerge-fork-spike.md`, `dev-auth-and-revocation-eviction.md`,
`gatekeeper-google-calendar-decisions.md`, `meetings-voice-decisions.md`,
`workouts-decisions.md`.

**Root-level** — `.impeccable.md` — **see §8, doc-scope caveat**;
`packages/typed-storage-effect/__tests__/worker.ts`, `packages/typed-storage-effect/src/storage.ts`
(these two reference "vault" only in doc-comment examples illustrating the generic
typed-storage-effect API using a vault-shaped example — confirm at implementation time whether
the mention is illustrative-generic or actually vault-specific test data; if purely illustrative
naming with no bearing on the real vault concept, it's still fine/harmless to rename for
consistency since it's just an example variable name, but it does NOT indicate a second real
"vault" concept in that package).

---

## 7. SQL identifiers (`packages/backend/src/read-model.ts`)

The Durable Object's local read-model SQLite schema uses `vaultId` as a real column name:

```sql
CREATE TABLE IF NOT EXISTS rm_nodes (
  id TEXT PRIMARY KEY, vaultId TEXT NOT NULL, title TEXT NOT NULL, createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rm_nodes_vaultId ON rm_nodes(vaultId);
CREATE VIEW IF NOT EXISTS graph_nodes AS SELECT id, vaultId, title, createdAt FROM rm_nodes;
```

All three (`rm_nodes.vaultId` column, `rm_nodes_vaultId` index, `graph_nodes` view's `vaultId`
column/select-list entry) rename to `workspaceId`/`rm_nodes_workspaceId`. Safe for the same
never-deployed reason as §3: this schema is created fresh, per-DO-instance, via idempotent `IF NOT
EXISTS` DDL, and no real persisted data exists anywhere. The one operational note: a developer's
*existing* local `.wrangler/state` DO SQLite file (if any) was created with the old column name;
`IF NOT EXISTS` won't retroactively rename it, so — same as the §3 note — delete
`packages/backend/.wrangler/` locally after the rename lands rather than trying to migrate it.

---

## 8. Doc-file scope caveat (flag for confirmation, do not resolve unilaterally)

The hard constraint states scope is "code AND `apps/athenaeum/docs/*.md`." Read literally, that
authorizes markdown edits **only** for the six files directly inside `apps/athenaeum/docs/`
(listed in §6). The following markdown files also mention "vault" but sit **outside** that literal
glob, inside nested doc folders or as standalone READMEs elsewhere in the app:

- `native/docs/decisions.md`
- `native/watchOS/docs/watchos-notes.md`
- `native/AthenaeumDomain/README.md`
- `.impeccable.md` (app root)

**Decision for this plan: treat these four as out of scope**, on the same "historical record"
logic the hard constraint already applies to the architecture plan and memory files — these read
as narrative decision logs/design briefs describing what was built and why at the time, not living
reference documentation that needs to stay perfectly in sync with current identifier names. If a
later stage's own instructions explicitly widen scope to "all markdown under `apps/athenaeum`,"
this reservation should be revisited then — but no stage should silently edit them assuming that
widening without it being said outright, since the hard constraint enumerates `docs/*.md`
specifically rather than saying "all markdown."

---

## 9. Generated fixtures (`native/AthenaeumDomain/Tests/AthenaeumDomainTests/Fixtures/*.json`)

These `.json` files are build output, not hand-authored: `scripts/generate-fixtures.ts` constructs
each fixture from the real `@athenaeum/domain`-equivalent Swift schemas and serializes them. Once
`vaultId` → `workspaceId` lands in `generate-fixtures.ts` and the schemas it imports, the correct
move is to **re-run the script** to regenerate the fixtures with the new field name (or hand-edit
the JSON identically if re-running isn't convenient in that stage) — not to treat the JSON as
independent source needing its own separate renaming decision.

---

## 10. External reference note (leave untouched)

Several comments cite `docs/sharing.md` as the design source being ported (e.g. `errors.ts`,
`auth.ts`, `sharing-rpc.ts`). This is **`cloudflare-os/docs/sharing.md`** — confirmed to exist at
`/Users/rawkode/Code/src/github.com/cloudflare/cloudflare-os/docs/sharing.md`, a different repo
entirely, outside this rename's scope. That source document uses `gadget` as its own concept name
(this app's "port" substituted `gadget → vault`). Do **not** edit anything in `cloudflare-os`, and
do not change the citation path `docs/sharing.md` itself. What DOES change: the *prose describing
the substitution* in this app's own comments (e.g. "`gadget` → `vault` (this port's uniform
substitution...)" becomes "`gadget` → `workspace` (this port's uniform substitution...)"), since the
substitution's target name is what's changing, not the citation.

---

## Summary of decisions requiring no further confirmation

1. Naming table above is final and exhaustive for every distinct form found.
2. `VaultWorkspace` → `Workspace` (not `WorkspaceWorkspace`) is the one non-mechanical exception,
   justified in §1.
3. `wrangler.jsonc`'s DO migration: in-place class-name edit in the existing `v1` tag, no new
   `renamed_classes` migration — justified in §3 (no prior real deploy).
4. No genuine naming collision with an unrelated "workspace" concept — verified in §4;
   `WorkspaceNotFound`/`WorkspaceAccessDenied` already belong to this same concept and just need
   their `vaultId` field/comments updated, not their class names.
5. No R2/KV binding embeds "vault" — nothing to rename there beyond the DO class itself. Local-only
   storage keys/query param/file-naming (§5) are renamed for consistency since nothing has shipped.
6. SQL column/index/view names in the local read-model schema rename too (§7), with a local
   `.wrangler` cache-clear note for implementers.
7. Four markdown files outside the literal `apps/athenaeum/docs/*.md` glob are flagged, not
   resolved — treated as out of scope pending explicit confirmation (§8).
8. Generated JSON fixtures should be regenerated via their source script, not hand-maintained
   separately (§9).
9. `cloudflare-os/docs/sharing.md` citations and its own `gadget` terminology are untouched; only
   this app's own substitution-describing prose changes (§10).
