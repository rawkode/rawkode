#!/usr/bin/env bun
import meow from "meow";
import path from "node:path";
import { FileSystemModuleLoader } from "./core/module-loader.ts";
import { ModuleDAG } from "./core/dag.ts";
import { ModuleExecutor } from "./core/executor.ts";
import { InkSimpleVisualizer, InkInteractiveTUIVisualizer } from "./core/ink/index.ts";
import type { ActionContext } from "./core/action.ts";
import { registerCoreActions } from "./core/actions/index.ts";
import { initSudoCache } from "./utils/commands/mod.ts";
import { systemContext } from "./core/system-context.ts";
import chalk from "chalk";

export interface CLIOptions {
	basePath?: string;
}

export async function runCLI(options: CLIOptions = {}) {
	registerCoreActions();

	const cli = meow(
		`
	  Usage
	    $ dhd <command> [options] [modules...]

	  Commands
	    plan      Show what changes would be made
	    apply     Apply the changes
	    list      List available modules

	  Options
	    --verbose, -v    Show detailed output
	    --tui            Use interactive TUI for execution
	    --dry-run        Don't make any changes (same as plan)
	    --help           Show this help
	    --version        Show version

	  Examples
	    $ dhd plan
	    $ dhd apply
	    $ dhd plan nushell
	    $ dhd apply command-line/git desktop/firefox
`,
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
			},
		},
	);

	const command = cli.input[0];
	const targetModules = cli.input.slice(1);

	if (!command || command === "help") {
		cli.showHelp();
		return;
	}

	const loader = new FileSystemModuleLoader();
	const basePath = options.basePath || process.cwd();

	try {
		const modules = await loader.discover(basePath);

		if (command === "list") {
			console.log(chalk.bold.blue("\n📦 Available modules:\n"));
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

		const dag = new ModuleDAG();
		for (const module of modules) {
			dag.addModule(module);
		}
		dag.build();

		let filteredDag = dag;
		if (targetModules.length > 0) {
			filteredDag = dag.filter((module) => {
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
	} finally {
		// Shutdown telemetry if initialized
		if (cli.flags.otel) {
			const { getTelemetry } = await import("./core/telemetry.ts");
			try {
				await getTelemetry().shutdown();
			} catch {}
		}
	}
}

// Run CLI if called directly
if (import.meta.main) {
	runCLI().catch((error) => {
		console.error(chalk.red("Fatal error:"), error);
		process.exit(1);
	});
}