/** Pure fail-closed checks shared by the CI audit and its negative tests. */
export function assertNoUnknownWorkerEntrypoints(source) {
  const tree = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.Latest, true)
  const defaults = tree.statements.filter(ts.isExportAssignment)
  let expression = defaults.length === 1 ? defaults[0].expression : undefined
  while (expression && (ts.isSatisfiesExpression(expression) || ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression))) expression = expression.expression
  if (defaults.length !== 1 || !expression || !ts.isObjectLiteralExpression(expression)) throw new Error("Worker must have exactly one static default-exported object")
  const properties = expression.properties
  if (properties.some(ts.isSpreadAssignment)) throw new Error("Worker default export cannot use spreads")
  let fetches = 0
  for (const property of properties) {
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : ts.isComputedPropertyName(property.name) && ts.isStringLiteral(property.name.expression) ? property.name.expression.text : undefined)
    if (name !== "fetch") throw new Error(`unknown Worker entrypoint kind: ${name ?? "dynamic"}`)
    if (!(ts.isMethodDeclaration(property) || (ts.isPropertyAssignment(property) && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))))) throw new Error("Worker fetch must be a static function")
    fetches += 1
  }
  if (fetches !== 1) throw new Error("Worker must expose exactly one fetch handler")
}
export function assertKnownDirectWriteSinks(sources, registered) {
  const writeNames = new Set(["put", "delete", "exec", "prepare", "run", "save", "insert", "update", "create", "batch", "set", "upsert", "write"])
  const unknown = []
  for (const [file, source] of Object.entries(sources)) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    let writes = false
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && writeNames.has(node.expression.name.text)) writes = true
      ts.forEachChild(node, visit)
    }
    visit(tree)
    if (writes && !registered.includes(file)) unknown.push(file)
  }
  if (unknown.length) throw new Error(`unknown direct storage/sql write sinks: ${unknown.join(",")}`)
}
import ts from "typescript"
