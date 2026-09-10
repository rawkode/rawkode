import migrations from "../migrations/migrations.js";
import { DurableObject } from "cloudflare:workers";
import { connectOAuth } from "@e2/oauth-client";
import type { AccountEnv, CalendarEnv } from "./env.ts";
import { syncGoogle } from "./mirror.ts";
import { watchMail } from "./gmail.ts";
import { scopes } from "./google.ts";
import { accountStorage, migrateAccount } from "./storage.ts";
import { createAccountApi } from "./account-api.ts";
import { drainContactProjectionOutbox } from "./projection.ts";

interface CoordinatorStorage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	getAlarm(): Promise<number | null>;
	setAlarm(time: number): Promise<void>;
	deleteAlarm(): Promise<void>;
}

/** Durable state and network effects are explicit inputs to the coordinator. */
export const startAccount = async (
	storage: CoordinatorStorage,
	connectionId: string,
	immediate = false,
) => {
	if (await storage.get<boolean>("deleted")) {
		throw new Error("Account has been deleted");
	}
	const existing = await storage.get<string>("connection");
	if (existing && existing !== connectionId) {
		throw new Error("Account identity mismatch");
	}
	await storage.put("connection", connectionId);
	const alarm = await storage.getAlarm();
	if (alarm === null || immediate && alarm > Date.now() + 1000) {
		await storage.setAlarm(Date.now() + 1000);
	}
};

export const syncAccount = async (
	storage: CoordinatorStorage,
	env: AccountEnv,
) => {
	const id = await storage.get<string>("connection");
	if (!id) return;
	// A recovery alarm is durable before network I/O, including unexpected termination.
	await storage.setAlarm(Date.now() + 15 * 60_000);
	try {
		using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
		const connection = (await oauth.listConnections()).find((c) =>
			c.id === id && c.providerId === "google" && c.status === "connected"
		);
		if (!connection) {
			await storage.deleteAlarm();
			return;
		}
		const result = await syncGoogle(env, oauth, connection);
		const projection = await drainContactProjectionOutbox(
			env.DB,
			env.ENTITIES_ADMIN,
			id,
		);
		if (env.GMAIL_PUBSUB_TOPIC && connection.scopes.includes(scopes.gmail)) {
			const watch = await env.DB.prepare(
				"SELECT renewed_at FROM gmail_watches WHERE connection_id = ?",
			).bind(id).first<{ renewed_at: number }>();
			if (watch && watch.renewed_at < Date.now() - 86_400_000) {
				await watchMail(env, oauth, connection);
			}
		}
		await storage.put("failures", 0);
		await storage.setAlarm(
			Date.now() + (result.pending || projection.pending ? 1000 : 15 * 60_000),
		);
	} catch {
		if (await storage.get<boolean>("deleted")) return;
		const failures = Math.min(
			(await storage.get<number>("failures") ?? 0) + 1,
			10,
		);
		await storage.put("failures", failures);
		await storage.setAlarm(
			Date.now() + Math.min(30_000 * 2 ** (failures - 1), 3_600_000),
		);
		console.error("Google account sync will retry", {
			connectionId: id,
			failures,
		});
	}
};

/** Thin RPC adapter: every object is named by exactly one OAuth connection. */
export class GoogleAccount extends DurableObject<CalendarEnv> {
	#local: ReturnType<typeof accountStorage>;
	constructor(ctx: DurableObjectState, env: CalendarEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() =>
			Promise.resolve().then(() => migrateAccount(ctx.storage, migrations))
		);
		this.#local = accountStorage(ctx.storage);
	}
	#identity(connectionId: string) {
		if (
			typeof connectionId !== "string" ||
			!this.ctx.id.equals(this.env.GOOGLE_ACCOUNTS.idFromName(connectionId))
		) {
			throw new Error("Account identity mismatch");
		}
	}
	#api(connectionId: string, owner: string) {
		this.#identity(connectionId);
		this.#local.assertActive();
		return createAccountApi({ ...this.env, DB: this.#local.db }, owner);
	}
	async start(connectionId: string, immediate = false) {
		this.#identity(connectionId);
		using oauth = await connectOAuth(
			this.env.OAUTH,
			this.env.OAUTH_SERVICE_CREDENTIAL,
		);
		const connection = (await oauth.listConnections()).find((row) =>
			row.id === connectionId && row.providerId === "google" &&
			row.status === "connected"
		);
		if (!connection) throw new Error("Google access is not authorized");
		this.#local.revive(connection.grantVersion);
		return startAccount(this.#local.coordinator, connectionId, immediate);
	}
	async #run<T>(
		id: string,
		owner: string,
		action: (api: ReturnType<typeof createAccountApi>) => Promise<T>,
	) {
		const result = await action(this.#api(id, owner));
		this.#local.assertActive();
		return result;
	}
	sync(id: string, owner: string) {
		return this.#run(id, owner, (api) => api.sync(id));
	}
	listRecords(id: string, owner: string, collection: string, after = "") {
		return this.#run(
			id,
			owner,
			(api) => api.listRecords(id, collection, after),
		);
	}
	searchMail(id: string, owner: string, query: string, pageToken?: string) {
		return this.#run(id, owner, (api) => api.searchMail(id, query, pageToken));
	}
	upcoming(id: string, owner: string, from: string, to: string) {
		return this.#run(id, owner, (api) => api.upcoming(id, from, to));
	}
	watchMail(id: string, owner: string) {
		return this.#run(id, owner, (api) => api.watchMail(id));
	}
	mailPeople(id: string, owner: string, from: string, to: string) {
		return this.#run(id, owner, (api) => api.mailPeople(id, from, to));
	}
	mailStatus(id: string, owner: string) {
		return this.#run(id, owner, (api) => api.mailStatus(id));
	}
	listEvents(id: string, owner: string) {
		return this.#run(id, owner, (api) => api.listEvents(id));
	}
	async deleteAccount(id: string, owner: string) {
		this.#identity(id);
		using oauth = await connectOAuth(
			this.env.OAUTH,
			this.env.OAUTH_SERVICE_CREDENTIAL,
		);
		const connection = await oauth.getConnectionForCleanup(id, owner);
		if (!connection) {
			throw new Error("Google access is not authorized");
		}
		await this.#local.remove(connection.grantVersion);
	}
	async notifyMail(id: string, email: string, history: string) {
		this.#identity(id);
		if (this.#local.deleted()) return;
		using oauth = await connectOAuth(
			this.env.OAUTH,
			this.env.OAUTH_SERVICE_CREDENTIAL,
		);
		if (
			!(await oauth.listConnections()).some((row) =>
				row.id === id && row.providerId === "google" &&
				row.status === "connected" && row.scopes.includes(scopes.gmail)
			)
		) return;
		await this.#local.db.prepare(
			"UPDATE gmail_watches SET history_id = ?, notified_at = ? WHERE connection_id = ? AND email = ? AND (length(history_id) < length(?) OR (length(history_id) = length(?) AND history_id < ?))",
		).bind(history, Date.now(), id, email, history, history, history).run();
	}
	override alarm() {
		if (this.#local.deleted()) return Promise.resolve();
		return syncAccount(this.#local.coordinator, {
			...this.env,
			DB: this.#local.db,
		});
	}
}
