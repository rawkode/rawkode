import { z } from "zod"

export const Install = z.object({
  type: z.literal("install"),
  packages: z.array(
    z.object({
      default: z.string(),
      brew: z.string().optional(),
      pacman: z.string().optional(),
      apt: z.string().optional(),
      dnf: z.string().optional(),
      yay: z.string().optional(),
      nix: z.string().optional(),
    }).strict()
  ).min(1),
}).strict()

// Source can be either resolved (path) or unresolved (relativePath)
const SourceRef = z.object({
  kind: z.literal("Source"),
  path: z.string().optional(),
  relativePath: z.string().optional(),
}).strict().refine(
  data => (data.path && !data.relativePath) || (!data.path && data.relativePath),
  { message: "Source must have either path or relativePath, not both" }
)

const FileRef = z.union([
  SourceRef,
  z.object({ kind: z.literal("User"),   path: z.string() }).strict(),
  z.object({ kind: z.literal("System"), path: z.string() }).strict(),
  z.object({
    kind: z.literal("Http"),
    url: z.string().url(),
    integrity: z.string().regex(/^sha256-[0-9a-fA-F]{64}$/).optional(),
  }).strict(),
])

export const LinkFile = z.object({
  type: z.literal("linkFile"),
  source: FileRef,
  target: FileRef.refine(f => f.kind === "User", {
    message: "linkFile.target must be a User path",
  }),
  force: z.boolean().default(false),
  description: z.string().optional(),
}).strict()

export const RunCommand = z.object({
  type: z.literal("runCommand"),
  command: z.string(),
  description: z.string().optional(),
  sudo: z.boolean().default(false),
}).strict()

export const ModuleStatic = z.object({
  name: z.string(),
  tags: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
}).strict()

export type InstallT = z.infer<typeof Install>
export type LinkFileT = z.infer<typeof LinkFile>
export type RunCommandT = z.infer<typeof RunCommand>
export type ActionT = InstallT | LinkFileT | RunCommandT
export type ModuleStaticT = z.infer<typeof ModuleStatic>

export type WhenPart =
  | { platformIn?: Array<"linux" | "darwin" | "win32"> }
  | ((ctx: import("./ctx").Ctx) => boolean | Promise<boolean>)

export type ModuleT = ModuleStaticT & {
  when?: WhenPart | WhenPart[]
  actions: ActionT[]
  _modulePath?: string  // Internal: set by CLI during discovery
}
