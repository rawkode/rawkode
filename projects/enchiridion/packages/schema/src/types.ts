// @enchiridion/schema — the supertag module contract's data shapes.
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md, plan
// §Supertag module contract. Ported 1:1 (field identity, inheritance shape)
// from apps/enchiridion/Sources/EnchiridionCore/SupertagModels.swift and
// ModuleFoundation.swift, adapted to a TS module-as-code shape: a Swift
// `SupertagID`/`RelationID` is an explicit, freestanding identifier; here a
// supertag/relation's identity is normally *derived* from the module's `id`
// plus the object key it's declared under (`workout` inside module
// `dev.rawkode.workouts` -> `dev.rawkode.workouts.workout`), which makes an
// out-of-namespace declaration structurally impossible for the common case.
// The optional `id` overrides below exist for the uncommon case a module
// needs to claim a specific fully-qualified identifier (e.g. adopting a
// legacy/reserved id) — registry.ts's `qualifyModule` still requires any
// override to be owned by the declaring module's namespace.

/** Field types, ported 1:1 from SupertagFieldType in
 *  apps/enchiridion/Sources/EnchiridionCore/SupertagModels.swift. */
export type SupertagFieldType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "dateTime"
  | "select"
  | "url"
  | "email"
  | "phone"
  | "entityReference";

export interface SupertagSelectOption {
  id: string;
  name: string;
  color?: string;
}

export interface SupertagFieldDefinition<Type extends SupertagFieldType = SupertagFieldType> {
  type: Type;
  name?: string;
  allowsMultiple?: boolean;
  isRequired?: boolean;
  isMultiline?: boolean;
  options?: SupertagSelectOption[];
  /** Supertag IDs this field may reference — only meaningful for
   *  `entityReference` fields. entityReference fields compile to canonical
   *  relations (forward + inverse); backlinks are projections, never
   *  materialized (plan §Supertag module contract). */
  allowedSupertagIDs?: string[];
}

/** A single supertag's shape within a module. `parents` are other
 *  supertags' fully-qualified IDs (namespace-qualified for
 *  cross-module inheritance), forming the acyclic inheritance DAG. */
export interface SupertagDefinition {
  name: string;
  symbol: string;
  parents?: string[];
  fields: Record<string, SupertagFieldDefinition>;
  /** Explicit fully-qualified id override. Defaults to
   *  `${module.id}.${key}` when omitted — see file header. Must still be
   *  owned by the declaring module's namespace. */
  id?: string;
}

export type RelationCardinality = "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";

/** A property key a relation is the canonical materialization of — links an
 *  `entityReference` field back to the relation it compiles to. Optional:
 *  relations with no `property` are pure graph relations with no backing
 *  scalar field (e.g. Swift's `BuiltInRelations.mentions`). */
export interface SupertagRelationProperty {
  supertagID: string;
  fieldID: string;
}

/** Forward/inverse relation names, endpoint constraints, cardinality —
 *  ported concept from BuiltInRelations in
 *  apps/enchiridion/Sources/EnchiridionCore/GraphOntology.swift. */
export interface RelationDefinition {
  from: string[];
  to: string[];
  forwardName: string;
  inverseName: string;
  cardinality: RelationCardinality;
  /** Explicit fully-qualified id override — see file header. */
  id?: string;
  /** The entityReference field this relation canonically materializes, if
   *  any. Drives `relationIDForProperty`/`propertyKeyForRelation`
   *  (relations.ts), the TS port of Swift's `BuiltInRelations.relationID(for:)`
   *  / `.propertyKey(for:)` bidirectional mapping. */
  property?: SupertagRelationProperty;
}

export interface ProjectionDefinition {
  /** Bump on any change to `sql`; additive-only upgrades are enforced at
   *  build time (registry.ts's `validateAdditiveUpgrade`). */
  version: number;
  sql: string;
  /** Explicit fully-qualified declaration id override. Defaults to
   *  `${module.id}.projection.${key}` when omitted, where `key` is this
   *  projection's object key in `SupertagModule.projections` (also used
   *  directly as the public SQL view name, per the plan's module contract
   *  example — `projections: { graph_workouts_v1: {...} }`). */
  id?: string;
}

/** External snapshot -> page upsert with baseline-hash never-clobber
 *  semantics, ported concept from
 *  apps/enchiridion/Sources/EnchiridionCore/CalendarEventMaterialization.swift. */
export interface MaterializerDefinition<Snapshot = unknown> {
  name: string;
  targetSupertag: string;
  materialize: (snapshot: Snapshot) => never; // TODO: real upsert-with-baseline-hash contract.
}

export interface ResolverDefinition {
  /** Optional GraphQL fields beyond generated defaults. Left as `unknown`
   *  pending packages/graphql-composer's resolver contract (P1). */
  [fieldName: string]: unknown;
}

export interface SupertagModuleUI {
  presentationOrder?: string[];
  /** Fully-qualified view type ids this module declares. Must be owned by
   *  the module's own namespace (registry.ts's `qualifyModule`). */
  viewTypes?: string[];
}

export interface SupertagModule {
  /** Reverse-DNS namespace this module owns, e.g. "dev.rawkode.workouts". */
  id: string;
  version: number;
  supertags: Record<string, SupertagDefinition>;
  relations?: Record<string, RelationDefinition>;
  projections?: Record<string, ProjectionDefinition>;
  materializers?: MaterializerDefinition[];
  resolvers?: Record<string, ResolverDefinition>;
  ui?: SupertagModuleUI;
}
