import type { ActionT } from "./schema"
import type { Ctx } from "./ctx"
import { resolveSourcePath } from "./paths"
import crypto from "node:crypto"
import path from "node:path"
import os from "node:os"

export type PlanOp =
  | { op: "install"; manager: "brew"|"pacman"|"apt"|"dnf"|"yay"|"nix"; pkg: string }
  | { op: "download"; url: string; dest: string; integrity?: `sha256-${string}` }
  | { op: "link"; src: string; dst: string; overwrite: boolean }
  | { op: "runCommand"; command: string; description?: string; sudo: boolean }

const CACHE = path.join(os.homedir(), ".cache", "dotfiles", "http")

function resolvePkg(p: any, mgr: string) { return p[mgr] ?? p.default }

export function plan(
  actions: ActionT[],
  mgr: "brew"|"pacman"|"apt"|"dnf"|"yay"|"nix",
  moduleDir?: string
): PlanOp[] {
  const ops: PlanOp[] = []
  for (const a of actions) {
    if (a.type === "install") {
      for (const p of a.packages) ops.push({ op: "install", manager: mgr, pkg: resolvePkg(p, mgr) })
    } else if (a.type === "linkFile") {
      // Resolve Source paths if we have a moduleDir
      let source = a.source
      if (source.kind === "Source" && moduleDir) {
        source = resolveSourcePath(source, moduleDir)
      }

      if (source.kind === "Http") {
        const key = crypto.createHash("sha256").update(source.url).digest("hex").slice(0, 16)
        const dest = path.join(CACHE, key)
        ops.push({ op: "download", url: source.url, dest, integrity: source.integrity })
        ops.push({ op: "link", src: dest, dst: a.target.path, overwrite: a.force })
      } else {
        if (!source.path) {
          throw new Error(`Source path not resolved for ${JSON.stringify(source)}`)
        }
        ops.push({ op: "link", src: source.path, dst: a.target.path, overwrite: a.force })
      }
    } else if (a.type === "runCommand") {
      ops.push({ op: "runCommand", command: a.command, description: a.description, sudo: a.sudo })
    }
  }
  return ops
}
