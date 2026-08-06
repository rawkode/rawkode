#!/usr/bin/env bun

/**
 * Deployable Effect source may not escape to native Promises or unchecked casts.
 *
 * This intentionally uses TypeScript's parser and type checker, not lexical
 * matching: inferred promises, template interpolation, dynamic imports, TSX,
 * and every async/cast syntax form are checked. The single approved exception
 * is runtime's audited Cloudflare adapter ledger.
 */
import { Glob } from "bun";
import { resolve } from "node:path";
import ts from "typescript";
import { deployableTypeScriptRoots } from "./check-deployable-v2-roots";

const projectRoot = resolve(import.meta.dir, "..");
/** These files are the audited runtime adapter ledger's native seams. */
const runtimeAdapterPaths = new Set([
  resolve(projectRoot, "packages/runtime/src/adapters.ts"),
  resolve(projectRoot, "packages/runtime/src/durable-object-client.ts"),
]);
const effectModuleMarker = "@enchiridion/effect-module";
const sourceGlob = new Glob("**/*.{ts,mts,cts,tsx}");
const workerSourceGlob = new Glob("**/src/**/*.{ts,mts,cts,tsx}");
const testFile = /\.test\.(?:ts|mts|cts|tsx)$/u;

type Violation = { readonly kind: string; readonly position: number };

const isConstAssertion = (node: ts.AsExpression | ts.TypeAssertion): boolean =>
  node.type.kind === ts.SyntaxKind.ConstType ||
  (ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) &&
    node.type.typeName.text === "const");

const typeName = (node: ts.EntityName): string =>
  ts.isIdentifier(node) ? node.text : node.right.text;

const isPromiseType = (checker: ts.TypeChecker, node: ts.Expression): boolean => {
  const type = checker.getTypeAtLocation(node);
  if (checker.getPromisedTypeOfPromise(type) !== undefined) return true;
  // Thenables from browser/Cloudflare APIs do not always resolve to lib.d.ts's
  // `Promise`; reject them too rather than treating an unknown platform type as
  // a safe Effect value.
  const apparent = checker.getApparentType(type);
  return (
    checker.getPropertyOfType(apparent, "then") !== undefined &&
    checker.getPropertyOfType(apparent, "catch") !== undefined
  );
};

const isPromiseReturningCallable = (checker: ts.TypeChecker, node: ts.Expression): boolean => {
  const returnsPromise = (type: ts.Type, visited: Set<ts.Type>): boolean => {
    if (visited.has(type)) return false;
    visited.add(type);
    if (checker.getPromisedTypeOfPromise(type) !== undefined) return true;
    const apparent = checker.getApparentType(type);
    if (
      checker.getPropertyOfType(apparent, "then") !== undefined &&
      checker.getPropertyOfType(apparent, "catch") !== undefined
    )
      return true;
    return [...type.getCallSignatures(), ...type.getConstructSignatures()].some((signature) =>
      returnsPromise(checker.getReturnTypeOfSignature(signature), visited),
    );
  };
  return returnsPromise(checker.getTypeAtLocation(node), new Set());
};

const calleeName = (expression: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
};

