import { sha256Hex } from "@enchiridion/protocol";
import type { DirectoryResolution } from "./types";

const alias = /^v[12]\.[A-Za-z0-9_-]{1,64}\.([A-Za-z0-9_-]{43})$/u;

export const maximumDirectoryReplayRetentionSeconds = 300;

const encodeBase64URL = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

/**
 * A binding alias always carries a canonical, unpadded 32-byte base64url HMAC.
 * Decoding and re-encoding rejects alternate tail bits as well as all aliases.
 */
export const isCanonicalDirectoryAlias = (value: string): boolean => {
  const match = alias.exec(value);
  const encoded = match?.[1];
  if (encoded === undefined) return false;
  try {
    const padded = `${encoded.replace(/-/gu, "+").replace(/_/gu, "/")}=`;
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.length === 32 && encodeBase64URL(bytes) === encoded;
  } catch {
    return false;
  }
};

const digestText = (value: string): string => sha256Hex(new TextEncoder().encode(value));

/** Pure binding-derived initializer: raw Access identity can never affect this value. */
export const deriveDirectoryInitID = (bindingID: string): string | undefined =>
  isCanonicalDirectoryAlias(bindingID)
    ? `init-${digestText(`v2.directory.init\u0000${bindingID}`)}`
    : undefined;

/** P06 bootstrap state only. Future lifecycle work must introduce an explicit versioned transition. */
export const validDirectoryResolution = (bindingID: string, value: DirectoryResolution): boolean =>
  isCanonicalDirectoryAlias(bindingID) &&
  /^owner-[A-Za-z0-9_-]{16,128}$/u.test(value.ownerID.value) &&
  /^vault-[A-Za-z0-9_-]{16,128}$/u.test(value.vaultID.value) &&
  value.ownerID.value !== value.vaultID.value &&
  value.initID === deriveDirectoryInitID(bindingID) &&
  value.generationEpoch === 1 &&
  value.activeGeneration === 1 &&
  value.routingEpoch === 1 &&
  value.credentialEpoch === 1;
