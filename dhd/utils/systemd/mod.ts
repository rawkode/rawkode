import { $ } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";

interface UnitConfig {
	type:
		| "simple"
		| "oneshot"
		| "dbus"
		| "notify"
		| "forking"
		| "idle"
		| "socket";
	description: string;
	wantedBy: string;
	scope: "system" | "user";
}

interface Service extends UnitConfig {
	execStart: string;
}

interface Socket extends UnitConfig {
	type: "socket";
	listenStream: string;
	directoryMode: string;
}

export class SystemdUnit<T extends UnitConfig> {
	private readonly home: string | undefined;

	constructor(
		public name: string,
		public unit: T,
	) {
		this.home = import.meta.env.HOME;
	}

	private getDirectory() {
		mkdirSync(`${this.home}/.config/systemd/user`, {
			recursive: true,
		});

		return this.unit.scope === "system"
			? "/etc/systemd/system"
			: `${this.home}/.config/systemd/user`;
	}

	install(): this {
		const unitPath = `${this.getDirectory()}/${this.name}`;
		writeFileSync(unitPath, new TextEncoder().encode(this.toString()));
		return this;
	}

	async enable() {
		return await $`systemctl enable ${this.unit.scope == "user" ? "--user" : ""} --now ${this.name}`;
	}

	// Yes, this sucks. I'll refactor when it's working.
	private toString() {
		const unit = `[Unit]\nDescription=${this.unit.description}\n\n`;
		const install = `[Install]\nWantedBy=${this.unit.wantedBy}\n\n`;

		if ("execStart" in this.unit) {
			return `${unit}[Service]\nType=${this.unit.type}\nExecStart=${this.unit.execStart}\n\n${install}`;
		}
		if ("listenStream" in this.unit && "directoryMode" in this.unit) {
			return `${unit}[Socket]\nType=${this.unit.type}\nListenStream=${this.unit.listenStream}\nDirectoryMode=${this.unit.directoryMode}\n\n${install}`;
		}
	}
}
