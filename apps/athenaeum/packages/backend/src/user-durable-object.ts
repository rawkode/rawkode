// `UserDurableObject` — account identity, workspace catalog, cross-workspace settings (plan
// §"Repo/package layout"). The identity slice (`ensureProfile`/`whoami`, keyed by
// `idFromName(email)`) was built by the dev-auth prerequisite stage — see that history below.
// This stage adds the rest: a per-user multi-workspace catalog and the fixed-identity default
// "Personal" workspace (plan §Phased delivery, Phase 4: "multi-workspace in the User DO with the
// fixed-identity default 'Personal' workspace"), plus a real Cap'n Web RPC surface
// (`createWorkspace`/`listWorkspaces`) reached over `/api/user` — the User-DO-scoped analog of
// `WorkspaceDurableObject`'s own `WorkspaceRpcApi`/`fetch()`, gated by MANDATORY Bearer auth (unlike the
// workspace route, where anonymous access is still the default for every pre-Phase-4 method): there
// is no sensible anonymous "whose catalog is this" question, so `fetch()` below rejects outright
// (401) rather than routing an anonymous connection to `UserRpcApi` at all.
//
// **Keyed by `idFromName(email)`** — the identical pattern cloudflare-os's
// `workshop-backend/src/user.ts`/`src/auth/login-flow.ts` use throughout: "the user DO is keyed
// by the verified email (this DO's id derives from idFromName(email))" (`user.ts`'s
// `loginOrCreateViaGatekeeper` doc comment), reached the same way from every one of its own
// sign-in paths (`login-flow.ts`: `this.ctx.exports.UserDurableObject.idFromName(email)`;
// `server.ts#authenticate`/`#authenticateFromCfAccess`/`#login`: `this.users.idFromName(...)`).
// `index.ts`'s `POST /api/dev/sign-in` route follows the exact same call shape here, and the new
// `GET/POST /api/user` route below derives the SAME id from the caller's verified credential
// (never a client-supplied id) — see `index.ts#handleUserRequest`'s own doc comment.
//
// A DO instance never has to be told its own email by a caller — like `WorkspaceDurableObject` reads
// `ctx.id.name` back as `#workspaceId` for defense-in-depth (`requireOwnWorkspace`), this class reads
// `ctx.id.name` back as `#ownEmail` and every method verifies its `email` parameter (or, for the
// Cap'n Web methods below, the connection's verified `AuthenticatedUser.email`) matches, rather
// than trusting a caller-supplied value blindly.
//
// **Fixed-identity default "Personal" workspace** (plan §Phased delivery, Phase 4): derived
// deterministically from `#ownEmail` via `deriveDefaultWorkspaceId` below — SHA-256 of a fixed,
// namespaced string, truncated to 16 bytes and formatted as a UUID. Same input always produces
// the same workspace id, so "fresh devices using the same account address the same... zone" (the
// plan's own phrasing, one level up from CloudKit zones to workspace ids) holds for Athenaeum's own
// multi-workspace catalog: two sign-ins for the same email, even from a fresh `UserDurableObject`
// instance (this DO's storage is itself durable, but the derivation doesn't even depend on that —
// it's pure function of `email`), always name the exact same workspace.

import { DurableObject } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { newHttpBatchRpcResponse, newWebSocketRpcSession, RpcTarget } from "capnweb"
import {
  type AuthenticatedUser,
  CreateWorkspaceInput,
  CreateWorkspaceOutput,
  CurrentUser,
  Email,
  EntityId,
  IsoDateTimeString,
  ListWorkspacesInput,
  ListWorkspacesOutput,
  requireAuthenticatedUser,
  Unauthorized,
  UnexpectedError,
  WorkspaceCatalogEntry,
  type DomainError
} from "@athenaeum/domain"
import {
  collection,
  createEffectTypedStorage,
  type Collection,
  type Singleton,
  type TypedStorageError
} from "@athenaeum/typed-storage-effect"
import { extractBearerCredential, verifyDevCredential } from "./dev-auth.js"
import { decodeRpcInput, runRpcEffect } from "./rpc-boundary.js"
import type { WorkspaceDurableObject } from "./workspace-durable-object.js"
import type { Env } from "./index.js"

/** The one durable fact this stage's identity slice needs: has this account been seen before,
 *  and if so, when. Deliberately minimal — no display name — every field beyond
 *  `email`/`createdAt` is genuinely a later stage's concern, not a placeholder cut for time. */
export interface UserProfile {
  readonly email: string
  readonly createdAt: string
}

const NOT_CREATED_SENTINEL: UserProfile = { email: "", createdAt: "" }

const workspacesCollectionSchema = collection<WorkspaceCatalogEntry>()({
  primaryKey: "workspaceId"
})

