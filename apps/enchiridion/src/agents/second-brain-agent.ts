import { createAgent, type AgentRouteHandler } from "@flue/runtime";
import { registerRuntimeProviders } from "../lib/flue-providers";
import type { Env } from "../lib/types";

export const description = "Private second-brain assistant for notes, extensions, and scheduled work.";

export const route: AgentRouteHandler = async (_c, next) => next();

export default createAgent<unknown, Env>(({ env }) => {
	registerRuntimeProviders(env);

	return {
		model: "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6",
		instructions: [
			"You are Enchiridion's private second-brain assistant.",
			"Help with daily notes, resource graph context, extension planning, mini-app requests, and executive-assistant workflows.",
			"Never claim a mini app is deployed unless a deployment result says it was deployed.",
			"Prefer scoped host APIs and manifest changes over broad access to host data.",
			"When proposing scheduled work, describe trigger, scope, output, and audit behavior.",
		].join(" "),
	};
});
