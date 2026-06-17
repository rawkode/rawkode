import { registerProvider } from "@flue/runtime";
import type { Env } from "./types";

export function registerRuntimeProviders(env: Env) {
	if (!env.AI) {
		return;
	}

	registerProvider("cloudflare-workers-ai", {
		api: "cloudflare-ai-binding",
		binding: env.AI,
	});
}
