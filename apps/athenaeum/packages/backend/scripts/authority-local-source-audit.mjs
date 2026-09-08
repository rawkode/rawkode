import ts from "typescript"
import { AUTHORITY_PURE_INTRINSICS } from "../src/authority-pure-intrinsics.mjs"

const forbiddenIdentifiers = new Set(["Promise", "WebSocket", "fetch", "caches", "Effect", "env", "crypto", "setTimeout", "setInterval", "queueMicrotask", "eval", "Function", "require", "globalThis", "window", "document", "process"])
const forbiddenProperties = new Set(["fetch", "waitUntil", "caches", "crypto", "subtle", "storage", "stub", "env", "constructor", "prototype", "__proto__", "getPrototypeOf", "setPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getOwnPropertyNames", "getOwnPropertySymbols", "defineProperty", "defineProperties", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "caller", "callee", "arguments", "apply", "bind", "call"])
const allowedIntrinsics = new Set(AUTHORITY_PURE_INTRINSICS)
/**
 * Pure globals are not values in local commands: a handler may only invoke one of these exact
 * static methods. This prevents aliases/enumeration/reflection from recovering constructors.
 */
const allowedIntrinsicReceiverMethods = Object.freeze({
  Array: new Set(["isArray"]),
  JSON: new Set(["parse", "stringify"]),
  Math: new Set(["abs", "ceil", "floor", "max", "min", "round", "trunc"]),
  Number: new Set(["isFinite", "isInteger", "isNaN", "parseFloat", "parseInt"]),
  Object: new Set(["entries", "freeze", "hasOwn", "keys", "values"]),
  String: new Set(["fromCharCode", "fromCodePoint"])
})

const bindName = (scope, node) => {
  if (ts.isIdentifier(node)) scope.add(node.text)
  else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) for (const element of node.elements) if (ts.isBindingElement(element)) bindName(scope, element.name)
}
const declarationName = (node) => ts.isDeclarationName(node) || ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent) || ts.isPropertyAccessExpression(node.parent) && node.parent.name === node || ts.isPropertyAssignment(node.parent) && node.parent.name === node || ts.isPropertyDeclaration(node.parent) && node.parent.name === node || ts.isQualifiedName(node.parent) || ts.isTypeNode(node.parent) || ts.isLabeledStatement(node.parent)
const hoist = (scope, node) => {
  for (const statement of node.statements ?? []) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) { if (statement.name) bindName(scope, statement.name) }
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) bindName(scope, declaration.name)
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause
      if (clause.name) bindName(scope, clause.name)
      const bindings = clause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) bindName(scope, bindings.name)
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) bindName(scope, item.name)
    }
  }
}
/** Lexical, not file-global, free-variable check. Every scope carries only ancestors' bindings. */
const validateClosedBindings = (tree, file) => {
  const walk = (node, inherited) => {
    const scope = new Set(inherited)
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) hoist(scope, node)
    if (ts.isFunctionLike(node)) {
      if (node.name && ts.isIdentifier(node.name)) bindName(scope, node.name)
      for (const parameter of node.parameters) bindName(scope, parameter.name)
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) bindName(scope, node.variableDeclaration.name)
    if (ts.isIdentifier(node) && !declarationName(node) && !scope.has(node.text) && !allowedIntrinsics.has(node.text)) throw new Error(`unresolved or ambient local handler identifier: ${node.text} in ${file}`)
    ts.forEachChild(node, (child) => walk(child, scope))
  }
  walk(tree, new Set())
}

