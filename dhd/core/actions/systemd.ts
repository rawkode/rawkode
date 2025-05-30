import { Action, type ActionContext, type SideEffect } from "../action.ts";
import { SystemdUnit } from "../../utils/systemd/mod.ts";
import { existsSync } from "node:fs";
import path from "node:path";

export interface SystemdServiceConfig {
	name: string;
	description: string;
	execStart: string;
	type?: "simple" | "oneshot" | "dbus" | "notify" | "forking" | "idle";
	wantedBy?: string;
	scope?: "system" | "user";
	restart?: "no" | "on-success" | "on-failure" | "on-abnormal" | "on-watchdog" | "on-abort" | "always";
	restartSec?: number;
	environment?: Record<string, string>;
	workingDirectory?: string;
	user?: string;
	group?: string;
}

export class SystemdServiceAction extends Action<SystemdServiceConfig> {
	private getUnitPath(): string {
		const home = import.meta.env.HOME;
		const scope = this.config.scope || "user";
		const dir = scope === "system" 
			? "/etc/systemd/system"
			: `${home}/.config/systemd/user`;
		
		return `${dir}/${this.config.name}`;
	}

	async plan(context: ActionContext): Promise<SideEffect[]> {
		const unitPath = this.getUnitPath();
		const exists = existsSync(unitPath);

		const effects: SideEffect[] = [];

		// Check if unit file needs to be created/updated
		effects.push({
			type: exists ? "file_modify" : "file_create",
			description: `${exists ? "Update" : "Create"} systemd unit ${this.config.name}`,
			target: unitPath,
			metadata: {
				scope: this.config.scope || "user",
			},
		});

		// Plan to enable and start the service
		effects.push({
			type: "service_enable",
			description: `Enable and start systemd service ${this.config.name}`,
			target: this.config.name,
			metadata: {
				scope: this.config.scope || "user",
			},
		});

		return effects;
	}

	async apply(context: ActionContext): Promise<void> {
		if (context.dryRun) return;

		// Create unit file content
		const unitContent = this.generateUnitContent();
		
		// Create the systemd unit
		const unit = new SystemdUnit(this.config.name, {
			type: this.config.type || "simple",
			description: this.config.description,
			wantedBy: this.config.wantedBy || "default.target",
			scope: this.config.scope || "user",
			execStart: this.config.execStart,
		});

		// Install the unit file by writing content directly
		const home = import.meta.env.HOME;
		const scope = this.config.scope || "user";
		const dir = scope === "system" 
			? "/etc/systemd/system"
			: `${home}/.config/systemd/user`;

		// Ensure directory exists
		const fs = await import("node:fs");
		fs.mkdirSync(dir, { recursive: true });

		// Write unit file
		const unitPath = `${dir}/${this.config.name}`;
		fs.writeFileSync(unitPath, unitContent);

		// Enable and start the service
		await unit.enable();
	}

	private generateUnitContent(): string {
		const sections: string[] = [];

		// [Unit] section
		sections.push("[Unit]");
		sections.push(`Description=${this.config.description}`);
		sections.push("");

		// [Service] section
		sections.push("[Service]");
		sections.push(`Type=${this.config.type || "simple"}`);
		sections.push(`ExecStart=${this.config.execStart}`);

		if (this.config.restart) {
			sections.push(`Restart=${this.config.restart}`);
		}

		if (this.config.restartSec) {
			sections.push(`RestartSec=${this.config.restartSec}`);
		}

		if (this.config.workingDirectory) {
			sections.push(`WorkingDirectory=${this.config.workingDirectory}`);
		}

		if (this.config.user) {
			sections.push(`User=${this.config.user}`);
		}

		if (this.config.group) {
			sections.push(`Group=${this.config.group}`);
		}

		if (this.config.environment) {
			Object.entries(this.config.environment).forEach(([key, value]) => {
				sections.push(`Environment="${key}=${value}"`);
			});
		}

		sections.push("");

		// [Install] section
		sections.push("[Install]");
		sections.push(`WantedBy=${this.config.wantedBy || "default.target"}`);
		sections.push("");

		return sections.join("\n");
	}
}

export interface SystemdSocketConfig {
	name: string;
	description: string;
	listenStream: string;
	directoryMode?: string;
	wantedBy?: string;
	scope?: "system" | "user";
}

export class SystemdSocketAction extends Action<SystemdSocketConfig> {
	private getUnitPath(): string {
		const home = import.meta.env.HOME;
		const scope = this.config.scope || "user";
		const dir = scope === "system" 
			? "/etc/systemd/system"
			: `${home}/.config/systemd/user`;
		
		return `${dir}/${this.config.name}`;
	}

	async plan(context: ActionContext): Promise<SideEffect[]> {
		const unitPath = this.getUnitPath();
		const exists = existsSync(unitPath);

		const effects: SideEffect[] = [];

		// Check if unit file needs to be created/updated
		effects.push({
			type: exists ? "file_modify" : "file_create",
			description: `${exists ? "Update" : "Create"} systemd socket ${this.config.name}`,
			target: unitPath,
			metadata: {
				scope: this.config.scope || "user",
			},
		});

		// Plan to enable and start the socket
		effects.push({
			type: "service_enable",
			description: `Enable and start systemd socket ${this.config.name}`,
			target: this.config.name,
			metadata: {
				scope: this.config.scope || "user",
			},
		});

		return effects;
	}

	async apply(context: ActionContext): Promise<void> {
		if (context.dryRun) return;

		// Create unit file content
		const unitContent = this.generateUnitContent();
		
		// Create the systemd unit
		const unit = new SystemdUnit(this.config.name, {
			type: "socket",
			description: this.config.description,
			wantedBy: this.config.wantedBy || "sockets.target",
			scope: this.config.scope || "user",
			listenStream: this.config.listenStream,
			directoryMode: this.config.directoryMode || "0755",
		});

		// Install the unit file by writing content directly
		const home = import.meta.env.HOME;
		const scope = this.config.scope || "user";
		const dir = scope === "system" 
			? "/etc/systemd/system"
			: `${home}/.config/systemd/user`;

		// Ensure directory exists
		const fs = await import("node:fs");
		fs.mkdirSync(dir, { recursive: true });

		// Write unit file
		const unitPath = `${dir}/${this.config.name}`;
		fs.writeFileSync(unitPath, unitContent);

		// Enable and start the socket
		await unit.enable();
	}

	private generateUnitContent(): string {
		const sections: string[] = [];

		// [Unit] section
		sections.push("[Unit]");
		sections.push(`Description=${this.config.description}`);
		sections.push("");

		// [Socket] section
		sections.push("[Socket]");
		sections.push(`ListenStream=${this.config.listenStream}`);
		
		if (this.config.directoryMode) {
			sections.push(`DirectoryMode=${this.config.directoryMode}`);
		}

		sections.push("");

		// [Install] section
		sections.push("[Install]");
		sections.push(`WantedBy=${this.config.wantedBy || "sockets.target"}`);
		sections.push("");

		return sections.join("\n");
	}
}