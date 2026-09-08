import { writeFile } from "node:fs/promises"
import { buildNativeRichLoroV1Corpus, nativeRichLoroSourceCanonicalContent } from "../src/native-rich-loro-v1-corpus.js"

const sha256 = async (encoded: string): Promise<string> => {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
const sha256Text = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const corpus = buildNativeRichLoroV1Corpus()
const sourceDigest = await sha256Text(nativeRichLoroSourceCanonicalContent(corpus))
const manifest = {
  ...corpus,
  sourceDigest,
  cases: await Promise.all(corpus.cases.map(async (fixture) => ({
    ...fixture,
    baseSnapshotSHA256: await sha256(fixture.baseSnapshotBase64),
    baseVVSHA256: await sha256(fixture.baseVVBase64)
  })))
}
await writeFile(new URL("../src/fixtures/native-rich-loro-v1-source-corpus.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
