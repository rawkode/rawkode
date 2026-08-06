import { describe, expect, test } from "bun:test";
import {
  defineSupertagModule,
  SupertagRegistry,
  SupertagRegistryError,
  validateAdditiveUpgrade,
  type SupertagModule,
} from "./index";

function expectRegistryError(fn: () => unknown, code: string, detail?: string): void {
  try {
    fn();
    throw new Error("expected a SupertagRegistryError to be thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(SupertagRegistryError);
    const registryError = error as SupertagRegistryError;
    expect(registryError.code).toBe(code as SupertagRegistryError["code"]);
    if (detail !== undefined) expect(registryError.detail).toBe(detail);
  }
}

// ---------------------------------------------------------------------------
// defineSupertagModule() — single-module sanity check.
// ---------------------------------------------------------------------------

describe("defineSupertagModule — single-module validation", () => {
  test("accepts a well-formed module and returns it unchanged", () => {
    const module: SupertagModule = {
      id: "dev.rawkode.enchiridion.workouts",
      version: 1,
      supertags: {
        workout: { name: "Workout", symbol: "figure.run", fields: { duration: { type: "number" } } },
      },
    };
    expect(defineSupertagModule(module)).toBe(module);
  });

  test("rejects an empty module id", () => {
    expectRegistryError(
      () => defineSupertagModule({ id: "", version: 1, supertags: {} }),
      "invalid_module",
    );
  });

  test("rejects a non-positive module version", () => {
    expectRegistryError(
      () => defineSupertagModule({ id: "dev.rawkode.enchiridion.workouts", version: 0, supertags: {} }),
      "invalid_module",
    );
  });

  test("rejects a supertag id override outside the module's own namespace (foreign declaration)", () => {
    expectRegistryError(
      () =>
        defineSupertagModule({
          id: "dev.rawkode.enchiridion.workouts",
          version: 1,
          supertags: {
            workout: { id: "dev.rawkode.enchiridion.other.workout", name: "Workout", symbol: "figure.run", fields: {} },
          },
        }),
      "foreign_declaration",
      "dev.rawkode.enchiridion.other.workout",
    );
  });

  test("rejects a relation id override outside the module's own namespace", () => {
    expectRegistryError(
      () =>
        defineSupertagModule({
          id: "dev.rawkode.enchiridion.workouts",
          version: 1,
          supertags: {},
          relations: {
            rel: {
              id: "dev.rawkode.enchiridion.other.rel",
              from: [],
              to: [],
              forwardName: "x",
              inverseName: "y",
              cardinality: "manyToOne",
            },
          },
        }),
      "foreign_declaration",
      "dev.rawkode.enchiridion.other.rel",
    );
  });

  test("rejects a view type outside the module's own namespace", () => {
    expectRegistryError(
      () =>
        defineSupertagModule({
          id: "dev.rawkode.enchiridion.workouts",
          version: 1,
          supertags: {},
          ui: { viewTypes: ["dev.rawkode.enchiridion.other.summary"] },
        }),
      "foreign_declaration",
      "dev.rawkode.enchiridion.other.summary",
    );
  });

  test("rejects a duplicate explicit id claimed by two declarations in the same module", () => {
    expectRegistryError(
      () =>
        defineSupertagModule({
          id: "dev.rawkode.enchiridion.workouts",
          version: 1,
          supertags: {
            a: { id: "dev.rawkode.enchiridion.workouts.shared", name: "A", symbol: "circle", fields: {} },
            b: { id: "dev.rawkode.enchiridion.workouts.shared", name: "B", symbol: "circle", fields: {} },
          },
        }),
      "identifier_collision",
      "dev.rawkode.enchiridion.workouts.shared",
    );
  });

  // Port of ModuleFoundationTests.testRegistryRejectsUnsafeOrNonPublicProjectionDeclarations
  // (ModuleFoundationTests.swift:56-71): a projection with a stacked
  // statement ("SELECT 1; DELETE FROM pages") must be rejected.
  test("rejects an unsafe (stacked-statement) projection SQL", () => {
    expectRegistryError(
      () =>
        defineSupertagModule({
          id: "dev.rawkode.enchiridion.workouts",
          version: 1,
          supertags: {},
          projections: {
            graph_workouts: { version: 1, sql: "SELECT 1; DELETE FROM pages" },
          },
        }),
      "invalid_projection",
      "graph_workouts",
    );
  });

  test("rejects a projection view name that doesn't match graph_[a-z0-9_]+", () => {
    expectRegistryError(
      () =>
        defineSupertagModule({
          id: "dev.rawkode.enchiridion.workouts",
          version: 1,
          supertags: {},
          projections: { Workouts: { version: 1, sql: "SELECT 1" } },
        }),
      "invalid_projection",
      "Workouts",
    );
  });

  test("rejects an inheritance cycle contained entirely within one module", () => {
    expectRegistryError(
      () =>
        defineSupertagModule({
          id: "dev.rawkode.enchiridion.workouts",
          version: 1,
          supertags: {
            a: { name: "A", symbol: "circle", fields: {}, parents: ["dev.rawkode.enchiridion.workouts.b"] },
            b: { name: "B", symbol: "circle", fields: {}, parents: ["dev.rawkode.enchiridion.workouts.a"] },
          },
        }),
      "cyclic_inheritance",
    );
  });

  test("tolerates a dangling parent reference to an unloaded/unknown tag (cross-module reference)", () => {
    const module: SupertagModule = {
      id: "dev.rawkode.workouts",
      version: 1,
      supertags: {
        workout: {
          name: "Workout",
          symbol: "figure.run",
          fields: {},
          parents: ["dev.rawkode.enchiridion.core.event"],
        },
      },
    };
    expect(defineSupertagModule(module)).toBe(module);
  });
});

// ---------------------------------------------------------------------------
// SupertagRegistry.build() — cross-module validation.
// ---------------------------------------------------------------------------

describe("SupertagRegistry.build — cross-module validation", () => {
  const core: SupertagModule = {
    id: "dev.rawkode.enchiridion.core",
    version: 1,
    supertags: {
      event: { name: "Event", symbol: "calendar", fields: { start: { type: "dateTime" } } },
    },
  };

  test("builds successfully across independent modules and resolves effective schema across the namespace boundary", () => {
    const workouts: SupertagModule = {
      id: "dev.rawkode.workouts",
      version: 1,
      supertags: {
        workout: {
          name: "Workout",
          symbol: "figure.run",
          parents: ["dev.rawkode.enchiridion.core.event"],
          fields: { duration: { type: "number" } },
        },
      },
    };

    const registry = SupertagRegistry.build([core, workouts]);
    expect(registry.getModule("dev.rawkode.workouts")).toBe(workouts);
    expect(registry.getSupertag("dev.rawkode.workouts.workout")).toBeDefined();

    const fields = registry.effectiveFields("dev.rawkode.workouts.workout");
    expect(fields.map((f) => f.propertyKey)).toEqual([
      { supertagID: "dev.rawkode.enchiridion.core.event", fieldID: "start" },
      { supertagID: "dev.rawkode.workouts.workout", fieldID: "duration" },
    ]);

    const tagIDs = registry.effectiveTagIDs(["dev.rawkode.workouts.workout"]);
    expect(tagIDs).toEqual(new Set(["dev.rawkode.workouts.workout", "dev.rawkode.enchiridion.core.event"]));
  });

  test("rejects two modules registered under the same module id", () => {
    expectRegistryError(
      () => SupertagRegistry.build([core, { ...core, version: 2 }]),
      "duplicate_module",
      core.id,
    );
  });

  // Adapted port of ModuleFoundationTests
  // .testRegistryRejectsDeterministicDeclarationCollisions
  // (ModuleFoundationTests.swift:8-33): projection *view names* are not
  // namespace-prefixed (unlike supertag/relation ids), so two independently
  // namespaced modules can pick the same one — the registry must catch it.
  test("rejects two modules declaring the same projection view name", () => {
    const alpha: SupertagModule = {
      id: "dev.rawkode.enchiridion.alpha",
      version: 1,
      supertags: {},
      projections: { graph_shared: { version: 1, sql: "SELECT 1" } },
    };
    const beta: SupertagModule = {
      id: "dev.rawkode.enchiridion.beta",
      version: 1,
      supertags: {},
      projections: { graph_shared: { version: 1, sql: "SELECT 2" } },
    };
    expectRegistryError(() => SupertagRegistry.build([alpha, beta]), "duplicate_projection_view", "graph_shared");
  });

  test("rejects two modules whose explicit id overrides collide on the same declaration identifier", () => {
    const alpha: SupertagModule = {
      id: "dev.rawkode.enchiridion.alpha",
      version: 1,
      supertags: {
        shared: {
          id: "dev.rawkode.enchiridion.shared.graph",
          name: "Shared",
          symbol: "circle",
          fields: {},
        },
      },
    };
    const beta: SupertagModule = {
      id: "dev.rawkode.enchiridion.beta",
      version: 1,
      supertags: {
        shared: {
          id: "dev.rawkode.enchiridion.shared.graph",
          name: "Shared",
          symbol: "circle",
          fields: {},
        },
      },
    };
    // Neither module owns "dev.rawkode.enchiridion.shared.graph" (it's
    // outside both "dev.rawkode.enchiridion.alpha." and
    // "dev.rawkode.enchiridion.beta." prefixes), so this is caught earlier
    // as a foreign declaration than as a collision — still a rejection.
    expectRegistryError(() => SupertagRegistry.build([alpha, beta]), "foreign_declaration");
  });

  test("rejects a cross-module inheritance cycle only detectable once every module is loaded", () => {
    const a: SupertagModule = {
      id: "dev.rawkode.a",
      version: 1,
      supertags: { tag: { name: "A", symbol: "circle", fields: {}, parents: ["dev.rawkode.b.tag"] } },
    };
    const b: SupertagModule = {
      id: "dev.rawkode.b",
      version: 1,
      supertags: { tag: { name: "B", symbol: "circle", fields: {}, parents: ["dev.rawkode.a.tag"] } },
    };
    expectRegistryError(() => SupertagRegistry.build([a, b]), "cyclic_inheritance");
  });

  test("relation resolution works across the merged registry", () => {
    const withRelation: SupertagModule = {
      id: "dev.rawkode.enchiridion.core",
      version: 1,
      supertags: {
        task: { name: "Task", symbol: "checkmark.circle", fields: { project: { type: "entityReference" } } },
        project: { name: "Project", symbol: "folder", fields: {} },
      },
      relations: {
        "task-project": {
          from: ["dev.rawkode.enchiridion.core.task"],
          to: ["dev.rawkode.enchiridion.core.project"],
          forwardName: "project",
          inverseName: "tasks",
          cardinality: "manyToOne",
          property: { supertagID: "dev.rawkode.enchiridion.core.task", fieldID: "project" },
        },
      },
    };
    const registry = SupertagRegistry.build([withRelation]);
    const relationID = registry.relationIDForProperty({
      supertagID: "dev.rawkode.enchiridion.core.task",
      fieldID: "project",
    });
    expect(relationID).toBe("dev.rawkode.enchiridion.core.task-project");
    expect(registry.propertyKeyForRelation(relationID)).toEqual({
      supertagID: "dev.rawkode.enchiridion.core.task",
      fieldID: "project",
    });
    // A field with no declared relation still resolves via the synthetic
    // fallback, matching BuiltInRelations.relationID(for:)'s default case.
    expect(
      registry.relationIDForProperty({ supertagID: "dev.rawkode.enchiridion.core.task", fieldID: "assignee" }),
    ).toBe("property-relation:dev.rawkode.enchiridion.core.task:assignee");
  });
});

// ---------------------------------------------------------------------------
// validateAdditiveUpgrade() / SupertagRegistry.upgrade() — additive-only
// upgrades. Adapted port of ModuleFoundationTests
// .testReconcileModuleProvisionsAndVersionUpgradesOwnedProjection
// (ModuleFoundationTests.swift:99-167)'s version/statement rules, plus the
// field type/cardinality rule from LibraryRepository
// .additivelyMergedModuleSupertag (ModuleFoundation.swift:383-404).
// ---------------------------------------------------------------------------

describe("validateAdditiveUpgrade", () => {
  const v1: SupertagModule = {
    id: "dev.rawkode.enchiridion.alpha",
    version: 1,
    supertags: {
      workout: {
        name: "Workout",
        symbol: "figure.run",
        fields: { duration: { type: "number" }, split: { type: "select", options: [{ id: "push", name: "Push" }] } },
      },
    },
    relations: {
      area: {
        from: ["dev.rawkode.enchiridion.alpha.workout"],
        to: ["dev.rawkode.enchiridion.core.area"],
        forwardName: "area",
        inverseName: "workouts",
        cardinality: "manyToOne",
      },
    },
    projections: { graph_workouts_v1: { version: 1, sql: "SELECT 1 AS value" } },
  };

  test("allows adding a new supertag, a new field, a new relation, and a new projection", () => {
    const v2: SupertagModule = {
      ...v1,
      version: 2,
      supertags: {
        ...v1.supertags,
        workout: { ...v1.supertags.workout!, fields: { ...v1.supertags.workout!.fields, notes: { type: "text" } } },
        route: { name: "Route", symbol: "map", fields: {} },
      },
      relations: {
        ...v1.relations,
        person: {
          from: ["dev.rawkode.enchiridion.alpha.workout"],
          to: ["dev.rawkode.enchiridion.core.person"],
          forwardName: "with",
          inverseName: "workouts",
          cardinality: "manyToMany",
        },
      },
      projections: { ...v1.projections, graph_workouts_routes_v1: { version: 1, sql: "SELECT 2 AS value" } },
    };
    expect(() => validateAdditiveUpgrade(v1, v2)).not.toThrow();
  });

  test("allows the rename pattern: keep the old field id and add a new one alongside it", () => {
    const v2: SupertagModule = {
      ...v1,
      version: 2,
      supertags: {
        workout: {
          ...v1.supertags.workout!,
          fields: { ...v1.supertags.workout!.fields, intensity: { type: "select", options: [{ id: "high", name: "High" }] } },
        },
      },
    };
    expect(() => validateAdditiveUpgrade(v1, v2)).not.toThrow();
  });

  test("rejects removing an existing field outright", () => {
    const v2: SupertagModule = {
      ...v1,
      version: 2,
      supertags: { workout: { ...v1.supertags.workout!, fields: { duration: { type: "number" } } } },
    };
    expectRegistryError(() => validateAdditiveUpgrade(v1, v2), "incompatible_upgrade", "workout.split");
  });

  test("rejects changing an existing field's type", () => {
    const v2: SupertagModule = {
      ...v1,
      version: 2,
      supertags: {
        workout: {
          ...v1.supertags.workout!,
          fields: { ...v1.supertags.workout!.fields, duration: { type: "text" } },
        },
      },
    };
    expectRegistryError(() => validateAdditiveUpgrade(v1, v2), "incompatible_upgrade", "workout.duration");
  });

  test("rejects changing an existing field's cardinality (allowsMultiple)", () => {
    const v2: SupertagModule = {
      ...v1,
      version: 2,
      supertags: {
        workout: {
          ...v1.supertags.workout!,
          fields: { ...v1.supertags.workout!.fields, duration: { type: "number", allowsMultiple: true } },
        },
      },
    };
    expectRegistryError(() => validateAdditiveUpgrade(v1, v2), "incompatible_upgrade", "workout.duration");
  });

  test("rejects removing an existing supertag", () => {
    const v2: SupertagModule = { ...v1, version: 2, supertags: {} };
    expectRegistryError(() => validateAdditiveUpgrade(v1, v2), "incompatible_upgrade", "workout");
  });

  test("rejects removing an existing relation", () => {
    const v2: SupertagModule = { ...v1, version: 2, relations: {} };
    expectRegistryError(() => validateAdditiveUpgrade(v1, v2), "incompatible_upgrade", "area");
  });

  test("rejects changing an existing relation's cardinality", () => {
    const v2: SupertagModule = {
      ...v1,
      version: 2,
      relations: { area: { ...v1.relations!.area!, cardinality: "manyToMany" } },
    };
    expectRegistryError(() => validateAdditiveUpgrade(v1, v2), "incompatible_upgrade", "area");
  });

  test("allows renaming a relation's forward/inverse display names", () => {
    const v2: SupertagModule = {
      ...v1,
      version: 2,
      relations: { area: { ...v1.relations!.area!, forwardName: "location", inverseName: "workout sessions" } },
    };
    expect(() => validateAdditiveUpgrade(v1, v2)).not.toThrow();
  });

  test("rejects an in-place projection SQL change at the same version", () => {
    const v2: SupertagModule = {
      ...v1,
      version: 2,
      projections: { graph_workouts_v1: { version: 1, sql: "SELECT 2 AS value" } },
    };
    expectRegistryError(() => validateAdditiveUpgrade(v1, v2), "incompatible_upgrade", "graph_workouts_v1");
  });

  test("allows a projection SQL change when the projection's own version is bumped", () => {
    const v2: SupertagModule = {
      ...v1,
      version: 2,
      projections: { graph_workouts_v1: { version: 2, sql: "SELECT 2 AS value" } },
    };
    expect(() => validateAdditiveUpgrade(v1, v2)).not.toThrow();
  });

  test("rejects a projection version decrease", () => {
    const bumped: SupertagModule = { ...v1, version: 2, projections: { graph_workouts_v1: { version: 2, sql: "SELECT 2" } } };
    const rollback: SupertagModule = { ...bumped, version: 3, projections: { graph_workouts_v1: { version: 1, sql: "SELECT 1" } } };
    expectRegistryError(() => validateAdditiveUpgrade(bumped, rollback), "incompatible_upgrade", "graph_workouts_v1");
  });

  test("allows a same-version, byte-identical re-declare (idempotent replay)", () => {
    expect(() => validateAdditiveUpgrade(v1, { ...v1 })).not.toThrow();
  });

  test("rejects a module version that decreases", () => {
    expectRegistryError(() => validateAdditiveUpgrade(v1, { ...v1, version: 0 }), "incompatible_upgrade");
  });
});

describe("SupertagRegistry.upgrade / withModule", () => {
  const v1: SupertagModule = {
    id: "dev.rawkode.enchiridion.alpha",
    version: 1,
    supertags: { thing: { name: "Thing", symbol: "circle", fields: { value: { type: "number" } } } },
    projections: { graph_alpha_v1: { version: 1, sql: "SELECT 1 AS value" } },
  };

  test("upgrade() applies a valid additive upgrade and leaves the previous registry untouched", () => {
    const registry = SupertagRegistry.build([v1]);
    const v2: SupertagModule = {
      ...v1,
      version: 2,
      projections: { graph_alpha_v1: { version: 2, sql: "SELECT 2 AS value" } },
    };
    const upgraded = registry.upgrade(v2);

    expect(registry.getModule(v1.id)?.version).toBe(1);
    expect(upgraded.getModule(v1.id)?.version).toBe(2);
  });

  test("upgrade() rejects and does not mutate the registry when the upgrade is incompatible", () => {
    const registry = SupertagRegistry.build([v1]);
    const bad: SupertagModule = { ...v1, version: 2, supertags: {} };
    expectRegistryError(() => registry.upgrade(bad), "incompatible_upgrade");
    expect(registry.getModule(v1.id)?.version).toBe(1);
  });

  test("upgrade() rejects a module id that isn't registered yet", () => {
    const registry = SupertagRegistry.build([v1]);
    expectRegistryError(
      () => registry.upgrade({ id: "dev.rawkode.enchiridion.unregistered", version: 1, supertags: {} }),
      "invalid_module",
    );
  });

  test("withModule() re-validates the full cross-module set", () => {
    const registry = SupertagRegistry.build([v1]);
    const conflicting: SupertagModule = {
      id: "dev.rawkode.enchiridion.beta",
      version: 1,
      supertags: {},
      projections: { graph_alpha_v1: { version: 1, sql: "SELECT 2" } },
    };
    expectRegistryError(() => registry.withModule(conflicting), "duplicate_projection_view", "graph_alpha_v1");
  });
});
