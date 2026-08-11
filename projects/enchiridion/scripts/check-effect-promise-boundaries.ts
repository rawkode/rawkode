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
const runtimeAdaptersPath = resolve(projectRoot, "packages/runtime/src/adapters.ts");
const runtimeDurableObjectClientPath = resolve(
  projectRoot,
  "packages/runtime/src/durable-object-client.ts",
);
/** These files are the audited runtime adapter ledger's native seams. */
const runtimeAdapterPaths = new Set([
  runtimeAdaptersPath,
  runtimeDurableObjectClientPath,
  resolve(projectRoot, "packages/runtime/src/request-body.ts"),
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

/**
 * The only worker-side Effect-to-Promise exits. They must remain direct calls
 * to runtime's already-audited boundaries; wrappers, aliases, and any other
 * Promise source still pass through normal rejection below.
 */
const isRuntimeBoundaryType = (
  checker: ts.TypeChecker,
  node: ts.Expression,
  expectedName: "DurableObjectBoundary" | "WorkerBoundary",
): boolean => {
  const type = checker.getTypeAtLocation(node);
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return (
    symbol?.name === expectedName &&
    symbol.declarations?.some(
      (declaration) => resolve(declaration.getSourceFile().fileName) === runtimeAdaptersPath,
    ) === true
  );
};

const resolvedRuntimeSymbol = (
  checker: ts.TypeChecker,
  node: ts.Identifier,
  expectedName: "makeDurableObjectBoundary" | "makeWorkerBoundary",
): boolean => {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return false;
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return (
    resolved.name === expectedName &&
    resolved.declarations?.some(
      (declaration) => resolve(declaration.getSourceFile().fileName) === runtimeAdaptersPath,
    ) === true
  );
};

const isDirectRuntimeFactory = (
  checker: ts.TypeChecker,
  node: ts.Expression,
  expectedName: "makeDurableObjectBoundary" | "makeWorkerBoundary",
): boolean =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  resolvedRuntimeSymbol(checker, node.expression, expectedName);

const hasReadonlyModifier = (node: ts.PropertyDeclaration): boolean =>
  node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) === true;

const isDirectWorkerBoundaryBinding = (checker: ts.TypeChecker, node: ts.Identifier): boolean => {
  const symbol = checker.getSymbolAtLocation(node);
  const declaration = symbol?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    isDirectRuntimeFactory(checker, declaration.initializer, "makeWorkerBoundary")
  );
};

const isDirectDurableObjectBoundaryProperty = (
  checker: ts.TypeChecker,
  node: ts.PropertyAccessExpression,
): boolean => {
  const symbol = checker.getSymbolAtLocation(node.name);
  const declaration = symbol?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isPropertyDeclaration(declaration) &&
    hasReadonlyModifier(declaration) &&
    declaration.initializer !== undefined &&
    isDirectRuntimeFactory(checker, declaration.initializer, "makeDurableObjectBoundary")
  );
};

const isAuditedDurableObjectFetch = (checker: ts.TypeChecker, node: ts.CallExpression): boolean => {
  const fetch = node.expression;
  if (!ts.isPropertyAccessExpression(fetch) || fetch.name.text !== "fetch") return false;
  const callbacks = fetch.expression;
  if (!ts.isPropertyAccessExpression(callbacks) || callbacks.name.text !== "callbacks") return false;
  const boundary = callbacks.expression;
  return (
    ts.isPropertyAccessExpression(boundary) &&
    boundary.name.text === "boundary" &&
    boundary.expression.kind === ts.SyntaxKind.ThisKeyword &&
    isRuntimeBoundaryType(checker, boundary, "DurableObjectBoundary") &&
    isDirectDurableObjectBoundaryProperty(checker, boundary) &&
    node.arguments.length === 1
  );
};

const isAuditedWorkerHandle = (checker: ts.TypeChecker, node: ts.CallExpression): boolean => {
  const handle = node.expression;
  return (
    ts.isPropertyAccessExpression(handle) &&
    handle.name.text === "handle" &&
    ts.isIdentifier(handle.expression) &&
    handle.expression.text === "boundary" &&
    isRuntimeBoundaryType(checker, handle.expression, "WorkerBoundary") &&
    isDirectWorkerBoundaryBinding(checker, handle.expression) &&
    node.arguments.length === 3
  );
};

