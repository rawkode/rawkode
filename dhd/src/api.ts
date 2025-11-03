import { z } from "zod"
import { Install, LinkFile, RunCommand, ModuleStatic, type ModuleT } from "./schema"
import type { FileRef } from "./paths"

// Re-export path helpers so they're available when importing from api
export { source, userPath, userConfig, systemPath, http } from "./paths"
export type { PathKind } from "./paths"

export function install(
  pkg: string | string[],
  perManager?: Partial<Record<"brew"|"pacman"|"apt"|"dnf"|"yay"|"nix", string>>
) {
  const list = Array.isArray(pkg) ? pkg : [pkg]
  return Install.parse({
    type: "install",
    packages: list.map(name => ({ default: name, ...perManager })),
  })
}

export function linkFile(input: {
  source: FileRef
  target: FileRef
  force?: boolean
  description?: string
}) {
  return LinkFile.parse({ type: "linkFile", ...input })
}

export function runCommand(
  command: string,
  options?: { description?: string; sudo?: boolean }
) {
  return RunCommand.parse({
    type: "runCommand",
    command,
    description: options?.description,
    sudo: options?.sudo ?? false,
  })
}

export function defineModule(base: z.input<typeof ModuleStatic> & { when?: import("./schema").WhenPart | import("./schema").WhenPart[] }) {
  // Extract only ModuleStatic fields for parsing (exclude 'when')
  const { name, tags, dependsOn } = base
  const stat = ModuleStatic.parse({ name, tags, dependsOn })
  return {
    actions(list: unknown[]): ModuleT {
      // validate individual actions via discriminators
      const parsed = list.map(a => {
        if (typeof a !== "object" || !a) throw new Error("Invalid action")
        // Already parsed by builders; trust here for POC
        return a as any
      })
      return { ...stat, when: base.when, actions: parsed }
    },
  }
}
