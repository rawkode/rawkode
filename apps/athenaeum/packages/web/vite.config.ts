import { defineConfig, type Plugin } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

export interface LegacyBoundaryChunk {
  readonly fileName: string;
  readonly modules: readonly string[];
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
  readonly assets: readonly string[];
}

export interface LegacyBoundaryModule {
  readonly id: string;
  readonly importedIds: readonly string[];
  readonly dynamicallyImportedIds: readonly string[];
}

// Rollup IDs can differ only by a plugin query. Preserve that identity for graph traversal: the
// query is part of the edge, even though it is not relevant when classifying the source path.
const normalizeBoundaryIdentity = (value: string): string =>
  value.replace(/\\/g, "/").replace(/\/+/g, "/");

const normalizeBoundaryPath = (value: string): string =>
  normalizeBoundaryIdentity(value).replace(/[?#].*$/, "");

const matches = (value: string, pattern: RegExp): boolean => pattern.test(normalizeBoundaryPath(value));
const isNotesRootModule = (value: string): boolean =>
  matches(value, /(?:^|\/)(?:NotesRoute|DailyNote|LoroRichNoteEditor)\.(?:[cm]?[jt]sx?)$/);
const isLegacyAdapterModule = (value: string): boolean =>
  matches(value, /(?:^|\/)legacy-daily-note\.(?:[cm]?[jt]sx?)$/);
const isRichNoteEditorModule = (value: string): boolean =>
  matches(value, /(?:^|\/)RichNoteEditor\.(?:[cm]?[jt]sx?)$/);
const isAutomergePageModule = (value: string): boolean =>
  matches(value, /(?:^|\/)automerge-page\.(?:[cm]?[jt]sx?)$/);
const isLegacyMigrationModule = (value: string): boolean =>
  matches(value, /(?:^|\/)rich-text\/migration\.(?:[cm]?[jt]sx?)$/);
// `schema.ts` is intentionally shared by the Loro editor after its Automerge references became
// type-only. The rest of the vendored adapter (sync/traversal/DocHandle) remains legacy-only.
const isLegacyVendorModule = (value: string): boolean =>
  matches(value, /(?:^|\/)vendor\/automerge-prosemirror\/(?!schema\.(?:[cm]?[jt]sx?)$|types\.(?:[cm]?[jt]sx?)$).+/);
const isAutomergeRuntimeModule = (value: string): boolean =>
  matches(value, /(?:^|\/)@automerge(?:[+/]|$)/i);
const isLoroWasm = (value: string): boolean =>
  matches(value, /(?:^|\/)[^/]*loro[^/]*\.wasm$/i);
const isAutomergeWasm = (value: string): boolean =>
  !isLoroWasm(value) && matches(value, /(?:^|\/)[^/]*automerge[^/]*\.wasm$/i);

const isLegacyRuntimeModule = (value: string): boolean =>
  isLegacyAdapterModule(value) ||
  isRichNoteEditorModule(value) ||
  isAutomergePageModule(value) ||
  isLegacyMigrationModule(value) ||
  isLegacyVendorModule(value) ||
  isAutomergeRuntimeModule(value);

const findChunk = (chunks: ReadonlyMap<string, LegacyBoundaryChunk>, reference: string): LegacyBoundaryChunk | undefined => {
  const normalized = normalizeBoundaryIdentity(reference);
  const direct = chunks.get(normalized);
  if (direct !== undefined) return direct;
  return [...chunks.values()].find((chunk) => chunk.fileName.endsWith(`/${normalized}`) || normalized.endsWith(`/${chunk.fileName}`));
};

const closureFrom = (
  initial: readonly LegacyBoundaryChunk[],
  chunks: ReadonlyMap<string, LegacyBoundaryChunk>,
  includeDynamicImports: boolean
): LegacyBoundaryChunk[] => {
  const visited = new Map<string, LegacyBoundaryChunk>();
  const pending = [...initial];
  while (pending.length > 0) {
    const chunk = pending.pop();
    if (chunk === undefined || visited.has(chunk.fileName)) continue;
    visited.set(chunk.fileName, chunk);
    const references = includeDynamicImports
      ? [...chunk.imports, ...chunk.dynamicImports]
      : chunk.imports;
    for (const reference of references) {
      const dependency = findChunk(chunks, reference);
      if (dependency !== undefined) pending.push(dependency);
    }
  }
  return [...visited.values()];
};

const describeModules = (modules: Iterable<string>, predicate: (value: string) => boolean): string[] =>
  [...modules].filter(predicate);

const describeAssets = (chunks: readonly LegacyBoundaryChunk[], predicate: (value: string) => boolean): string[] =>
  chunks.flatMap((chunk) => chunk.assets.filter(predicate).map((asset) => `${chunk.fileName}:${asset}`));

const normalizeModuleGraph = (
  modules: Iterable<LegacyBoundaryModule>
): ReadonlyMap<string, LegacyBoundaryModule> => new Map([...modules].map((module) => {
  const id = normalizeBoundaryIdentity(module.id);
  return [id, {
    id,
    importedIds: module.importedIds.map(normalizeBoundaryIdentity),
    dynamicallyImportedIds: module.dynamicallyImportedIds.map(normalizeBoundaryIdentity)
  }] as const;
}));

const moduleClosureFrom = (
  initial: Iterable<string>,
  modules: ReadonlyMap<string, LegacyBoundaryModule>,
  includeDynamicImports: boolean
): Set<string> => {
  const visited = new Set<string>();
  const pending = [...initial];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const module = modules.get(id);
    if (module === undefined) continue;
    pending.push(...module.importedIds);
    if (includeDynamicImports) pending.push(...module.dynamicallyImportedIds);
  }
  return visited;
};

const chunksContainingModules = (
  chunks: readonly LegacyBoundaryChunk[],
  moduleIds: ReadonlySet<string>
): LegacyBoundaryChunk[] => chunks.filter((chunk) => chunk.modules.some((id) => moduleIds.has(id)));

/**
 * Fails a production bundle if the exact Notes module graph regains an Automerge edge. Rollup's
 * module graph establishes edge ownership; emitted chunks/assets then prove the corresponding
 * output still keeps Automerge in the declared lazy compatibility closure.
 */
export const verifyLegacyBundleBoundary = (
  chunks: readonly LegacyBoundaryChunk[],
  modules: Iterable<LegacyBoundaryModule>
): void => {
  const byFileName = new Map(chunks.map((chunk) => [normalizeBoundaryIdentity(chunk.fileName), {
    ...chunk,
    fileName: normalizeBoundaryIdentity(chunk.fileName),
    modules: chunk.modules.map(normalizeBoundaryIdentity),
    imports: chunk.imports.map(normalizeBoundaryIdentity),
    dynamicImports: chunk.dynamicImports.map(normalizeBoundaryIdentity),
    assets: chunk.assets.map(normalizeBoundaryIdentity)
  }] as const));
  const moduleGraph = normalizeModuleGraph(modules);
  const roots = [...moduleGraph.keys()].filter(isNotesRootModule);
  if (roots.length === 0) throw new Error("Legacy bundle boundary: could not find an exact Notes/DailyNote/Loro module root");

  const staticModuleClosure = moduleClosureFrom(roots, moduleGraph, false);
  const staticSourceViolations = describeModules(staticModuleClosure, isLegacyRuntimeModule);
  if (staticSourceViolations.length > 0) {
    throw new Error("Legacy bundle boundary: static Notes/DailyNote/Loro closure contains legacy code: " + staticSourceViolations.join(", "));
  }

  const dynamicRoots = [...staticModuleClosure].flatMap((id) =>
    moduleGraph.get(id)?.dynamicallyImportedIds ?? []);
  const directLegacyRoots = dynamicRoots.filter(isLegacyAdapterModule);
  if (directLegacyRoots.length === 0) {
    throw new Error("Legacy bundle boundary: Notes/DailyNote/Loro closure must reach legacy-daily-note through a direct dynamic import");
  }

  // Module edges alone are insufficient: Rollup may co-locate a lazily-owned module in an output
  // chunk that the static Notes route imports. Walk the emitted static chunk closure too, so the
  // Loro path cannot download legacy bytes merely because their source edge is dynamic.
  const staticOutputClosure = closureFrom(
    chunksContainingModules([...byFileName.values()], staticModuleClosure),
    byFileName,
    false
  );
  const legacyAdapterChunks = chunksContainingModules([...byFileName.values()], new Set(directLegacyRoots));
  const staticOutputFiles = new Set(staticOutputClosure.map((chunk) => chunk.fileName));
  const coLocatedAdapterChunks = legacyAdapterChunks.filter((chunk) => staticOutputFiles.has(chunk.fileName));
  if (coLocatedAdapterChunks.length > 0) {
    throw new Error("Legacy bundle boundary: declared legacy adapter is co-located in static Notes/DailyNote/Loro output: " + coLocatedAdapterChunks.map((chunk) => chunk.fileName).join(", "));
  }

  const staticOutputViolations = [
    ...describeModules(staticOutputClosure.flatMap((chunk) => chunk.modules), isLegacyRuntimeModule),
    ...describeAssets(staticOutputClosure, isAutomergeWasm)
  ];
  if (staticOutputViolations.length > 0) {
    throw new Error("Legacy bundle boundary: static Notes/DailyNote/Loro output closure contains legacy code: " + staticOutputViolations.join(", "));
  }

  // Notes may dynamically load unrelated, Loro-safe UI. Every direct dynamic edge other than the
  // declared compatibility adapter is still a boundary: following its whole lazy closure must not
  // provide an alternate route to any legacy runtime, including its emitted WASM.
  const nonLegacyDynamicRoots = dynamicRoots.filter((id) => !isLegacyAdapterModule(id));
  const nonLegacyDynamicClosure = moduleClosureFrom(nonLegacyDynamicRoots, moduleGraph, true);
  const nonLegacyDynamicChunks = closureFrom(
    chunksContainingModules([...byFileName.values()], nonLegacyDynamicClosure),
    byFileName,
    true
  );
  const nonLegacyDynamicViolations = [
    ...describeModules(nonLegacyDynamicClosure, isLegacyRuntimeModule),
    ...describeModules(nonLegacyDynamicChunks.flatMap((chunk) => chunk.modules), isLegacyRuntimeModule),
    ...describeAssets(nonLegacyDynamicChunks, isAutomergeWasm)
  ];
  if (nonLegacyDynamicViolations.length > 0) {
    throw new Error(`Legacy bundle boundary: non-adapter direct dynamic closure contains legacy code: ${nonLegacyDynamicViolations.join(", ")}`);
  }

  const dynamicModuleClosure = moduleClosureFrom(directLegacyRoots, moduleGraph, true);
  const dynamicClosure = closureFrom(
    chunksContainingModules([...byFileName.values()], dynamicModuleClosure),
    byFileName,
    true
  );
  const requirements: ReadonlyArray<readonly [string, (value: string) => boolean, readonly LegacyBoundaryChunk[]]> = [
    ["legacy adapter", isLegacyAdapterModule, dynamicClosure],
    ["RichNoteEditor", isRichNoteEditorModule, dynamicClosure],
    ["automerge-page", isAutomergePageModule, dynamicClosure],
    ["legacy migration", isLegacyMigrationModule, dynamicClosure],
    ["legacy vendor runtime", isLegacyVendorModule, dynamicClosure],
    ["Automerge runtime", isAutomergeRuntimeModule, dynamicClosure]
  ];
  const missingModules = requirements
    .filter(([, predicate, closure]) => !closure.some((chunk) => chunk.modules.some(predicate)))
    .map(([name]) => name);
  const hasAutomergeWasm = dynamicClosure.some((chunk) => chunk.assets.some(isAutomergeWasm));
  if (!hasAutomergeWasm) missingModules.push("Automerge WASM asset");
  if (missingModules.length > 0) {
    throw new Error(`Legacy bundle boundary: dynamic legacy closure is missing ${missingModules.join(", ")}`);
  }
};

type ViteChunkMetadata = { readonly importedAssets?: Iterable<string> };
type RollupOutputChunkLike = {
  readonly fileName: string;
  readonly modules: Readonly<Record<string, unknown>>;
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
  readonly referencedFiles: readonly string[];
  readonly viteMetadata?: ViteChunkMetadata;
};

type RollupModuleInfoLike = {
  readonly id: string;
  readonly importedIds: readonly string[];
  readonly dynamicallyImportedIds: readonly string[];
};

const collectModuleGraph = (
  initialModuleIds: Iterable<string>,
  getModuleInfo: (id: string) => RollupModuleInfoLike | null
): LegacyBoundaryModule[] => {
  const modules = new Map<string, LegacyBoundaryModule>();
  const pending = [...initialModuleIds];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || modules.has(normalizeBoundaryIdentity(id))) continue;
    const module = getModuleInfo(id);
    if (module === null) continue;
    const normalizedModule: LegacyBoundaryModule = {
      id: module.id,
      importedIds: module.importedIds,
      dynamicallyImportedIds: module.dynamicallyImportedIds
    };
    modules.set(normalizeBoundaryIdentity(module.id), normalizedModule);
    pending.push(...module.importedIds, ...module.dynamicallyImportedIds);
  }
  return [...modules.values()];
};

