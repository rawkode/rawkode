#!/usr/bin/env bun

import { join } from "path";
import { loadConfig, findConfig, CONFIG_TEMPLATE, GITHUB_CONFIG_TEMPLATE } from "./config/index.ts";
import { readState, clearState } from "./state/index.ts";
import { run } from "./runner/index.ts";
import { isGitRepo, getCurrentBranch } from "./git/index.ts";
import {
  loadPhases,
  phasesExist,
  getPhasesDir,
  createDefaultPhases,
  NoPhaseConfiguredError,
} from "./phases/index.ts";

const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`
rocko - A portable, extensible PLAN -> BUILD -> REVIEW agent

Usage:
  rocko <command> [options]

Commands:
  run           Run the agent (default)
  init          Create config file and default phases
  status        Show current state and progress
  clean         Clear the current state
  phases        Phase management commands
    phases list   Show loaded phases and their transitions

Options:
  --max-iterations <n>   Max PLAN->BUILD->REVIEW cycles (default: from config)
  --dry-run              Skip git commits and GitHub updates
  --verbose, -v          Enable debug logging
  --help, -h             Show this help message
  --version              Show version

Examples:
  rocko run                    Run with default settings
  rocko run --max-iterations 3 Run for 3 iterations max
  rocko run --dry-run          Run without committing
  rocko init                   Create config file and phases
  rocko status                 Show current progress
  rocko phases list            Show phase configuration
`);
}

function printVersion(): void {
  console.log(`rocko v${VERSION}`);
}

interface ParsedArgs {
  command: string;
  subcommand?: string;
  maxIterations?: number;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  adapterType?: "markdown" | "github";
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: "run",
    dryRun: false,
    verbose: false,
    help: false,
    version: false,
  };

  let foundCommand = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--version") {
      result.version = true;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--verbose" || arg === "-v") {
      result.verbose = true;
    } else if (arg === "--max-iterations") {
      const value = args[++i];
      if (value) {
        result.maxIterations = parseInt(value, 10);
      }
    } else if (arg === "--github") {
      result.adapterType = "github";
    } else if (!arg.startsWith("-")) {
      if (!foundCommand) {
        result.command = arg;
        foundCommand = true;
      } else if (!result.subcommand) {
        result.subcommand = arg;
      }
    }
  }

  return result;
}

