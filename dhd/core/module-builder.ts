import type { ModuleDefinition, ModuleMetadata } from "./module.ts";
import type { Action } from "./action.ts";
import { PackageInstallAction, type PackageConfig } from "./actions/package.ts";
import {
	SymlinkAction,
	FileWriteAction,
	FileCopyAction,
	type SymlinkConfig,
	type FileWriteConfig,
	type FileCopyConfig,
} from "./actions/file.ts";
import { CommandAction, type CommandConfig } from "./actions/command.ts";
import { ConditionalAction, type ConditionFunction } from "./actions/conditional.ts";
import { HttpDownloadAction, type HttpDownloadConfig } from "./actions/http.ts";
import { SystemContext } from "./system-context.ts";

export class ModuleBuilder {
	private metadata: ModuleMetadata;
	private actions: Action[] = [];

	constructor(name: string) {
		this.metadata = { name };
	}

	description(desc: string): this {
		this.metadata.description = desc;
		return this;
	}

	dependsOn(...modules: string[]): this {
		this.metadata.dependencies = modules;
		return this;
	}

	tags(...tags: string[]): this {
		this.metadata.tags = tags;
		return this;
	}

	packageInstall(config: PackageConfig): this {
		this.actions.push(
			new PackageInstallAction(
				`Install ${config.packages.join(", ")} via ${config.manager}`,
				`Installing packages using ${config.manager}`,
				config,
			),
		);
		return this;
	}

	symlink(config: SymlinkConfig): this {
		this.actions.push(
			new SymlinkAction(
				`Symlink ${config.target}`,
				`Create symlink from ${config.source} to ${config.target}`,
				config,
			),
		);
		return this;
	}

	fileWrite(config: FileWriteConfig): this {
		this.actions.push(
			new FileWriteAction(
				`Write ${config.path}`,
				`Write content to ${config.path}`,
				config,
			),
		);
		return this;
	}

	fileCopy(config: FileCopyConfig): this {
		this.actions.push(
			new FileCopyAction(
				`Copy to ${config.destination}`,
				`Copy ${config.source} to ${config.destination}`,
				config,
			),
		);
		return this;
	}

	command(config: CommandConfig): this {
		this.actions.push(
			new CommandAction(
				`Run ${config.command}`,
				`Execute command: ${config.command}`,
				config,
			),
		);
		return this;
	}

	httpDownload(config: HttpDownloadConfig): this {
		this.actions.push(
			new HttpDownloadAction(
				`Download ${config.url}`,
				`Download ${config.url} to ${config.destination}`,
				config,
			),
		);
		return this;
	}

	customAction<T>(action: Action<T>): this {
		this.actions.push(action);
		return this;
	}

	when(condition: ConditionFunction): ConditionalModuleBuilder {
		return new ConditionalModuleBuilder(this, condition);
	}

	build(): ModuleDefinition {
		return {
			metadata: this.metadata,
			actions: this.actions,
		};
	}
}

export class ConditionalModuleBuilder {
	constructor(
		private parent: ModuleBuilder,
		private condition: ConditionFunction,
	) {}

	packageInstall(config: PackageConfig): ModuleBuilder {
		const action = new PackageInstallAction(
			`Install ${config.packages.join(", ")} via ${config.manager}`,
			`Installing packages using ${config.manager}`,
			config,
		);

		this.parent.customAction(
			new ConditionalAction(
				`Conditional: ${action.name}`,
				`Conditionally ${action.description}`,
				{ condition: this.condition, action },
			),
		);

		return this.parent;
	}

	symlink(config: SymlinkConfig): ModuleBuilder {
		const action = new SymlinkAction(
			`Symlink ${config.target}`,
			`Create symlink from ${config.source} to ${config.target}`,
			config,
		);

		this.parent.customAction(
			new ConditionalAction(
				`Conditional: ${action.name}`,
				`Conditionally ${action.description}`,
				{ condition: this.condition, action },
			),
		);

		return this.parent;
	}

	fileWrite(config: FileWriteConfig): ModuleBuilder {
		const action = new FileWriteAction(
			`Write ${config.path}`,
			`Write content to ${config.path}`,
			config,
		);

		this.parent.customAction(
			new ConditionalAction(
				`Conditional: ${action.name}`,
				`Conditionally ${action.description}`,
				{ condition: this.condition, action },
			),
		);

		return this.parent;
	}

	fileCopy(config: FileCopyConfig): ModuleBuilder {
		const action = new FileCopyAction(
			`Copy to ${config.destination}`,
			`Copy ${config.source} to ${config.destination}`,
			config,
		);

		this.parent.customAction(
			new ConditionalAction(
				`Conditional: ${action.name}`,
				`Conditionally ${action.description}`,
				{ condition: this.condition, action },
			),
		);

		return this.parent;
	}

	command(config: CommandConfig): ModuleBuilder {
		const action = new CommandAction(
			`Run ${config.command}`,
			`Execute command: ${config.command}`,
			config,
		);

		this.parent.customAction(
			new ConditionalAction(
				`Conditional: ${action.name}`,
				`Conditionally ${action.description}`,
				{ condition: this.condition, action },
			),
		);

		return this.parent;
	}

	httpDownload(config: HttpDownloadConfig): ModuleBuilder {
		const action = new HttpDownloadAction(
			`Download ${config.url}`,
			`Download ${config.url} to ${config.destination}`,
			config,
		);

		this.parent.customAction(
			new ConditionalAction(
				`Conditional: ${action.name}`,
				`Conditionally ${action.description}`,
				{ condition: this.condition, action },
			),
		);

		return this.parent;
	}
}

export function defineModule(name: string): ModuleBuilder {
	return new ModuleBuilder(name);
}
