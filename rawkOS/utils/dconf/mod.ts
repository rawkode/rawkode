import { runCommand } from "../commands/mod.ts";
import { readFileSync } from "fs-extra";

export const dconfImport = async (
	importPath: string,
	rootPath = "/",
	options: { verbose?: boolean } = {},
) => {
	const content = readFileSync(importPath, "utf-8");
	const proc = Bun.spawn(["dconf", "load", rootPath], {
		stdin: new TextEncoder().encode(content),
		stdout: options.verbose ? "inherit" : "ignore",
		stderr: options.verbose ? "inherit" : "ignore",
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`dconf load failed with exit code ${exitCode}`);
	}
};
