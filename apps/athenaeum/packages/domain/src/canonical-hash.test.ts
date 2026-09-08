import { describe, expect, it } from "vitest"
import { canonicalJson, canonicalJsonBytes, sha256Hex, sha256HexSync } from "./canonical-hash.js"

describe("canonical proposal hashing", () => {
  it("sorts object keys recursively and produces the standard SHA-256 digest", async () => {
    const value = { z: [3, { b: "two", a: "one" }], a: true }
    expect(canonicalJson(value)).toBe('{"a":true,"z":[3,{"a":"one","b":"two"}]}')
    const bytes = canonicalJsonBytes("abc")
    expect(sha256HexSync(bytes)).toBe("6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25")
    await expect(sha256Hex(bytes)).resolves.toBe(sha256HexSync(bytes))
  })
})
