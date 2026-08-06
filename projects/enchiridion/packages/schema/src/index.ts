// @enchiridion/schema — the supertag module contract.
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md,
// plan §Supertag module contract.
//
// This package owns `defineSupertagModule()` and build-time validation of
// the module contract: namespace ownership, no collisions across modules,
// projections as one safe SELECT, additive-only upgrades (type/cardinality
// changes rejected), acyclic inheritance DAG — a TS port of the invariants
// in apps/enchiridion/Sources/EnchiridionCore/ModuleFoundation.swift, plus
// effective-schema resolution (GraphOntology.swift's `SupertagInheritance`)
// and relation<->property resolution (GraphOntology.swift's
// `BuiltInRelations`). See registry.ts, inheritance.ts, relations.ts, and
// sql-safety.ts for what's ported 1:1 vs. deliberately adapted, and why.
//
// File layout:
//   types.ts        — the module contract's data shapes (SupertagModule,
//                      SupertagDefinition, RelationDefinition, ...).
//   sql-safety.ts    — projection SQL/view-name safety checks.
//   inheritance.ts   — effective-schema DAG resolution
//                      (effectiveFields/effectiveTagIDs).
//   relations.ts     — entityReference-field <-> relation id resolution.
//   registry.ts       — qualifyModule/defineSupertagModule/SupertagRegistry/
//                      validateAdditiveUpgrade: namespace ownership,
//                      cross-module collisions, additive-only upgrades,
//                      acyclic inheritance.
// Everything above is re-exported from here, the package's public surface.

export type {
  MaterializerDefinition,
  ProjectionDefinition,
  RelationCardinality,
  RelationDefinition,
  ResolverDefinition,
  SupertagDefinition,
  SupertagFieldDefinition,
  SupertagFieldType,
  SupertagModule,
  SupertagModuleUI,
  SupertagRelationProperty,
  SupertagSelectOption,
} from "./types";

export {
  isSafeProjectionStatement,
  isValidProjectionViewName,
} from "./sql-safety";

export {
  effectiveFields,
  effectiveTagIDs,
  propertyKeyToString,
  propertyKeysEqual,
} from "./inheritance";
export type { QualifiedSupertagDefinition, SupertagEffectiveField, SupertagPropertyKey } from "./inheritance";

export { propertyKeyForRelation, relationIDForProperty } from "./relations";
export type { QualifiedRelationDefinition } from "./relations";

export {
  defineSupertagModule,
  qualifyModule,
  SupertagRegistry,
  SupertagRegistryError,
  validateAdditiveUpgrade,
} from "./registry";
export type {
  QualifiedModule,
  QualifiedProjectionDefinition,
  SupertagRegistryErrorCode,
} from "./registry";

import type { SupertagFieldDefinition } from "./types";

/** Field-builder helpers — the `f.number()`, `f.select([...])` shorthand
 *  from the plan's example module. Each just returns a plain field
 *  definition object for `qualifyModule`/`defineSupertagModule` to validate;
 *  no validation happens here (field-shape validation, e.g. `select` needing
 *  non-empty options, is deliberately out of scope for P1 — supertags/core
 *  is TS-authored and type-checked, so malformed field literals are already
 *  caught at the call site by `SupertagFieldDefinition`'s type). */
export const f = {
  text: (opts: Omit<SupertagFieldDefinition<"text">, "type"> = {}): SupertagFieldDefinition<"text"> => ({
    type: "text",
    ...opts,
  }),
  number: (
    opts: Omit<SupertagFieldDefinition<"number">, "type"> = {},
  ): SupertagFieldDefinition<"number"> => ({ type: "number", ...opts }),
  boolean: (
    opts: Omit<SupertagFieldDefinition<"boolean">, "type"> = {},
  ): SupertagFieldDefinition<"boolean"> => ({ type: "boolean", ...opts }),
  date: (opts: Omit<SupertagFieldDefinition<"date">, "type"> = {}): SupertagFieldDefinition<"date"> => ({
    type: "date",
    ...opts,
  }),
  dateTime: (
    opts: Omit<SupertagFieldDefinition<"dateTime">, "type"> = {},
  ): SupertagFieldDefinition<"dateTime"> => ({ type: "dateTime", ...opts }),
  /** Option ids are derived from the display name the same way Swift's
   *  `BuiltInSupertags.selectField` does it
   *  (apps/enchiridion/Sources/EnchiridionCore/SupertagModels.swift:327-334):
   *  lowercase, then replace each space with a hyphen. No other
   *  normalization (no trimming, no collapsing repeated spaces, no
   *  punctuation stripping) — matching Swift exactly, including its rough
   *  edges, matters here because these ids are real stored values from the
   *  old app's user data that must round-trip unchanged through the P1
   *  importer. Swift's `selectField` has no override for this, so neither
   *  does this. */
  select: (
    options: string[],
    opts: Omit<SupertagFieldDefinition<"select">, "type" | "options"> = {},
  ): SupertagFieldDefinition<"select"> => ({
    type: "select",
    options: options.map((name) => ({ id: name.toLowerCase().replaceAll(" ", "-"), name })),
    ...opts,
  }),
  url: (opts: Omit<SupertagFieldDefinition<"url">, "type"> = {}): SupertagFieldDefinition<"url"> => ({
    type: "url",
    ...opts,
  }),
  email: (
    opts: Omit<SupertagFieldDefinition<"email">, "type"> = {},
  ): SupertagFieldDefinition<"email"> => ({ type: "email", ...opts }),
  phone: (
    opts: Omit<SupertagFieldDefinition<"phone">, "type"> = {},
  ): SupertagFieldDefinition<"phone"> => ({ type: "phone", ...opts }),
  entityReference: (
    allowed: string[],
    opts: Omit<SupertagFieldDefinition<"entityReference">, "type" | "allowedSupertagIDs"> = {},
  ): SupertagFieldDefinition<"entityReference"> => ({
    type: "entityReference",
    allowedSupertagIDs: allowed,
    ...opts,
  }),
};

/** A tagged-template helper for projection SQL, so `sql\`SELECT ...\`` reads
 *  as SQL to tooling/highlighters. Just concatenates — the actual safety
 *  check (`isSafeProjectionStatement`) runs on the resulting string at
 *  `defineSupertagModule`/`qualifyModule` time (registry.ts), once the
 *  surrounding module's namespace is known. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ""), "");
}
