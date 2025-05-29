#!/usr/bin/env bun
import meow, { type Options as MeowOptions } from "meow";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleDAG } from "../dag.ts";
import { ModuleExecutor } from "../executor.ts";
import { InkSimpleVisualizer, InkInteractiveTUIVisualizer } from "../ink/index.ts";
import type { ActionContext } from "../action.ts";
import { registerCoreActions } from "../actions/index.ts";
import { initSudoCache } from "../../utils/commands/mod.ts";
import { systemContext } from "../system-context.ts";
import chalk from "chalk";
import { StandaloneModuleLoader } from "./standalone-loader.ts";
import type { Module } from "../module.ts";

export interface StandaloneOptions {
  // The name of the CLI tool
  name: string;
  // The CLI description
  description?: string;
  // The version of the CLI
  version?: string;
  // Additional meow options
  meowOptions?: Partial<MeowOptions<any>>;
  // Custom module filter function
  moduleFilter?: (module: Module, targets: string[]) => boolean;
  // Custom help text
  helpText?: string;
  // Whether to register core actions (default: true)
  registerActions?: boolean;
  // Additional CLI commands
  additionalCommands?: {
    [command: string]: (
      cli: any,
      modules: Module[],
      context: ActionContext
    ) => Promise<void>;
  };
}