const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message: error._tag === "StorageError"
      ? error.message
      : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

/** `DurableObjectStorage` round-trips values through structured clone — see
 *  `nodes-repository-live.ts`'s `reviveNode` for the identical concern/fix, applied here to
 *  `WorkspaceCatalogEntry`: a record read back from `storage.kv` is a plain object, not the
 *  `Schema.Class` instance `Schema.encodeSync(ListWorkspacesOutput)` needs for its nested
 *  `workspaces: Schema.Array(WorkspaceCatalogEntry)` field. */
const reviveWorkspaceCatalogEntry = (raw: unknown): Effect.Effect<WorkspaceCatalogEntry, UnexpectedError> =>
  Schema.decodeUnknown(WorkspaceCatalogEntry)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({
          message: `corrupt stored workspace catalog entry: ${TreeFormatter.formatErrorSync(parseError)}`
        })
    )
  )

/**
 * Derives this account's fixed-identity default "Personal" workspace id — a pure function of
 * `email`, so it never needs to be looked up or persisted separately from the catalog entry
 * itself (see this file's header comment). Not a cryptographic commitment (no secret input) —
 * deliberately: the point is determinism (same email -> same workspace, every time), not
 * unguessability, exactly like a UUIDv5 namespaced-name derivation (which this approximates:
 * SHA-256 rather than UUIDv5's SHA-1, since `crypto.subtle` and this codebase's own HMAC
 * discipline — `dev-auth.ts`'s header comment — already standardize on SHA-256 throughout).
 */
export const deriveDefaultWorkspaceId = async (email: Email): Promise<EntityId> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`athenaeum-default-workspace:v1:${email}`)
  )
  const bytes = new Uint8Array(digest).slice(0, 16)
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  return Schema.decodeUnknownSync(EntityId)(uuid)
}

/**
 * Registers `workspaceId` in `workspaces` as owned by `ownEmail`, AND (plan task item 3: "implicitly, as
 * workspace owner") initializes that workspace's own `WorkspaceDurableObject` ownership record via
 * `workspaceExports.getByName(workspaceId).initializeOwner(...)` — the native `ctx.exports`-only method
 * `workspace-durable-object.ts` builds for exactly this call (see its own doc comment for why it's
 * deliberately not Cap'n Web-exposed). Both writes happen before returning, so a caller never
 * observes a catalog entry whose `WorkspaceDurableObject` hasn't been told who owns it yet.
 */
const registerWorkspace = (
  workspaceExports: DurableObjectNamespace<WorkspaceDurableObject>,
  workspaces: Collection<WorkspaceCatalogEntry, EntityId>,
  ownEmail: Email,
  workspaceId: EntityId,
  title: string,
  isDefault: boolean
): Effect.Effect<WorkspaceCatalogEntry, UnexpectedError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => workspaceExports.getByName(workspaceId).initializeOwner(ownEmail, title),
      catch: (cause) =>
        new UnexpectedError({ message: `failed to initialize workspace owner: ${String(cause)}` })
    })
    const entry = new WorkspaceCatalogEntry({ workspaceId, title, ownerId: ownEmail, role: "build", isDefault })
    yield* workspaces.put(entry).pipe(Effect.mapError(toUnexpectedError))
    return entry
  })

const listCatalog = (
  workspaces: Collection<WorkspaceCatalogEntry, EntityId>
): Effect.Effect<ReadonlyArray<WorkspaceCatalogEntry>, UnexpectedError> =>
  workspaces.list().pipe(
    Effect.mapError(toUnexpectedError),
    Effect.flatMap((raws) => Effect.forEach(raws, reviveWorkspaceCatalogEntry))
  )

/**
 * The Cap'n Web-facing RPC surface for a user's own catalog — reached only via
 * `UserDurableObject#fetch()` below, which has already verified the connection's Bearer
 * credential (mandatory here, unlike `WorkspaceRpcApi`'s optional auth) before constructing this.
 * Every method still re-derives the caller from `CurrentUser`/`requireAuthenticatedUser` (rather
 * than trusting the constructor-captured `currentUser` implicitly) and checks it against
 * `ownEmail` — the same "auth-context plumbing... follow the established pattern, extend it,
 * don't bypass it" discipline `WorkspaceRpcApi#whoami` established, applied here to two methods that
 * actually gate on it (unlike `whoami`, which never rejects).
 */
class UserRpcApi extends RpcTarget {
  readonly #ownEmail: Email
  readonly #workspaces: Collection<WorkspaceCatalogEntry, EntityId>
  readonly #workspaceExports: DurableObjectNamespace<WorkspaceDurableObject>
  readonly #currentUser: AuthenticatedUser