const isAuditedBoundaryExit = (checker: ts.TypeChecker, node: ts.CallExpression): boolean =>
  isAuditedDurableObjectFetch(checker, node) || isAuditedWorkerHandle(checker, node);

const isAuditedWorkerFetchProperty = (checker: ts.TypeChecker, node: ts.PropertyAssignment): boolean =>
  ts.isIdentifier(node.name) &&
  node.name.text === "fetch" &&
  ts.isArrowFunction(node.initializer) &&
  ts.isCallExpression(node.initializer.body) &&
  isAuditedWorkerHandle(checker, node.initializer.body);

/**
 * In deployable Effect modules, a callback-shaped boundary exit is privileged
 * even when TypeScript has erased it to `any`.  Reject it unless the exact AST
 * and runtime-adapter provenance above prove it is our audited conversion.
 */
const resemblesBoundaryExit = (node: ts.CallExpression): boolean => {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) return false;
  if (expression.name.text === "handle") return true;
  return (
    expression.name.text === "fetch" &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "callbacks"
  );
};

const isProvenBoundaryTarget = (checker: ts.TypeChecker, node: ts.Expression): boolean =>
  (ts.isIdentifier(node) &&
    isRuntimeBoundaryType(checker, node, "WorkerBoundary") &&
    isDirectWorkerBoundaryBinding(checker, node)) ||
  (ts.isPropertyAccessExpression(node) &&
    node.name.text === "boundary" &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword &&
    isRuntimeBoundaryType(checker, node, "DurableObjectBoundary") &&
    isDirectDurableObjectBoundaryProperty(checker, node));

const isProvenBoundaryOrCallbacksTarget = (checker: ts.TypeChecker, node: ts.Expression): boolean =>
  isProvenBoundaryTarget(checker, node) ||
  (ts.isPropertyAccessExpression(node) &&
    node.name.text === "callbacks" &&
    isProvenBoundaryTarget(checker, node.expression));

/**
 * Runtime's fixed Durable Object client is the other audited invoke seam. Its
 * `invoke` already returns Effect, so recognition here does not admit any new
 * Promise flow; it instead pins the call to direct, provenance-checked use of
 * `makeFixedDurableObjectClient` and rejects aliases, wrappers, and mutation.
 */
const isRuntimeFixedClientType = (checker: ts.TypeChecker, node: ts.Expression): boolean => {
  const type = checker.getTypeAtLocation(node);
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return (
    symbol?.name === "FixedDurableObjectClient" &&
    symbol.declarations?.some(
      (declaration) =>
        resolve(declaration.getSourceFile().fileName) === runtimeDurableObjectClientPath,
    ) === true
  );
};

const resolvedFixedClientFactorySymbol = (checker: ts.TypeChecker, node: ts.Identifier): boolean => {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return false;
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return (
    resolved.name === "makeFixedDurableObjectClient" &&
    resolved.declarations?.some(
      (declaration) =>
        resolve(declaration.getSourceFile().fileName) === runtimeDurableObjectClientPath,
    ) === true
  );
};

const isDirectFixedClientFactory = (checker: ts.TypeChecker, node: ts.Expression): boolean =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  resolvedFixedClientFactorySymbol(checker, node.expression);

const isDirectFixedClientBinding = (checker: ts.TypeChecker, node: ts.Identifier): boolean => {
  const symbol = checker.getSymbolAtLocation(node);
  const declaration = symbol?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    isDirectFixedClientFactory(checker, declaration.initializer)
  );
};

const isDirectFixedClientProperty = (
  checker: ts.TypeChecker,
  node: ts.PropertyAccessExpression,
): boolean => {
  const symbol = checker.getSymbolAtLocation(node.name);
  const declaration = symbol?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isPropertyDeclaration(declaration) &&
    hasReadonlyModifier(declaration) &&
    declaration.initializer !== undefined &&
    isDirectFixedClientFactory(checker, declaration.initializer)
  );
};

