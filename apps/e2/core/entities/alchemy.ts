import { workerName } from "../../naming.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";

export const workerSource = {
	main: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
	compatibility: { date: "2026-07-11", flags: ["nodejs_compat"] },
};

export default () =>
	Effect.flatMap(Alchemy.Stage, (stage) =>
		Cloudflare.Worker("core-entities", {
			name: workerName("core-entities", stage),
			...workerSource,
			workersDev: false,
			env: {
				ENTITIES: Cloudflare.DurableObject("Entities", {
					className: "Entities",
				}),
			},
		}));
