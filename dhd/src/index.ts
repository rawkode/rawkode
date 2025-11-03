// Public API exports
export { defineModule, install, linkFile, runCommand } from "./api"
export { source, userPath, userConfig, systemPath, http, makePathFns } from "./paths"
export type { FileRef, PathKind } from "./paths"
export { makeCtx, evalWhen } from "./ctx"
export type { Ctx } from "./ctx"
export { runModules } from "./orchestrator"
export { plan } from "./plan"
export type { PlanOp } from "./plan"
export { execOp } from "./exec"
export type { ModuleT, ModuleStaticT, ActionT, InstallT, LinkFileT, RunCommandT, WhenPart } from "./schema"

// High-level helpers
export { user, shellIntegration } from "./helpers"
