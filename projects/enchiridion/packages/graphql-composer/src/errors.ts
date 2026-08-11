// @enchiridion/graphql-composer — composer-time errors.
//
// GraphQL's type-name namespace is separate from `@enchiridion/schema`'s
// supertag-id namespace (packages/schema's `SupertagRegistry.build()`
// already guarantees no two supertags/relations/projections/view-types
// share a fully-qualified *id* across modules — see registry.ts). Two
// modules can still declare supertags with the same *display* `name`
// ("Task" from `dev.rawkode.a.task` and `dev.rawkode.b.task`), which would
// collide as GraphQL type names even though their ids never collide. This
// file's `GraphQLComposerError` is how `composePothosConfig` surfaces that
// class of problem (and its cousins: field-name collisions on one object
// type, root Query field-name collisions, and relation endpoints that
// don't resolve to any loaded supertag) as a clear build-time failure
// rather than one module's type silently shadowing another's — task brief
// point 6 ("Namespace-collision handling").

export type GraphQLComposerErrorCode =
  | "type_name_collision"
  | "field_name_collision"
  | "enum_value_collision"
  | "query_field_collision"
  | "unknown_relation_endpoint"
  | "unresolvable_entity_reference";

/** Thrown by `composePothosConfig`/`composePothosConfigFromRegistry` on the
 *  first composition-time problem found. `code` is the machine-checkable
 *  discriminant (tests assert on it, mirroring
 *  `@enchiridion/schema`'s `SupertagRegistryError`); `detail` is the
 *  offending name (a GraphQL type/field/enum-value name, or a relation/
 *  supertag id). */
export class GraphQLComposerError extends Error {
  readonly code: GraphQLComposerErrorCode;
  readonly detail: string;

  constructor(code: GraphQLComposerErrorCode, detail: string, message?: string) {
    super(message ?? `${code}: ${detail}`);
    this.name = "GraphQLComposerError";
    this.code = code;
    this.detail = detail;
  }
}

/** Claims a name in one shared namespace (GraphQL type names, or field
 *  names scoped to one object type, or root Query field names), throwing a
 *  clearly-coded `GraphQLComposerError` the first time two different
 *  owners claim the same name. Re-claiming a name already owned by the
 *  SAME owner is a no-op (lets a single supertag's own composition touch a
 *  name more than once without tripping the check on itself). */
export class NameRegistry {
  private readonly owners = new Map<string, string>();

  constructor(private readonly code: GraphQLComposerErrorCode) {}

  claim(name: string, owner: string): void {
    const existing = this.owners.get(name);
    if (existing !== undefined && existing !== owner) {
      throw new GraphQLComposerError(
        this.code,
        name,
        `"${name}" is claimed by both ${existing} and ${owner} — GraphQL type/field names are a namespace separate from supertag ids, and this collision must be resolved by renaming one of them`,
      );
    }
    this.owners.set(name, owner);
  }

  ownerOf(name: string): string | undefined {
    return this.owners.get(name);
  }
}
