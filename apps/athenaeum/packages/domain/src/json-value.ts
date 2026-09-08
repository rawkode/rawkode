import * as Schema from "effect/Schema"

// Shared by `Fact.value` (see fact.ts) and `ViewSpec`'s predicate-tree leaf `value`/`values`
// (see view-spec.ts). Design decision (plan task item 3 — "Schema.Unknown or a JSON-safe union
// — your call, document it"): a real recursive JSON-safe union, not `Schema.Unknown`.
// `Schema.Unknown` would decode/encode as a no-op passthrough, which loses two things this
// domain package cares about: (1) a validation boundary — a caller could hand a Fact a
// non-JSON-safe value (a Date, a class instance, a function) and it would sail through
// `Schema.decodeUnknown` unchallenged, only to fail confusingly later when the backend tries to
// persist it to DO SQLite or serialize it across the Cap'n Web wire; (2) structural equality —
// facts/predicates get compared and round-tripped (sync feed hashing, RPC envelopes), and
// `Schema.Unknown`'s `unknown`-typed values don't give TypeScript or Schema's own `Equal`
// support any structure to compare. A JSON-safe recursive union catches both at the same
// `Schema.decodeUnknown` boundary every other field in this package is already validated at.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export const JsonValue: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.Null,
    Schema.Boolean,
    Schema.Number,
    Schema.String,
    Schema.Array(JsonValue),
    Schema.Record({ key: Schema.String, value: JsonValue })
  )
)
