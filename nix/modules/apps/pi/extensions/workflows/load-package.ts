import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

let globalNpmRoot: string | null = null;

function getGlobalNpmRoot(): string | null {
	if (globalNpmRoot !== null) return globalNpmRoot;
	try {
		globalNpmRoot =
			execSync("npm root -g", { encoding: "utf8" }).trim() || null;
	} catch {
		globalNpmRoot = null;
	}
	return globalNpmRoot;
}

export function loadPackage(name: string): unknown {
	const candidates = [
		join(process.cwd(), ".pi", "npm", "node_modules", name),
		join(os.homedir(), ".pi", "agent", "npm", "node_modules", name),
	];
	const globalRoot = getGlobalNpmRoot();
	if (globalRoot) candidates.push(join(globalRoot, name));

	for (const c of candidates) {
		try {
			return require(c);
		} catch {}
	}
	try {
		return require(name);
	} catch {
		throw new Error(
			`Unable to resolve ${name}. Install via \`packages: ["npm:${name}"]\` in .pi/settings.json.`,
		);
	}
}
