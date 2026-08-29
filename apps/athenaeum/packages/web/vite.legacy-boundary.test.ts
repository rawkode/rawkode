import { describe, expect, it } from "vitest";
import {
  verifyLegacyBundleBoundary,
  type LegacyBoundaryChunk,
  type LegacyBoundaryModule
} from "./vite.config.js";

const legacyChunk: LegacyBoundaryChunk = {
  fileName: "assets/legacy-daily-note-C4DT.js",
  modules: [
    "/workspace/apps/athenaeum/packages/web/src/legacy-daily-note.tsx",
    "/workspace/apps/athenaeum/packages/web/src/RichNoteEditor.tsx",
    "/workspace/apps/athenaeum/packages/web/src/automerge-page.ts",
    "/workspace/apps/athenaeum/packages/web/src/rich-text/migration.ts",
    "/workspace/apps/athenaeum/packages/web/src/vendor/automerge-prosemirror/syncPlugin.ts",
    "/workspace/node_modules/.pnpm/@automerge+automerge@3.2.1/node_modules/@automerge/automerge/dist/fullfat_bundler.js"
  ],
  imports: [],
  dynamicImports: [],
  assets: ["assets/automerge_wasm_bg-ABC.wasm"]
};

const notesChunk = (overrides: Partial<LegacyBoundaryChunk> = {}): LegacyBoundaryChunk => ({
  fileName: "assets/NotesRoute-ABC.js",
  modules: [
    "C:\\workspace\\apps\\athenaeum\\packages\\web\\src\\routes\\NotesRoute.tsx",
    "C:\\workspace\\apps\\athenaeum\\packages\\web\\src\\DailyNote.tsx",
    "C:\\workspace\\apps\\athenaeum\\packages\\web\\src\\LoroRichNoteEditor.tsx",
    // This shared schema adapter is intentionally safe in the Loro graph: its Automerge imports
    // are type-only, while actual vendor sync/traversal code lives in the dynamic legacy chunk.
    "C:\\workspace\\apps\\athenaeum\\packages\\web\\src\\vendor\\automerge-prosemirror\\schema.ts"
  ],
  imports: [],
  dynamicImports: ["assets\\legacy-daily-note-C4DT.js"],
  // A Loro WASM asset is allowed in the static Notes graph and must not be mistaken for Automerge.
  assets: ["assets/loro_wasm_bg-XYZ.wasm"],
  ...overrides
});

const notesModule = "/workspace/apps/athenaeum/packages/web/src/routes/NotesRoute.tsx";
const dailyNoteModule = "/workspace/apps/athenaeum/packages/web/src/DailyNote.tsx";
const loroEditorModule = "/workspace/apps/athenaeum/packages/web/src/LoroRichNoteEditor.tsx";
const sharedSchemaModule = "/workspace/apps/athenaeum/packages/web/src/vendor/automerge-prosemirror/schema.ts";
const legacyModule = "/workspace/apps/athenaeum/packages/web/src/legacy-daily-note.tsx";

const moduleGraph = (overrides: Partial<Record<string, Partial<LegacyBoundaryModule>>> = {}): LegacyBoundaryModule[] => {
  const module = (id: string, importedIds: readonly string[] = [], dynamicallyImportedIds: readonly string[] = []): LegacyBoundaryModule => ({
    id,
    importedIds,
    dynamicallyImportedIds,
    ...overrides[id]
  });
  const graph = [
    module(notesModule, [dailyNoteModule, loroEditorModule]),
    module(dailyNoteModule, [sharedSchemaModule], [legacyModule]),
    module(loroEditorModule, [sharedSchemaModule]),
    module(sharedSchemaModule),
    module(legacyModule),
    ...legacyChunk.modules.slice(1).map((id) => module(id))
  ];
  const knownIds = new Set(graph.map(({ id }) => id));
  for (const [id, override] of Object.entries(overrides)) {
    if (!knownIds.has(id)) graph.push({ id, importedIds: [], dynamicallyImportedIds: [], ...override });
  }
  return graph;
};

