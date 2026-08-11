// @enchiridion/graphql-composer — supertag modules -> one Pothos schema.
//
// Plan §Supertag module contract: "graphql-composer turns the merged set of
// `supertags` + `relations` + `resolvers` across all loaded modules into a
// single Pothos builder config for vault's one GraphQL schema — modules
// aggregate into that one schema, not into separate services." Plan
// §Backend architecture, "GraphQL API": Pothos-core, no
// `plugin-federation`/`plugin-drizzle`, served by `workers/vault` via
// GraphQL Yoga at `/graphql`.
//
// This is the P1 implementation the file used to skeleton (see jj history
// for the old TODO). It generalizes `workers/vault/src/graphql/schema.ts`'s
// hand-written `Page`/`Query.page`/`Query.pages` pattern (one plain
// `SchemaBuilder`, `builder.objectRef(...).implement(...)`, resolvers over
// a typed accessor context, never `vault.query()`) across every supertag in
// a `SupertagRegistry`, instead of being a fresh design:
//
//   - One Pothos object type per EFFECTIVE supertag (`registry.
//     effectiveFields()` — an inherited field, e.g. `Company.website`
//     (declared on `Organization`), appears on the child type too, still
//     resolving against the OWNING supertag's fact-storage key).
//   - `entityReference` fields resolve through the relation they compile to
//     (`registry.relationIDForProperty()`), returning the target
//     supertag's generated type (or a list, for `allowsMultiple` fields) —
//     never left as a bare id/scalar.
//   - Every relation also gets an inverse/backlink field on its target
//     type(s), computed via a query against the accessor contract
//     (`accessors.ts`), never materialized — plan §Supertag module
//     contract: "backlinks are projections, never materialized."
//   - Root `Query` fields per supertag: `person(id: String!): Person`,
//     `people(limit: Int, cursor: String): PersonConnection!` — the same
//     shape as `Page`'s `Query.page`/`Query.pages`.
//   - Resolvers call ONLY `accessors.ts`'s `SupertagAccessors` contract
//     (via `request-loaders.ts`'s per-request batching), never a
//     free-form-SQL `vault.query()` — plan §"Query surfaces — two, not
//     one".
//   - `errors.ts`'s `GraphQLComposerError` catches GraphQL type/field-name
//     collisions between modules — a namespace SEPARATE from
//     `@enchiridion/schema`'s supertag-id namespace (see that file's
//     header) — as a clear build-time failure.
//
// What this file deliberately does NOT do yet: apply a module's optional
// `resolvers` (`SupertagModule.resolvers`, `packages/schema/src/types.ts`'s
// `ResolverDefinition` — still `Record<string, unknown>` pending its own
// contract) or a module's `projections`/`materializers`/`ui` — none of
// those are GraphQL-schema concerns this package owns. Mutations are also
// out of scope here, matching `schema.ts`'s P0 file-bottom TODO (writes are
// RPC, per the plan's "Writes are RPC, not GraphQL mutations" pin).

import SchemaBuilder from "@pothos/core";
import type { GraphQLSchema } from "graphql";

import {
  propertyKeyToString,
  SupertagRegistry,
  type QualifiedRelationDefinition,
  type QualifiedSupertagDefinition,
  type SupertagEffectiveField,
  type SupertagFieldDefinition,
  type SupertagModule,
} from "@enchiridion/schema";

import type {
  GraphQLComposerContext,
  SupertagListResult,
  SupertagNodeRecord,
} from "./accessors";
import { GraphQLComposerError, NameRegistry } from "./errors";
import { lowerFirst, pluralize, toCamelCase, toEnumValueName, toPascalCase } from "./naming";
import { hydrateNodes, relationSourceLoaderFor, relationTargetLoaderFor } from "./request-loaders";