const isBindingName = (node) => {
  const parent = node.parent
  return (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isEnumDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isModuleDeclaration(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportSpecifier(parent)) && parent.name === node
}

const validateNoIntrinsicShadowing = (tree, file) => {
  const visit = (node) => {
    if (ts.isIdentifier(node) && allowedIntrinsics.has(node.text) && isBindingName(node)) throw new Error(`local handler may not shadow pure intrinsic: ${node.text} in ${file}`)
    ts.forEachChild(node, visit)
  }
  visit(tree)
}

const validatePureIntrinsicUses = (tree, file) => {
  const visit = (node) => {
    if (ts.isIdentifier(node) && allowedIntrinsics.has(node.text) && !declarationName(node)) {
      const access = node.parent
      const methods = allowedIntrinsicReceiverMethods[node.text]
      const call = ts.isPropertyAccessExpression(access) ? access.parent : undefined
      if (!ts.isPropertyAccessExpression(access) || access.expression !== node || methods === undefined || !methods.has(access.name.text) || !ts.isCallExpression(call) || call.expression !== access || access.questionDotToken !== undefined || call.questionDotToken !== undefined) {
        throw new Error(`forbidden local handler intrinsic use: ${node.text} in ${file}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
}

const staticPropertyName = (node) => ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined

const validateObjectBindingKeys = (tree, file) => {
  const validate = (name) => {
    if (ts.isComputedPropertyName(name)) throw new Error(`computed local handler binding property is forbidden: ${file}`)
    const key = staticPropertyName(name)
    if (key === undefined || forbiddenProperties.has(key)) throw new Error(`forbidden local handler binding property: ${key ?? "<unknown>"} in ${file}`)
  }
  const visit = (node) => {
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : undefined)
      if (name !== undefined) validate(name)
    }
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) validate(node.name)
    ts.forEachChild(node, visit)
  }
  visit(tree)
}

const unparenthesized = (node) => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) ? unparenthesized(node.expression) : node

const isObjectFreeze = (node) => ts.isCallExpression(node) && node.arguments.length === 1 && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" && node.expression.name.text === "freeze"

const isImmutableModuleValue = (value) => {
  const node = unparenthesized(value)
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true
  if (!isObjectFreeze(node)) return false
  const frozen = unparenthesized(node.arguments[0])
  if (ts.isArrayLiteralExpression(frozen)) return frozen.elements.every((element) => !ts.isSpreadElement(element) && isImmutableModuleValue(element))
  if (ts.isObjectLiteralExpression(frozen)) return frozen.properties.every((property) => ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && isImmutableModuleValue(property.initializer))
  return false
}

const validateModuleState = (tree, file) => {
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) throw new Error(`mutable module state is forbidden in local handler: ${file}`)
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer === undefined || !isImmutableModuleValue(declaration.initializer)) throw new Error(`mutable module state is forbidden in local handler: ${file}`)
    }
  }
}

const propertyWriteOperators = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
])

const containsPropertyTarget = (node) => {
  const target = unparenthesized(node)
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) return true
  let found = false
  ts.forEachChild(target, (child) => { if (!found && containsPropertyTarget(child)) found = true })
  return found
}

const validateNoStateCarriers = (tree, file) => {
  const reject = (detail) => { throw new Error(`mutable local handler state carrier is forbidden (${detail}): ${file}`) }
  const visit = (node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) reject("class")
    if (ts.isClassStaticBlockDeclaration(node)) reject("class static block")
    if (ts.isPropertyDeclaration(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) reject("class static field")
    if (ts.isEnumDeclaration(node)) reject("enum")
    if (ts.isModuleDeclaration(node)) reject("namespace")
    if (ts.isBinaryExpression(node) && propertyWriteOperators.has(node.operatorToken.kind) && containsPropertyTarget(node.left)) reject("property write")
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) && containsPropertyTarget(node.operand)) reject("property update")
    if (ts.isDeleteExpression(node) && containsPropertyTarget(node.expression)) reject("property delete")
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && containsPropertyTarget(node.initializer)) reject("property loop assignment")
    ts.forEachChild(node, visit)
  }
  visit(tree)
}

const literalModuleSpecifier = (declaration) => declaration.moduleSpecifier && ts.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : undefined
const isRuntimeModuleDeclaration = (node) => !((ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) || (ts.isExportDeclaration(node) && node.isTypeOnly))
const normalizeRelative = (from, specifier) => {
  if (!specifier.startsWith(".")) return undefined
  const withoutExtension = specifier.replace(/\.(?:[cm]?js|tsx?)$/, "")
  const candidate = `${withoutExtension}.ts`
  const base = from.slice(0, from.lastIndexOf("/") + 1)
  const parts = []
  for (const part of `${base}${candidate}`.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") { if (parts.length === 0) return undefined; parts.pop() } else parts.push(part)
  }
  return `/${parts.join("/")}`
}

const forbiddenSyntax = (source, file) => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if (tree.parseDiagnostics.length > 0) throw new Error(`unparseable local handler source: ${file}`)
  validateNoStateCarriers(tree, file)
  validateModuleState(tree, file)
  const visit = (node) => {
    if (ts.isFunctionLike(node) && (node.asteriskToken !== undefined || node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))) throw new Error(`suspending local handler function is forbidden: ${file}`)
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) throw new Error(`suspending local handler expression is forbidden: ${file}`)
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) throw new Error(`for-await local handler loop is forbidden: ${file}`)
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = literalModuleSpecifier(node)
      if (specifier === undefined) throw new Error(`dynamic or unresolved local handler import in ${file}`)
      if (!specifier.startsWith(".")) throw new Error(`nonlocal local handler import: ${specifier}`)
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error(`dynamic import in local handler: ${file}`)
      if (ts.isIdentifier(node.expression) && forbiddenIdentifiers.has(node.expression.text)) throw new Error(`forbidden local handler API: ${node.expression.text}`)
    }
    if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) throw new Error(`forbidden local handler API: ${node.text}`)
    if (ts.isElementAccessExpression(node)) throw new Error(`computed local handler property access is forbidden: ${file}`)
    if (ts.isComputedPropertyName(node)) throw new Error(`computed local handler property name is forbidden: ${file}`)
    if (ts.isPropertyAccessExpression(node) && forbiddenProperties.has(node.name.text)) throw new Error(`forbidden local handler property: ${node.name.text}`)
    if (ts.isIdentifier(node) && node.text === "Atomics") throw new Error("forbidden local handler API: Atomics")
    ts.forEachChild(node, visit)
  }
  visit(tree)
  validateNoIntrinsicShadowing(tree, file)
  validatePureIntrinsicUses(tree, file)
  validateObjectBindingKeys(tree, file)
  validateClosedBindings(tree, file)
  return tree
}

/** Pure source-map audit used by Worker tests; comments and strings are not inspected. */
export const auditLocalHandlerGraph = (files, entrypoints) => {
  const visiting = new Set(), visited = new Set()
  const walk = (file) => {
    if (visiting.has(file)) throw new Error(`cycle in local handler imports: ${file}`)
    if (visited.has(file)) return
    const source = files[file]
    if (typeof source !== "string") throw new Error(`unresolved local handler import: ${file}`)
    visiting.add(file)
    const tree = forbiddenSyntax(source, file)
    tree.forEachChild((node) => {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node) || !isRuntimeModuleDeclaration(node)) return
      const specifier = literalModuleSpecifier(node)
      if (!specifier) return
      const target = normalizeRelative(file, specifier)
      if (!target || !(target in files)) throw new Error(`unresolved or escaping local handler import: ${specifier} from ${file}`)
      walk(target)
    })
    visiting.delete(file); visited.add(file)
  }
  for (const entry of entrypoints) walk(entry)
  return [...visited]
}

export const auditLocalHandlerFiles = (root, entrypoints, readText, resolveImport) => {
  const visiting = new Set(), visited = new Set()
  const walk = (file) => {
    const real = file.startsWith("/") ? file : resolveImport(file)
    if (!real.startsWith(`${root}/`)) throw new Error(`local handler path escapes approved root: ${file}`)
    if (visiting.has(real)) throw new Error(`cycle in local handler imports: ${real}`)
    if (visited.has(real)) return
    visiting.add(real)
    const source = readText(real); const tree = forbiddenSyntax(source, real)
    tree.forEachChild((node) => {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node) || !isRuntimeModuleDeclaration(node)) return
      const specifier = literalModuleSpecifier(node)
      if (!specifier || specifier === "@athenaeum/domain") return
      if (!specifier.startsWith(".")) throw new Error(`nonlocal local handler import: ${specifier}`)
      const target = resolveImport(real, specifier)
      if (!target.startsWith(`${root}/`)) throw new Error(`local handler import escapes root: ${specifier}`)
      walk(target)
    })
    visiting.delete(real); visited.add(real)
  }
  for (const entry of entrypoints) walk(entry)
  return [...visited]
}
