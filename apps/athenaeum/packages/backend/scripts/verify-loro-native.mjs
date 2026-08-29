import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

import { newHttpBatchRpcSession } from "capnweb"
// The Worker bundles `loro-crdt/bundler`; this harness runs in Node and must use the package's
// NodeJS/WASM entry point because the bundler entry intentionally omits the `.js` extension.
import { LoroDoc, LoroList, LoroMap, LoroText, VersionVector } from "loro-crdt/nodejs"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const nativePackage = join(repositoryRoot, "native", "AthenaeumCore")
const backendUrl = process.env.ATHENAEUM_BACKEND_URL ?? "http://127.0.0.1:8787"
const probeText = "native interoperability probe"

const bytes = (value, label) => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (Array.isArray(value)) return Uint8Array.from(value)
  throw new TypeError(`${label} was not returned as bytes`)
}

const sameVersionVector = (left, right) => {
  try {
    const leftVector = VersionVector.decode(left)
    const rightVector = VersionVector.decode(right)
    return leftVector.compare(rightVector) === 0 && rightVector.compare(leftVector) === 0
  } catch {
    return false
  }
}

const requireValue = (condition, message) => {
  if (!condition) throw new Error(message)
}

const expectRpcErrorTag = async (promise, tag) => {
  try {
    await promise
  } catch (error) {
    requireValue(error instanceof Error, `expected ${tag} RPC error`)
    const envelope = JSON.parse(error.message)
    requireValue(envelope?.tag === tag, `expected ${tag} RPC error, got ${String(envelope?.tag)}`)
    return
  }
  throw new Error(`expected ${tag} RPC error, but the request succeeded`)
}

const canonicalText = (doc) => {
  const root = doc.getMap("athenaeum-prosemirror-v1")
  requireValue(root instanceof LoroMap, "server snapshot is missing the ProseMirror root map")
  const rootChildren = root.get("children")
  requireValue(rootChildren instanceof LoroList && rootChildren.length > 0, "server snapshot is missing a paragraph")
  const paragraph = rootChildren.get(0)
  requireValue(paragraph instanceof LoroMap, "server snapshot paragraph is not a map")
  const paragraphChildren = paragraph.get("children")
  requireValue(
    paragraphChildren instanceof LoroList && paragraphChildren.length > 0,
    "server snapshot paragraph is missing text"
  )
  const text = paragraphChildren.get(0)
  requireValue(text instanceof LoroText, "server snapshot paragraph text is not a LoroText")
  return text.toString()
}

const runProbe = (args) =>
  new Promise((resolveProcess, reject) => {
    const child = spawn("swift", ["run", "--package-path", nativePackage, "loro-interoperability-probe", ...args], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code, signal) => resolveProcess({ code, signal, stdout, stderr }))
  })

const assertProbeSucceeded = async (args) => {
  const result = await runProbe(args)
  if (result.code !== 0) {
    throw new Error(`native Loro probe failed with exit ${String(result.code)}${result.stderr ? `: ${result.stderr.trim()}` : ""}`)
  }
}

