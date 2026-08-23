// The one durable fact `WorkspaceDurableObject` itself needs about multi-workspace/sharing (plan
// §"Phased delivery", Phase 4: "multi-workspace in the User DO with the fixed-identity default
// 'Personal' workspace... creating a workspace registers it in both the creating UserDurableObject's
// catalog and (implicitly, as workspace owner) the new WorkspaceDurableObject itself"): who owns it, and
// under what title it was created. Deliberately minimal — no `collaborators`/`shareKeys` storage
// here (that's the next stage's `SharingService`, per this stage's own scope boundary; this file
// only notes the one fact a permission graph's "owner is the implicit root" (docs/sharing.md
// §The owner as root) needs to exist for later: which email *is* the root for this workspace).
//
// A separate module (not folded into `workspace-durable-object.ts` directly) for the same reason
// `nodes-repository-live.ts`/`pages-repository-live.ts`/etc. are each their own file: "one DO
// class, composed from separate Effect Services in separate modules... each owning its own
// typed-storage-effect collections" (plan §"Storage & domain model", God-object mitigation).

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Email } from "@athenaeum/domain"
import { createEffectTypedStorage, type Singleton } from "@athenaeum/typed-storage-effect"

export interface WorkspaceMeta {
  readonly ownerEmail: string | null
  readonly title: string
}

const UNINITIALIZED: WorkspaceMeta = { ownerEmail: null, title: "" }

/** Built once per `WorkspaceDurableObject` construction, same pattern as every other
 *  `make*Collections`/`make*Singleton` helper this DO composes in its constructor. */
export const makeWorkspaceMetaSingleton = (storage: DurableObjectStorage): Singleton<WorkspaceMeta> =>
  createEffectTypedStorage(storage, { singletons: { workspaceMeta: UNINITIALIZED } }).workspaceMeta

/**
 * Registers this workspace's owner, once — real logic behind `WorkspaceDurableObject#initializeOwner`
 * (see that method's own doc comment for the ctx.exports-only/never-Cap'n-Web-exposed access
 * rule, same rationale as `evictSessions`). Idempotent for the SAME owner (a second call is a
 * harmless no-op, returning the original record — never lets a repeat call silently rewrite
 * `title`); refuses outright for a DIFFERENT owner, since a workspace's ownership is a one-time,
 * append-only fact, never silently reassigned.
 */
export const initializeWorkspaceOwner = (
  workspaceMeta: Singleton<WorkspaceMeta>,
  workspaceId: string,
  ownerEmail: string,
  title: string
): Effect.Effect<WorkspaceMeta, never, never> =>
  Effect.gen(function* () {
    const decodedEmail = Schema.decodeUnknownSync(Email)(ownerEmail)
    const existing = yield* Effect.orDie(workspaceMeta.get())
    if (existing.ownerEmail !== null) {
      if (existing.ownerEmail !== decodedEmail) {
        return yield* Effect.die(
          new Error(
            `WorkspaceDurableObject ${workspaceId} already has owner ${existing.ownerEmail}; refusing to reinitialize as ${decodedEmail}.`
          )
        )
      }
      return existing
    }
    const meta: WorkspaceMeta = { ownerEmail: decodedEmail, title }
    yield* Effect.orDie(workspaceMeta.put(meta))
    return meta
  })
