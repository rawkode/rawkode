// @enchiridion/schema — module registry validation.
//
// Port of `ModuleRegistry` / `ModuleRegistryError` / `ModuleNamespace`
// (apps/enchiridion/Sources/EnchiridionCore/ModuleFoundation.swift) plus the
// plan's "additive-only upgrades" and "acyclic inheritance DAG" rules (plan
// §Supertag module contract) that the Swift file doesn't literally implement
// as registry-time checks (Swift's inheritance resolution is cycle-*tolerant*
// at read time — see inheritance.ts's header — and its additive-upgrade
// check lives in `LibraryRepository.additivelyMergedModuleSupertag`, a
// runtime DB-reconciliation merge, not a registry-construction check). Here,
// modules are the sole source of truth for their own schema (no partial
// runtime patches to reconcile against), so both are enforced up front, at
// build time, per this task's brief — see each function's doc comment for
// exactly where behavior diverges from Swift and why.
//
// Two entry points, per the file's two use cases:
//   - `defineSupertagModule()` / `qualifyModule()`: single-module sanity
//     check, callable with no other modules loaded yet (what a supertag
//     module file itself calls at definition time).
//   - `SupertagRegistry.build()`: cross-module check across every loaded
//     module (what graph-core's eventual consumers call once, with every
//     supertag module loaded together) — namespace collisions and inheritance
//     cycles can only be fully verified once every module is present.

import {
  effectiveFields,
  effectiveTagIDs,
  type QualifiedSupertagDefinition,
  type SupertagEffectiveField,
  type SupertagPropertyKey,
} from "./inheritance";
import { propertyKeyForRelation, relationIDForProperty, type QualifiedRelationDefinition } from "./relations";
import { isSafeProjectionStatement, isValidProjectionViewName } from "./sql-safety";
import type { RelationDefinition, SupertagDefinition, SupertagModule } from "./types";

export type SupertagRegistryErrorCode =
  | "invalid_module"
  | "duplicate_module"
  | "identifier_collision"
  | "foreign_declaration"
  | "incompatible_upgrade"
  | "invalid_projection"
  | "duplicate_projection_view"
  | "cyclic_inheritance";

/** TS analog of `ModuleRegistryError` (ModuleFoundation.swift:103-121).
 *  `code` is the machine-checkable discriminant (tests assert on it);
 *  `detail` is the offending identifier (module id, tag/relation/projection
 *  id, view name, or `"a -> b -> a"`-shaped cycle path). */
export class SupertagRegistryError extends Error {
  readonly code: SupertagRegistryErrorCode;
  readonly detail: string;

  constructor(code: SupertagRegistryErrorCode, detail: string, message?: string) {
    super(message ?? `${code}: ${detail}`);
    this.name = "SupertagRegistryError";
    this.code = code;
    this.detail = detail;
  }
}

export interface QualifiedProjectionDefinition {
  /** Namespaced declaration id — defaults to `${module.id}.projection.${viewName}`. */
  id: string;
  /** Public SQL view name — the object key in `SupertagModule.projections`. */
  viewName: string;
  version: number;
  sql: string;
}

export interface QualifiedModule {
  id: string;
  version: number;
  supertags: QualifiedSupertagDefinition[];
  relations: QualifiedRelationDefinition[];
  projections: QualifiedProjectionDefinition[];
  viewTypeIDs: string[];
}

function ownsIdentifier(moduleID: string, identifier: string): boolean {
  return identifier === moduleID || identifier.startsWith(`${moduleID}.`);
}

/** Depth-first cycle check over a supertag set's `parents` edges. Throws
 *  `SupertagRegistryError("cyclic_inheritance", ...)` with the cycle path on
 *  the first back-edge found; silently skips parent ids that aren't in
 *  `supertags` (a dangling/not-yet-loaded reference isn't this check's
 *  problem — `effectiveFields`/`effectiveTagIDs` already tolerate those). */
function assertAcyclic(supertags: readonly QualifiedSupertagDefinition[]): void {
  const byID = new Map(supertags.map((s) => [s.id, s] as const));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function visit(id: string): void {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart), id];
      throw new SupertagRegistryError("cyclic_inheritance", cycle.join(" -> "));
    }
    const definition = byID.get(id);
    if (!definition) return;

    state.set(id, "visiting");
    stack.push(id);
    for (const parentID of definition.parents ?? []) visit(parentID);
    stack.pop();
    state.set(id, "done");
  }

  for (const supertag of supertags) visit(supertag.id);
}

/** Single-module validation + identifier derivation. Called by both
 *  `defineSupertagModule()` (module-definition time, no registry) and
 *  `SupertagRegistry.build()` (once per module, before cross-module checks).
 *  Throws `SupertagRegistryError` on the first violation found; never
 *  mutates `module`. */
