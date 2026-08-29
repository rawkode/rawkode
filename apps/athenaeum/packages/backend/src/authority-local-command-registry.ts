import type { LocalMutationCapability } from "./workspace-local-mutation-capability.js"
import { AUTHORITY_LOCAL_COMMANDS } from "./authority-local-commands.js"

/** A handler is a synchronous, statically registered command implementation. */
export type LocalCommandHandler<Output = unknown> = (capability: LocalMutationCapability, payload: unknown) => Output
export type LocalCommandEntry = Readonly<{ kind: string; handler: LocalCommandHandler }>
export type AuthorityLocalCommandRegistry = Readonly<{
  get: (kind: string) => LocalCommandHandler | undefined
}>

/**
 * Construct an immutable registry. Production code uses the static table below; this constructor
 * exists so the contract harness can provide isolated handlers without a mutable global hook.
 */
const createImmutableRegistry = (entries: readonly LocalCommandEntry[]): AuthorityLocalCommandRegistry => {
  const handlers = new Map<string, LocalCommandHandler>()
  for (const entry of entries) {
    if (!entry || typeof entry.kind !== "string" || entry.kind.trim().length === 0 || typeof entry.handler !== "function") throw new Error("invalid local command entry")
    if (handlers.has(entry.kind)) throw new Error(`duplicate local command: ${entry.kind}`)
    handlers.set(entry.kind, entry.handler)
  }
  return Object.freeze({ get: (kind: string) => handlers.get(kind) })
}

/** The production registry is static and has no runtime registration/mutation API. */
export const authorityLocalCommandRegistry = createImmutableRegistry(AUTHORITY_LOCAL_COMMANDS)
