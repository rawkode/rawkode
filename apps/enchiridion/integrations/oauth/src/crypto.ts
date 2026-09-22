import type { OAuthEnv } from "./env.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const randomSecret = (): string => {
	return toBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll(
		"+",
		"-",
	).replaceAll("/", "_").replaceAll("=", "");
};

export const sha256 = async (value: string): Promise<string> => {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", encoder.encode(value)),
	);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
};

const toBase64 = (bytes: Uint8Array): string => {
	return btoa(String.fromCharCode(...bytes));
};
const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
};

const readKeyring = async (env: Pick<OAuthEnv, "TOKEN_KEYRING">) => {
	const value: unknown = JSON.parse(await env.TOKEN_KEYRING.get());
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid token keyring.");
	}
	const { active, keys } = value as { active?: unknown; keys?: unknown };
	if (
		typeof active !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(active) ||
		!keys || typeof keys !== "object" || Array.isArray(keys) ||
		!Object.hasOwn(keys, active)
	) throw new Error("Invalid token keyring.");
	const entries = Object.entries(keys);
	if (
		entries.some(([id, key]) =>
			!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || typeof key !== "string" ||
			!/^[A-Za-z0-9+/]{43}=$/.test(key) || fromBase64(key).byteLength !== 32
		)
	) throw new Error("Invalid token encryption key.");
	return { active, keys: keys as Record<string, string> };
};

const importKey = (keys: Record<string, string>, id: string) => {
	if (!Object.hasOwn(keys, id)) throw new Error("Unknown encryption key.");
	return crypto.subtle.importKey(
		"raw",
		fromBase64(keys[id]),
		"AES-GCM",
		false,
		["encrypt", "decrypt"],
	);
};

/** Fetch the current keyring for each operation so retained capabilities observe rotation. */
export const createTokenVault = (env: Pick<OAuthEnv, "TOKEN_KEYRING">) => {
	const encrypt = async (value: string, context: string): Promise<string> => {
		const { active, keys } = await readKeyring(env);
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const encrypted = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: encoder.encode(context) },
			await importKey(keys, active),
			encoder.encode(value),
		);
		return ["v1", active, toBase64(iv), toBase64(new Uint8Array(encrypted))]
			.join(".");
	};

	const decrypt = async (value: string, context: string): Promise<string> => {
		const { keys } = await readKeyring(env);
		const [version, id, iv, encrypted, extra] = value.split(".");
		if (version !== "v1" || !id || !iv || !encrypted || extra !== undefined) {
			throw new Error("Invalid encrypted credential.");
		}
		const result = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: fromBase64(iv),
				additionalData: encoder.encode(context),
			},
			await importKey(keys, id),
			fromBase64(encrypted),
		);
		return decoder.decode(result);
	};
	return { encrypt, decrypt };
};
