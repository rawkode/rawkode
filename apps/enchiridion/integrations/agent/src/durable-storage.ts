import type {
	DurableObjectStorage,
	DurableObjectTransaction,
} from "@cloudflare/workers-types";
import type { VoiceStorage } from "./reservations.ts";

/** Keeps Cloudflare's actual storage transaction boundary. Do not substitute
 * an eventually consistent KV namespace or a per-process Map in production. */
export const durableVoiceStorage = (
	storage: Pick<DurableObjectStorage, "transaction">,
): VoiceStorage => ({
	transaction: (action) =>
		storage.transaction((transaction: DurableObjectTransaction) =>
			action({
				get: <T>(key: string) => transaction.get<T>(key),
				put: (key: string, value: unknown) => transaction.put(key, value),
			})
		),
});