export type {
  GraphQLComposerContext,
  SupertagAccessors,
  SupertagListOptions,
  SupertagListResult,
  SupertagNodeRecord,
} from "./accessors";
export { GraphQLComposerError, NameRegistry } from "./errors";
export type { GraphQLComposerErrorCode } from "./errors";
export { lowerFirst, pluralize, toCamelCase, toEnumValueName, toPascalCase } from "./naming";
export { createBatchLoader, hydrateNodes, relationSourceLoaderFor, relationTargetLoaderFor } from "./request-loaders";

/** The concrete Pothos `SchemaBuilder` type every generated ref/field in
 *  this package is built against — every supertag object type shares this
 *  ONE builder instance (per compose call), matching the plan's "modules
 *  aggregate into that one schema, not into separate services." Derived via
 *  `InstanceType<typeof SchemaBuilder<...>>` rather than `SchemaBuilder<...>`
 *  directly: `@pothos/core`'s default export is a `const` with a `new<Types>`
 *  call signature, not a `class`, so there is no standalone `SchemaBuilder`
 *  TYPE to parameterize — only a constructor VALUE to instantiate. */
export type ComposerSchemaBuilder = InstanceType<typeof SchemaBuilder<{ Context: GraphQLComposerContext }>>;

/** The PRE-implement Pothos object-ref type every supertag's GraphQL type
 *  is reserved as in Pass 1 below (`refsByTagID`, `builder.objectRef
 *  <SupertagNodeRecord>(typeName)`) — hoisted to module scope (via a
 *  `declare const` type-only witness, never a real value: this line
 *  produces zero runtime code) so it can appear in `ComposedPothosConfig`'s
 *  public shape, not just as a function-local type inside
 *  `composePothosConfigFromRegistry`. Exported as `objectRefForTagID` so an
 *  external caller (`workers/vault/src/graphql/composed-schema.ts`) can
 *  extend an ALREADY-COMPOSED supertag type with more fields via
 *  `builder.objectFields(ref, ...)` — the exact mechanism Pass 3 below
 *  already uses internally for backlink fields, just made available past
 *  this function's return, for a field a supertag module itself doesn't
 *  declare (a server-only field resolved through another worker, e.g.
 *  `EmailThread.messages`). */
declare const objectRefTypeWitness: ComposerSchemaBuilder;
export type SupertagObjectRef = ReturnType<typeof objectRefTypeWitness.objectRef<SupertagNodeRecord>>;

/** What `composePothosConfig`/`composePothosConfigFromRegistry` hand back
 *  to a caller (`workers/vault`, or a test). `builder`/`schema` are the
 *  two things a caller actually needs — `schema` to serve directly via
 *  Yoga (mirrors `workers/vault/src/graphql/schema.ts`'s exported
 *  `schema`), `builder` if a caller wants to keep extending the same
 *  builder before calling `.toSchema()` again (e.g. a future mutation
 *  pass). The name-map fields are introspection/debugging aids — e.g. for
 *  `packages/codegen`'s eventual Swift codegen to reuse the exact same
 *  GraphQL type names this package generated, rather than re-deriving
 *  them independently and risking drift. */
export interface ComposedPothosConfig {
  registry: SupertagRegistry;
  builder: ComposerSchemaBuilder;
  schema: GraphQLSchema;
  /** Qualified supertag id -> generated GraphQL object type name. */
  typeNameForTagID: ReadonlyMap<string, string>;
  /** Qualified supertag id -> the actual (already-`.implement()`-ed) Pothos
   *  object ref for that type — see `SupertagObjectRef`'s doc comment for
   *  why this is exposed and how a caller uses it. */
  objectRefForTagID: ReadonlyMap<string, SupertagObjectRef>;
  /** `propertyKeyToString({supertagID, fieldID})` -> generated GraphQL
   *  enum type name, for every `select` field composed. */
  enumTypeNameForPropertyKey: ReadonlyMap<string, string>;
  /** Qualified supertag id -> root `Query` field name, singular and
   *  plural (e.g. `"...task"` -> `{ singular: "task", plural: "tasks" }`). */
  queryFieldNameForTagID: ReadonlyMap<string, { singular: string; plural: string }>;
}

