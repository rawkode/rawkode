/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// Public API exports
export {
  defaults,
  defineModule,
  install,
  launchd,
  linkFile,
  loginItem,
  runCommand,
} from "./api.ts";
export { http, makePathFns, source, systemPath, userConfig, userPath } from "./paths.ts";
export type { FileRef, PathKind } from "./paths.ts";
export { evalWhen, makeCtx } from "./ctx.ts";
export type { Ctx } from "./ctx.ts";
export { runModules } from "./orchestrator.ts";
export { plan } from "./plan.ts";
export type { PlanOp } from "./plan.ts";
export { execOp } from "./exec.ts";
export type {
  ActionT,
  DefaultsT,
  InstallT,
  LaunchdT,
  LinkFileT,
  LoginItemT,
  ModuleStaticT,
  ModuleT,
  RunCommandT,
  WhenPart,
} from "./schema.ts";

// High-level helpers
export { shellIntegration, user } from "./helpers.ts";

// macOS helpers
export { dock, finder, keyboard, missionControl, screenSaver, trackpad } from "./helpers/macos.ts";
export type {
  DockOptions,
  FinderOptions,
  HotCornerAction,
  KeyboardOptions,
  MissionControlOptions,
  ScreenSaverOptions,
  TrackpadOptions,
} from "./helpers/macos.ts";
