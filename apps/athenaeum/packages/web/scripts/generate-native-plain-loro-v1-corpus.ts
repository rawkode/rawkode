import { writeFile } from "node:fs/promises"
import { buildNativePlainLoroV1Corpus } from "../src/native-plain-loro-v1-corpus.js"

const sha256 = async (encoded: string): Promise<string> => {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const corpus = buildNativePlainLoroV1Corpus()
const manifest = {
  ...corpus,
  cases: await Promise.all(corpus.cases.map(async (fixture) => ({
    ...fixture,
    initialSnapshotSHA256: await sha256(fixture.initialSnapshotBase64),
    acceptedBaseVVSHA256: await sha256(fixture.acceptedBaseVVBase64)
  })))
}
await writeFile(new URL("../src/fixtures/native-plain-loro-v1-corpus.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
