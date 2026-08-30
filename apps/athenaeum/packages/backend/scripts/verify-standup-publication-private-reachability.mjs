import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { tmpdir } from "node:os"
import ts from "typescript"

const defaultSourceRoot = realpathSync(new URL("../src", import.meta.url).pathname)
// The durable authority adapter and its private record contract are production infrastructure
// now. The publisher/issuer remain deliberately unwired: no external RPC can mint a grant or
// publish an employee report until the trusted workforce ingress is implemented separately.
const forbiddenNames = new Set([
  "standup-publication-service-live.ts",
  "standup-run-grant-issuer-private-contract.ts",
  "standup-run-grant-issuer-private-service.ts"
])

const resolveLocalSource = (from, specifier) => {
  const withoutExtension = specifier.replace(/\.(?:[cm]?js|[cm]?tsx?)$/, "")
  const candidates = [
    resolve(dirname(from), `${withoutExtension}.ts`),
    resolve(dirname(from), `${withoutExtension}.tsx`),
    resolve(dirname(from), `${withoutExtension}.mts`),
    resolve(dirname(from), `${withoutExtension}.cts`),
    resolve(dirname(from), withoutExtension, "index.ts"),
    resolve(dirname(from), withoutExtension, "index.tsx")
  ]
  const candidate = candidates.find(existsSync)
  if (candidate === undefined) throw new Error(`unresolved local module import: ${specifier} from ${from}`)
  return realpathSync(candidate)
}

const localModuleSpecifiers = (file, source) => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if (tree.parseDiagnostics.length > 0) throw new Error(`unparseable production source: ${file}`)
  const result = []
  const visit = (node) => {
    if (ts.isImportEqualsDeclaration(node)) throw new Error(`import-equals is forbidden in reachability roots: ${file}`)
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error(`computed module specifier is forbidden in ${file}`)
        if (node.moduleSpecifier.text.startsWith(".")) result.push(node.moduleSpecifier.text)
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new Error(`dynamic import is forbidden in reachability roots: ${file}`)
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      throw new Error(`require is forbidden in reachability roots: ${file}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return result
}

/**
 * A positive, transitive import-closure check. The private publisher and grant issuer must remain
 * unreachable from all production entry roots until a separately gated workforce ingress exists.
 */
export const verifyStandupPublicationPrivateReachability = (sourceRoot = defaultSourceRoot) => {
  const root = realpathSync(sourceRoot)
  const roots = ["index.ts", "workspace-durable-object.ts", "user-durable-object.ts"]
    .map((name) => resolve(root, name))
    .filter(existsSync)
    .map((path) => realpathSync(path))
  if (roots.length !== 3) throw new Error("private standup reachability roots are incomplete")
  const forbidden = new Set([...forbiddenNames].map((name) => realpathSync(resolve(root, name))))
  const visit = (file, seen = new Set()) => {
    const real = realpathSync(file)
    if (seen.has(real)) return
    seen.add(real)
    for (const specifier of localModuleSpecifiers(real, readFileSync(real, "utf8"))) {
      const target = resolveLocalSource(real, specifier)
      if (forbidden.has(target)) throw new Error(`production root reaches dormant private standup module: ${real} -> ${target}`)
      visit(target, seen)
    }
  }
  for (const rootFile of roots) visit(rootFile)
  return roots
}

const fixture = mkdtempSync(join(tmpdir(), "athenaeum-private-standup-reachability-"))
const fixtureRoot = join(fixture, "src")
mkdirSync(fixtureRoot, { recursive: true })
const write = (name, source) => writeFileSync(join(fixtureRoot, name), source)
const rootFiles = () => {
  write("index.ts", "import { safe } from './safe.js'; export { safe }")
  write("workspace-durable-object.ts", "export { safe } from './safe.js'")
  write("user-durable-object.ts", "export { safe } from './safe.js'")
  write("safe.ts", "export { value as safe } from './nested/helper.js'")
  mkdirSync(join(fixtureRoot, "nested"), { recursive: true })
  write("nested/helper.ts", "export const value = 1")
  for (const name of forbiddenNames) write(name, "export const dormant = true")
}

try {
  rootFiles()
  assert.doesNotThrow(() => verifyStandupPublicationPrivateReachability(fixtureRoot), "a valid transitive root closure must pass")

  for (const forbiddenName of forbiddenNames) {
    const specifier = `./${forbiddenName.replace(/\.ts$/, ".js")}`
    write("nested/helper.ts", `export { dormant as value } from '../${forbiddenName.replace(/\.ts$/, ".js")}';`)
    assert.throws(() => verifyStandupPublicationPrivateReachability(fixtureRoot), /reaches dormant private standup module/)
    write("nested/helper.ts", "export const value = 1")

    write("index.ts", `const path = '${specifier}'; export const run = import(path)`)
    assert.throws(() => verifyStandupPublicationPrivateReachability(fixtureRoot), /dynamic import/)
    write("index.ts", `export const run = import('${specifier}')`)
    assert.throws(() => verifyStandupPublicationPrivateReachability(fixtureRoot), /dynamic import/)
    write("index.ts", `import privatePublisher = require('${specifier}'); export { privatePublisher }`)
    assert.throws(() => verifyStandupPublicationPrivateReachability(fixtureRoot), /import-equals/)
    write("index.ts", "import { safe } from './safe.js'; export { safe }")
  }
  write("index.ts", "import { missing } from './does-not-exist.js'; export { missing }")
  assert.throws(() => verifyStandupPublicationPrivateReachability(fixtureRoot), /unresolved local module import/)
  console.log("standup publication private reachability fixtures verified")
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

verifyStandupPublicationPrivateReachability()
console.log("standup publication publisher and grant issuer remain unreachable from production roots")