describe("Vite legacy daily-note boundary", () => {
  it("accepts a Loro static closure and a directly dynamic Automerge closure", () => {
    expect(() => verifyLegacyBundleBoundary([notesChunk(), legacyChunk], moduleGraph())).not.toThrow();
  });

  it("rejects a static Automerge edge even when the dynamic legacy chunk is otherwise complete", () => {
    const staticAutomerge = notesChunk({
      modules: [...notesChunk().modules, "/workspace/apps/athenaeum/packages/web/src/automerge-page.ts"]
    });

    expect(() => verifyLegacyBundleBoundary([staticAutomerge, legacyChunk], moduleGraph({
      [dailyNoteModule]: { importedIds: [sharedSchemaModule, "/workspace/apps/athenaeum/packages/web/src/automerge-page.ts"] }
    })))
      .toThrow(/static Notes\/DailyNote\/Loro closure contains legacy code/);
  });

  it("rejects legacy code co-located in the emitted static Notes chunk", () => {
    const coLocatedLegacy = notesChunk({
      // This is deliberately absent from the source closure: source-edge checks alone would pass.
      modules: [notesModule, dailyNoteModule, loroEditorModule, sharedSchemaModule, "/workspace/apps/athenaeum/packages/web/src/automerge-page.ts"]
    });

    expect(() => verifyLegacyBundleBoundary([coLocatedLegacy, legacyChunk], moduleGraph()))
      .toThrow(/static Notes\/DailyNote\/Loro output closure contains legacy code/);
  });

  it("rejects the declared legacy adapter when Rollup co-locates it in static output", () => {
    const coLocatedAdapter = notesChunk({
      modules: [notesModule, dailyNoteModule, loroEditorModule, sharedSchemaModule, legacyModule]
    });

    expect(() => verifyLegacyBundleBoundary([coLocatedAdapter, legacyChunk], moduleGraph()))
      .toThrow(/declared legacy adapter is co-located in static Notes\/DailyNote\/Loro output/);
  });

  it("rejects a second direct dynamic root that carries Automerge outside the declared adapter", () => {
    const automergeEscape: LegacyBoundaryChunk = {
      fileName: "assets/automerge-escape.js",
      modules: [
        "/workspace/apps/athenaeum/packages/web/src/legacy-escape.ts",
        "/workspace/apps/athenaeum/packages/web/src/automerge-page.ts"
      ],
      imports: [],
      dynamicImports: [],
      assets: ["assets/automerge_wasm_bg-escape.wasm"]
    };
    expect(() => verifyLegacyBundleBoundary([notesChunk(), legacyChunk, automergeEscape], moduleGraph({
      [dailyNoteModule]: { dynamicallyImportedIds: [legacyModule, "/workspace/apps/athenaeum/packages/web/src/legacy-escape.ts"] },
      "/workspace/apps/athenaeum/packages/web/src/legacy-escape.ts": {
        dynamicallyImportedIds: [],
        importedIds: ["/workspace/apps/athenaeum/packages/web/src/automerge-page.ts"]
      },
      "/workspace/apps/athenaeum/packages/web/src/automerge-page.ts": {}
    })))
      .toThrow(/non-adapter direct dynamic closure contains legacy code/);
  });

  it("rejects legacy bytes co-located in a non-adapter dynamic output chunk", () => {
    const safeLazyModule = "/workspace/apps/athenaeum/packages/web/src/safe-lazy.ts";
    const coLocatedEscape: LegacyBoundaryChunk = {
      fileName: "assets/safe-lazy.js",
      // The source graph for safe-lazy has no Automerge edge, but its emitted bytes do.
      modules: [safeLazyModule, "/workspace/apps/athenaeum/packages/web/src/automerge-page.ts"],
      imports: [],
      dynamicImports: [],
      assets: ["assets/automerge_wasm_bg-escape.wasm"]
    };

    expect(() => verifyLegacyBundleBoundary([notesChunk(), legacyChunk, coLocatedEscape], moduleGraph({
      [dailyNoteModule]: { dynamicallyImportedIds: [legacyModule, safeLazyModule] },
      [safeLazyModule]: {}
    }))).toThrow(/non-adapter direct dynamic closure contains legacy code/);
  });

  it("rejects an Automerge escape dynamically imported by a static Notes helper", () => {
    const helperModule = "/workspace/apps/athenaeum/packages/web/src/notes-helper.ts";
    const escapeModule = "/workspace/apps/athenaeum/packages/web/src/automerge-escape.ts";
    const escapeChunk: LegacyBoundaryChunk = {
      fileName: "assets/automerge-escape.js",
      modules: [escapeModule, "/workspace/apps/athenaeum/packages/web/src/automerge-page.ts"],
      imports: [],
      dynamicImports: [],
      assets: ["assets/automerge_wasm_bg-escape.wasm"]
    };

    expect(() => verifyLegacyBundleBoundary([notesChunk(), legacyChunk, escapeChunk], moduleGraph({
      [dailyNoteModule]: { importedIds: [sharedSchemaModule, helperModule] },
      [helperModule]: { dynamicallyImportedIds: [escapeModule] },
      [escapeModule]: { importedIds: ["/workspace/apps/athenaeum/packages/web/src/automerge-page.ts"] },
      "/workspace/apps/athenaeum/packages/web/src/automerge-page.ts": {}
    }))).toThrow(/non-adapter direct dynamic closure contains legacy code/);
  });

  it("preserves query variants as distinct module identities when checking dynamic escapes", () => {
    const variantA = "/workspace/apps/athenaeum/packages/web/src/source.ts?variant=A";
    const variantB = "/workspace/apps/athenaeum/packages/web/src/source.ts?variant=B";
    const escapeModule = "/workspace/apps/athenaeum/packages/web/src/automerge-escape.ts";
    const escapeChunk: LegacyBoundaryChunk = {
      fileName: "assets/automerge-escape.js",
      modules: [escapeModule, "/workspace/apps/athenaeum/packages/web/src/automerge-page.ts"],
      imports: [],
      dynamicImports: [],
      assets: []
    };

    // B is intentionally inserted before A. A path-only graph key would overwrite B and lose
    // its escape edge; Rollup's full query-qualified IDs must remain separate graph vertices.
    expect(() => verifyLegacyBundleBoundary([notesChunk(), legacyChunk, escapeChunk], moduleGraph({
      [dailyNoteModule]: { importedIds: [sharedSchemaModule, variantB, variantA] },
      [variantB]: { dynamicallyImportedIds: [escapeModule] },
      [variantA]: {},
      [escapeModule]: { importedIds: ["/workspace/apps/athenaeum/packages/web/src/automerge-page.ts"] }
    }))).toThrow(/non-adapter direct dynamic closure contains legacy code/);
  });

  it("requires legacy-daily-note itself to be directly dynamic from the Notes closure", () => {
    const bridge: LegacyBoundaryChunk = {
      fileName: "assets/other-route.js",
      modules: ["/workspace/apps/athenaeum/packages/web/src/other-route.tsx"],
      imports: [],
      dynamicImports: [legacyChunk.fileName],
      assets: []
    };
    expect(() => verifyLegacyBundleBoundary([notesChunk(), bridge, legacyChunk], moduleGraph({
      [dailyNoteModule]: { dynamicallyImportedIds: ["/workspace/apps/athenaeum/packages/web/src/other-route.tsx"] },
      "/workspace/apps/athenaeum/packages/web/src/other-route.tsx": { dynamicallyImportedIds: [legacyModule] }
    })))
      .toThrow(/direct dynamic import/);
  });
});