export function qualifyModule(module: SupertagModule): QualifiedModule {
  const moduleID = typeof module.id === "string" ? module.id.trim() : "";
  if (moduleID.length === 0) {
    throw new SupertagRegistryError("invalid_module", module.id ?? "", "module id must be a non-empty string");
  }
  if (!Number.isInteger(module.version) || module.version <= 0) {
    throw new SupertagRegistryError("invalid_module", moduleID, `module ${moduleID} version must be a positive integer`);
  }

  const localIdentifiers = new Set<string>();
  const claim = (kind: string, id: string): void => {
    if (!ownsIdentifier(moduleID, id)) {
      throw new SupertagRegistryError("foreign_declaration", id, `module ${moduleID} does not own ${kind} id ${id}`);
    }
    if (localIdentifiers.has(`${kind}:${id}`)) {
      throw new SupertagRegistryError("identifier_collision", id);
    }
    localIdentifiers.add(`${kind}:${id}`);
  };

  const supertags: QualifiedSupertagDefinition[] = Object.entries(module.supertags ?? {}).map(([key, def]) => {
    const id = def.id ?? `${moduleID}.${key}`;
    claim("supertag", id);
    return { ...def, id };
  });

  const relations: QualifiedRelationDefinition[] = Object.entries(module.relations ?? {}).map(([key, def]) => {
    const id = def.id ?? `${moduleID}.${key}`;
    claim("relation", id);
    return { ...def, id };
  });

  const projections: QualifiedProjectionDefinition[] = Object.entries(module.projections ?? {}).map(
    ([viewName, def]) => {
      if (!isValidProjectionViewName(viewName)) {
        throw new SupertagRegistryError("invalid_projection", viewName, `invalid projection view name "${viewName}"`);
      }
      if (!Number.isInteger(def.version) || def.version <= 0) {
        throw new SupertagRegistryError("invalid_projection", viewName, `projection "${viewName}" must have a positive version`);
      }
      if (!isSafeProjectionStatement(def.sql)) {
        throw new SupertagRegistryError(
          "invalid_projection",
          viewName,
          `projection "${viewName}" is not a single, safe SELECT statement`,
        );
      }
      const id = def.id ?? `${moduleID}.projection.${viewName}`;
      claim("projection", id);
      return { id, viewName, version: def.version, sql: def.sql };
    },
  );

  const viewTypeIDs = (module.ui?.viewTypes ?? []).map((id) => {
    claim("viewType", id);
    return id;
  });

  // Cycle check limited to this module's own supertags — cross-module
  // cycles can only be detected once every module is loaded, which is
  // SupertagRegistry.build()'s job.
  assertAcyclic(supertags);

  return { id: moduleID, version: module.version, supertags, relations, projections, viewTypeIDs };
}

/**
 * Defines a supertag module: validates it in isolation (namespace
 * self-consistency, projection SQL safety, internally-acyclic inheritance)
 * and returns it unchanged. Cross-module checks (identifier collisions
 * across modules, cross-module inheritance cycles) require a
 * `SupertagRegistry` — see `SupertagRegistry.build()`, which every
 * supertag-module-loading consumer (graph-core, graphql-composer, codegen)
 * is expected to call once with the full loaded module set.
 *
 * Port of `ModuleRegistry`'s per-module validation
 * (apps/enchiridion/Sources/EnchiridionCore/ModuleFoundation.swift) — see
 * this file's header for exactly what's ported vs. adapted.
 */
