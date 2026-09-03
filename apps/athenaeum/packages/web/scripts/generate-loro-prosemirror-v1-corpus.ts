import { writeFile } from "node:fs/promises"
import { buildLoroProseMirrorV1Corpus } from "../src/loro-prosemirror-v1-corpus.js"

const sha256 = async (encoded: string): Promise<string> => {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const corpus = buildLoroProseMirrorV1Corpus()
const manifest = {
  ...corpus,
  fixtures: await Promise.all(corpus.fixtures.map(async (fixture) => ({
    ...fixture,
    snapshotSHA256: await sha256(fixture.snapshotBase64)
  })))
}

await writeFile(new URL("../src/fixtures/loro-prosemirror-v1-corpus.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
