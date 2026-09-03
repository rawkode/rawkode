// The REAL (`typed-storage-effect`-backed) `TokenStore` — one singleton per
// `GatekeeperAccountDurableObject` instance (one DO per connected account, per this stage's own
// "GatekeeperUser" adaptation — see `gatekeeper-account-durable-object.ts`'s header comment).
// Same "collections/singleton passed in, Layer.succeed built from them" shape as
// `workspace-ownership.ts#makeWorkspaceMetaSingleton` (this file's own template).

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { createEffectTypedStorage, type Singleton } from "@athenaeum/typed-storage-effect"
import { DISCONNECTED_TOKENS, TokenStore, type StoredTokens } from "./token-store.js"

export const makeTokenSingleton = (storage: DurableObjectStorage): Singleton<StoredTokens> =>
  createEffectTypedStorage(storage, { singletons: { tokens: DISCONNECTED_TOKENS } }).tokens

export const makeTokenStoreTypedStorageLive = (singleton: Singleton<StoredTokens>): Layer.Layer<TokenStore> =>
  Layer.succeed(TokenStore, {
    get: Effect.orDie(singleton.get()),
    put: (tokens) => Effect.orDie(singleton.put(tokens)),
    clear: Effect.orDie(singleton.put(DISCONNECTED_TOKENS))
  })
