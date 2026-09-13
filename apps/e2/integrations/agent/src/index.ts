import { withinVoiceDeadline } from "./deadline.ts";
import { DurableObject } from "cloudflare:workers";
import { authenticate, sameOriginPost } from "../../../website/src/lib/auth.ts";
import { durableVoiceStorage } from "./durable-storage.ts";
import {
	closeOwnedVoiceSession,
	createOwnerVoiceRuntime,
	type VoiceRuntimeEnv,
} from "./runtime.ts";
import { createVoiceReservations } from "./reservations.ts";
import { createApiDayReader } from "./day-reader.ts";
import { attachLiveSideband } from "./sideband.ts";
import { createVoiceReasoner } from "./reasoner.ts";

interface Env extends VoiceRuntimeEnv {
	VOICE_OWNERS: DurableObjectNamespace;
	LOADER: WorkerLoader;
}
export class VoiceOwner extends DurableObject<Env> {
	override async fetch(request: Request): Promise<Response> {
		const identity = await withinVoiceDeadline(() =>
			authenticate(request, this.env)
		);
		if (!identity) return new Response("Unauthorized", { status: 401 });
		const storage = durableVoiceStorage(this.ctx.storage);
		const ledger = createVoiceReservations(storage, identity.ownerId);
		const runtime = createOwnerVoiceRuntime(storage, identity, this.env, {
			attach: async (_owner, requestID, sessionID, original, context) => {
				try {
					const key = await withinVoiceDeadline(() =>
						this.env.OPENAI_API_KEY.get()
					);
					if (!key) throw new Error("Voice is not configured");
					const read = await withinVoiceDeadline(() =>
						createApiDayReader(original, this.env, this.env.API)
					);
					const isCurrent = () => ledger.isSessionActive(sessionID);
					const execute = createVoiceReasoner({
						timeZone: context.timeZone,
						loader: this.env.LOADER,
						apiKey: key,
						isCurrent,
						readDay: (input, signal) => read(identity.ownerId, input, signal),
					});
					const controller = await attachLiveSideband({
						sessionID,
						apiKey: key,
						authorize: isCurrent,
						execute,
						onClosed: async () => {
							await ledger.reconcile(requestID, { state: "closed", sessionID });
						},
					});
					this.ctx.waitUntil(controller.finished.then(async (result) => {
						if (!result.finalized) {
							await closeOwnedVoiceSession(ledger, sessionID, this.env);
						}
					}));
				} catch (error) {
					// A created call whose control plane failed must not be handed to the client.
					// End through the same provider-verified path; failed cleanup keeps quota held.
					await closeOwnedVoiceSession(ledger, sessionID, this.env).catch(
						() => {},
					);
					throw error;
				}
			},
		});
		return runtime(request);
	}
}
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!sameOriginPost(request, env.WEBSITE_ORIGIN)) {
			return new Response("Forbidden", { status: 403 });
		}
		const identity = await withinVoiceDeadline(() =>
			authenticate(request, env)
		);
		if (!identity) return new Response("Unauthorized", { status: 401 });
		return env.VOICE_OWNERS.get(env.VOICE_OWNERS.idFromName(identity.ownerId))
			.fetch(request);
	},
};
