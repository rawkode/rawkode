import { evalWhen, makeCtx } from "./ctx.ts";
import type { ModuleT } from "./schema.ts";
import { plan, type PlanOp } from "./plan.ts";
import { execOp } from "./exec.ts";
import path from "node:path";

async function validateSudoAccess(ops: PlanOp[]) {
  // Check if any operations need sudo
  const needsSudo = ops.some((op) => op.op === "runCommand" && op.sudo);

  if (needsSudo) {
    console.log(
      "Some operations require sudo privileges. Validating access...",
    );

    // Run sudo -v to prompt for password and cache credentials
    const command = new Deno.Command("sudo", {
      args: ["-v"],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    const { code } = await command.output();

    if (code !== 0) {
      throw new Error("Failed to validate sudo access");
    }

    console.log("Sudo access validated.\n");
  }
}

export async function runModules(
  mods: ModuleT[],
  manager: "brew" | "mas" | "pacman" | "apt" | "dnf" | "yay" | "nix",
  allModules?: ModuleT[],
) {
  const ctx = makeCtx();
  const queue: ModuleT[] = [];
  const seen = new Set<string>();
  // Use allModules for dependency lookup if provided, otherwise use mods
  const moduleRegistry = allModules || mods;
  async function visit(m: ModuleT) {
    if (seen.has(m.name)) return;
    seen.add(m.name);
    for (const d of m.dependsOn) {
      const dep = moduleRegistry.find((x) => x.name === d);
      if (dep) await visit(dep);
    }
    if (await evalWhen(m.when, ctx)) queue.push(m);
  }
  for (const m of mods) await visit(m);

  // Plan all operations first
  const allOps: PlanOp[] = [];
  for (const m of queue) {
    const moduleDir = m._modulePath ? path.dirname(m._modulePath) : undefined;
    const ops = plan(m.actions, manager, moduleDir);
    allOps.push(...ops);
  }

  // Validate sudo access upfront if needed
  await validateSudoAccess(allOps);

  // Execute all operations
  for (const op of allOps) {
    await execOp(op);
  }
}
