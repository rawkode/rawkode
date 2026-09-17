import type { OAuthEnv } from "./env";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomSecret(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function fromBase64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }

/** Row and field identity authenticate the ciphertext as well as its contents. */
export class TokenVault {
  #keys: Record<string, string>;
  #active: string;

  constructor(env: Pick<OAuthEnv, "TOKEN_ENCRYPTION_KEYS" | "TOKEN_ENCRYPTION_KEY_ID">) {
    this.#keys = JSON.parse(env.TOKEN_ENCRYPTION_KEYS);
    this.#active = env.TOKEN_ENCRYPTION_KEY_ID;
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(this.#active) || !Object.hasOwn(this.#keys, this.#active)) {
      throw new Error("Token encryption is not configured.");
    }
  }

  async #key(id: string) {
    if (!Object.hasOwn(this.#keys, id)) throw new Error("Unknown encryption key.");
    const key = fromBase64(this.#keys[id]);
    if (key.byteLength !== 32) throw new Error("Encryption keys must contain 32 bytes.");
    return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  async encrypt(value: string, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, await this.#key(this.#active), encoder.encode(value));
    return ["v1", this.#active, toBase64(iv), toBase64(new Uint8Array(encrypted))].join(".");
  }

  async decrypt(value: string, context: string): Promise<string> {
    const [version, id, iv, encrypted, extra] = value.split(".");
    if (version !== "v1" || !id || !iv || !encrypted || extra !== undefined) throw new Error("Invalid encrypted credential.");
    const result = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(context) }, await this.#key(id), fromBase64(encrypted));
    return decoder.decode(result);
  }
}