async function runCommand(args: ParsedArgs): Promise<void> {
  if (!(await isGitRepo())) {
    console.error("Error: Not a git repository. rocko must be run in a git repo.");
    process.exit(1);
  }

  // Check if phases are configured
  if (!(await phasesExist())) {
    console.error("Error: No phases configured. Run `rocko init` to create default phases.");
    process.exit(1);
  }

  const config = await loadConfig();

  if (args.maxIterations) {
    config.maxIterations = args.maxIterations;
  }

  const branch = await getCurrentBranch();
  console.log(`rocko starting on branch: ${branch}`);
  console.log(`   Max iterations: ${config.maxIterations}`);
  console.log(`   Adapter: ${config.adapter.type}`);
  if (args.dryRun) {
    console.log(`   Mode: DRY RUN (no commits)`);
  }
  console.log("");

  try {
    const result = await run({
      config,
      dryRun: args.dryRun,
      verbose: args.verbose,
    });

    console.log("");
    if (result.success) {
      console.log(`Rocko completed successfully!`);
      console.log(`   Iterations: ${result.iterations}`);
      console.log(`   Tasks completed: ${result.tasksCompleted.length}`);
      if (result.tasksCompleted.length > 0) {
        console.log("   Tasks:");
        for (const task of result.tasksCompleted) {
          console.log(`     - ${task.title}`);
        }
      }
    } else {
      console.error(`Rocko encountered an error: ${result.error}`);
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof NoPhaseConfiguredError) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

async function initCommand(args: ParsedArgs): Promise<void> {
  const configPath = await findConfig();
  const phasesDir = getPhasesDir();
  const hasPhases = await phasesExist();

  let createdConfig = false;
  let createdPhases = false;

  // Create config file if it doesn't exist
  if (!configPath) {
    const template = args.adapterType === "github" ? GITHUB_CONFIG_TEMPLATE : CONFIG_TEMPLATE;
    const filename = "rocko.config.ts";

    await Bun.write(join(process.cwd(), filename), template);
    console.log(`Created ${filename}`);
    createdConfig = true;
  } else {
    console.log(`Config file already exists at ${configPath}`);
  }

  // Create phases directory and default phases if they don't exist
  if (!hasPhases) {
    await createDefaultPhases(phasesDir);
    console.log(`Created default phases in ${phasesDir}/`);
    createdPhases = true;
  } else {
    console.log(`Phases already exist in ${phasesDir}/`);
  }

  if (createdConfig || createdPhases) {
    console.log("");
    console.log("Next steps:");
    if (createdConfig) {
      console.log("  1. Edit rocko.config.ts to configure your adapter");
      if (args.adapterType === "github") {
        console.log("  2. Set GITHUB_TOKEN environment variable");
        console.log("  3. Update owner and repo in the config");
      } else {
        console.log("  2. Create a TASKS.md file with your tasks");
      }
    }
    if (createdPhases) {
      console.log("  - Customize phases in .rocko/phases/ as needed");
    }
    console.log("  - Run `rocko run` to start");
  }
}

async function statusCommand(): Promise<void> {
  const state = await readState();

  if (!state) {
    console.log("No active rocko session found.");
    console.log("Run `rocko run` to start a new session.");
    return;
  }

  console.log("Rocko Status");
  console.log("");
  console.log(`  Phase: ${state.currentPhase}`);
  console.log(`  Iteration: ${state.iteration} / ${state.maxIterations}`);

  if (state.task) {
    console.log("");
    console.log("  Current Task:");
    console.log(`    ID: ${state.task.id}`);
    console.log(`    Title: ${state.task.title}`);
    console.log(`    Source: ${state.task.source}`);
  }

  if (state.error) {
    console.log("");
    console.log(`  Error: ${state.error}`);
  }

  console.log("");
  console.log(`  Started: ${state.startedAt}`);
  console.log(`  Updated: ${state.updatedAt}`);

  if (state.history.length > 0) {
    console.log("");
    console.log("  Recent History:");
    const recentHistory = state.history.slice(-5);
    for (const entry of recentHistory) {
      console.log(`    - [${entry.phase}] ${entry.event}`);
    }
  }
}

async function cleanCommand(): Promise<void> {
  await clearState();
  console.log("State cleared. Ready for a fresh run.");
}

async function phasesListCommand(verbose: boolean): Promise<void> {
  const hasPhases = await phasesExist();

  if (!hasPhases) {
    console.log("No phases configured.");
    console.log("Run `rocko init` to create default phases.");
    return;
  }

  try {
    const graph = await loadPhases();

    console.log("Loaded Phases");
    console.log("");

    // Display phases in a graph-like format
    for (const [phaseId, phase] of graph.phases) {
      const markers: string[] = [];
      if (phase.initial) markers.push("initial");
      if (phase.final) markers.push("final");

      const markerStr = markers.length > 0 ? ` (${markers.join(", ")})` : "";

      console.log(`  ${phase.name} [${phaseId}]${markerStr}`);
      console.log(`    File: ${phase.filePath}`);

      if (phase.transitions.length > 0) {
        console.log("    Transitions:");
        for (const transition of phase.transitions) {
          const condition = transition.when ? ` when: ${transition.when}` : "";
          console.log(`      -> ${transition.target} (${transition.event})${condition}`);
        }
      }

      if (verbose) {
        if (phase.ai) {
          console.log(`    AI Config: maxTurns=${phase.ai.maxTurns}${phase.ai.model ? `, model=${phase.ai.model}` : ""}`);
        }
        if (phase.systemPrompt) {
          const preview = phase.systemPrompt.slice(0, 60).replace(/\n/g, " ");
          console.log(`    System Prompt: ${preview}...`);
        }
      }

      console.log("");
    }

    // Show graph summary
    console.log("Graph Summary:");
    console.log(`  Total phases: ${graph.phases.size}`);
    console.log(`  Initial phase: ${graph.initialPhaseId}`);
    console.log(`  Final phases: ${graph.finalPhaseIds.join(", ")}`);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error loading phases: ${error.message}`);
    } else {
      console.error("Error loading phases");
    }
    process.exit(1);
  }
}

async function phasesCommand(args: ParsedArgs): Promise<void> {
  const subcommand = args.subcommand ?? "list";

  switch (subcommand) {
    case "list":
      await phasesListCommand(args.verbose);
      break;
    default:
      console.error(`Unknown phases subcommand: ${subcommand}`);
      console.log("Available subcommands: list");
      process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (args.version) {
    printVersion();
    return;
  }

  try {
    switch (args.command) {
      case "run":
        await runCommand(args);
        break;
      case "init":
        await initCommand(args);
        break;
      case "status":
        await statusCommand();
        break;
      case "clean":
        await cleanCommand();
        break;
      case "phases":
        await phasesCommand(args);
        break;
      default:
        console.error(`Unknown command: ${args.command}`);
        printHelp();
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
      if (args.verbose) {
        console.error(error.stack);
      }
    } else {
      console.error("An unexpected error occurred");
    }
    process.exit(1);
  }
}

main();
