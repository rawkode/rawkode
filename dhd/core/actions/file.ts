import { Action, type ActionContext, type SideEffect } from "../action.ts";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

export interface SymlinkConfig {
	source: string;
	target: string;
	force?: boolean;
}

export class SymlinkAction extends Action<SymlinkConfig> {
	private resolveSource(source: string, moduleDir?: string): string {
		// If source is already absolute, return as-is
		if (source.startsWith("/")) {
			return source;
		}
		// If we have a module directory and source is relative, resolve it
		if (moduleDir && !source.startsWith("~")) {
			const resolved = path.join(moduleDir, source);
			// In bundled environments, we trust that the module directory is correct
			// and skip the existence check since the file might not be accessible
			// from the bundled context
			return resolved;
		}
		return source;
	}

	async plan(context: ActionContext): Promise<SideEffect[]> {
		const home = import.meta.env.HOME;
		const targetPath = this.config.target.startsWith("~")
			? this.config.target.replace("~", home)
			: this.config.target.startsWith("/")
				? this.config.target
				: `${home}/${this.config.target}`;

		const resolvedSource = this.resolveSource(
			this.config.source,
			context.moduleDir,
		);

		// Check if symlink already exists and points to the correct source
		try {
			const fs = await import("node:fs");
			const stats = fs.lstatSync(targetPath);
			if (stats.isSymbolicLink()) {
				const currentTarget = fs.readlinkSync(targetPath);
				if (currentTarget === resolvedSource) {
					// Symlink already exists and points to the correct source
					return [];
				}
			}
		} catch (error) {
			// File doesn't exist, need to create symlink
		}

		return [
			{
				type: "symlink_create",
				description: `Create symlink ${targetPath} -> ${resolvedSource}`,
				target: targetPath,
				metadata: {
					source: resolvedSource,
					force: this.config.force,
				},
			},
		];
	}

	async apply(context: ActionContext): Promise<void> {
		if (context.dryRun) return;

		const home = import.meta.env.HOME;
		const target = this.config.target.startsWith("~")
			? this.config.target.substring(2) // Remove ~/ prefix
			: this.config.target.startsWith("/")
				? this.config.target
				: this.config.target;

		const resolvedSource = this.resolveSource(
			this.config.source,
			context.moduleDir,
		);

		ensureHomeSymlink(resolvedSource, target, { force: this.config.force });
	}
}

export interface FileWriteConfig {
	path: string;
	content: string | Uint8Array;
	mode?: number;
}

export class FileWriteAction extends Action<FileWriteConfig> {
	async plan(context: ActionContext): Promise<SideEffect[]> {
		const exists = existsSync(this.config.path);
		return [
			{
				type: exists ? "file_modify" : "file_create",
				description: `${exists ? "Modify" : "Create"} file ${this.config.path}`,
				target: this.config.path,
				metadata: {
					mode: this.config.mode,
				},
			},
		];
	}

	async apply(context: ActionContext): Promise<void> {
		if (context.dryRun) return;

		const dir = path.dirname(this.config.path);
		mkdirSync(dir, { recursive: true });

		if (typeof this.config.content === "string") {
			writeFileSync(this.config.path, this.config.content);
		} else {
			writeFileSync(this.config.path, this.config.content);
		}

		if (this.config.mode) {
			const fs = await import("node:fs");
			fs.chmodSync(this.config.path, this.config.mode);
		}
	}
}

export interface FileCopyConfig {
	source: string;
	destination: string;
	mode?: number;
	privileged?: boolean;
}

export class FileCopyAction extends Action<FileCopyConfig> {
	private resolveSource(source: string, moduleDir?: string): string {
		// If source is already absolute, return as-is
		if (source.startsWith("/")) {
			return source;
		}
		// If we have a module directory and source is relative, resolve it
		if (moduleDir && !source.startsWith("~")) {
			return path.join(moduleDir, source);
		}
		return source;
	}

	async plan(context: ActionContext): Promise<SideEffect[]> {
		const resolvedSource = this.resolveSource(
			this.config.source,
			context.moduleDir,
		);
		const exists = existsSync(this.config.destination);

		// If destination exists, check if it's identical to source
		if (exists && existsSync(resolvedSource)) {
			try {
				const sourceContent = readFileSync(resolvedSource);
				const destContent = readFileSync(this.config.destination);
				if (sourceContent.equals(destContent)) {
					// Files are identical, no need to copy
					return [];
				}
			} catch (error) {
				// If we can't read files, assume they need to be copied
			}
		}

		return [
			{
				type: exists ? "file_modify" : "file_create",
				description: `Copy ${resolvedSource} to ${this.config.destination}`,
				target: this.config.destination,
				metadata: {
					source: resolvedSource,
					mode: this.config.mode,
					requiresElevation: this.config.privileged,
				},
				requiresElevation: this.config.privileged,
			},
		];
	}

	async apply(context: ActionContext): Promise<void> {
		if (context.dryRun) return;

		const resolvedSource = this.resolveSource(
			this.config.source,
			context.moduleDir,
		);

		if (this.config.privileged) {
			// Use sudo to copy the file
			const { runPrivilegedCommand } = await import("../../utils/commands/mod.ts");
			const tempFile = `/tmp/rawkos-copy-${Date.now()}`;
			
			// Copy to temp location first
			writeFileSync(tempFile, readFileSync(resolvedSource));
			
			// Create directory with sudo if needed
			const dir = path.dirname(this.config.destination);
			await runPrivilegedCommand("mkdir", ["-p", dir], { verbose: context.verbose });
			
			// Copy with sudo
			await runPrivilegedCommand("cp", [tempFile, this.config.destination], { verbose: context.verbose });
			
			// Set permissions if needed
			if (this.config.mode) {
				await runPrivilegedCommand("chmod", [this.config.mode.toString(8), this.config.destination], { verbose: context.verbose });
			}
			
			// Clean up temp file
			try {
				const fs = await import("node:fs");
				fs.unlinkSync(tempFile);
			} catch {}
		} else {
			const dir = path.dirname(this.config.destination);
			mkdirSync(dir, { recursive: true });

			const content = readFileSync(resolvedSource);
			writeFileSync(this.config.destination, content);

			if (this.config.mode) {
				const fs = await import("node:fs");
				fs.chmodSync(this.config.destination, this.config.mode);
			}
		}
	}
}