const main = async () => {
  const workspaceId = randomUUID()
  const nodeId = randomUUID()
  const sessionId = `native-probe-${randomUUID()}`
  // HTTP-batch sessions are single request/response batches. Open a fresh session for every
  // dependent call rather than reusing one after its first awaited result (WebSocket sessions are
  // reusable, HTTP batches are deliberately not).
  const rpc = (method, input) => newHttpBatchRpcSession(`${backendUrl}/api/workspace/${workspaceId}`)[method](input)

  await rpc("createNode", { workspaceId, id: nodeId, title: "Native Loro interoperability probe" })
  await rpc("createLoroPage", { workspaceId, nodeId })
  const started = await rpc("startLoroPageSync", { workspaceId, nodeId, sessionId })
  const serverSnapshot = bytes(started.message, "startLoroPageSync.message")
  const serverVersion = bytes(started.serverVersion, "startLoroPageSync.serverVersion")
  requireValue(serverSnapshot.byteLength > 0, "server returned an empty Loro snapshot")
  requireValue(serverVersion.byteLength > 0, "server returned an empty Loro version vector")

  const tempDir = await mkdtemp(join(tmpdir(), "athenaeum-loro-native-"))
  try {
    const snapshotPath = join(tempDir, "server.snapshot")
    const serverVersionPath = join(tempDir, "server.version")
    const updatePath = join(tempDir, "swift.update")
    const clientVersionPath = join(tempDir, "swift.version")
    const malformedSnapshotPath = join(tempDir, "malformed.snapshot")
    const malformedUpdatePath = join(tempDir, "malformed.update")
    const malformedClientVersionPath = join(tempDir, "malformed.version")

    await writeFile(snapshotPath, serverSnapshot)
    await writeFile(serverVersionPath, serverVersion)
    await writeFile(malformedSnapshotPath, Uint8Array.of(0, 1, 2))

    const probeArgs = [
      "--snapshot", snapshotPath,
      "--server-version", serverVersionPath,
      "--update", updatePath,
      "--client-version", clientVersionPath,
      "--text", probeText
    ]
    await assertProbeSucceeded(probeArgs)

    const update = new Uint8Array(await readFile(updatePath))
    const clientVersion = new Uint8Array(await readFile(clientVersionPath))
    requireValue(update.byteLength > 0, "native probe emitted an empty update")
    requireValue(clientVersion.byteLength > 0, "native probe emitted an empty client version")

    const clientDoc = new LoroDoc()
    clientDoc.import(serverSnapshot)
    clientDoc.import(update)
    requireValue(canonicalText(clientDoc) === probeText, "Swift update did not edit the canonical PM text")

    // Native interoperability can produce a valid Loro content update, but public raw content
    // transport is deliberately fenced: user content must use commitLoroPageContent instead.
    await expectRpcErrorTag(rpc("loroPageSyncMessage", {
      workspaceId,
      nodeId,
      sessionId: started.sessionId,
      ordinal: 0,
      update,
      clientVersion
    }), "LoroSemanticCommitRequired")
    const syncResponse = await rpc("loroPageSyncMessage", {
      workspaceId,
      nodeId,
      sessionId: started.sessionId,
      ordinal: 0,
      update: new Uint8Array(),
      clientVersion: serverVersion
    })
    const responseServerVersion = bytes(syncResponse.serverVersion, "loroPageSyncMessage.serverVersion")
    requireValue(syncResponse.sessionId === started.sessionId, "sync response changed the session id")
    requireValue(syncResponse.ordinal === 0, "sync response changed the request ordinal")
    requireValue(syncResponse.reset === false, "server reset an empty native Loro convergence frame")
    requireValue(syncResponse.converged === true, "server did not converge on the native client version")
    requireValue(sameVersionVector(responseServerVersion, serverVersion), "server version vector changed after the rejected native content update")
    if (syncResponse.update !== null) {
      requireValue(bytes(syncResponse.update, "loroPageSyncMessage.update").byteLength === 0, "server returned an unexpected follow-up update")
    }

    const freshApi = newHttpBatchRpcSession(`${backendUrl}/api/workspace/${workspaceId}`)
    const fresh = await freshApi.startLoroPageSync({ workspaceId, nodeId, sessionId: `fresh-${randomUUID()}` })
    const persistedDoc = new LoroDoc()
    persistedDoc.import(bytes(fresh.message, "fresh startLoroPageSync.message"))
    requireValue(canonicalText(persistedDoc) !== probeText, "fresh server reload accepted the forbidden native raw edit")

    const malformedResult = await runProbe([
      "--snapshot", malformedSnapshotPath,
      "--server-version", serverVersionPath,
      "--update", malformedUpdatePath,
      "--client-version", malformedClientVersionPath,
      "--text", probeText
    ])
    requireValue(malformedResult.code === 4, `malformed snapshot was not rejected with exit 4 (got ${String(malformedResult.code)})`)

    console.log(`Loro native interoperability passed for disposable workspace ${workspaceId}`)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
