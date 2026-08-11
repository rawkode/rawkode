// @enchiridion/schema — supertag inheritance DAG resolution.
//
// Port of `SupertagInheritance` (and the `SupertagEffectiveField` /
// `SupertagPropertyKey` shapes it produces) from
// apps/enchiridion/Sources/EnchiridionCore/GraphOntology.swift:1-86 and
// SupertagModels.swift:164-174.
//
// Field identity is the FULL `(supertagID, fieldID)` property key, never
// just the local fieldID — this is what lets `person.email` and
// `customer.email` coexist in one effective schema (Swift's
// `SupertagEffectiveField` doc comment, GraphOntology.swift:3-6).

import type { SupertagDefinition, SupertagFieldDefinition } from "./types";

/** A supertag with its identity resolved to a fully-qualified id — the
 *  input shape `effectiveFields`/`effectiveTagIDs` operate over. Produced by
 *  `qualifyModule`/`SupertagRegistry` (registry.ts) once a module's `id` is
 *  known; kept as a separate type here (rather than requiring `id` on
 *  `SupertagDefinition` itself) so inheritance.ts has no dependency on how
 *  ids get derived. */
export interface QualifiedSupertagDefinition extends SupertagDefinition {
  id: string;
}

/** A property's full identity — matches `SupertagPropertyKey`
 *  (SupertagModels.swift:164-174). */
export interface SupertagPropertyKey {
  supertagID: string;
  fieldID: string;
}

/** Matches Swift's `SupertagPropertyKey.storageKey`
 *  (SupertagModels.swift:173). */
export function propertyKeyToString(key: SupertagPropertyKey): string {
  return `${key.supertagID}:${key.fieldID}`;
}

export function propertyKeysEqual(a: SupertagPropertyKey, b: SupertagPropertyKey): boolean {
  return a.supertagID === b.supertagID && a.fieldID === b.fieldID;
}

/** A property inherited through a supertag hierarchy without losing the
 *  schema that owns it — matches `SupertagEffectiveField`
 *  (GraphOntology.swift:7-25). */
export interface SupertagEffectiveField {
  propertyKey: SupertagPropertyKey;
  definition: SupertagFieldDefinition;
}

/** Port of `SupertagInheritance.effectiveTagIDs(for:definitions:)`
 *  (GraphOntology.swift:28-45). Cycle-tolerant by design (matches Swift's
 *  `testEffectiveTagIDsTerminateAndIncludeEveryTagInACycle`): a mutual-parent
 *  cycle terminates and every tag in it ends up in the result, it does not
 *  throw. `SupertagRegistry`/`qualifyModule` (registry.ts) reject cyclic
 *  inheritance earlier, at module-load time — this function stays
 *  defensively cycle-safe underneath that as a second line of defense, the
 *  same way Swift's runtime resolution does. */
export function effectiveTagIDs(
  directTagIDs: Iterable<string>,
  definitions: readonly QualifiedSupertagDefinition[],
): Set<string> {
  const byID = new Map(definitions.map((d) => [d.id, d] as const));
  const effective = new Set(directTagIDs);
  const pending = [...effective];

  while (pending.length > 0) {
    const tagID = pending.pop() as string;
    const definition = byID.get(tagID);
    if (!definition) continue;
    for (const parentID of definition.parents ?? []) {
      if (!effective.has(parentID)) {
        effective.add(parentID);
        pending.push(parentID);
      }
    }
  }
  return effective;
}

/** Port of `SupertagInheritance.effectiveFields(for:definitions:)`
 *  (GraphOntology.swift:53-85). Parents are traversed in their declared
 *  order before the child; each live schema is visited once (diamond
 *  inheritance and cycles are both handled without duplicating an
 *  ancestor's fields); field ownership stays the schema that declared it. */
export function effectiveFields(
  selectedTagID: string,
  definitions: readonly QualifiedSupertagDefinition[],
): SupertagEffectiveField[] {
  const byID = new Map(definitions.map((d) => [d.id, d] as const));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const fields: SupertagEffectiveField[] = [];

  function visit(tagID: string): void {
    if (visited.has(tagID) || visiting.has(tagID)) return;
    const definition = byID.get(tagID);
    if (!definition) return;

    visiting.add(tagID);
    for (const parentID of definition.parents ?? []) visit(parentID);
    visiting.delete(tagID);
    visited.add(tagID);

    for (const [fieldID, fieldDefinition] of Object.entries(definition.fields)) {
      fields.push({ propertyKey: { supertagID: definition.id, fieldID }, definition: fieldDefinition });
    }
  }

  visit(selectedTagID);
  return fields;
}
