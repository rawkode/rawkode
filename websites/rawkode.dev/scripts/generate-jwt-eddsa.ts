#!/usr/bin/env bun
/*
 * Generate raw Ed25519 keys for JWT (EdDSA) compatible with @alteran/astro
 *
 * Outputs base64url values for:
 * - JWT_ED25519_PRIVATE_KEY (raw 32-byte private key)
 * - JWT_ED25519_PUBLIC_KEY  (raw 32-byte public key)
 *
 * Usage:
 *   bun run scripts/generate-jwt-eddsa.ts
 */

import { webcrypto as crypto } from 'crypto';

function toB64Url(bytes: ArrayBuffer | Uint8Array): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return Buffer.from(s, 'binary').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// Minimal DER parser to extract the 32-byte seed from PKCS#8 Ed25519 private key
function extractRawSeedFromPkcs8(pkcs8Der: Uint8Array): Uint8Array {
  // Look for the inner OCTET STRING of length 0x20 (32) as per RFC 8410
  // Pattern: 0x04 0x20 <32 bytes>
  for (let i = 0; i + 2 + 32 <= pkcs8Der.length; i++) {
    if (pkcs8Der[i] === 0x04 && pkcs8Der[i + 1] === 0x20) {
      return pkcs8Der.subarray(i + 2, i + 2 + 32);
    }
  }
  throw new Error('Could not locate 32-byte seed inside PKCS#8 key');
}

async function main() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519', namedCurve: 'Ed25519' } as any, true, ['sign', 'verify']);

  // Export public key as raw (32 bytes)
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));

  // Export private key as PKCS#8, then extract 32-byte seed (raw private)
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const privRaw = extractRawSeedFromPkcs8(pkcs8);

  const privB64Url = toB64Url(privRaw);
  const pubB64Url = toB64Url(pubRaw);

  console.log('JWT_ED25519_PRIVATE_KEY (base64url, 32 bytes):');
  console.log('  ' + privB64Url);
  console.log('JWT_ED25519_PUBLIC_KEY  (base64url, 32 bytes):');
  console.log('  ' + pubB64Url);

  console.log('\nSecret Store suggestions:');
  console.log('  Name: alteran-jwt-ed25519-private  → value = JWT_ED25519_PRIVATE_KEY (above)');
  console.log('  Name: alteran-jwt-ed25519-public   → value = JWT_ED25519_PUBLIC_KEY  (above)');
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});

