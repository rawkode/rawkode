/**
 * Stage 1A: an unwired, contract-only Workspace mutation authority.
 *
 * This file deliberately does not import WorkspaceDurableObject, LedgerService, Worker routes, or
 * any external client. It describes the port that the eventual Workspace DO integration must
 * satisfy. The first transaction is read-only admission/replay; only an absent request proceeds
 * through fresh action resolution and a second transaction.
 */
import { authorityLocalCommandRegistry } from "./authority-local-command-registry.js"
import type {
  AuthorityAdmissionPort,
  AuthorityInput,
  AuthorityOutcome,
  AuthorityReceipt,
  AuthorityStore,
  KernelIdentityPort
} from "./authority-kernel-contract.js"
import { executeMutationAuthorityWithRegistry } from "./workspace-mutation-authority-internal.js"

// Compatibility boundary: public callers retain the existing named contract exports.
export * from "./authority-kernel-contract.js"

/** Run one mutation through the unwired authority contract using the immutable production table. */
export const executeUnwiredMutationAuthority = async <Output = unknown>(
  store: AuthorityStore<AuthorityReceipt<Output>>,
  admission: AuthorityAdmissionPort,
  input: AuthorityInput,
  identity: KernelIdentityPort,
  handlerAttempts = 3
): Promise<AuthorityOutcome<Output>> => executeMutationAuthorityWithRegistry(store, admission, input, identity, handlerAttempts, authorityLocalCommandRegistry)
