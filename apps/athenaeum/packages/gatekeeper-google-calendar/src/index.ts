// Public surface of `@athenaeum/gatekeeper-google-calendar`. See docs/gatekeeper-google-calendar-
// decisions.md for the full design and `worker.ts` for this package's own Worker entrypoint.

export * from "./calendar-types.js"
export * from "./errors.js"
export {
  GoogleCalendarClient,
  type GoogleCalendarClientApi,
  type AuthorizationUrlOptions,
  type CalendarEventsListQuery,
  type SendUpdatesOptions
} from "./google-calendar-client.js"
export { HttpFetch, HttpFetchLive } from "./http-fetch.js"
export {
  makeGoogleCalendarClientRealLive,
  type GoogleCalendarClientRealConfig
} from "./google-calendar-client-real.js"
export {
  makeGoogleCalendarClientScripted,
  type GoogleCalendarClientScriptedFixtures,
  type GoogleCalendarClientScriptedHandle,
  type ScriptedGoogleAccount,
  type RecordedCall
} from "./google-calendar-client-scripted.js"
export {
  GatekeeperUserVerifier,
  ObserverIdentity,
  mintGatekeeperUserVerifier,
  unwrapGatekeeperUserVerifier
} from "./observer-verifier.js"
export {
  ObserverLedger,
  ObserverLedgerInMemory,
  type ObserverLedgerApi,
  type RegisteredObserver
} from "./observer-ledger.js"
export {
  makeObserverLedgerCollections,
  makeObserverLedgerTypedStorageLive,
  type ObserverLedgerCollections
} from "./observer-ledger-typed-storage.js"
export {
  verifyObserverStrategyB,
  addObserverStrategyC,
  removeObserverStrategyC,
  onDatasetTouched,
  accessCheckWindow,
  type AccessTokenResolver
} from "./observer-verification.js"
export {
  TokenStore,
  TokenStoreInMemory,
  DISCONNECTED_TOKENS,
  type TokenStoreApi,
  type StoredTokens
} from "./token-store.js"
export { makeTokenSingleton, makeTokenStoreTypedStorageLive } from "./token-store-typed-storage.js"
export {
  GatekeeperAccountService,
  type GatekeeperAccountServiceApi,
  type AccessTokenResolver as GatekeeperAccountAccessTokenResolver
} from "./gatekeeper-account-service.js"
export {
  makeGatekeeperAccountServiceLive,
  type GatekeeperAccountServiceConfig
} from "./gatekeeper-account-service-live.js"
export { GatekeeperAccountDurableObject } from "./gatekeeper-account-durable-object.js"
export {
  errorEnvelopeFromCause,
  parseErrorEnvelope,
  runOrThrowEnvelope,
  throwErrorEnvelope,
  type ErrorEnvelope
} from "./rpc-boundary.js"
