import * as Alchemy from "alchemy";
import { isActionState, State } from "alchemy/State";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { retainedSecretValue } from "./retained-secret.ts";

const previousResource = (logicalId: string, resourceType: string) =>
	Effect.gen(function* () {
		const stack = yield* Alchemy.Stack;
		const stage = yield* Alchemy.Stage;
		const state = yield* yield* State;
		const prior = yield* state.get({
			stack: stack.name,
			stage,
			fqn: logicalId,
		});
		if (
			!prior || isActionState(prior) || prior.resourceType !== resourceType ||
			prior.logicalId !== logicalId ||
			(prior.status !== "created" && prior.status !== "updated")
		) {
			return yield* Effect.die(
				new Error(
					`Missing configuration and no completed deployment state for ${logicalId}`,
				),
			);
		}
		return prior;
	});

export const deploymentSecret = (
	key: string,
	logicalId: string,
	name: string,
) =>
	Effect.gen(function* () {
		const configured = yield* Config.option(Config.redacted(key));
		if (Option.isSome(configured)) return configured.value;
		const prior = yield* previousResource(
			logicalId,
			"Cloudflare.SecretsStore.Secret",
		);
		return retainedSecretValue(prior, name);
	}).pipe(Effect.orDie, Output.fromEffect);
