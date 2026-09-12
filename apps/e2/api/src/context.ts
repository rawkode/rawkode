import type { DocumentsApi } from "../../core/documents/src/types.ts";
import type { CalendarApi } from "@e2/oauth-client/calendar";
import type { GitHubActivityApi, GitHubApi } from "@e2/oauth-client/github";
import type { EntitiesApi } from "@e2/entities";
import type { AuthConfig, Identity } from "../../website/src/lib/auth.ts";

export interface ApiEnv extends AuthConfig {
	ENTITIES_ADMIN?: {
		admin(owner: string): Promise<EntitiesApi & Disposable>;
	};
	DOCUMENTS_ADMIN?: {
		admin(owner: string): Promise<DocumentsApi & Disposable>;
	};
	GOOGLE_ADMIN?: { admin(owner: string): Promise<CalendarApi & Disposable> };
	GITHUB_ADMIN?: {
		admin(owner: string): Promise<GitHubApi & GitHubActivityApi & Disposable>;
	};
}
export interface ApiContext {
	identity: Identity;
	env: ApiEnv;
	cache: Map<string, unknown>;
	consume: () => void;
}
export interface IntegrationSchema {
	typeDefs: string;
	fields: Record<
		string,
		(
			source: unknown,
			args: Record<string, unknown>,
			context: ApiContext,
		) => unknown
	>;
}
export const createContext = (env: ApiEnv, identity: Identity): ApiContext => {
	let remaining = 50;
	return {
		env,
		identity,
		cache: new Map(),
		consume: () => {
			if (--remaining < 0) throw new Error("Request budget exceeded");
		},
	};
};

export const requestMemo = <T>(
	context: ApiContext,
	key: string,
	load: () => Promise<T>,
): Promise<T> => {
	const existing = context.cache.get(key);
	if (existing) return existing as Promise<T>;
	const pending = load();
	context.cache.set(key, pending);
	return pending;
};
