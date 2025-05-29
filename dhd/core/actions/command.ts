import { Action, type ActionContext, type SideEffect } from "../action.ts";
import { runCommand, runPrivilegedCommand } from "../../utils/commands/mod.ts";
import { existsSync } from "node:fs";

export interface CommandConfig {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	privileged?: boolean;
	// Optional check function to determine if command needs to run
	skipIf?: () => boolean;
}

export class CommandAction extends Action<CommandConfig> {
	async plan(context: ActionContext): Promise<SideEffect[]> {
		// Check if we should skip this command
		if (this.config.skipIf && this.config.skipIf()) {
			return [];
		}

		// Special handling for mkdir --parents
		if (
			this.config.command === "mkdir" &&
			this.config.args?.includes("--parents") &&
			this.config.args.length >= 2
		) {
			// Get the directory path (last argument)
			const dirPath = this.config.args[this.config.args.length - 1];
			if (existsSync(dirPath)) {
				// Directory already exists, no need to create
				return [];
			}
		}

		const fullCommand = [this.config.command, ...(this.config.args || [])].join(
			" ",
		);
		return [
			{
				type: "command_run",
				description: `Run command: ${fullCommand}`,
				target: this.config.command,
				metadata: {
					args: this.config.args,
					cwd: this.config.cwd,
					env: this.config.env,
					requiresElevation: this.config.privileged,
				},
				requiresElevation: this.config.privileged,
			},
		];
	}

	async apply(context: ActionContext): Promise<void> {
		if (context.dryRun) return;

		const options = {
			cwd: this.config.cwd,
			env: this.config.env,
			verbose: context.verbose,
			onOutput: context.eventEmitter && context.currentModule ? 
				(data: string) => context.eventEmitter!.emit('moduleOutput', context.currentModule, data) : 
				undefined,
			onError: context.eventEmitter && context.currentModule ? 
				(data: string) => context.eventEmitter!.emit('moduleOutput', context.currentModule, data) : 
				undefined,
		};

		if (this.config.privileged) {
			await runPrivilegedCommand(
				this.config.command,
				this.config.args || [],
				options,
			);
		} else {
			await runCommand(this.config.command, this.config.args || [], options);
		}
	}
}
