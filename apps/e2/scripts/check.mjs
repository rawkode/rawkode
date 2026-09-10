import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const denoCheck = (file) => {
	const result = spawnSync("deno", ["check", file], { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
};

const workspaceEntrypoints = [
	"alchemy.run.ts",
	"api/src/index.ts",
	...readdirSync("integrations", { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? [
				`integrations/${entry.name}/schema.ts`,
				`integrations/${entry.name}/drizzle.config.ts`,
				`integrations/${entry.name}/src/index.ts`,
			].filter(existsSync)
			: []
	),
	...readdirSync("packages/oauth-client/src")
		.filter((file) => file.endsWith(".ts"))
		.map((file) => `packages/oauth-client/src/${file}`),
	...readdirSync("core", { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? [`core/${entry.name}/src/index.ts`, `core/${entry.name}/schema.ts`]
				.filter(existsSync)
			: []
	),
];

workspaceEntrypoints.forEach(denoCheck);
