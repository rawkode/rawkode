import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertSnapshot, snapshot } from "./protected-path-snapshot.mjs"

const root = mkdtempSync(join(tmpdir(), "athenaeum-protected-path-"))
try {
  const source = join(root, "apps/athenaeum/packages/backend/src")
  mkdirSync(source, { recursive: true })
  const file = join(source, "workspace-durable-object.ts")
  writeFileSync(file, "before")
  const before = snapshot(root)
  writeFileSync(file, "after"); assert.throws(() => assertSnapshot(root, before), /drift/)
  writeFileSync(file, "before"); rmSync(file); assert.throws(() => assertSnapshot(root, before), /drift/)
  writeFileSync(file, "before"); writeFileSync(join(source, "calendar-collections.ts"), "added"); assert.throws(() => assertSnapshot(root, before), /drift/)
  rmSync(join(source, "calendar-collections.ts")); chmodSync(file, 0o755); assert.throws(() => assertSnapshot(root, before), /drift/)
  chmodSync(file, 0o644); execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "fixture"], { cwd: root })
  const tracked = snapshot(root); writeFileSync(file, "changed tracked")
  const after = snapshot(root)["apps/athenaeum/packages/backend/src/workspace-durable-object.ts"]
  assert.match(after.trackedBinaryPatch, /workspace-durable-object\.ts/); assert.match(after.trackedBinaryPatch, /(?:diff --git|GIT binary patch)/); assert.throws(() => assertSnapshot(root, tracked), /drift/)
  assert.throws(() => execFileSync("node", [new URL("./protected-path-snapshot.mjs", import.meta.url).pathname, "capture", "inside.json"], { cwd: root }))
  console.log("protected path snapshot verified")
} finally { rmSync(root, { recursive: true, force: true }) }