  constructor(
    ownEmail: Email,
    workspaces: Collection<WorkspaceCatalogEntry, EntityId>,
    workspaceExports: DurableObjectNamespace<WorkspaceDurableObject>,
    currentUser: AuthenticatedUser
  ) {
    super()
    this.#ownEmail = ownEmail
    this.#workspaces = workspaces
    this.#workspaceExports = workspaceExports
    this.#currentUser = currentUser
  }

  /** Fails with `Unauthorized` unless the connection's verified identity IS this catalog's
   *  owner — always true in practice (`fetch()` below only ever constructs this class after
   *  confirming exactly that), kept as a real check rather than an assumption for the same
   *  "defense-in-depth, not the primary check" reason `workspace-durable-object.ts#requireOwnWorkspace`
   *  exists. */
  #requireOwnAccount(): Effect.Effect<AuthenticatedUser, Unauthorized, CurrentUser> {
    return requireAuthenticatedUser.pipe(
      Effect.flatMap((user) =>
        user.email === this.#ownEmail
          ? Effect.succeed(user)
          : Effect.fail(new Unauthorized({ message: "Credential does not match this account's catalog." }))
      )
    )
  }

  #withCurrentUser<A, E>(program: Effect.Effect<A, E, CurrentUser>): Effect.Effect<A, E> {
    return program.pipe(Effect.provideService(CurrentUser, Option.some(this.#currentUser)))
  }

  async createWorkspace(input: unknown): Promise<unknown> {
    const ownEmail = this.#ownEmail
    const workspaces = this.#workspaces
    const workspaceExports = this.#workspaceExports
    const program: Effect.Effect<CreateWorkspaceOutput, DomainError> = this.#withCurrentUser(
      decodeRpcInput(CreateWorkspaceInput, input).pipe(
        Effect.flatMap((decoded) =>
          this.#requireOwnAccount().pipe(
            Effect.flatMap(() => {
              const workspaceId = Schema.decodeUnknownSync(EntityId)(crypto.randomUUID())
              return registerWorkspace(workspaceExports, workspaces, ownEmail, workspaceId, decoded.title, false)
            }),
            Effect.map((workspace) => new CreateWorkspaceOutput({ workspace }))
          )
        )
      )
    )
    return runRpcEffect(program, CreateWorkspaceOutput)
  }

  async listWorkspaces(input: unknown): Promise<unknown> {
    const workspaces = this.#workspaces
    const program: Effect.Effect<ListWorkspacesOutput, DomainError> = this.#withCurrentUser(
      decodeRpcInput(ListWorkspacesInput, input).pipe(
        Effect.flatMap(() =>
          this.#requireOwnAccount().pipe(
            Effect.flatMap(() => listCatalog(workspaces)),
            Effect.map((catalogWorkspaces) => new ListWorkspacesOutput({ workspaces: catalogWorkspaces }))
          )
        )
      )
    )
    return runRpcEffect(program, ListWorkspacesOutput)
  }
}

