#!/usr/bin/env node
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

// The backend is the workspace package that declares official `loro-crdt`; resolve from that
// manifest so this root-level generator does not add a duplicate dependency declaration.
const requireFromBackend = createRequire(new URL("../packages/backend/package.json", import.meta.url))
const { LoroDoc } = await import(requireFromBackend.resolve("loro-crdt/bundler"))

const fixtureURL = new URL("../fixtures/loro-version-vector-identity.json", import.meta.url)
const check = process.argv.includes("--check")

const canonicalPreimage = (entries) =>
  `[${entries
    .slice()
    .sort((left, right) => BigInt(left.peer) < BigInt(right.peer) ? -1 : BigInt(left.peer) > BigInt(right.peer) ? 1 : 0)
    .map(({ peer, counter }) => `{"counter":${counter},"peer":"${peer}"}`)
    .join(",")}]`

// Use official Loro operations, rather than manufacturing a VersionVector encoding. The merged
// document must retain two numeric peers whose decimal ordering differs from lexical ordering.
const first = new LoroDoc()
first.setPeerId(2n)
const text = first.getText("identity-fixture")
text.insert(0, "abc")
first.commit()

const second = new LoroDoc()
second.import(first.export({ mode: "snapshot" }))
second.setPeerId(10n)
second.getText("identity-fixture").insert(3, "defg")
second.commit()

const vector = second.version()
const entries = [...vector.toJSON()]
  .map(([peer, counter]) => ({ peer: String(peer), counter }))
  .sort((left, right) => BigInt(left.peer) < BigInt(right.peer) ? -1 : BigInt(left.peer) > BigInt(right.peer) ? 1 : 0)
if (entries.map(({ peer }) => peer).join(",") !== "2,10") {
  throw new Error("fixture must contain numeric peers 2 then 10")
}
if (entries.some(({ counter }) => !Number.isInteger(counter) || counter <= 0) || entries[0].counter === entries[1].counter) {
  throw new Error("fixture peers must have distinct nonzero counters")
}
const preimage = canonicalPreimage(entries)
const fixture = {
  format: "athenaeum.loro-version-vector-identity.v1",
  generator: {
    package: "loro-crdt/bundler",
    operations: "peer 2 inserts abc; peer 10 imports snapshot then inserts defg"
  },
  encodedVersionVectorBase64: Buffer.from(vector.encode()).toString("base64"),
  entries,
  canonicalPreimage: preimage,
  sha256: createHash("sha256").update(preimage, "utf8").digest("hex")
}
const rendered = `${JSON.stringify(fixture, null, 2)}\n`

if (check) {
  const checkedIn = await readFile(fixtureURL, "utf8")
  if (checkedIn !== rendered) {
    throw new Error(`Version-vector identity fixture drifted; run ${fileURLToPath(import.meta.url)}`)
  }
} else {
  await writeFile(fixtureURL, rendered)
}
