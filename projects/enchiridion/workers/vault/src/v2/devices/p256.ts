/** @enchiridion/effect-module */

const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const decodeBase64 = (value: string): Uint8Array | undefined => {
  if (!base64.test(value)) return undefined;
  try {
    const text = atob(value);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
    let encoded = "";
    for (const byte of bytes) encoded += String.fromCharCode(byte);
    return btoa(encoded) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
};

const derLength = (
  bytes: Uint8Array,
  offset: number,
): readonly [size: number, contentOffset: number] | undefined => {
  const first = bytes[offset];
  if (first === undefined) return undefined;
  if (first < 0x80) return [first, offset + 1];
  const lengthBytes = first & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 2 || offset + lengthBytes >= bytes.length)
    return undefined;
  let size = 0;
  for (let index = 1; index <= lengthBytes; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined || (index === 1 && byte === 0)) return undefined;
    size = (size << 8) | byte;
  }
  return size < 0x80 ? undefined : [size, offset + lengthBytes + 1];
};

const p256Integer = (
  bytes: Uint8Array,
  offset: number,
): readonly [value: Uint8Array, end: number] | undefined => {
  if (bytes[offset] !== 0x02) return undefined;
  const length = derLength(bytes, offset + 1);
  if (length === undefined) return undefined;
  const [size, contentOffset] = length;
  const end = contentOffset + size;
  const first = bytes[contentOffset];
  const second = bytes[contentOffset + 1];
  if (
    first === undefined ||
    size < 1 ||
    size > 33 ||
    end > bytes.length ||
    (first & 0x80) !== 0 ||
    (size > 1 && first === 0 && second !== undefined && (second & 0x80) === 0)
  )
    return undefined;
  const source =
    first === 0 ? bytes.slice(contentOffset + 1, end) : bytes.slice(contentOffset, end);
  if (source.length > 32) return undefined;
  const output = new Uint8Array(32);
  output.set(source, 32 - source.length);
  return [output, end];
};

/**
 * Converts protocol-canonical ECDSA DER to the IEEE P1363 `r || s` bytes required by WebCrypto.
 * This is synchronous and native-Promise-free; actual `crypto.subtle.verify` belongs to runtime's
 * audited adapter seam.
 */
export const p256DerBase64ToP1363 = (value: string): Uint8Array | undefined => {
  const bytes = decodeBase64(value);
  if (bytes === undefined || bytes[0] !== 0x30) return undefined;
  const sequence = derLength(bytes, 1);
  if (sequence === undefined) return undefined;
  const [size, contentOffset] = sequence;
  if (contentOffset + size !== bytes.length) return undefined;
  const r = p256Integer(bytes, contentOffset);
  if (r === undefined) return undefined;
  const s = p256Integer(bytes, r[1]);
  if (s === undefined || s[1] !== bytes.length) return undefined;
  const output = new Uint8Array(64);
  output.set(r[0]);
  output.set(s[0], 32);
  return output;
};
