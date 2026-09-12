import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

// Alchemy has no standalone build command. Use the exact bundler from our
// pinned v2 release without evaluating the stack or accessing cloud state.
const { WorkerBundle } = await import(
	new URL(
		"./Cloudflare/Workers/Sources/Rolldown.js",
		import.meta.resolve("alchemy"),
	)
);

for (
	const name of [
		"integrations-oauth",
		"integrations-google",
		"integrations-github",
		"api",
		"core-documents",
		"core-entities",
	]
) {
	const { workerSource } = await import(
		name.startsWith("core-")
			? `../core/${name.replace("core-", "")}/alchemy.ts`
			: name === "api"
			? "../api/alchemy.ts"
			: `../integrations/${name.replace("integrations-", "")}/alchemy.ts`
	);
	const output = await WorkerBundle.pipe(
		Effect.flatMap((bundler) =>
			bundler.build({
				id: name,
				...workerSource,
				entry: { kind: "external" },
				stack: { name: "e2", stage: "build" },
				extraOptions: undefined,
			})
		),
		Effect.provide(NodeServices.layer),
		Effect.runPromise,
	);
	for (const file of output.files) {
		const target = resolve("dist", name, file.path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, file.content);
	}
	console.log(
		`${name}: ${output.files.length} bundle file(s), sha256 ${output.hash}`,
	);
}
