import type { EntityId } from "@athenaeum/domain"

export type TagMembershipOperation = {
  readonly kind: "assign" | "unassign"
  readonly tagId: EntityId
  readonly requestId: string
}

type ActivePlan = {
  readonly targetKey: string
  readonly previousKey: string
  readonly operations: readonly TagMembershipOperation[]
  readonly inFlight: boolean
}

export type TagMembershipReconciler = {
  /** Publish the latest desired membership. A newer request is queued behind any active plan. */
  readonly request: (tagIds: readonly EntityId[]) => void
  /** Reset the confirmed server baseline, used when an editor session is initialized. */
  readonly seed: (tagIds: readonly EntityId[]) => void
  /** Record a successful direct membership mutation without launching a duplicate reconciliation. */
  readonly confirm: (tagIds: readonly EntityId[]) => void
  readonly snapshot: () => {
    readonly confirmedKey: string
    readonly desiredKey: string
    readonly activeTargetKey?: string
    readonly activeInFlight: boolean
  }
}

export const tagMembershipKey = (tagIds: readonly EntityId[]): string =>
  [...tagIds].map(String).sort().join(",")

/**
 * Serializes tag-membership writes without making the editor wait for the network. Each plan
 * keeps its request IDs across retries, and a newer desired state is only planned after the
 * current plan has completed. This prevents an older delayed assign from landing after a newer
 * unassign and leaving the graph inconsistent with the document.
 */
export const createTagMembershipReconciler = ({
  send,
  onError,
  initialTagIds = []
}: {
  readonly send: (operations: readonly TagMembershipOperation[]) => Promise<void>
  readonly onError?: (error: unknown) => void
  readonly initialTagIds?: readonly EntityId[]
}): TagMembershipReconciler => {
  let confirmedKey = tagMembershipKey(initialTagIds)
  let desiredIds: readonly EntityId[] = [...initialTagIds]
  let active: ActivePlan | undefined

  const launch = (): void => {
    if (active?.inFlight) return

    // A failed plan remains authoritative until its stable request IDs have been retried. Do not
    // derive a newer delta from an uncertain partial write; that is how stale memberships leak in.
    if (active !== undefined) {
      const attempt: ActivePlan = { ...active, inFlight: true }
      active = attempt
      void send(attempt.operations).then(
        () => {
          if (active !== attempt) return
          confirmedKey = attempt.targetKey
          active = undefined
          launch()
        },
        (error) => {
          if (active !== attempt) return
          active = { ...attempt, inFlight: false }
          onError?.(error)
        }
      )
      return
    }

    const targetKey = tagMembershipKey(desiredIds)
    if (targetKey === confirmedKey) return
    const previousIds = new Set(confirmedKey.length === 0 ? [] : confirmedKey.split(","))
    const desiredSet = new Set(desiredIds.map(String))
    const operations: TagMembershipOperation[] = [
      ...desiredIds
        .filter((tagId) => !previousIds.has(String(tagId)))
        .map((tagId) => ({ kind: "assign" as const, tagId, requestId: crypto.randomUUID() })),
      ...[...previousIds]
        .filter((tagId) => !desiredSet.has(tagId))
        .map((tagId) => ({ kind: "unassign" as const, tagId: tagId as EntityId, requestId: crypto.randomUUID() }))
    ]
    if (operations.length === 0) {
      confirmedKey = targetKey
      launch()
      return
    }

    const attempt: ActivePlan = { targetKey, previousKey: confirmedKey, operations, inFlight: true }
    active = attempt
    void send(attempt.operations).then(
      () => {
        if (active !== attempt) return
        confirmedKey = attempt.targetKey
        active = undefined
        launch()
      },
      (error) => {
        if (active !== attempt) return
        active = { ...attempt, inFlight: false }
        onError?.(error)
      }
    )
  }

  return {
    request: (tagIds) => {
      desiredIds = [...tagIds]
      launch()
    },
    seed: (tagIds) => {
      confirmedKey = tagMembershipKey(tagIds)
      desiredIds = [...tagIds]
      active = undefined
    },
    confirm: (tagIds) => {
      const key = tagMembershipKey(tagIds)
      if (active !== undefined) {
        // Keep the active plan and only move the desired target forward. Its completion will
        // establish a fresh confirmed baseline before deriving the next delta.
        desiredIds = [...tagIds]
        return
      }
      confirmedKey = key
      desiredIds = [...tagIds]
      active = undefined
    },
    snapshot: () => ({
      confirmedKey,
      desiredKey: tagMembershipKey(desiredIds),
      activeTargetKey: active?.targetKey,
      activeInFlight: active?.inFlight ?? false
    })
  }
}
