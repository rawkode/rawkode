// @enchiridion/schema — relation <-> entityReference-field resolution.
//
// Port of `BuiltInRelations.relationID(for:)` / `.propertyKey(for:)`
// (apps/enchiridion/Sources/EnchiridionCore/GraphOntology.swift:119-161).
//
// Swift's version is a hardcoded switch table over a small fixed set of
// built-in relations. This module system is data-driven (modules declare
// arbitrary relations, not a closed fixed set), so the pairing between an
// entityReference field and the relation it compiles to is carried
// explicitly on `RelationDefinition.property` (types.ts) rather than
// inferred from field/relation naming — the *fallback* behavior (an
// undeclared pairing gets a synthetic `property-relation:<tag>:<field>` id)
// is still ported exactly, including the reverse parse.

import type { SupertagPropertyKey } from "./inheritance";
import type { RelationDefinition } from "./types";

/** A relation with its identity resolved to a fully-qualified id — produced
 *  by `qualifyModule`/`SupertagRegistry` (registry.ts), mirroring
 *  `QualifiedSupertagDefinition` (inheritance.ts). */
export interface QualifiedRelationDefinition extends RelationDefinition {
  id: string;
}

const SYNTHETIC_PREFIX = "property-relation:";

/** Port of `BuiltInRelations.relationID(for:)`
 *  (GraphOntology.swift:119-136). Returns the id of the relation whose
 *  `property` matches `key`, or the synthetic fallback id if no relation
 *  declares that pairing — matching Swift's `default: .init(rawValue:
 *  "property-relation:\(tag):\(field)")` branch exactly. */
export function relationIDForProperty(
  key: SupertagPropertyKey,
  relations: readonly QualifiedRelationDefinition[],
): string {
  const declared = relations.find(
    (relation) => relation.property?.supertagID === key.supertagID && relation.property?.fieldID === key.fieldID,
  );
  if (declared) return declared.id;
  return `${SYNTHETIC_PREFIX}${key.supertagID}:${key.fieldID}`;
}

/** Port of `BuiltInRelations.propertyKey(for:)`
 *  (GraphOntology.swift:138-161): the inverse of `relationIDForProperty`,
 *  including parsing the synthetic `property-relation:<tag>:<field>` id
 *  back into its property key when no relation declares the pairing
 *  explicitly. Returns `undefined` for a relation id that has neither an
 *  explicit `property` nor the synthetic shape (matches Swift's `return
 *  nil` default). */
export function propertyKeyForRelation(
  relationID: string,
  relations: readonly QualifiedRelationDefinition[],
): SupertagPropertyKey | undefined {
  const declared = relations.find((relation) => relation.id === relationID);
  if (declared?.property) return declared.property;

  if (!relationID.startsWith(SYNTHETIC_PREFIX)) return undefined;
  const rest = relationID.slice(SYNTHETIC_PREFIX.length);
  const separatorIndex = rest.indexOf(":");
  if (separatorIndex === -1) return undefined;
  return {
    supertagID: rest.slice(0, separatorIndex),
    fieldID: rest.slice(separatorIndex + 1),
  };
}
