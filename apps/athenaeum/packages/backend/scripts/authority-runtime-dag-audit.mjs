import ts from "typescript"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

const authorityRuntimeAllowlist = Object.freeze({
  "workspace-mutation-authority.ts": Object.freeze({
    local: Object.freeze(["authority-kernel-contract.ts", "authority-local-command-registry.ts", "workspace-mutation-authority-internal.ts"]),
    external: Object.freeze([])
  }),
  "workspace-mutation-authority-internal.ts": Object.freeze({
    local: Object.freeze(["authority-kernel-contract.ts", "authority-trusted-data-token.ts", "workspace-local-mutation-capability.ts"]),
    external: Object.freeze(["@athenaeum/domain"])
  }),
  "authority-kernel-contract.ts": Object.freeze({ local: Object.freeze([]), external: Object.freeze(["@athenaeum/domain"]) }),
  "workspace-local-mutation-capability.ts": Object.freeze({ local: Object.freeze(["authority-trusted-data-token.ts"]), external: Object.freeze([]) }),
  "authority-trusted-data-token.ts": Object.freeze({ local: Object.freeze([]), external: Object.freeze([]) }),
  "authority-local-command-registry.ts": Object.freeze({ local: Object.freeze(["authority-local-commands.ts"]), external: Object.freeze([]) }),
  "authority-local-commands.ts": Object.freeze({ local: Object.freeze([]), external: Object.freeze([]) })
})

export const authorityRuntimeModuleNames = Object.freeze(Object.keys(authorityRuntimeAllowlist))

export const resolveAuthoritySource = (from, specifier) => {
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
  if (candidate === undefined) throw new Error(`unresolved authority runtime import: ${specifier} from ${from}`)
  return realpathSync(candidate)
}

const isRuntimeImport = (declaration) => {
  const clause = declaration.importClause
  if (clause === undefined) return true
  if (clause.isTypeOnly) return false
  if (clause.name !== undefined) return true
  if (clause.namedBindings === undefined) return false
  if (ts.isNamespaceImport(clause.namedBindings)) return true
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly)
}

/** Parse only executable import edges. Type-only edges cannot create a runtime authority path. */
export const runtimeModuleSpecifiers = (file, source) => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if (tree.parseDiagnostics.length > 0) throw new Error(`unparseable authority source: ${file}`)
  const specifiers = []
  const visit = (node) => {
    if (ts.isImportEqualsDeclaration(node)) throw new Error(`import-equals is forbidden in authority runtime source: ${file}`)
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error(`computed authority runtime import in ${file}`)
      if (isRuntimeImport(node)) specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      if (node.moduleSpecifier === undefined) return
      if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error(`computed authority runtime export in ${file}`)
      specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error(`dynamic authority runtime import in ${file}`)
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") throw new Error(`require is forbidden in authority runtime source: ${file}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return specifiers
}

const sameSet = (actual, expected) => actual.size === expected.size && [...actual].every((entry) => expected.has(entry))

/**
 * Enforce the complete executable graph for the dormant authority package. The contract is the
 * only shared vertex: wrapper -> internal/kernel and internal -> kernel, never internal -> wrapper.
 */
export const verifyAuthorityRuntimeDag = (sourceRoot) => {
  const root = realpathSync(sourceRoot)
  const paths = new Map(authorityRuntimeModuleNames.map((name) => [name, resolve(root, name)]))
  for (const [name, path] of paths) {
    if (!existsSync(path)) throw new Error(`missing authority runtime module: ${name}`)
  }
  const visiting = new Set()
  const visited = new Set()
  const walk = (name, lineage = []) => {
    if (visiting.has(name)) throw new Error(`cycle in authority runtime DAG: ${[...lineage, name].join(" -> ")}`)
    if (visited.has(name)) return
    const path = paths.get(name)
    if (path === undefined) throw new Error(`unlisted authority runtime module: ${name}`)
    visiting.add(name)
    const policy = authorityRuntimeAllowlist[name]
    const actualLocal = new Set()
    const actualExternal = new Set()
    for (const specifier of runtimeModuleSpecifiers(path, readFileSync(path, "utf8"))) {
      if (!specifier.startsWith(".")) {
        actualExternal.add(specifier)
        continue
      }
      const target = resolveAuthoritySource(path, specifier)
      if (!target.startsWith(`${root}/`)) throw new Error(`authority runtime import escapes source root: ${specifier} from ${name}`)
      const targetName = relative(root, target).replace(/\\/g, "/")
      actualLocal.add(targetName)
      if (!paths.has(targetName)) throw new Error(`unlisted authority runtime helper: ${name} -> ${targetName}`)
      walk(targetName, [...lineage, name])
    }
    const expectedLocal = new Set(policy.local)
    const expectedExternal = new Set(policy.external)
    if (!sameSet(actualLocal, expectedLocal)) throw new Error(`authority runtime local edges differ for ${name}: expected ${[...expectedLocal].join(",")} got ${[...actualLocal].join(",")}`)
    if (!sameSet(actualExternal, expectedExternal)) throw new Error(`authority runtime external edges differ for ${name}: expected ${[...expectedExternal].join(",")} got ${[...actualExternal].join(",")}`)
    visiting.delete(name)
    visited.add(name)
  }
  for (const name of authorityRuntimeModuleNames) walk(name)
  return Object.freeze([...visited].sort())
}