/** Composes one Pothos schema from every supertag module in `modules` —
 *  builds a `SupertagRegistry` first (validating namespace ownership,
 *  additive-only-ness is upgrade-time only, and inheritance acyclicity —
 *  see `@enchiridion/schema`'s `registry.ts`), then delegates to
 *  `composePothosConfigFromRegistry`. */
export function composePothosConfig(modules: readonly SupertagModule[]): ComposedPothosConfig {
  return composePothosConfigFromRegistry(SupertagRegistry.build(modules));
}

/** Same as `composePothosConfig`, but takes an already-built
 *  `SupertagRegistry` directly — for a caller that already has one (e.g.
 *  `workers/vault` boot-time wiring, or a test that wants to build a
 *  registry once and compose against it more than once). This is the
 *  "accept a `SupertagRegistry` as a parameter" alternative the task brief
 *  calls out. */
export function composePothosConfigFromRegistry(registry: SupertagRegistry): ComposedPothosConfig {
  const builder = new SchemaBuilder<{ Context: GraphQLComposerContext }>({});

  // ---------------------------------------------------------------------
  // Local types derived from `builder`'s own generics via TS instantiation
  // expressions + `Parameters`/`ReturnType`, rather than hand-spelling
  // Pothos's internal `SchemaTypes`/`PothosSchemaTypes` namespace generics
  // (fragile against Pothos version bumps and hard to get right by
  // inspection). Each is grounded in a REAL method on the concrete
  // `builder` instance above, so it always matches whatever Pothos
  // actually expects for that call, including across Pothos upgrades.
  // ---------------------------------------------------------------------

  type ObjectRefType = ReturnType<typeof builder.objectRef<SupertagNodeRecord>>;
  // Connection refs are STORED after `.implement()` (Pass 4 calls
  // `.objectRef(...).implement(...)` in one expression, unlike the
  // two-pass supertag refs above) — `.implement()`'s return type is a
  // plain `ObjectRef`, not the pre-implement `ImplementableObjectRef`
  // `objectRef()` alone returns, so the STORAGE type is derived one level
  // deeper than the pre-implement ref its `fields` thunk type comes from.
  type ConnectionImplementableRefType = ReturnType<typeof builder.objectRef<SupertagListResult>>;
  type ConnectionRefType = ReturnType<ConnectionImplementableRefType["implement"]>;

  type NodeFieldsShape = NonNullable<Parameters<ObjectRefType["implement"]>[0]["fields"]>;
  type NodeFieldBuilder = Parameters<NodeFieldsShape>[0];
  type NodeFieldMap = ReturnType<NodeFieldsShape>;

  type ConnectionFieldsShape = NonNullable<Parameters<ConnectionImplementableRefType["implement"]>[0]["fields"]>;
  type ConnectionFieldBuilder = Parameters<ConnectionFieldsShape>[0];

  type QueryFieldsShapeType = Parameters<typeof builder.queryFields>[0];
  type QueryFieldBuilder = Parameters<QueryFieldsShapeType>[0];
  type QueryFieldMap = ReturnType<QueryFieldsShapeType>;

  // `unionType`/`enumType` are generic over `Member`/`Param` — wrapping
  // each in a function with a CONCRETE parameter type (rather than taking
  // `ReturnType<typeof builder.unionType>` directly, which resolves against
  // the unconstrained generic) pins the instantiation so the returned ref
  // type is concrete too.
  function defineUnionType(
    name: string,
    memberRefs: ObjectRefType[],
    resolveType: (parent: SupertagNodeRecord) => string | undefined,
  ) {
    return builder.unionType(name, { types: memberRefs, resolveType });
  }
  type UnionRefType = ReturnType<typeof defineUnionType>;
  type EndpointRef = ObjectRefType | UnionRefType;

  function defineEnumType(name: string, values: Record<string, { value: string; description?: string }>) {
    return builder.enumType(name, { values });
  }
  type EnumRefType = ReturnType<typeof defineEnumType>;

  // ---------------------------------------------------------------------
  // Namespace bookkeeping (task brief point 6, "Namespace-collision
  // handling"): GraphQL type names, per-type field names, and root Query
  // field names are each their own shared namespace, separate from
  // `@enchiridion/schema`'s supertag-id namespace — see errors.ts's header.
  // ---------------------------------------------------------------------

  const typeNames = new NameRegistry("type_name_collision");
  const queryFieldNames = new NameRegistry("query_field_collision");
  const fieldNameRegistries = new Map<string, NameRegistry>();
  function fieldNamesFor(typeName: string): NameRegistry {
    let existing = fieldNameRegistries.get(typeName);
    if (!existing) {
      existing = new NameRegistry("field_name_collision");
      fieldNameRegistries.set(typeName, existing);
    }
    return existing;
  }

  // ---------------------------------------------------------------------
  // Pass 0: qualified supertags + GraphQL type-name assignment. A
  // supertag's `name` (e.g. "Person", "Company") is used verbatim through
  // `toPascalCase` (a no-op for already-PascalCase names, real
  // normalization for anything else) — collisions here are exactly the
  // "GraphQL type names are a separate namespace from supertag ids" case
  // the task brief calls out, since two different supertag ids could
  // declare the same display `name`.
  // ---------------------------------------------------------------------

  const supertags: readonly QualifiedSupertagDefinition[] = registry.allSupertags();
  const typeNameForTagID = new Map<string, string>();
  for (const supertag of supertags) {
    const typeName = toPascalCase(supertag.name);
    typeNames.claim(typeName, supertag.id);
    typeNameForTagID.set(supertag.id, typeName);
  }

  // ---------------------------------------------------------------------
  // Pass 1: reserve every object-type ref up front, UNIMPLEMENTED. Fields
  // are added in Pass 2 — reserving refs first is what lets a
  // self-referencing field (`Task.parent: Task`, `Task.subtasks: [Task!]!`)
  // and forward references between not-yet-implemented types resolve
  // without an ordering dependency.
  // ---------------------------------------------------------------------

  const refsByTagID = new Map<string, ObjectRefType>();
  for (const supertag of supertags) {
    const typeName = typeNameForTagID.get(supertag.id);
    if (!typeName) continue; // unreachable: every supertag got a type name in Pass 0.
    refsByTagID.set(supertag.id, builder.objectRef<SupertagNodeRecord>(typeName));
  }

  const enumRefsByPropertyKey = new Map<string, EnumRefType>();
  const enumTypeNameForPropertyKey = new Map<string, string>();

  /** Lazily creates (and memoizes) the GraphQL enum type for one `select`
   *  field, named `${OwningTypeName}${PascalCase(fieldID)}` — e.g.
   *  `TaskStatus`, `AreaStatus`, `ProjectStatus` for three different
   *  `status` fields on three different supertags, so same-named fields on
   *  different supertags never collide. Enum VALUE names are
   *  SCREAMING_SNAKE derived from the option id (`toEnumValueName`); each
   *  value's underlying Pothos `value:` is the option's own id string
   *  UNCHANGED, so a resolver returning the stored option id (not the
   *  GraphQL value name) round-trips correctly — matching
   *  `f.select()`'s doc comment that these ids are real stored data that
   *  must round-trip unchanged (`supertags/core/src/index.ts`'s header). */
  function getOrCreateEnumType(
    propertyKey: { supertagID: string; fieldID: string },
    definition: SupertagFieldDefinition,
  ): EnumRefType {
    const key = propertyKeyToString(propertyKey);
    const existing = enumRefsByPropertyKey.get(key);
    if (existing) return existing;

    const ownerTypeName = typeNameForTagID.get(propertyKey.supertagID);
    if (!ownerTypeName) {
      throw new GraphQLComposerError(
        "unresolvable_entity_reference",
        key,
        `select field ${key} is declared on unknown supertag "${propertyKey.supertagID}"`,
      );
    }

    const enumTypeName = `${ownerTypeName}${toPascalCase(propertyKey.fieldID)}`;
    typeNames.claim(enumTypeName, `select field ${key}`);

    const valueNames = new NameRegistry("enum_value_collision");
    const values: Record<string, { value: string; description?: string }> = {};
    for (const option of definition.options ?? []) {
      const valueName = toEnumValueName(option.id);
      valueNames.claim(valueName, option.id);
      values[valueName] = { value: option.id, description: option.name };
    }

    const ref = defineEnumType(enumTypeName, values);
    enumRefsByPropertyKey.set(key, ref);
    enumTypeNameForPropertyKey.set(key, enumTypeName);
    return ref;
  }

  const unionRefsByKey = new Map<string, UnionRefType>();

  /** Resolves the GraphQL output type for a set of endpoint supertag ids
   *  (an `entityReference` field's `allowedSupertagIDs`, or a relation's
   *  `from`/`to`) — the single referenced type directly, or a generated
   *  GraphQL union (`AOrB`, member order matching `tagIDs`' own order) when
   *  more than one supertag is allowed. Every member/target id must
   *  already have a reserved ref from Pass 1; an id that doesn't (a
   *  dangling reference to a supertag no loaded module declares) is a
   *  clear composition-time error, not a silently-skipped field. */
  function resolveEndpointType(tagIDs: readonly string[], ownerDescription: string): EndpointRef {
    if (tagIDs.length === 0) {
      throw new GraphQLComposerError(
        "unresolvable_entity_reference",
        ownerDescription,
        `${ownerDescription} has no endpoint supertags to resolve a GraphQL type from`,
      );
    }

    const [onlyID] = tagIDs;
    if (tagIDs.length === 1 && onlyID) {
      const ref = refsByTagID.get(onlyID);
      if (!ref) {
        throw new GraphQLComposerError(
          "unknown_relation_endpoint",
          onlyID,
          `${ownerDescription} references unknown supertag "${onlyID}"`,
        );
      }
      return ref;
    }

    const cacheKey = [...tagIDs].sort().join("|");
    const existingUnion = unionRefsByKey.get(cacheKey);
    if (existingUnion) return existingUnion;

    const memberRefs = tagIDs.map((id) => {
      const ref = refsByTagID.get(id);
      if (!ref) {
        throw new GraphQLComposerError(
          "unknown_relation_endpoint",
          id,
          `${ownerDescription} references unknown supertag "${id}"`,
        );
      }
      return ref;
    });
    const unionName = tagIDs.map((id) => typeNameForTagID.get(id) ?? id).join("Or");
    typeNames.claim(unionName, ownerDescription);

    const unionRef = defineUnionType(unionName, memberRefs, (parent) => {
      const match = tagIDs.find((id) => parent.tagIDs.includes(id));
      return match ? typeNameForTagID.get(match) : undefined;
    });
    unionRefsByKey.set(cacheKey, unionRef);
    return unionRef;
  }

  /** Builds one `entityReference` field: resolves the relation it
   *  canonically materializes (`registry.relationIDForProperty` —
   *  `packages/schema/src/relations.ts`), then a forward-direction
   *  resolver that goes through `request-loaders.ts`'s per-request batching
   *  loader, never a raw per-field accessor call. */
  function buildEntityReferenceField(
    t: NodeFieldBuilder,
    propertyKey: { supertagID: string; fieldID: string },
    definition: SupertagFieldDefinition,
  ): NodeFieldMap[string] {
    const relationID = registry.relationIDForProperty(propertyKey);
    const target = resolveEndpointType(
      definition.allowedSupertagIDs ?? [],
      `entityReference field ${propertyKeyToString(propertyKey)}`,
    );
    const multiple = Boolean(definition.allowsMultiple);
    const required = Boolean(definition.isRequired);

    if (multiple) {
      return t.field({
        type: [target],
        nullable: false,
        description: definition.name,
        resolve: async (parent, _args, ctx) => {
          const targets = (await relationTargetLoaderFor(ctx, relationID)(parent.id)) ?? [];
          return hydrateNodes(ctx, targets);
        },
      });
    }
    return t.field({
      type: target,
      nullable: !required,
      description: definition.name,
      resolve: async (parent, _args, ctx) => {
        const targets = (await relationTargetLoaderFor(ctx, relationID)(parent.id)) ?? [];
        const [targetID] = targets;
        if (!targetID) return null;
        const [hydrated] = await hydrateNodes(ctx, [targetID]);
        return hydrated ?? null;
      },
    });
  }

  /** Maps one effective field's `SupertagFieldType` to a Pothos field.
   *  Scalar mapping (task brief point 2): `text`/`url`/`email`/`phone` ->
   *  `String`; `number` -> `Float` (matches Swift's `SupertagValue.number
   *  (Double)`, `SupertagModels.swift` — a GraphQL `Int` is 32-bit and
   *  would truncate); `boolean` -> `Boolean`; `date`/`dateTime` -> `Float`
   *  epoch-milliseconds, matching `Page.createdAt`'s established `Float!`
   *  convention (`workers/vault/src/graphql/schema.ts`) rather than adding
   *  a bespoke date scalar this schema doesn't otherwise need; `select` ->
   *  a generated enum (`getOrCreateEnumType`); `entityReference` -> a typed
   *  relation field (`buildEntityReferenceField`). `allowsMultiple` wraps
   *  the scalar kinds in a non-null list of non-null items (`[X!]!`,
   *  defaulting to `[]` — never a null list, since "no values set" and "an
   *  empty list" are the same fact for a multi-valued property); a
   *  required single-valued field is `X!`, optional is `X`. */
  function buildField(t: NodeFieldBuilder, effectiveField: SupertagEffectiveField): NodeFieldMap[string] {
    const { propertyKey, definition } = effectiveField;
    const factKey = propertyKeyToString(propertyKey);
    const multiple = Boolean(definition.allowsMultiple);
    const required = Boolean(definition.isRequired);
    const description = definition.name;

    switch (definition.type) {
      case "text":
      case "url":
      case "email":
      case "phone":
        return multiple
          ? t.stringList({
              nullable: false,
              description,
              resolve: (parent) => (parent.facts[factKey] as string[] | undefined) ?? [],
            })
          : t.string({
              nullable: !required,
              description,
              resolve: (parent) => (parent.facts[factKey] as string | undefined) ?? null,
            });

      case "number":
        return multiple
          ? t.floatList({
              nullable: false,
              description,
              resolve: (parent) => (parent.facts[factKey] as number[] | undefined) ?? [],
            })
          : t.float({
              nullable: !required,
              description,
              resolve: (parent) => (parent.facts[factKey] as number | undefined) ?? null,
            });

      case "boolean":
        return multiple
          ? t.booleanList({
              nullable: false,
              description,
              resolve: (parent) => (parent.facts[factKey] as boolean[] | undefined) ?? [],
            })
          : t.boolean({
              nullable: !required,
              description,
              resolve: (parent) => (parent.facts[factKey] as boolean | undefined) ?? null,
            });

      case "date":
      case "dateTime":
        return multiple
          ? t.floatList({
              nullable: false,
              description,
              resolve: (parent) => (parent.facts[factKey] as number[] | undefined) ?? [],
            })
          : t.float({
              nullable: !required,
              description,
              resolve: (parent) => (parent.facts[factKey] as number | undefined) ?? null,
            });

      case "select": {
        const enumRef = getOrCreateEnumType(propertyKey, definition);
        return multiple
          ? t.field({
              type: [enumRef],
              nullable: false,
              description,
              resolve: (parent) => (parent.facts[factKey] as string[] | undefined) ?? [],
            })
          : t.field({
              type: enumRef,
              nullable: !required,
              description,
              resolve: (parent) => (parent.facts[factKey] as string | undefined) ?? null,
            });
      }

      case "entityReference":
        return buildEntityReferenceField(t, propertyKey, definition);

      default: {
        const exhaustive: never = definition.type;
        throw new GraphQLComposerError(
          "unresolvable_entity_reference",
          String(exhaustive),
          `field ${factKey} has an unhandled SupertagFieldType`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // Pass 2: implement every object type's fields — its own effective
  // fields (`registry.effectiveFields`, inheritance-resolved, see this
  // file's header) plus the 4 built-in node fields every supertag type
  // shares (mirrors `Page`'s `id`/`createdAt`/`modifiedAt`/`deletedAt`).
  // ---------------------------------------------------------------------

  for (const supertag of supertags) {
    const typeName = typeNameForTagID.get(supertag.id);
    const ref = refsByTagID.get(supertag.id);
    if (!typeName || !ref) continue; // unreachable: reserved together in Pass 1.

    const effectiveFields = registry.effectiveFields(supertag.id);
    const fieldNames = fieldNamesFor(typeName);

    const fieldsShape: NodeFieldsShape = (t) => {
      const fields: NodeFieldMap = {
        id: t.exposeString("id", { nullable: false }),
        createdAt: t.exposeFloat("createdAt", { nullable: false }),
        modifiedAt: t.exposeFloat("modifiedAt", { nullable: false }),
        deletedAt: t.exposeFloat("deletedAt", { nullable: true }),
      };
      fieldNames.claim("id", "built-in");
      fieldNames.claim("createdAt", "built-in");
      fieldNames.claim("modifiedAt", "built-in");
      fieldNames.claim("deletedAt", "built-in");

      for (const effectiveField of effectiveFields) {
        const fieldName = toCamelCase(effectiveField.propertyKey.fieldID);
        fieldNames.claim(fieldName, propertyKeyToString(effectiveField.propertyKey));
        fields[fieldName] = buildField(t, effectiveField);
      }
      return fields;
    };

    ref.implement({
      description: `A vault page tagged "${supertag.name}".`,
      fields: fieldsShape,
    });
  }

  // ---------------------------------------------------------------------
  // Pass 3: backlink/inverse fields for every relation with concrete
  // endpoints — added via `builder.objectFields` AFTER every object type
  // is already implemented (Pothos allows adding fields to an implemented
  // type incrementally; it does not allow calling `.implement()` twice).
  // Relations with no endpoints at all (`from: []`/`to: []` — the open
  // "system" `mentions` relation in `supertags/core`, backing `@mention`
  // rich-text edges rather than a scalar entityReference field) have
  // nothing to attach a backlink field TO and are skipped, matching
  // `GraphDataModel.md`'s framing of that relation as a graph projection
  // with no fixed endpoint types.
  // ---------------------------------------------------------------------

  const relations: readonly QualifiedRelationDefinition[] = registry.allRelations();
  for (const relation of relations) {
    if (relation.from.length === 0 || relation.to.length === 0) continue;

    const inverseFieldName = toCamelCase(relation.inverseName);
    const sourceType = resolveEndpointType(relation.from, `relation "${relation.id}" (from)`);
    // Cardinality reads "<source-side>To<target-side>": "manyToOne" means
    // many sources per one target, so the FORWARD direction (source ->
    // target) is single-valued and the INVERSE (target -> its sources) is
    // a list; "manyToMany" is a list both ways. Only the inverse shape is
    // needed here — the forward shape already comes from the
    // `entityReference` field's own `allowsMultiple` (Pass 2).
    const inverseMultiple = relation.cardinality === "manyToOne" || relation.cardinality === "manyToMany";

    for (const targetTagID of relation.to) {
      const targetTypeName = typeNameForTagID.get(targetTagID);
      const targetRef = refsByTagID.get(targetTagID);
      if (!targetTypeName || !targetRef) {
        throw new GraphQLComposerError(
          "unknown_relation_endpoint",
          targetTagID,
          `relation "${relation.id}" targets unknown supertag "${targetTagID}"`,
        );
      }
      fieldNamesFor(targetTypeName).claim(inverseFieldName, relation.id);

      const backlinkFieldsShape: NodeFieldsShape = (t) => ({
        [inverseFieldName]: inverseMultiple
          ? t.field({
              type: [sourceType],
              nullable: false,
              resolve: async (parent, _args, ctx) => {
                const sources = (await relationSourceLoaderFor(ctx, relation.id)(parent.id)) ?? [];
                return hydrateNodes(ctx, sources);
              },
            })
          : t.field({
              type: sourceType,
              nullable: true,
              resolve: async (parent, _args, ctx) => {
                const sources = (await relationSourceLoaderFor(ctx, relation.id)(parent.id)) ?? [];
                const [sourceID] = sources;
                if (!sourceID) return null;
                const [hydrated] = await hydrateNodes(ctx, [sourceID]);
                return hydrated ?? null;
              },
            }),
      });
      builder.objectFields(targetRef, backlinkFieldsShape);
    }
  }

  // ---------------------------------------------------------------------
  // Pass 4: root Query fields + per-supertag Connection type, mirroring
  // `Page`'s `Query.page`/`Query.pages`/`PageConnection`
  // (`workers/vault/src/graphql/schema.ts`) across every supertag.
  // ---------------------------------------------------------------------

  const connectionRefsByTagID = new Map<string, ConnectionRefType>();
  function getOrCreateConnectionType(tagID: string, typeName: string, ref: ObjectRefType): ConnectionRefType {
    const existing = connectionRefsByTagID.get(tagID);
    if (existing) return existing;

    const connectionName = `${typeName}Connection`;
    typeNames.claim(connectionName, tagID);
    const connectionRef = builder.objectRef<SupertagListResult>(connectionName).implement({
      description: `A single page of ${typeName} results.`,
      fields: (t: ConnectionFieldBuilder) => ({
        items: t.field({ type: [ref], nullable: false, resolve: (parent) => parent.items }),
        nextCursor: t.string({ nullable: true, resolve: (parent) => parent.nextCursor }),
      }),
    });
    connectionRefsByTagID.set(tagID, connectionRef);
    return connectionRef;
  }

  const queryFieldNameForTagID = new Map<string, { singular: string; plural: string }>();

  builder.queryType({
    fields: (t: QueryFieldBuilder) => {
      const fields: QueryFieldMap = {};

      for (const supertag of supertags) {
        const typeName = typeNameForTagID.get(supertag.id);
        const ref = refsByTagID.get(supertag.id);
        if (!typeName || !ref) continue; // unreachable: reserved in Pass 1.

        const singularName = lowerFirst(typeName);
        const pluralName = pluralize(singularName);
        queryFieldNames.claim(singularName, supertag.id);
        queryFieldNames.claim(pluralName, supertag.id);
        queryFieldNameForTagID.set(supertag.id, { singular: singularName, plural: pluralName });

        const connectionRef = getOrCreateConnectionType(supertag.id, typeName, ref);
        const tagID = supertag.id;

        fields[singularName] = t.field({
          type: ref,
          nullable: true,
          args: { id: t.arg.string({ required: true }) },
          resolve: (_root, args, ctx) => ctx.vault.getNodeWithFacts(args.id),
        });

        fields[pluralName] = t.field({
          type: connectionRef,
          nullable: false,
          args: {
            limit: t.arg.int({ required: false }),
            cursor: t.arg.string({ required: false }),
          },
          resolve: (_root, args, ctx) =>
            ctx.vault.listNodesByTag(tagID, {
              limit: args.limit ?? undefined,
              cursor: args.cursor ?? undefined,
            }),
        });
      }

      return fields;
    },
  });

  const schema: GraphQLSchema = builder.toSchema();

  return {
    registry,
    builder,
    schema,
    typeNameForTagID,
    objectRefForTagID: refsByTagID,
    enumTypeNameForPropertyKey,
    queryFieldNameForTagID,
  };
}
