import ts from "typescript"

const forbiddenIdentifiers = new Set(["Promise", "WebSocket", "fetch", "caches", "Effect", "env", "crypto", "setTimeout", "setInterval", "queueMicrotask", "eval", "Function", "require"])
const forbiddenProperties = new Set(["fetch", "waitUntil", "caches", "crypto", "subtle", "storage", "stub", "env"])

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
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = literalModuleSpecifier(node)
      if (specifier === undefined) throw new Error(`dynamic or unresolved local handler import in ${file}`)
      if (!specifier.startsWith(".") && specifier !== "@athenaeum/domain") throw new Error(`nonlocal local handler import: ${specifier}`)
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error(`dynamic import in local handler: ${file}`)
      if (ts.isIdentifier(node.expression) && forbiddenIdentifiers.has(node.expression.text)) throw new Error(`forbidden local handler API: ${node.expression.text}`)
    }
    if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) throw new Error(`forbidden local handler API: ${node.text}`)
    if (ts.isPropertyAccessExpression(node) && forbiddenProperties.has(node.name.text)) throw new Error(`forbidden local handler property: ${node.name.text}`)
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && forbiddenProperties.has(node.argumentExpression.text)) throw new Error(`forbidden local handler property: ${node.argumentExpression.text}`)
    ts.forEachChild(node, visit)
  }
  visit(tree)
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
      if (!specifier || specifier === "@athenaeum/domain") return
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
