#!/usr/bin/env -S deno run -A
/// <reference lib="deno.ns" />
/// <reference lib="dom" />
import { runModules } from "./orchestrator.ts";
import type { ModuleT } from "./schema.ts";
import { glob } from "glob";
// @ts-types="npm:@types/which@^3"
import which from "which";

async function hasCmd(cmd: string): Promise<boolean> {
  try {
    await which(cmd);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(): Promise<
  "brew" | "mas" | "pacman" | "apt" | "dnf" | "yay" | "nix"
> {
  if (await hasCmd("brew")) return "brew";
  if (await hasCmd("mas")) return "mas";
  if (await hasCmd("pacman")) return "pacman";
  if (await hasCmd("yay")) return "yay";
  if (await hasCmd("apt-get")) return "apt";
  if (await hasCmd("dnf")) return "dnf";
  if (await hasCmd("nix-env")) return "nix";
  throw new Error("No supported package manager found");
}

async function discoverModules(cwd: string): Promise<ModuleT[]> {
  const pattern = "**/mod.{ts,js}";
  const files = await glob(pattern, {
    cwd,
    absolute: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
  });

  const modules: ModuleT[] = [];
  for (const file of files) {
    try {
      const mod = await import(file);
      const moduleExport = mod.default || mod;
      if (moduleExport && typeof moduleExport === "object" && "name" in moduleExport) {
        const module = moduleExport as ModuleT;
        // Store the module file path for later path resolution
        module._modulePath = file;
        modules.push(module);
      }
    } catch (err) {
      console.error(`Failed to load module ${file}:`, err);
    }
  }

  return modules;
}

async function main() {
  const args = process.argv.slice(2);

  // Check for flags
  const dryRun = args.includes("--dry-run");
  const filteredArgs = args.filter((a) => a !== "--dry-run" && a !== "--");

  // All non-flag arguments are treated as module names
  // (bunx strips -- before passing args, so we can't rely on it)
  const moduleNames = filteredArgs;

  const cwd = process.cwd();
  console.log(`Discovering modules in ${cwd}...`);

  const allModules = await discoverModules(cwd);

  if (allModules.length === 0) {
    console.log("No modules found. Make sure you have mod.ts files in your modules directory.");
    process.exit(1);
  }

  // Filter modules if specific names provided
  let modules = allModules;
  if (moduleNames.length > 0) {
    modules = allModules.filter((m) => moduleNames.includes(m.name));
    if (modules.length === 0) {
      console.error(`No modules found matching: ${moduleNames.join(", ")}`);
      console.log(`Available modules: ${allModules.map((m) => m.name).join(", ")}`);
      process.exit(1);
    }
  }

  const manager = await detectPackageManager();
  console.log(`Using package manager: ${manager}`);
  console.log(`\nRunning modules:`);
  for (const mod of modules) {
    console.log(`  - ${mod.name}${mod.tags?.length ? ` [${mod.tags.join(", ")}]` : ""}`);
  }
  console.log();

  if (dryRun) {
    console.log("Dry-run mode - skipping execution");
    return;
  }

  await runModules(modules, manager, allModules);

  console.log("\n✓ Done!");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
