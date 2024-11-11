import { $ } from "zx";
import { stringify } from "@std/ini";

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
	constructor(public name: string, public unit: T) {}

	private getDirectory() {
		return this.unit.scope === "system"
			? "/etc/systemd/system"
			: "/etc/systemd/user";
	}

	install(): this {
		const unitPath = `${this.getDirectory()}/${this.name}.service`;
		Deno.writeFileSync(unitPath, new TextEncoder().encode(this.toString()));
		return this;
	}

	async enable() {
		return await $`systemctl enable ${this.name}`;
	}

	private toString() {
		return `[Unit]\n${stringify({ ...this.unit })}`;
	}
}
