import type { LocalCommandEntry } from "./authority-local-command-registry.js"

/**
 * Concrete production commands belong in this immutable table. Each handler must be imported
 * statically here so the source-boundary audit can walk its complete transitive graph. Stage 1A
 * intentionally ships no production command and therefore cannot silently make a route mutable.
 */
export const AUTHORITY_LOCAL_COMMANDS: readonly LocalCommandEntry[] = Object.freeze([])
