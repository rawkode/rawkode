import { LoroDoc, LoroMap } from "loro-crdt/bundler"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import corpus from "../../web/src/fixtures/loro-prosemirror-v1-corpus.json"
import {
  LORO_PAGE_META_CONTAINER,
  LORO_PAGE_SCHEMA_VERSION,
  LORO_PROSEMIRROR_CONTAINER
} from "@athenaeum/domain"
import { validateLoroProseMirrorV1Tree } from "../src/loro-prosemirror-v1-contract.js"

const decodeBase64 = (encoded: string): Uint8Array => {
  const binary = atob(encoded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * The native projection corpus must remain structurally valid for the production backend before
 * it can be trusted as a client compatibility input. This test deliberately consumes the checked-
 * in artifact, rather than re-running web generation, so it catches generator/manifest drift.
 */
describe("Loro ProseMirror v1 checked-in compatibility corpus", () => {
  it("accepts official web-schema/plugin fixtures and rejects adversarial known-shape fixtures", async () => {
    expect(corpus.format).toBe("athenaeum-loro-prosemirror-v1-corpus")
    expect(corpus.corpusVersion).toBe(1)

    for (const fixture of corpus.fixtures) {
      const snapshot = decodeBase64(fixture.snapshotBase64)
      expect(await sha256(snapshot), fixture.id).toBe(fixture.snapshotSHA256)
      const doc = new LoroDoc()
      doc.import(snapshot)
      expect(doc.getMap(LORO_PAGE_META_CONTAINER).get("schemaVersion"), fixture.id).toBe(LORO_PAGE_SCHEMA_VERSION)
      const root = doc.getMap(LORO_PROSEMIRROR_CONTAINER)
      expect(root, fixture.id).toBeInstanceOf(LoroMap)

      if (fixture.valid) {
        expect(() => Effect.runSync(validateLoroProseMirrorV1Tree(root)), fixture.id).not.toThrow()
      } else {
        expect(() => Effect.runSync(validateLoroProseMirrorV1Tree(root)), fixture.id).toThrow()
      }
    }
  })
})
