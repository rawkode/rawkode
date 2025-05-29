import type { SystemContext } from "./system-context.ts";

/**
 * Common condition helpers for use with the module builder's .when() method
 */
export const conditions = {
	// Hardware conditions
	hasFingerprint: (system: SystemContext) => system.hardware.hasFingerprint,
	hasTpm: (system: SystemContext) => system.hardware.hasTpm,
	hasNvidiaGpu: (system: SystemContext) => system.hardware.hasNvidiaGpu,
	hasAmdGpu: (system: SystemContext) => system.hardware.hasAmdGpu,
	hasIntelGpu: (system: SystemContext) => system.hardware.hasIntelGpu,

	// Desktop environment conditions
	isGnome: (system: SystemContext) => system.desktop.isGnome,
	isKde: (system: SystemContext) => system.desktop.isKde,
	isNiri: (system: SystemContext) => system.desktop.isNiri,
	isWayland: (system: SystemContext) => system.desktop.isWayland,
	isX11: (system: SystemContext) => system.desktop.isX11,

	// User conditions
	isUser: (username: string) => (system: SystemContext) =>
		system.user.name === username,
	isNotRoot: (system: SystemContext) => !system.system.isRoot,
	isRoot: (system: SystemContext) => system.system.isRoot,

	// Platform conditions
	isLinux: (system: SystemContext) => system.system.platform === "linux",
	isDarwin: (system: SystemContext) => system.system.platform === "darwin",
	isArch: (arch: string) => (system: SystemContext) =>
		system.system.arch === arch,

	// Hostname conditions
	isHost: (hostname: string) => (system: SystemContext) =>
		system.system.hostname === hostname,

	// Combine conditions
	and:
		(...conditions: Array<(system: SystemContext) => boolean>) =>
		(system: SystemContext) =>
			conditions.every((cond) => cond(system)),

	or:
		(...conditions: Array<(system: SystemContext) => boolean>) =>
		(system: SystemContext) =>
			conditions.some((cond) => cond(system)),

	not:
		(condition: (system: SystemContext) => boolean) =>
		(system: SystemContext) =>
			!condition(system),
};
