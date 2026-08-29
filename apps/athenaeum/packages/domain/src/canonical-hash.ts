/**
 * Canonical JSON used for proposal snapshots.  This is intentionally small and synchronous: the
 * durable-object transaction compares these bytes directly, rather than awaiting WebCrypto.
 */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]))
  }
  return value
}

export const CANONICAL_SNAPSHOT_VERSION = "athenaeum.canonical-json.v1" as const
export const canonicalJson = (value: unknown): string => JSON.stringify(canonical(value))
/** UTF-8 encoder kept dependency-free so this domain package remains usable outside DOM runtimes. */
const utf8 = (text: string): Uint8Array => {
  const encoded: number[] = []
  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00; index++ }
    }
    if (code < 0x80) encoded.push(code)
    else if (code < 0x800) encoded.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) encoded.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else encoded.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }
  return new Uint8Array(encoded)
}
export const canonicalJsonBytes = (value: unknown): Uint8Array => utf8(canonicalJson(value))

/** A transport/integrity digest only; callers must re-read and compare canonical bytes in a transaction. */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => sha256HexSync(bytes)

export const canonicalSha256 = (value: unknown): Promise<string> => sha256Hex(canonicalJsonBytes(value))

/** Synchronous SHA-256 for Durable Object transactions: never substitute WebCrypto inside a transaction callback. */
export const sha256HexSync = (input: Uint8Array): string => {
  const words = new Uint32Array(64)
  const bitLength = input.length * 8
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64
  const bytes = new Uint8Array(paddedLength)
  bytes.set(input); bytes[input.length] = 0x80
  new DataView(bytes.buffer).setUint32(paddedLength - 4, bitLength >>> 0, false)
  new DataView(bytes.buffer).setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false)
  let a = 0x6a09e667, b = 0xbb67ae85, c = 0x3c6ef372, d = 0xa54ff53a
  let e = 0x510e527f, f = 0x9b05688c, g = 0x1f83d9ab, h = 0x5be0cd19
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const view = new DataView(bytes.buffer, offset, 64)
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4, false)
    for (let i = 16; i < 64; i++) { const x = words[i - 15]!, y = words[i - 2]!; words[i] = (((rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + words[i - 16]! + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) + words[i - 7]!) >>> 0) }
    let [aa, bb, cc, dd, ee, ff, gg, hh] = [a, b, c, d, e, f, g, h]
    for (let i = 0; i < 64; i++) { const s1 = rotr(ee, 6) ^ rotr(ee, 11) ^ rotr(ee, 25); const choose = (ee & ff) ^ (~ee & gg); const t1 = (hh + s1 + choose + k[i]! + words[i]!) >>> 0; const s0 = rotr(aa, 2) ^ rotr(aa, 13) ^ rotr(aa, 22); const majority = (aa & bb) ^ (aa & cc) ^ (bb & cc); const t2 = (s0 + majority) >>> 0; hh = gg; gg = ff; ff = ee; ee = (dd + t1) >>> 0; dd = cc; cc = bb; bb = aa; aa = (t1 + t2) >>> 0 }
    a = (a + aa) >>> 0; b = (b + bb) >>> 0; c = (c + cc) >>> 0; d = (d + dd) >>> 0; e = (e + ee) >>> 0; f = (f + ff) >>> 0; g = (g + gg) >>> 0; h = (h + hh) >>> 0
  }
  return [a,b,c,d,e,f,g,h].map((word) => word.toString(16).padStart(8, "0")).join("")
}
