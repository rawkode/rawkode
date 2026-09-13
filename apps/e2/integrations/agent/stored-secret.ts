import type * as Cloudflare from "alchemy/Cloudflare";

/** Bind the existing secret without reading, replacing or managing its value. */
export const bindStoredVoiceSecret = (worker: Cloudflare.Worker) =>
	worker.bind`OPENAI_API_KEY`({
		bindings: [{
			type: "secrets_store_secret",
			name: "OPENAI_API_KEY",
			storeId: "492e5e40b9d64ebeac7e7a77db91ff6e",
			secretName: "e2-production-agent-openai-api-key",
		}],
	});
