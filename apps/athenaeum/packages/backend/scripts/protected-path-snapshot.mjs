import { createHash } from "node:crypto"
import { lstatSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { resolve, relative } from "node:path"

export const PROTECTED_PATHS = [
  "apps/athenaeum/packages/backend/src/workspace-durable-object.ts",
  "apps/athenaeum/packages/backend/src/standup-publication-collections.ts",
  "apps/athenaeum/packages/backend/src/standup-publication-service-live.ts",
  "apps/athenaeum/packages/backend/src/calendar-collections.ts",
  "apps/athenaeum/packages/backend/src/calendar-connection-identity.ts",
  "apps/athenaeum/packages/backend/src/calendar-gatekeeper-client.ts",
  "apps/athenaeum/packages/backend/src/calendar-oauth-state.ts",
  "apps/athenaeum/packages/backend/src/calendar-service-live.ts",
  "apps/athenaeum/packages/backend/src/dev-scripted-calendar-client.ts",
  "apps/athenaeum/packages/backend/src/gatekeeper-service-credential.ts",
  "apps/athenaeum/packages/backend/src/meetings-service-live.ts",
  "apps/athenaeum/packages/backend/src/meeting-collections.ts",
  "apps/athenaeum/packages/backend/test/calendar-connection-identity.test.ts",
  "apps/athenaeum/packages/backend/test/calendar-gatekeeper-client.test.ts",
  "apps/athenaeum/packages/backend/test/calendar-service.test.ts",
  "apps/athenaeum/packages/backend/test/meetings.test.ts",
  "apps/athenaeum/packages/backend/test/support.ts"
]

export function snapshot(root) {
  return Object.fromEntries(PROTECTED_PATHS.map((path) => {
    const absolute = resolve(root, path)
    try {
      const stat = lstatSync(absolute)
      const bytes = stat.isFile() ? readFileSync(absolute) : Buffer.alloc(0)
      const tracked = (() => { try { execFileSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: root, stdio: "ignore" }); return true } catch { return false } })()
      // A binary patch is retained for tracked content; exact bytes retain untracked pre-existing
      // files (including the intentionally dirty protected standup files) without a HEAD baseline.
      const custody = tracked
        ? { trackedBinaryPatch: execFileSync("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--", path], { cwd: root, encoding: "utf8" }) }
        : { untrackedBytesBase64: bytes.toString("base64") }
      return [path, { exists: true, type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other", mode: stat.mode & 0o7777, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), ...custody }]
    } catch (error) {
      if (error?.code === "ENOENT") return [path, { exists: false }]
      throw error
    }
  }))
}

export function assertSnapshot(root, expected) {
  const actual = snapshot(root)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`protected path snapshot drift: ${JSON.stringify({ expected, actual })}`)
}

const [mode, target] = process.argv.slice(2)
const externalTarget = (target) => { if (!target || !relative(resolve(process.cwd()), resolve(target)).startsWith("..")) throw new Error("snapshot target must be outside the worktree") }
if (mode === "capture" && target) { externalTarget(target); writeFileSync(target, `${JSON.stringify(snapshot(process.cwd()), null, 2)}\n`) }
else if (mode === "verify" && target) { externalTarget(target); assertSnapshot(process.cwd(), JSON.parse(readFileSync(target, "utf8"))) }
else if (import.meta.url === `file://${process.argv[1]}`) throw new Error("usage: protected-path-snapshot.mjs <capture|verify> <snapshot-file>")
