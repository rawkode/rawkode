import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { make } from "@alchemy.run/frontend-frameworks/astro";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const output = await make({
	root: resolve("website"),
	astro: { output: "server" },
}).pipe(
	Effect.flatMap((framework) => framework.build({ root: resolve("website") })),
	Effect.provide(NodeServices.layer),
	Effect.runPromise,
);
await mkdir("dist/website", { recursive: true });
await writeFile("dist/website/build.json", JSON.stringify(output));
console.log("Website built with Alchemy Astro adapter");