const findViolations = (sourceFile: ts.SourceFile, checker: ts.TypeChecker): readonly Violation[] => {
  const found: Violation[] = [];
  const add = (kind: string, node: ts.Node): void => {
    found.push({ kind, position: node.getStart(sourceFile) });
  };
  const inspectCallableEscape = (expression: ts.Expression): void => {
    if (isPromiseReturningCallable(checker, expression)) {
      add("Promise-returning callable escape", expression);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (!isConstAssertion(node)) add("type assertion", node);
    }
    if (ts.isTypeReferenceNode(node) && ["Promise", "PromiseLike"].includes(typeName(node.typeName))) {
      add("Promise type", node);
    }
    if (ts.isFunctionLike(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      add("async function", node);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add("dynamic import", node);
      const called = calleeName(node.expression);
      if (called === "fetch" || called === "request") add(`native ${called} call`, node);
      if (["then", "catch", "finally"].includes(called ?? "")) add("native Promise chain", node);
      if (isPromiseType(checker, node)) add("inferred Promise", node);
    }
    if (ts.isNewExpression(node) && isPromiseType(checker, node)) add("inferred Promise", node);
    if (ts.isExpression(node) && isPromiseType(checker, node)) add("inferred Promise", node);
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined)
      inspectCallableEscape(node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
      inspectCallableEscape(node.right);
    if (ts.isPropertyAssignment(node)) inspectCallableEscape(node.initializer);
    if (ts.isShorthandPropertyAssignment(node)) inspectCallableEscape(node.name);
    if (ts.isExportAssignment(node)) inspectCallableEscape(node.expression);
    if (ts.isReturnStatement(node) && node.expression !== undefined)
      inspectCallableEscape(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

const uniqueKinds = (violations: readonly Violation[]): readonly string[] =>
  [...new Set(violations.map(({ kind }) => kind))];

const programForConfig = (configPath: string): ts.Program => {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, resolve(configPath, ".."), undefined, configPath);
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
};

type FixtureExtension = ".ts" | ".mts" | ".cts" | ".tsx";

const scriptKindFor = (extension: FixtureExtension): ts.ScriptKind => {
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".mts") return ts.ScriptKind.MTS;
  if (extension === ".cts") return ts.ScriptKind.CTS;
  return ts.ScriptKind.TS;
};

const fixtureProgram = (source: string, extension: FixtureExtension): ts.Program => {
  const fixturePath = resolve(projectRoot, `__effect-boundary-fixture__${extension}`);
  const options = { strict: true, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.Preserve };
  const defaultHost = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (path) => path === fixturePath || defaultHost.fileExists(path),
    getSourceFile: (path, languageVersion) =>
      path === fixturePath
        ? ts.createSourceFile(path, source, languageVersion, true, scriptKindFor(extension))
        : defaultHost.getSourceFile(path, languageVersion),
    readFile: (path) => (path === fixturePath ? source : defaultHost.readFile(path)),
  };
  return ts.createProgram({ rootNames: [fixturePath], options, host });
};

const regressionFixtures = [
  { extension: ".ts", source: "const run = async () => 1;", expected: "async function" },
  { extension: ".ts", source: "class Worker { async request() { return 1; } }", expected: "async function" },
  { extension: ".ts", source: "const value = input as Record<string, unknown>;", expected: "type assertion" },
  { extension: ".ts", source: "const value = <Record<string, unknown>>input;", expected: "type assertion" },
  { extension: ".ts", source: "const pending: Promise<void> = Promise.resolve();", expected: "Promise type" },
  { extension: ".ts", source: "const pending = Promise.resolve(1);", expected: "inferred Promise" },
  { extension: ".ts", source: "const pending = fetch(url);", expected: "native fetch call" },
  { extension: ".ts", source: "client.request(url);", expected: "native request call" },
  { extension: ".ts", source: "fetch(url).then(handleResponse).catch(handleFailure).finally(cleanup);", expected: "native Promise chain" },
  { extension: ".ts", source: "const module = import(\"./dynamic\");", expected: "dynamic import" },
  { extension: ".ts", source: "const output = `${Promise.resolve(1)}`;", expected: "inferred Promise" },
  { extension: ".ts", source: "const result = left < right > other;", expected: undefined },
  { extension: ".mts", source: "const pending = Promise.resolve(1);", expected: "inferred Promise" },
  { extension: ".cts", source: "const run = async () => 1;", expected: "async function" },
  // TSX deliberately uses `as`, because angle-bracket assertions are invalid JSX syntax.
  { extension: ".tsx", source: "const value = input as Record<string, unknown>; const view = <div />;", expected: "type assertion" },
  {
    extension: ".ts",
    source: "declare const fetch: () => Promise<unknown>; export const leakedFetch = fetch;",
    expected: "Promise-returning callable escape",
  },
  {
    extension: ".ts",
    source: "declare class Request { json(): Promise<unknown> } export const leakedJSON = Request.prototype.json;",
    expected: "Promise-returning callable escape",
  },
  {
    extension: ".ts",
    source: "declare class Request { json(): Promise<unknown> } export const nested = { transport: { json: Request.prototype.json } };",
    expected: "Promise-returning callable escape",
  },
  {
    extension: ".ts",
    source: "declare const Factory: new () => Promise<unknown>; export const leakedConstructor = Factory;",
    expected: "Promise-returning callable escape",
  },
  {
    extension: ".ts",
    source: "declare const fetch: () => Promise<unknown>; export const nestedWrapper = () => fetch;",
    expected: "Promise-returning callable escape",
  },
  {
    extension: ".ts",
    source: "interface RecursiveCallable { (): RecursiveCallable } declare const recursive: RecursiveCallable; export const retained = recursive;",
    expected: undefined,
    clean: true,
  },
] as const;

for (const fixture of regressionFixtures) {
  const program = fixtureProgram(fixture.source, fixture.extension);
  const sourceFile = program
    .getSourceFiles()
    .find((file) => file.fileName.endsWith(`__effect-boundary-fixture__${fixture.extension}`));
  if (sourceFile === undefined) throw new Error("boundary checker fixture source missing");
  const kinds = uniqueKinds(findViolations(sourceFile, program.getTypeChecker()));
  if (fixture.expected !== undefined && !kinds.includes(fixture.expected)) {
    throw new Error(`boundary checker regression fixture bypassed: ${fixture.expected}`);
  }
  if (fixture.expected === undefined && fixture.clean === true && kinds.length > 0) {
    throw new Error(`boundary checker clean fixture produced: ${kinds.join(", ")}`);
  }
}

const deployableRoots = deployableTypeScriptRoots.map((root) => ({
  ...root,
  packagePath: resolve(projectRoot, root.path),
  sourcePath: root.sourcePath ?? "src",
}));
const sourcePaths = new Map<string, string>();

for (const root of deployableRoots) {
  for await (const relativePath of sourceGlob.scan({ cwd: resolve(root.packagePath, root.sourcePath) })) {
    const path = resolve(root.packagePath, root.sourcePath, relativePath);
    if (!testFile.test(path) && !runtimeAdapterPaths.has(path)) sourcePaths.set(path, relativePath);
  }
}
for await (const relativePath of workerSourceGlob.scan({ cwd: resolve(projectRoot, "workers") })) {
  const path = resolve(projectRoot, "workers", relativePath);
  if (testFile.test(path)) continue;
  const source = await Bun.file(path).text();
  if (source.includes(effectModuleMarker)) sourcePaths.set(path, `workers/${relativePath}`);
}

const violations: string[] = [];
for (const root of deployableRoots) {
  const program = programForConfig(resolve(root.packagePath, "tsconfig.json"));
  const checker = program.getTypeChecker();
  for (const sourceFile of program.getSourceFiles()) {
    const path = resolve(sourceFile.fileName);
    const displayPath = sourcePaths.get(path);
    if (displayPath === undefined) continue;
    const kinds = uniqueKinds(findViolations(sourceFile, checker));
    if (kinds.length > 0)
      violations.push(`${displayPath}: forbidden ${kinds.join(", ")}; use Effect and the audited adapter seam.`);
    sourcePaths.delete(path);
  }
}

// Marker-gated legacy sources may not have project references yet; analyse each
// using the same compiler API rather than falling back to lexical matching.
for (const [path, displayPath] of sourcePaths) {
  const source = await Bun.file(path).text();
  const extension = path.endsWith(".tsx")
    ? ".tsx"
    : path.endsWith(".mts")
      ? ".mts"
      : path.endsWith(".cts")
        ? ".cts"
        : ".ts";
  const program = fixtureProgram(source, extension);
  const sourceFile = program
    .getSourceFiles()
    .find((file) => file.fileName.endsWith(`__effect-boundary-fixture__${extension}`));
  if (sourceFile === undefined) throw new Error(`boundary checker could not parse ${displayPath}`);
  const kinds = uniqueKinds(findViolations(sourceFile, program.getTypeChecker()));
  if (kinds.length > 0)
    violations.push(`${displayPath}: forbidden ${kinds.join(", ")}; use Effect and the audited adapter seam.`);
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}
