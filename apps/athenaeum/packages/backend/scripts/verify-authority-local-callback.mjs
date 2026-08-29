import ts from "typescript"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { auditLocalHandlerFiles } from "./authority-local-source-audit.mjs"

const defaultRoot = realpathSync(new URL("../src", import.meta.url).pathname)

const resolveSource = (from, specifier) => {
  const withoutExtension = specifier.replace(/\.(?:[cm]?js|[cm]?tsx?)$/, "")
  const candidates = [
    resolve(dirname(from), `${withoutExtension}.ts`),
    resolve(dirname(from), `${withoutExtension}.tsx`),
    resolve(dirname(from), `${withoutExtension}.mts`),
    resolve(dirname(from), `${withoutExtension}.cts`),
    resolve(dirname(from), withoutExtension, "index.ts"),
    resolve(dirname(from), withoutExtension, "index.tsx")
  ]
  const candidate = candidates.find((path) => existsSync(path))
  if (candidate === undefined) throw new Error(`unresolved local module import: ${specifier} from ${from}`)
  return realpathSync(candidate)
}

const moduleSpecifiers = (file, source) => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if (tree.parseDiagnostics.length > 0) throw new Error(`unparseable production source: ${file}`)
  const specifiers = []
  const visit = (node) => {
    if (ts.isImportEqualsDeclaration(node)) throw new Error(`dynamic or disallowed production import in ${file}`)
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier === undefined) return
      if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error(`dynamic or unresolved production import in ${file}`)
      specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error(`dynamic or disallowed production import in ${file}`)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") throw new Error(`dynamic or disallowed production import in ${file}`)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return specifiers
}

const sourceFilesUnder = (directory) => {
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /\.(?:[cm]?tsx?)$/.test(entry.name)) files.push(realpathSync(path))
    }
  }
  walk(directory)
  return files.sort()
}

/**
 * Verify that the production source has exactly one callback into the authority core.
 * Resolution is path-based so extensionless, `.ts`, and normalized relative imports cannot evade
 * the boundary. Test-only registry injection is intentionally outside `src/`.
 */
export const verifyAuthorityLocalCallback = (sourceRoot = defaultRoot) => {
  const root = realpathSync(sourceRoot)
  const authorityPath = realpathSync(resolve(root, "workspace-mutation-authority.ts"))
  const internalPath = realpathSync(resolve(root, "workspace-mutation-authority-internal.ts"))
  const testSupportCandidate = resolve(root, "../test/authority-kernel-test-support.ts")
  const testSupportPath = existsSync(testSupportCandidate) ? realpathSync(testSupportCandidate) : undefined
  const entry = resolve(root, "authority-local-commands.ts")

  auditLocalHandlerFiles(root, [entry], (file) => readFileSync(file, "utf8"), resolveSource)

  const roots = ["index.ts", "workspace-durable-object.ts", "user-durable-object.ts"].map((name) => resolve(root, name)).filter(existsSync)
  const reachesForbidden = (start, visited = new Set()) => {
    const real = realpathSync(start); if (visited.has(real)) return false; visited.add(real)
    for (const specifier of moduleSpecifiers(real, readFileSync(real, "utf8"))) {
      if (!specifier.startsWith(".")) continue
      const target = resolveSource(real, specifier)
      if (target === authorityPath || target === internalPath) return true
      if (reachesForbidden(target, visited)) return true
    }
    return false
  }
  for (const rootEntry of roots) if (reachesForbidden(rootEntry)) throw new Error(`pre-bridge runtime root reaches unwired authority executor: ${rootEntry}`)

  for (const file of sourceFilesUnder(root)) {
    for (const specifier of moduleSpecifiers(file, readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue
      const target = resolveSource(file, specifier)
      if (target === internalPath && file !== authorityPath) throw new Error(`production source may import authority core only through ${authorityPath}: ${file}`)
      if (target === authorityPath) throw new Error(`pre-bridge production source may not reach unwired authority wrapper: ${file}`)
      if (testSupportPath !== undefined && target === testSupportPath) throw new Error(`production source may not import test-only authority support: ${file}`)
    }
  }

  const authorityImports = moduleSpecifiers(authorityPath, readFileSync(authorityPath, "utf8"))
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolveSource(authorityPath, specifier))
  if (!authorityImports.includes(internalPath)) throw new Error(`static authority wrapper must import ${internalPath}`)
}

verifyAuthorityLocalCallback()
console.log("authority local callback source verified")