export function defineSupertagModule(module: SupertagModule): SupertagModule {
  qualifyModule(module);
  return module;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeSQL(sql: string): string {
  return sql.trim().replace(/\s+/g, " ");
}

/**
 * Validates that `next` is a well-formed, additive-only upgrade of
 * `previous` (same module id): existing supertags/fields/relations/
 * projections may not be removed, and an existing field's `type` or
 * `allowsMultiple` (cardinality) may not change — a rename must be a new
 * field id, never a mutation of the old one. New supertags, fields,
 * relations, and projections are always fine. Throws
 * `SupertagRegistryError("incompatible_upgrade", ...)` on the first
 * violation.
 *
 * Adapted from `LibraryRepository.additivelyMergedModuleSupertag`
 * (ModuleFoundation.swift:383-404) and `reconcileModuleProjections`'s
 * version/statement immutability rule (ModuleFoundation.swift:260-337).
 * Deliberately stricter than Swift's field-merge behavior: Swift silently
 * re-adds a field the new declaration omits (a DB-reconciliation
 * compatibility shim for partial runtime patches); this validator rejects
 * that omission outright, because a TS module's declared `fields` is always
 * the module's complete, authoritative field set for that supertag — an
 * omission is far more likely an accidental breaking change than an
 * intentional partial patch.
 */
export function validateAdditiveUpgrade(previous: SupertagModule, next: SupertagModule): void {
  if (previous.id !== next.id) {
    throw new SupertagRegistryError("invalid_module", next.id, "an upgrade must target the same module id");
  }
  if (!Number.isInteger(next.version) || next.version < previous.version) {
    throw new SupertagRegistryError("incompatible_upgrade", next.id, `module ${next.id} version must not decrease`);
  }

  for (const [tagKey, oldTag] of Object.entries(previous.supertags ?? {})) {
    const newTag: SupertagDefinition | undefined = next.supertags?.[tagKey];
    if (!newTag) {
      throw new SupertagRegistryError("incompatible_upgrade", tagKey, `supertag "${tagKey}" was removed`);
    }
    for (const [fieldKey, oldField] of Object.entries(oldTag.fields ?? {})) {
      const newField = newTag.fields?.[fieldKey];
      const path = `${tagKey}.${fieldKey}`;
      if (!newField) {
        throw new SupertagRegistryError(
          "incompatible_upgrade",
          path,
          `field "${path}" was removed — a rename must be a new field id, not a removal`,
        );
      }
      if (newField.type !== oldField.type || Boolean(newField.allowsMultiple) !== Boolean(oldField.allowsMultiple)) {
        throw new SupertagRegistryError(
          "incompatible_upgrade",
          path,
          `field "${path}" changed type or cardinality — a retype must be a new field id`,
        );
      }
    }
  }

  for (const [relationKey, oldRelation] of Object.entries(previous.relations ?? {})) {
    const newRelation: RelationDefinition | undefined = next.relations?.[relationKey];
    if (!newRelation) {
      throw new SupertagRegistryError("incompatible_upgrade", relationKey, `relation "${relationKey}" was removed`);
    }
    if (
      newRelation.cardinality !== oldRelation.cardinality ||
      !sameStringArray(newRelation.from, oldRelation.from) ||
      !sameStringArray(newRelation.to, oldRelation.to)
    ) {
      throw new SupertagRegistryError(
        "incompatible_upgrade",
        relationKey,
        `relation "${relationKey}" changed cardinality or endpoints`,
      );
    }
  }

  for (const [viewName, oldProjection] of Object.entries(previous.projections ?? {})) {
    const newProjection = next.projections?.[viewName];
    if (!newProjection) {
      throw new SupertagRegistryError("incompatible_upgrade", viewName, `projection "${viewName}" was removed`);
    }
    if (newProjection.version < oldProjection.version) {
      throw new SupertagRegistryError("incompatible_upgrade", viewName, `projection "${viewName}" version decreased`);
    }
    if (newProjection.version === oldProjection.version && normalizeSQL(newProjection.sql) !== normalizeSQL(oldProjection.sql)) {
      throw new SupertagRegistryError(
        "incompatible_upgrade",
        viewName,
        `projection "${viewName}" changed SQL without a version bump`,
      );
    }
  }
}

/**
 * Immutable registry over every loaded supertag module, validated once at
 * construction — port of `ModuleRegistry`
 * (ModuleFoundation.swift:125-186). Consumers that load multiple supertag
 * modules together (graph-core, graphql-composer, codegen, and eventually
 * vault) build one `SupertagRegistry` from the full module set and use it
 * as the source of truth for namespace ownership, effective-schema
 * resolution, and relation lookups.
 */
export class SupertagRegistry {
  readonly modules: readonly SupertagModule[];
  readonly qualifiedModules: readonly QualifiedModule[];

  private constructor(modules: readonly SupertagModule[], qualifiedModules: readonly QualifiedModule[]) {
    this.modules = modules;
    this.qualifiedModules = qualifiedModules;
  }

  /** Validates and builds a registry from every module in `modules`.
   *  Modules are processed in id-sorted order so error ordering is
   *  deterministic (matches Swift's `manifests.sorted { $0.id < $1.id }`,
   *  ModuleFoundation.swift:129). Throws `SupertagRegistryError` on the
   *  first violation found: duplicate module id, a namespace violation or
   *  invalid projection from `qualifyModule`, a supertag/relation/
   *  projection-declaration/view-type id collision across modules, a
   *  duplicate projection view name across modules, or a cross-module
   *  inheritance cycle. */
  static build(modules: readonly SupertagModule[]): SupertagRegistry {
    const ordered = [...modules].sort((a, b) => a.id.localeCompare(b.id));
    const seenModuleIDs = new Set<string>();
    const qualifiedModules: QualifiedModule[] = [];

    const supertagIDs = new Set<string>();
    const relationIDs = new Set<string>();
    const projectionDeclarationIDs = new Set<string>();
    const projectionViewNames = new Set<string>();
    const viewTypeIDs = new Set<string>();

    for (const module of ordered) {
      if (seenModuleIDs.has(module.id)) {
        throw new SupertagRegistryError("duplicate_module", module.id);
      }
      seenModuleIDs.add(module.id);

      const qualified = qualifyModule(module);

      for (const supertag of qualified.supertags) {
        if (supertagIDs.has(supertag.id)) throw new SupertagRegistryError("identifier_collision", supertag.id);
        supertagIDs.add(supertag.id);
      }
      for (const relation of qualified.relations) {
        if (relationIDs.has(relation.id)) throw new SupertagRegistryError("identifier_collision", relation.id);
        relationIDs.add(relation.id);
      }
      for (const viewTypeID of qualified.viewTypeIDs) {
        if (viewTypeIDs.has(viewTypeID)) throw new SupertagRegistryError("identifier_collision", viewTypeID);
        viewTypeIDs.add(viewTypeID);
      }
      for (const projection of qualified.projections) {
        if (projectionDeclarationIDs.has(projection.id)) {
          throw new SupertagRegistryError("identifier_collision", projection.id);
        }
        projectionDeclarationIDs.add(projection.id);
        if (projectionViewNames.has(projection.viewName)) {
          throw new SupertagRegistryError("duplicate_projection_view", projection.viewName);
        }
        projectionViewNames.add(projection.viewName);
      }

      qualifiedModules.push(qualified);
    }

    // Cross-module cyclic inheritance: a supertag in one module may declare
    // a parent owned by another module (plan's `parents: [core.event]`
    // example) — only detectable once every module is loaded.
    const allSupertags = qualifiedModules.flatMap((m) => m.supertags);
    assertAcyclic(allSupertags);

    return new SupertagRegistry(ordered, qualifiedModules);
  }

  /** Convenience for the single-module case — equivalent to
   *  `SupertagRegistry.build([module])`. */
  static single(module: SupertagModule): SupertagRegistry {
    return SupertagRegistry.build([module]);
  }

  /** Returns a new registry with `module` added, re-validating the full
   *  cross-module set (namespace collisions and inheritance cycles can
   *  reappear with the new module present). */
  withModule(module: SupertagModule): SupertagRegistry {
    return SupertagRegistry.build([...this.modules, module]);
  }

  /** Validates `next` as an additive-only upgrade of the module currently
   *  registered under `next.id` (see `validateAdditiveUpgrade`), then
   *  returns a new registry with it applied. Throws
   *  `SupertagRegistryError("invalid_module", ...)` if `next.id` isn't
   *  already registered — use `withModule()` for a brand-new module. */
  upgrade(next: SupertagModule): SupertagRegistry {
    const previous = this.getModule(next.id);
    if (!previous) {
      throw new SupertagRegistryError("invalid_module", next.id, `module ${next.id} is not registered; use withModule() for a new module`);
    }
    validateAdditiveUpgrade(previous, next);
    const others = this.modules.filter((m) => m.id !== next.id);
    return SupertagRegistry.build([...others, next]);
  }

  getModule(id: string): SupertagModule | undefined {
    return this.modules.find((m) => m.id === id);
  }

  allSupertags(): QualifiedSupertagDefinition[] {
    return this.qualifiedModules.flatMap((m) => m.supertags);
  }

  allRelations(): QualifiedRelationDefinition[] {
    return this.qualifiedModules.flatMap((m) => m.relations);
  }

  allProjections(): QualifiedProjectionDefinition[] {
    return this.qualifiedModules.flatMap((m) => m.projections);
  }

  getSupertag(id: string): QualifiedSupertagDefinition | undefined {
    return this.allSupertags().find((s) => s.id === id);
  }

  /** TS port of `SupertagInheritance.effectiveFields`, resolved against
   *  every supertag across every loaded module (inheritance.ts). */
  effectiveFields(tagID: string): SupertagEffectiveField[] {
    return effectiveFields(tagID, this.allSupertags());
  }

  /** TS port of `SupertagInheritance.effectiveTagIDs`, resolved against
   *  every supertag across every loaded module (inheritance.ts). */
  effectiveTagIDs(tagIDs: Iterable<string>): Set<string> {
    return effectiveTagIDs(tagIDs, this.allSupertags());
  }

  /** TS port of `BuiltInRelations.relationID(for:)` (relations.ts). */
  relationIDForProperty(key: SupertagPropertyKey): string {
    return relationIDForProperty(key, this.allRelations());
  }

  /** TS port of `BuiltInRelations.propertyKey(for:)` (relations.ts). */
  propertyKeyForRelation(relationID: string): SupertagPropertyKey | undefined {
    return propertyKeyForRelation(relationID, this.allRelations());
  }
}
