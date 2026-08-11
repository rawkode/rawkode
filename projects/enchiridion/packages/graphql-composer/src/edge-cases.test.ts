// @enchiridion/graphql-composer — composition-time error handling and the
// GraphQL-union path for `entityReference` fields with more than one
// `allowedSupertagIDs` entry. `supertags/core` never exercises either of
// these (every collision/endpoint reference there is well-formed, and
// every entityReference field targets exactly one supertag), so this file
// uses small synthetic modules built directly against `@enchiridion/schema`
// to cover them.

import { describe, expect, test } from "bun:test";
import { graphql, printSchema } from "graphql";
import { defineSupertagModule, f, type SupertagModule } from "@enchiridion/schema";
import { composePothosConfig, GraphQLComposerError } from "./index";
import { FakeAccessors } from "./test-helpers/fake-accessors";

function moduleWithTaskNamed(id: string): SupertagModule {
  return defineSupertagModule({
    id,
    version: 1,
    supertags: { task: { name: "Task", symbol: "checkmark", fields: {} } },
  });
}

describe("GraphQL type-name collisions across modules", () => {
  test("two modules declaring the same display name throw type_name_collision, not a silent shadow", () => {
    const moduleA = moduleWithTaskNamed("dev.rawkode.composertest.a");
    const moduleB = moduleWithTaskNamed("dev.rawkode.composertest.b");

    expect(() => composePothosConfig([moduleA, moduleB])).toThrow(GraphQLComposerError);
    try {
      composePothosConfig([moduleA, moduleB]);
      throw new Error("expected composePothosConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphQLComposerError);
      expect((error as GraphQLComposerError).code).toBe("type_name_collision");
    }
  });

  test("composing the same module against itself twice does not collide (same owner, re-claim is a no-op)", () => {
    // Sanity check for NameRegistry.claim's "same owner" exemption: this
    // is NOT the interesting collision case, just confirms composing one
    // well-formed module doesn't spuriously trip the same check.
    const moduleA = moduleWithTaskNamed("dev.rawkode.composertest.single");
    expect(() => composePothosConfig([moduleA])).not.toThrow();
  });
});

describe("relation endpoints referencing an unloaded supertag", () => {
  test("a relation whose `to` names an unknown supertag id throws unknown_relation_endpoint", () => {
    const MODULE_ID = "dev.rawkode.composertest.ghost";
    const widgetTag = `${MODULE_ID}.widget`;
    const ghostModule = defineSupertagModule({
      id: MODULE_ID,
      version: 1,
      supertags: { widget: { name: "Widget", symbol: "sparkles", fields: {} } },
      relations: {
        widgetGhost: {
          from: [widgetTag],
          to: [`${MODULE_ID}.nonexistent`],
          forwardName: "ghost",
          inverseName: "widgets",
          cardinality: "manyToOne",
        },
      },
    });

    try {
      composePothosConfig([ghostModule]);
      throw new Error("expected composePothosConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphQLComposerError);
      expect((error as GraphQLComposerError).code).toBe("unknown_relation_endpoint");
    }
  });
});

describe("an entityReference field with no allowedSupertagIDs", () => {
  test("throws unresolvable_entity_reference rather than composing an untyped field", () => {
    const emptyRefModule = defineSupertagModule({
      id: "dev.rawkode.composertest.emptyref",
      version: 1,
      supertags: {
        widget: {
          name: "Widget",
          symbol: "sparkles",
          fields: { target: f.entityReference([], { name: "Target" }) },
        },
      },
    });

    try {
      composePothosConfig([emptyRefModule]);
      throw new Error("expected composePothosConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphQLComposerError);
      expect((error as GraphQLComposerError).code).toBe("unresolvable_entity_reference");
    }
  });
});

describe("entityReference fields allowing more than one target supertag", () => {
  const MODULE_ID = "dev.rawkode.composertest.union";
  const ALPHA = `${MODULE_ID}.alpha`;
  const BRAVO = `${MODULE_ID}.bravo`;
  const CHARLIE = `${MODULE_ID}.charlie`;

  const unionModule = defineSupertagModule({
    id: MODULE_ID,
    version: 1,
    supertags: {
      alpha: {
        name: "Alpha",
        symbol: "a.circle",
        fields: { target: f.entityReference([BRAVO, CHARLIE], { name: "Target" }) },
      },
      bravo: { name: "Bravo", symbol: "b.circle", fields: {} },
      charlie: { name: "Charlie", symbol: "c.circle", fields: {} },
    },
  });

  test("generates a GraphQL union named after its members, in declared order", () => {
    const config = composePothosConfig([unionModule]);
    const sdl = printSchema(config.schema);

    expect(sdl).toMatch(/union BravoOrCharlie = Bravo \| Charlie/);
    expect(sdl).toMatch(/type Alpha \{[^}]*target: BravoOrCharlie[^}]*\}/s);
  });

  test("resolves the union to the concrete type matching the target node's own tag", async () => {
    const config = composePothosConfig([unionModule]);
    const relationID = config.registry.relationIDForProperty({ supertagID: ALPHA, fieldID: "target" });

    const accessors = new FakeAccessors(
      [
        { id: "alpha_1", tagIDs: [ALPHA], createdAt: 1, modifiedAt: 1 },
        { id: "bravo_1", tagIDs: [BRAVO], createdAt: 1, modifiedAt: 1 },
      ],
      [{ relationID, sourceNodeID: "alpha_1", targetNodeID: "bravo_1" }],
    );

    const result = await graphql({
      schema: config.schema,
      source: `query { alpha(id: "alpha_1") { target { __typename ... on Bravo { id } } } }`,
      contextValue: { vault: accessors },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ alpha: { target: { __typename: "Bravo", id: "bravo_1" } } });
  });
});
