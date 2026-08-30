/**
 * Unforgeable in-process proof that a semantic projection is executing under LedgerService's
 * first-execution transaction. The type is exported solely so internal projection services can
 * require it; no constructor, factory, or validator escapes this backend module.
 */
declare const ledgerMutationCapabilityBrand: unique symbol
export interface LedgerMutationCapability {
  readonly [ledgerMutationCapabilityBrand]: true
}

export interface LedgerMutationScope {
  readonly type: string
  readonly workspaceId: string
  readonly targetKind: string
  readonly targetId: string
  /** The ledger fingerprint commits principal, policy, rationale and request semantics. */
  readonly fingerprint: string
}

const issued = new WeakMap<object, LedgerMutationScope>()

export const issueLedgerMutationCapability = (scope: LedgerMutationScope): LedgerMutationCapability => {
  const capability = {} as LedgerMutationCapability
  issued.set(capability, scope)
  return capability
}

export const isLedgerMutationCapability = (value: unknown, expected: LedgerMutationScope): value is LedgerMutationCapability => {
  if (typeof value !== "object" || value === null) return false
  const actual = issued.get(value)
  return actual !== undefined && actual.type === expected.type && actual.workspaceId === expected.workspaceId &&
    actual.targetKind === expected.targetKind && actual.targetId === expected.targetId && actual.fingerprint === expected.fingerprint
}