export function createStandaloneCLI(
  registry: any,
  modulePaths: string[],
  options: StandaloneOptions
) {
  const {
    name,
    description = `${name} - DHD-based configuration manager`,
    version = "1.0.0",
    meowOptions = {},
    moduleFilter,
    helpText,
    registerActions = true,
    additionalCommands = {},
  } = options;

  // Register core actions if requested
  if (registerActions) {
    registerCoreActions();
  }

  // Get the directory of this script
  const __filename = import.meta.url.startsWith('file://') 
    ? fileURLToPath(import.meta.url)
    : process.argv[1];
  const __dirname = path.dirname(__filename);

  const defaultHelp = `
  Usage
    $ ${name} <command> [options] [modules...]

  Commands
    plan      Show what changes would be made
    apply     Apply the changes
    list      List available modules
    ${Object.keys(additionalCommands).join("\n    ")}

  Options
    --verbose, -v    Show detailed output
    --tui            Use interactive TUI for execution
    --dry-run        Don't make any changes (same as plan)
    --help           Show this help
    --version        Show version

  Examples
    $ ${name} plan
    $ ${name} apply
    $ ${name} plan module1
    $ ${name} apply module1 module2
`;

  const cli = meow(
    helpText || defaultHelp,
    {
      importMeta: import.meta,
      flags: {
        verbose: {
          type: "boolean",
          shortFlag: "v",
        },
        tui: {
          type: "boolean",
        },
        dryRun: {
          type: "boolean",
        },
        ...((meowOptions.flags || {}) as any),
      },
      ...meowOptions,
    },
  );

  async function main() {
    const command = cli.input[0];
    const targetModules = cli.input.slice(1);

    if (!command || command === "help") {
      cli.showHelp();
      return;
    }

    // Use our standalone loader with absolute paths if available
    const absolutePaths = (globalThis as any).MODULE_ABSOLUTE_PATHS;
    const loader = new StandaloneModuleLoader(__dirname, registry, modulePaths, absolutePaths);

    try {
      const modules = await loader.discover(__dirname);

      if (command === "list") {
        console.log(chalk.bold.blue(`\n📦 Available ${name} modules:\n`));
        for (const module of modules) {
          console.log(`  ${chalk.yellow(module.name)}`);
          if (module.definition.metadata.description) {
            console.log(
              `    ${chalk.gray(module.definition.metadata.description)}`,
            );
          }
          if (module.dependencies.length > 0) {
            console.log(
              `    ${chalk.cyan("Dependencies:")} ${module.dependencies.join(", ")}`,
            );
          }
        }
        return;
      }

      // Check for additional commands
      if (additionalCommands[command]) {
        const sysCtx = await systemContext.getContext();
        const context: ActionContext = {
          dryRun: cli.flags.dryRun || false,
          verbose: cli.flags.verbose || false,
          system: sysCtx,
        };
        await additionalCommands[command](cli, modules, context);
        return;
      }

      const dag = new ModuleDAG();
      for (const module of modules) {
        dag.addModule(module);
      }
      dag.build();

      let filteredDag = dag;
      if (targetModules.length > 0) {
        filteredDag = dag.filter((module) => {
          if (moduleFilter) {
            return moduleFilter(module, targetModules);
          }
          // Default filter
          return targetModules.some((target) => {
            return (
              module.name === target ||
              module.path.includes(target) ||
              module.definition.metadata.tags?.includes(target)
            );
          });
        });
      }

      const sysCtx = await systemContext.getContext();

      const context: ActionContext = {
        dryRun: command === "plan" || cli.flags.dryRun,
        verbose: cli.flags.verbose,
        system: sysCtx,
      };

      const executor = new ModuleExecutor(filteredDag);
      const visualizer = new InkSimpleVisualizer(cli.flags.verbose);

      if (command === "plan" || command === "apply") {
        executor.on("groupStart", (modules) => visualizer.onGroupStart(modules));
        executor.on("moduleStart", (module) => visualizer.onModuleStart(module));
        executor.on("moduleComplete", (module) =>
          visualizer.onModuleComplete(module),
        );
        executor.on("moduleError", (module, error) =>
          visualizer.onModuleError(module, error),
        );
        executor.on("groupComplete", (modules) =>
          visualizer.onGroupComplete(modules),
        );

        if (command === "plan") {
          const effects = await executor.plan(context);
          visualizer.showPlan(effects);

          // Check if any effects require elevation
          const allEffects = Array.from(effects.values()).flat();
          if (allEffects.length > 0) {
            const requiresElevation = allEffects.some((effect) => effect.requiresElevation);
            if (requiresElevation) {
              console.log(
                chalk.yellow("\n⚠️  This plan requires elevated privileges"),
              );
            }
          }
        } else {
          const effects = await executor.plan(context);

          // Check if there are any effects to apply
          const allEffects = Array.from(effects.values()).flat();
          if (allEffects.length === 0) {
            console.log(chalk.green("\n✓ Nothing to do - all modules are up to date\n"));
            return;
          }

          // Check if any effects require elevation
          const requiresElevation = allEffects.some((effect) => effect.requiresElevation);

          // Show plan first (only for non-TUI mode)
          if (!cli.flags.tui) {
            visualizer.showPlan(effects);
          }

          // Initialize sudo cache if needed
          if (requiresElevation) {
            if (!cli.flags.tui) {
              console.log(chalk.yellow("\n⚠️  This will require elevated privileges"));
            }
            await initSudoCache(!cli.flags.tui);
          }

          if (!cli.flags.tui) {
            console.log(chalk.bold.blue("\n🔄 Applying changes...\n"));
          }
          
          if (cli.flags.tui) {
            // Remove the basic visualizer event handlers
            executor.removeAllListeners();
            
            // Clear the screen before starting TUI
            console.clear();
            
            // Use TUI visualizer for better output handling
            const tuiVisualizer = new InkInteractiveTUIVisualizer(cli.flags.verbose);
            
            // Connect TUI events
            executor.on("groupStart", (modules) => tuiVisualizer.onGroupStart(modules));
            executor.on("moduleStart", (module) => tuiVisualizer.onModuleStart(module));
            executor.on("moduleComplete", (module) => tuiVisualizer.onModuleComplete(module));
            executor.on("moduleError", (module, error) => tuiVisualizer.onModuleError(module, error));
            executor.on("moduleOutput", (moduleName, data) => tuiVisualizer.onModuleOutput(moduleName, data));
            executor.on("moduleNeedsInput", (moduleName) => tuiVisualizer.onModuleNeedsInput(moduleName));
            executor.on("groupComplete", (modules) => tuiVisualizer.onGroupComplete(modules));
            
            // Start the TUI
            tuiVisualizer.start();
            
            try {
              await executor.apply(context, effects);
              // Keep the process alive - the TUI footer already shows the quit instruction
              await new Promise(() => {}); // This will keep running until user presses 'q'
            } catch (error) {
              tuiVisualizer.cleanup();
              console.error(chalk.bold.red("\n❌ Execution failed:"), error);
              throw error;
            }
          } else {
            // Use the old visualizer
            await executor.apply(context, effects);
            visualizer.showSummary(true);
          }
        }
      } else {
        console.error(chalk.red(`Unknown command: ${command}`));
        cli.showHelp();
      }
    } catch (error) {
      console.error(chalk.red("\n❌ Error:"), error);
      process.exit(1);
    }
  }

  return main().catch((error) => {
    console.error(chalk.red("Fatal error:"), error);
    process.exit(1);
  });
}