const rollupChunkToBoundaryChunk = (chunk: RollupOutputChunkLike): LegacyBoundaryChunk => {
  const viteMetadata = chunk.viteMetadata;
  return {
    fileName: chunk.fileName,
    modules: Object.keys(chunk.modules),
    imports: chunk.imports,
    dynamicImports: chunk.dynamicImports,
    assets: [...chunk.referencedFiles, ...(viteMetadata?.importedAssets ?? [])]
  };
};

export const legacyBundleBoundaryVerifier = (): Plugin => ({
  name: "athenaeum:legacy-daily-note-boundary",
  apply: "build",
  generateBundle(_options, bundle) {
    const chunks = Object.values(bundle).flatMap((entry) =>
      entry.type === "chunk" ? [rollupChunkToBoundaryChunk(entry)] : []
    );
    const moduleGraph = collectModuleGraph(
      chunks.flatMap((chunk) => chunk.modules),
      (id) => this.getModuleInfo(id)
    );
    verifyLegacyBundleBoundary(chunks, moduleGraph);
  }
});

// `wasm()` (Daily notes stage addition): `@automerge/automerge`'s browser entrypoint
// (`fullfat_bundler.js`, selected automatically by Vite's default "browser" resolve condition)
// does `import * as wasm from "./automerge_wasm_bg.wasm"` — the still-experimental WASM/ESM-
// integration proposal browsers don't support natively (automerge's own README: "you must use a
// bundler"). Plain Vite doesn't rewrite that import form on its own; `vite-plugin-wasm` does, for
// both the dev-server transform and esbuild's dependency pre-bundling pass, compiling it to a real
// instantiated module with the resulting top-level `await` left as native ESM top-level await
// (supported by this project's target browsers and by Vite/Rollup's own default build target —
// see below for why the commonly-paired `vite-plugin-top-level-await` was tried and dropped).
//
// `vite-plugin-top-level-await` was tried first (the combination automerge+Vite guides usually
// recommend) but its 1.6.0 release throws `[vite-plugin-top-level-await] missing field 'type'`
// during `vite build` against this workspace's Vite 7/Rollup 4/@swc-core versions — a real,
// reproduced incompatibility (see the Daily notes stage's own verification notes), not a
// hypothetical one. It's dropped rather than pinned to an older, untested combination: Vite's
// default build target already supports native top-level await, so `vite-plugin-wasm` alone is
// sufficient for both `vite dev` (native ESM, no transform needed at all) and `vite build`
// (verified below).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  const backendHost = env.VITE_BACKEND_HOST?.trim() || "localhost:8787";
  const loroAlias = mode === "test"
    ? [{ find: /^loro-crdt(?:\/bundler)?$/, replacement: "loro-crdt/nodejs" }]
    : [{ find: /^loro-crdt$/, replacement: "loro-crdt/bundler" }];

  return {
    plugins: [react(), wasm(), legacyBundleBoundaryVerifier()],
    test: {
      css: true,
    },
    // `loro-prosemirror` imports the package root while the app's worker-safe code imports the
    // explicit bundler entry. Keep both imports on the same generated WASM module; otherwise Vite
    // emits two 3 MB Loro runtimes and the editor can receive containers from a different JS
    // class instance than the document it is binding.
    resolve: {
      alias: loroAlias
    },
    server: {
      port: 3000,
      host: true,
      proxy: {
        "/api": `http://${backendHost}`,
      },
    },
  };
});
