/** Test-only injection boundary for the contract harness. Production source must not import this module. */
import { executeMutationAuthorityWithRegistry } from "../src/workspace-mutation-authority-internal.js"
import type { AuthorityLocalCommandRegistry, LocalCommandEntry } from "../src/authority-local-command-registry.js"
import type {
  AuthorityAdmissionPort, AuthorityInput, AuthorityOutcome, AuthorityReceipt, AuthorityStore, KernelIdentityPort
} from "../src/workspace-mutation-authority.js"

export const createAuthorityLocalCommandRegistryForTests = (entries: readonly LocalCommandEntry[]): AuthorityLocalCommandRegistry => {
  const handlers = new Map<string, LocalCommandEntry["handler"]>()
  for (const entry of entries) {
    if (!entry || typeof entry.kind !== "string" || entry.kind.trim().length === 0 || typeof entry.handler !== "function") throw new Error("invalid local command entry")
    if (handlers.has(entry.kind)) throw new Error(`duplicate local command: ${entry.kind}`)
    handlers.set(entry.kind, entry.handler)
  }
  return Object.freeze({ get: (kind: string) => handlers.get(kind) })
}

export const executeAuthorityForTests = <Output = unknown>(
  store: AuthorityStore<AuthorityReceipt<Output>>,
  admission: AuthorityAdmissionPort,
  input: AuthorityInput,
  identity: KernelIdentityPort,
  registry: AuthorityLocalCommandRegistry,
  handlerAttempts = 3
): Promise<AuthorityOutcome<Output>> => executeMutationAuthorityWithRegistry(store, admission, input, identity, handlerAttempts, registry)
