import type { EntityId } from "@athenaeum/domain"

export type ReferenceReconciliationPlan = {
  readonly referencedNodeIds: readonly EntityId[]
  readonly requestId: string
}

type ActivePlan = ReferenceReconciliationPlan & {
  readonly targetKey: string
  readonly inFlight: boolean
}

export type ReferenceReconciler = {
  readonly request: (referencedNodeIds: readonly EntityId[]) => void
  readonly seed: (referencedNodeIds: readonly EntityId[]) => void
  readonly snapshot: () => {
    readonly confirmedKey: string
    readonly desiredKey: string
    readonly activeTargetKey?: string
    readonly activeRequestId?: string
    readonly activeInFlight: boolean
  }
}

export const referenceKey = (referencedNodeIds: readonly EntityId[]): string =>
  [...new Set(referencedNodeIds.map(String))].sort().join(",")

const canonicalIds = (referencedNodeIds: readonly EntityId[]): EntityId[] =>
  [...new Set(referencedNodeIds.map(String))].sort() as EntityId[]

/** Serializes desired-set mention projections. A newer editor state waits behind the active plan;
 * a transport failure retries the same immutable request id before deriving any newer state from it. */
export const createReferenceReconciler = ({
  send,
  onError,
  initialReferencedNodeIds = []
}: {
  readonly send: (plan: ReferenceReconciliationPlan) => Promise<void>
  readonly onError?: (error: unknown) => void
  readonly initialReferencedNodeIds?: readonly EntityId[]
}): ReferenceReconciler => {
  let confirmedKey = referenceKey(initialReferencedNodeIds)
  let desiredIds = canonicalIds(initialReferencedNodeIds)
  let active: ActivePlan | undefined

  const launch = (): void => {
    if (active?.inFlight) return

    if (active !== undefined) {
      const attempt: ActivePlan = { ...active, inFlight: true }
      active = attempt
      void send({ referencedNodeIds: attempt.referencedNodeIds, requestId: attempt.requestId }).then(
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

    const targetKey = referenceKey(desiredIds)
    if (targetKey === confirmedKey) return
    const attempt: ActivePlan = {
      targetKey,
      referencedNodeIds: desiredIds,
      requestId: crypto.randomUUID(),
      inFlight: true
    }
    active = attempt
    void send({ referencedNodeIds: attempt.referencedNodeIds, requestId: attempt.requestId }).then(
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
    request: (referencedNodeIds) => {
      desiredIds = canonicalIds(referencedNodeIds)
      launch()
    },
    seed: (referencedNodeIds) => {
      desiredIds = canonicalIds(referencedNodeIds)
      confirmedKey = referenceKey(desiredIds)
      active = undefined
    },
    snapshot: () => ({
      confirmedKey,
      desiredKey: referenceKey(desiredIds),
      activeTargetKey: active?.targetKey,
      activeRequestId: active?.requestId,
      activeInFlight: active?.inFlight ?? false
    })
  }
}