export class UserDurableObject extends DurableObject<Env> {
  readonly #ownEmail: Email
  readonly #profile: Singleton<UserProfile>
  readonly #workspaces: Collection<WorkspaceCatalogEntry, EntityId>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Populated whenever this DO is addressed via `idFromName(email)` (the only way `index.ts`'s
    // dev sign-in and `/api/user` routes ever reach it) — see this file's header comment.
    this.#ownEmail = Schema.decodeUnknownSync(Email)(ctx.id.name ?? "")
    const typedStorage = createEffectTypedStorage(ctx.storage, {
      collections: { workspaces: workspacesCollectionSchema },
      singletons: { profile: NOT_CREATED_SENTINEL }
    })
    this.#profile = typedStorage.profile
    this.#workspaces = typedStorage.workspaces
  }

  /**
   * Idempotently records that `email` has signed in, creating the account's profile on first
   * contact, AND ensures the fixed-identity default "Personal" workspace exists (this file's header
   * comment) — called by `index.ts`'s dev sign-in route immediately before it mints a credential,
   * mirroring cloudflare-os's `loginOrCreateViaGatekeeper`'s "create on first use" shape, minus
   * the `allowCreate`/closed-signups gate (this is a dev-only tool behind `DEV_AUTH_ENABLED`, not
   * a production signup surface with its own policy to enforce).
   *
   * Real, not a stub: a second call for the same email returns the *original* `createdAt`
   * unchanged (matches `user.ts`'s own "we intentionally do NOT refresh... on later logins" note,
   * minus the display-name field this stage doesn't have yet) — this is what makes two dev
   * sign-ins for the same email observably the same account, and two different emails observably
   * different accounts (distinct `UserDurableObject` instances via `idFromName`), the property
   * the sharing prerequisite actually needs. The default-workspace check runs on EVERY call
   * (idempotent internally, per `#ensureDefaultWorkspace`'s own doc comment), not just on first
   * profile creation — "created automatically... on first sign-in if it doesn't exist yet" holds
   * even for an edge case where the profile already existed but the workspace somehow didn't.
   */
  async ensureProfile(email: string): Promise<UserProfile> {
    const decoded = Schema.decodeUnknownSync(Email)(email)
    if (decoded !== this.#ownEmail) {
      throw new Error(
        `UserDurableObject identity mismatch: this instance is ${this.#ownEmail}, got ${decoded}`
      )
    }

    const existing = await Effect.runPromise(this.#profile.get())
    let profile: UserProfile
    if (existing.createdAt !== "") {
      profile = existing
    } else {
      const createdAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString())
      profile = { email: decoded, createdAt }
      await Effect.runPromise(this.#profile.put(profile))
    }

    await this.#ensureDefaultWorkspace()
    return profile
  }

  /**
   * Ensures this account's fixed-identity default "Personal" workspace exists, creating it (and
   * initializing its `WorkspaceDurableObject`'s owner record — `registerWorkspace` above) if not.
   * Idempotent: `deriveDefaultWorkspaceId` is a pure function of `#ownEmail`, so a repeat call always
   * checks the SAME catalog key and no-ops if it's already there — safe to call on every
   * `ensureProfile` invocation, not just the very first one.
   */
  async #ensureDefaultWorkspace(): Promise<WorkspaceCatalogEntry> {
    const workspaceId = await deriveDefaultWorkspaceId(this.#ownEmail)
    const existingRaw = await Effect.runPromise(this.#workspaces.get(workspaceId).pipe(Effect.mapError(toUnexpectedError)))
    if (existingRaw !== undefined) {
      return Effect.runPromise(reviveWorkspaceCatalogEntry(existingRaw))
    }
    return Effect.runPromise(
      registerWorkspace(this.ctx.exports.WorkspaceDurableObject, this.#workspaces, this.#ownEmail, workspaceId, "Personal", true)
    )
  }

  /** Like whoami(), but returns null if the account was never initialized. */
  async whoami(): Promise<UserProfile | null> {
    const existing = await Effect.runPromise(this.#profile.get())
    return existing.createdAt === "" ? null : existing
  }

  /**
   * The Cap'n Web session entrypoint for this account's own catalog — reached only via
   * `index.ts`'s `GET/POST /api/user` route, which has already verified the caller's Bearer
   * credential once (to derive WHICH `UserDurableObject` to address — see that route's own doc
   * comment). Verifies it again here, independently, and — unlike `WorkspaceDurableObject#fetch()`,
   * where an absent/invalid credential still proceeds anonymously for every pre-Phase-4 method —
   * rejects outright (401) if the credential is missing, invalid, or (403) names a different
   * account than this DO instance IS: there is no anonymous "whose catalog" case, and a caller
   * reaching this DO instance at all already means the routing layer resolved `idFromName` from
   * SOME verified email, so a mismatch here would mean a routing bug, not a legitimate anonymous
   * request — worth failing loudly rather than silently downgrading.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const bearer = extractBearerCredential(request, url)
    if (bearer === undefined) {
      return new Response("Authentication required.", { status: 401 })
    }

    const secret = this.env.DEV_AUTH_HMAC_SECRET
    if (secret === undefined || secret.length === 0) {
      return new Response(
        "Dev auth credential presented, but this deployment has no DEV_AUTH_HMAC_SECRET configured.",
        { status: 500 }
      )
    }

    const exit = await Effect.runPromiseExit(verifyDevCredential(bearer, secret))
    if (Exit.isFailure(exit)) {
      return new Response("Invalid or expired credential.", { status: 401 })
    }
    const currentUser = exit.value
    if (currentUser.email !== this.#ownEmail) {
      return new Response("Credential does not match this account.", { status: 403 })
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair()
      const server = pair[0]
      const client = pair[1]
      server.accept()
      newWebSocketRpcSession(
        server,
        new UserRpcApi(this.#ownEmail, this.#workspaces, this.ctx.exports.WorkspaceDurableObject, currentUser)
      )
      return new Response(null, { status: 101, webSocket: client })
    }

    if (request.method === "POST") {
      const response = await newHttpBatchRpcResponse(
        request,
        new UserRpcApi(this.#ownEmail, this.#workspaces, this.ctx.exports.WorkspaceDurableObject, currentUser)
      )
      response.headers.set("Access-Control-Allow-Origin", "*")
      return response
    }

    return new Response("This endpoint only accepts POST or WebSocket requests.", { status: 400 })
  }
}