const isProvenFixedClientTarget = (checker: ts.TypeChecker, node: ts.Expression): boolean =>
  isDirectFixedClientFactory(checker, node) ||
  (ts.isIdentifier(node) &&
    isRuntimeFixedClientType(checker, node) &&
    isDirectFixedClientBinding(checker, node)) ||
  (ts.isPropertyAccessExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword &&
    isRuntimeFixedClientType(checker, node) &&
    isDirectFixedClientProperty(checker, node));

const isAuditedFixedClientInvoke = (
  checker: ts.TypeChecker,
  node: ts.PropertyAccessExpression,
): boolean =>
  ts.isCallExpression(node.parent) &&
  node.parent.expression === node &&
  node.parent.arguments.length === 1 &&
  isProvenFixedClientTarget(checker, node.expression);

const isProvenAuditedMutationTarget = (checker: ts.TypeChecker, node: ts.Expression): boolean =>
  isProvenBoundaryOrCallbacksTarget(checker, node) || isProvenFixedClientTarget(checker, node);

const findViolations = (sourceFile: ts.SourceFile, checker: ts.TypeChecker): readonly Violation[] => {
  const found: Violation[] = [];
  const deployableEffectModule = sourceFile.getFullText().includes(effectModuleMarker);
  const add = (kind: string, node: ts.Node): void => {
    found.push({ kind, position: node.getStart(sourceFile) });
  };
  const inspectCallableEscape = (expression: ts.Expression): void => {
    if (isPromiseReturningCallable(checker, expression)) {
      add("Promise-returning callable escape", expression);
    }
  };
  const visit = (node: ts.Node): void => {
    if (deployableEffectModule && node.kind === ts.SyntaxKind.AnyKeyword)
      add("explicit any", node);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (!isConstAssertion(node)) add("type assertion", node);
    }
    if (
      deployableEffectModule &&
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "invoke" &&
      isRuntimeFixedClientType(checker, node.expression) &&
      !isAuditedFixedClientInvoke(checker, node)
    )
      add("unapproved durable object client invoke", node);
    if (ts.isTypeReferenceNode(node) && ["Promise", "PromiseLike"].includes(typeName(node.typeName))) {
      add("Promise type", node);
    }
    if (ts.isFunctionLike(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      add("async function", node);
    }
    if (ts.isCallExpression(node)) {
      if (isAuditedBoundaryExit(checker, node)) {
        /** The Promise result is boundary-owned, but the Effect argument is not. */
        for (const argument of node.arguments) visit(argument);
        return;
      }
      if (deployableEffectModule && resemblesBoundaryExit(node))
        add("unapproved boundary exit", node);
      if (
        deployableEffectModule &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(sourceFile) === "Object" &&
        ["assign", "defineProperty", "defineProperties"].includes(node.expression.name.text) &&
        node.arguments[0] !== undefined &&
        isProvenAuditedMutationTarget(checker, node.arguments[0])
      )
        add("audited boundary mutation", node);
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
    ) {
      if (
        deployableEffectModule &&
        ts.isPropertyAccessExpression(node.left) &&
        isProvenAuditedMutationTarget(checker, node.left.expression)
      )
        add("audited boundary mutation", node);
      inspectCallableEscape(node.right);
    }
    if (
      deployableEffectModule &&
      ts.isDeleteExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isProvenAuditedMutationTarget(checker, node.expression.expression)
    )
      add("audited boundary mutation", node);
    if (ts.isPropertyAssignment(node) && !isAuditedWorkerFetchProperty(checker, node))
      inspectCallableEscape(node.initializer);
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

const runtimeBoundaryFixture = (source: string): { readonly sourceFile: ts.SourceFile; readonly checker: ts.TypeChecker } => {
  const fixturePath = resolve(projectRoot, "__effect-boundary-runtime-fixture__.ts");
  const options = { strict: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const defaultHost = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (path) => path === fixturePath || defaultHost.fileExists(path),
    getSourceFile: (path, languageVersion) =>
      path === fixturePath
        ? ts.createSourceFile(path, source, languageVersion, true, ts.ScriptKind.TS)
        : defaultHost.getSourceFile(path, languageVersion),
    readFile: (path) => (path === fixturePath ? source : defaultHost.readFile(path)),
  };
  const program = ts.createProgram({ rootNames: [fixturePath], options, host });
  const sourceFile = program.getSourceFiles().find((file) => file.fileName === fixturePath);
  if (sourceFile === undefined) throw new Error("boundary checker runtime fixture source missing");
  return { sourceFile, checker: program.getTypeChecker() };
};

const boundaryCallNamed = (
  sourceFile: ts.SourceFile,
  name: "fetch" | "handle",
): ts.CallExpression | undefined => {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      found === undefined &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === name
    )
      found = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

const boundaryCalls = (sourceFile: ts.SourceFile): readonly ts.CallExpression[] => {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

const runtimeAdapterImport = JSON.stringify(runtimeAdaptersPath);
const runtimeFixturePrefix = `import { makeWorkerBoundary, makeDurableObjectBoundary } from ${runtimeAdapterImport};\ndeclare const workerHandler: Parameters<typeof makeWorkerBoundary>[0]; declare const state: Parameters<typeof makeDurableObjectBoundary>[0];\nconst boundary = makeWorkerBoundary(workerHandler);\ndeclare const request: unknown; declare const env: unknown; declare const ctx: unknown; declare const effect: never;\n`;
const runtimeWorkerFixture = runtimeBoundaryFixture(
  `${runtimeFixturePrefix}export const worker = { fetch: () => boundary.handle(request, env, ctx) };`,
);
const runtimeDurableObjectFixture = runtimeBoundaryFixture(
  `${runtimeFixturePrefix}class Holder { private readonly boundary = makeDurableObjectBoundary(state); fetch = () => this.boundary.callbacks.fetch(effect); }`,
);
const workerCall = boundaryCallNamed(runtimeWorkerFixture.sourceFile, "handle");
const durableObjectCall = boundaryCallNamed(runtimeDurableObjectFixture.sourceFile, "fetch");
const workerFixtureAccepted =
  workerCall !== undefined && isAuditedWorkerHandle(runtimeWorkerFixture.checker, workerCall);
const durableObjectFixtureAccepted =
  durableObjectCall !== undefined &&
  isAuditedDurableObjectFetch(runtimeDurableObjectFixture.checker, durableObjectCall);
const workerFixtureViolations = uniqueKinds(
  findViolations(runtimeWorkerFixture.sourceFile, runtimeWorkerFixture.checker),
);
const durableObjectFixtureViolations = uniqueKinds(
  findViolations(runtimeDurableObjectFixture.sourceFile, runtimeDurableObjectFixture.checker),
);
const fixtureTypeDescription = (checker: ts.TypeChecker, node: ts.Expression): string => {
  const type = checker.getTypeAtLocation(node);
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return `${checker.typeToString(type)}:${symbol?.name ?? "none"}:${symbol?.declarations?.map((declaration) => resolve(declaration.getSourceFile().fileName)).join(",") ?? "none"}`;
};
if (
  !workerFixtureAccepted ||
  !durableObjectFixtureAccepted ||
  workerFixtureViolations.length !== 0 ||
  durableObjectFixtureViolations.length !== 0
)
  throw new Error(
    `boundary checker audited callback fixture bypassed: worker=${workerFixtureAccepted}/${workerFixtureViolations.join(",")}/${workerCall === undefined ? "missing" : fixtureTypeDescription(runtimeWorkerFixture.checker, (workerCall.expression as ts.PropertyAccessExpression).expression)}; durable=${durableObjectFixtureAccepted}/${durableObjectFixtureViolations.join(",")}/${durableObjectCall === undefined ? "missing" : fixtureTypeDescription(runtimeDurableObjectFixture.checker, ((durableObjectCall.expression as ts.PropertyAccessExpression).expression as ts.PropertyAccessExpression).expression)}`,
  );

const rejectedBoundaryFixtures = [
  "const boundary = { handle: (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined) }; boundary.handle(request, env, ctx);",
  "const boundary: any = {}; boundary.handle(request, env, ctx);",
  "declare const injected: unknown; const fake: { handle: any } = injected as { handle: any }; const { handle } = fake; export const worker = { fetch: () => handle(request, env, ctx) };",
  "const boundary: unknown = {}; (boundary as { handle: (...args: unknown[]) => Promise<unknown> }).handle(request, env, ctx);",
  `${runtimeFixturePrefix}const handle = boundary.handle; handle(request, env, ctx);`,
  `${runtimeFixturePrefix}const fetch = boundary.handle; fetch(request, env, ctx);`,
  `${runtimeFixturePrefix}const other = boundary; other.handle(request, env, ctx);`,
  `${runtimeFixturePrefix}boundary.fetch(request, env, ctx);`,
  `import { makeWorkerBoundary } from ${runtimeAdapterImport}; declare const workerHandler: Parameters<typeof makeWorkerBoundary>[0]; declare const request: unknown; declare const env: unknown; declare const ctx: unknown; let boundary = makeWorkerBoundary(workerHandler); boundary.handle(request, env, ctx);`,
  `import { makeDurableObjectBoundary } from ${runtimeAdapterImport}; declare const state: Parameters<typeof makeDurableObjectBoundary>[0]; declare const effect: never; class Holder { private readonly boundary; constructor() { this.boundary = makeDurableObjectBoundary(state); } fetch = () => this.boundary.callbacks.fetch(effect); }`,
] as const;
for (const source of rejectedBoundaryFixtures) {
  const fixture = runtimeBoundaryFixture(`/** ${effectModuleMarker} */\n${source}`);
  if (boundaryCalls(fixture.sourceFile).some((call) => isAuditedBoundaryExit(fixture.checker, call)))
    throw new Error("boundary checker rejected callback fixture bypassed");
  if (uniqueKinds(findViolations(fixture.sourceFile, fixture.checker)).length === 0)
    throw new Error("boundary checker rejected callback fixture produced no violation");
}

const extraWrapperFixture = runtimeBoundaryFixture(
  `${runtimeFixturePrefix}const wrapped = () => boundary.handle(request, env, ctx); wrapped();`,
);
if (uniqueKinds(findViolations(extraWrapperFixture.sourceFile, extraWrapperFixture.checker)).length === 0)
  throw new Error("boundary checker extra wrapper fixture bypassed");

const nestedArgumentFixtures = [
  `${runtimeFixturePrefix}boundary.handle(fetch(url).then(value => value).catch(error => error), env, ctx);`,
  `${runtimeFixturePrefix}boundary.handle(import("./dynamic"), env, ctx);`,
  `${runtimeFixturePrefix}boundary.handle(value as unknown, env, ctx);`,
] as const;
for (const source of nestedArgumentFixtures) {
  const fixture = runtimeBoundaryFixture(source);
  if (uniqueKinds(findViolations(fixture.sourceFile, fixture.checker)).length === 0)
    throw new Error("boundary checker nested argument fixture bypassed");
}

const mutationFixtures = [
  `${runtimeFixturePrefix}boundary.handle = boundary.handle;`,
  `${runtimeFixturePrefix}Object.assign(boundary, {});`,
  `${runtimeFixturePrefix}Object.defineProperty(boundary, "handle", { value: boundary.handle });`,
  `${runtimeFixturePrefix}delete boundary.handle;`,
  `${runtimeFixturePrefix}class Holder { private readonly boundary = makeDurableObjectBoundary(state); mutate() { this.boundary.callbacks.fetch = this.boundary.callbacks.fetch; } }`,
  `${runtimeFixturePrefix}class Holder { private readonly boundary = makeDurableObjectBoundary(state); mutate() { Object.assign(this.boundary.callbacks, {}); } }`,
] as const;
for (const source of mutationFixtures) {
  const fixture = runtimeBoundaryFixture(`/** ${effectModuleMarker} */\n${source}`);
  if (!uniqueKinds(findViolations(fixture.sourceFile, fixture.checker)).includes("audited boundary mutation"))
    throw new Error("boundary checker mutation fixture bypassed");
}

const runtimeClientImport = JSON.stringify(runtimeDurableObjectClientPath);
const clientFixturePrefix = `import { makeFixedDurableObjectClient } from ${runtimeClientImport};\ndeclare const namespace: Parameters<typeof makeFixedDurableObjectClient>[0]; declare const configuration: Parameters<typeof makeFixedDurableObjectClient>[1]; declare const payload: Parameters<ReturnType<typeof makeFixedDurableObjectClient>["invoke"]>[0];\n`;

/** Direct, provenance-checked fixed-client invokes must stay accepted verbatim. */
const acceptedFixedClientFixtures = [
  `${clientFixturePrefix}export const invoked = makeFixedDurableObjectClient(namespace, configuration).invoke(payload);`,
  `${clientFixturePrefix}const client = makeFixedDurableObjectClient(namespace, configuration); export const invoked = client.invoke(payload);`,
  `${clientFixturePrefix}class Holder { private readonly client = makeFixedDurableObjectClient(namespace, configuration); run() { return this.client.invoke(payload); } }`,
] as const;
for (const source of acceptedFixedClientFixtures) {
  const fixture = runtimeBoundaryFixture(`/** ${effectModuleMarker} */\n${source}`);
  const kinds = uniqueKinds(findViolations(fixture.sourceFile, fixture.checker));
  if (kinds.length > 0)
    throw new Error(`boundary checker accepted fixed client fixture produced: ${kinds.join(", ")}`);
}

/** Aliased, wrapped, indirect, or non-const client access is never audited. */
const rejectedFixedClientFixtures = [
  `${clientFixturePrefix}const client = makeFixedDurableObjectClient(namespace, configuration); const invoke = client.invoke; export const leaked = invoke(payload);`,
  `${clientFixturePrefix}const client = makeFixedDurableObjectClient(namespace, configuration); const indirect = client; export const invoked = indirect.invoke(payload);`,
  `${clientFixturePrefix}const client = makeFixedDurableObjectClient(namespace, configuration); export const wrapped = { invoke: client.invoke };`,
  `${clientFixturePrefix}let client = makeFixedDurableObjectClient(namespace, configuration); export const invoked = client.invoke(payload);`,
  `${clientFixturePrefix}class Holder { private client = makeFixedDurableObjectClient(namespace, configuration); run() { return this.client.invoke(payload); } }`,
] as const;
for (const source of rejectedFixedClientFixtures) {
  const fixture = runtimeBoundaryFixture(`/** ${effectModuleMarker} */\n${source}`);
  const kinds = uniqueKinds(findViolations(fixture.sourceFile, fixture.checker));
  if (!kinds.includes("unapproved durable object client invoke"))
    throw new Error("boundary checker rejected fixed client fixture bypassed");
}

/** A structurally similar but non-provenance `invoke` is still Promise-checked. */
const promiseFixedClientFixture = runtimeBoundaryFixture(
  `/** ${effectModuleMarker} */\n${clientFixturePrefix}const fake = { invoke: (input: unknown) => Promise.resolve(input) }; export const invoked = fake.invoke(payload);`,
);
if (uniqueKinds(findViolations(promiseFixedClientFixture.sourceFile, promiseFixedClientFixture.checker)).length === 0)
  throw new Error("boundary checker non-provenance invoke fixture bypassed");

const fixedClientMutationFixtures = [
  `${clientFixturePrefix}const client = makeFixedDurableObjectClient(namespace, configuration); client.invoke = client.invoke;`,
  `${clientFixturePrefix}const client = makeFixedDurableObjectClient(namespace, configuration); Object.assign(client, {});`,
  `${clientFixturePrefix}const client = makeFixedDurableObjectClient(namespace, configuration); Object.defineProperty(client, "invoke", { value: undefined });`,
  `${clientFixturePrefix}const client = makeFixedDurableObjectClient(namespace, configuration); delete client.invoke;`,
  `${clientFixturePrefix}class Holder { private readonly client = makeFixedDurableObjectClient(namespace, configuration); mutate() { this.client.invoke = this.client.invoke; } }`,
] as const;
for (const source of fixedClientMutationFixtures) {
  const fixture = runtimeBoundaryFixture(`/** ${effectModuleMarker} */\n${source}`);
  if (!uniqueKinds(findViolations(fixture.sourceFile, fixture.checker)).includes("audited boundary mutation"))
    throw new Error("boundary checker fixed client mutation fixture bypassed");
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
