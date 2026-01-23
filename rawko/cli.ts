#!/usr/bin/env -S deno run --allow-all
/**
 * rawko-sdk CLI
 *
 * Usage:
 *   deno run --allow-all cli.ts "your task description"
 *   deno run --allow-all cli.ts --path /path/to/project "your task"
 */

import { parseArgs } from "jsr:@std/cli/parse-args";
import { Rawko } from "./mod.ts";

interface CLIArgs {
  _: string[];
  path?: string;
  help?: boolean;
  h?: boolean;
  verbose?: boolean;
  v?: boolean;
  version?: boolean;
  "dry-run"?: boolean;
}

function printHelp(): void {
  console.log(`
rawko-sdk - LLM-based agent orchestration framework

Usage:
  rawko [options] <task>

Options:
  -p, --path <dir>      Project directory containing .rawko.ts (default: current directory)
  -v, --verbose         Enable verbose output
  --dry-run             Generate execution plan and output as JSON without executing
  -h, --help            Show this help message
  --version             Show version

Examples:
  rawko "Add a hello world function to main.ts"
  rawko --path /path/to/project "Refactor the auth module"
  rawko -v "Fix the failing tests"
  rawko --dry-run "update all packages"
`);
}

function printVersion(): void {
  console.log("rawko-sdk v0.1.0");
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["path"],
    boolean: ["help", "verbose", "version", "dry-run"],
    alias: {
      p: "path",
      h: "help",
      v: "verbose",
    },
  }) as CLIArgs;

  if (args.help || args.h) {
    printHelp();
    Deno.exit(0);
  }

  if (args.version) {
    printVersion();
    Deno.exit(0);
  }

  const task = args._.join(" ");

  if (!task) {
    console.error("Error: No task provided");
    printHelp();
    Deno.exit(1);
  }

  const verbose = args.verbose || args.v;

  if (verbose) {
    console.log(`[rawko] Task: ${task}`);
    console.log(`[rawko] Project path: ${args.path ?? "."}`);
  }

  try {
    const rawko = new Rawko({
      basePath: args.path,
      verbose,
    });

    await rawko.init();

    if (verbose) {
      const agents = rawko.getAgents();
      console.log(`[rawko] Loaded ${agents.size} agents: ${[...agents.keys()].join(", ")}`);
    }

    // Handle dry-run mode: generate plan and output as JSON
    if (args["dry-run"]) {
      if (verbose) {
        console.log("[rawko] Dry-run mode: generating execution plan...");
      }

      const planResult = await rawko.generatePlan(task);
      console.log(JSON.stringify(planResult, null, 2));

      // Exit with code 1 for low confidence plans
      Deno.exit(planResult.confidence === "low" ? 1 : 0);
    }

    console.log("\n" + "=".repeat(60));
    console.log("Starting task...");
    console.log("=".repeat(60) + "\n");

    const result = await rawko.run(task);

    console.log("\n" + "=".repeat(60));
    console.log(`Task ${result.success ? "completed" : "failed"}`);
    console.log(`Iterations: ${result.iterations}`);
    console.log(`Output: ${result.output}`);
    console.log("=".repeat(60));

    Deno.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error(`\n[rawko] Error: ${(error as Error).message}`);

    if (verbose) {
      console.error((error as Error).stack);
    }

    Deno.exit(1);
  }
}

main();
