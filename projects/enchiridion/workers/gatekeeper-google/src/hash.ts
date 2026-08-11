// @enchiridion/worker-gatekeeper-google — small SHA-256 hex helper shared
// by `calendar-materialization.ts` (baseline-hash change detection) and
// `materialized-doc.ts` (deterministic provider-edge ids). Uses
// `crypto.subtle` (native in Bun/Workers/Node>=19) — same primitive choice
// as `@enchiridion/graph-core`, for the same reason (must run unmodified
// in a Cloudflare Worker). NOT the same digest scheme as graph-core's
// `PageID` derivation (no truncation, no cross-language parity
// requirement) — see `calendar-materialization.ts`'s file header on why
// this file's hashes are purely a local implementation detail.

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}
