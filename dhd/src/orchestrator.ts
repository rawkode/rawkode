import { evalWhen, makeCtx } from "./ctx"
import type { ModuleT } from "./schema"
import { plan, type PlanOp } from "./plan"
import { execOp } from "./exec"
import path from "node:path"

async function validateSudoAccess(ops: PlanOp[]) {
  // Check if any operations need sudo
  const needsSudo = ops.some(op => op.op === "runCommand" && op.sudo)

  if (needsSudo) {
    console.log("Some operations require sudo privileges. Validating access...")

    // Run sudo -v to prompt for password and cache credentials
    const proc = Bun.spawn({
      cmd: ["sudo", "-v"],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit"
    })
    const code = await proc.exited

    if (code !== 0) {
      throw new Error("Failed to validate sudo access")
    }

    console.log("Sudo access validated.\n")
  }
}

export async function runModules(mods: ModuleT[], manager: "brew"|"pacman"|"apt"|"dnf"|"yay"|"nix") {
  const ctx = makeCtx()
  const queue: ModuleT[] = []
  const seen = new Set<string>()
  async function visit(m: ModuleT) {
    if (seen.has(m.name)) return
    seen.add(m.name)
    for (const d of m.dependsOn) {
      const dep = mods.find(x => x.name === d)
      if (dep) await visit(dep)
    }
    if (await evalWhen(m.when, ctx)) queue.push(m)
  }
  for (const m of mods) await visit(m)

  // Plan all operations first
  const allOps: PlanOp[] = []
  for (const m of queue) {
    const moduleDir = m._modulePath ? path.dirname(m._modulePath) : undefined
    const ops = plan(m.actions, manager, moduleDir)
    allOps.push(...ops)
  }

  // Validate sudo access upfront if needed
  await validateSudoAccess(allOps)

  // Execute all operations
  for (const op of allOps) {
    await execOp(op)
  }
}
