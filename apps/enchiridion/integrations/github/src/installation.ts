import migrations from "../account-migrations/migrations.js";
import { DurableObject } from "cloudflare:workers";
import type { GitHubEnv, InstallationIdentity } from "./env.ts";
import {
	archiveInstallationPage,
	drainGitHubProjectionOutbox,
	initializeInstallation,
	reconcileInstallationPage,
	recordWebhook,
} from "./app-mirror.ts";
import { GitHubRateLimitError } from "./app-auth.ts";
import {
	installationDatabase,
	migrateInstallation,
} from "./installation-storage.ts";

const identity = async (
	db: ReturnType<typeof installationDatabase>,
): Promise<InstallationIdentity | null> => {
	const row = await db.prepare(
		`SELECT installation_id,owner_id,account_id,account_login,target_type
	   FROM installation_state LIMIT 1`,
	).first<{
		installation_id: string;
		owner_id: string;
		account_id: string;
		account_login: string;
		target_type: "User" | "Organization";
	}>();
	return row && {
		installationId: row.installation_id,
		ownerId: row.owner_id,
		accountId: row.account_id,
		accountLogin: row.account_login,
		targetType: row.target_type,
	};
};

export const runInstallation = async (
	storage: DurableObjectStorage,
	env: GitHubEnv,
) => {
	const db = installationDatabase(storage);
	const installation = await identity(db);
	if (!installation) return;
	await storage.setAlarm(Date.now() + 15 * 60_000);
	try {
		const state = await db.prepare(
			"SELECT status FROM installation_state WHERE installation_id=?",
		).bind(installation.installationId).first<{ status: string }>();
		const archive = state?.status === "deleted"
			? await archiveInstallationPage(db, installation)
			: { pending: false };
		const projection = await drainGitHubProjectionOutbox(
			db,
			env.ENTITIES_ADMIN,
			installation,
		);
		const mirror = state?.status === "active"
			? await reconcileInstallationPage(db, env, installation)
			: { pending: false };
		await db.prepare(
			"UPDATE installation_state SET failures=0,last_error=NULL,last_success_at=?,rate_limit_until=NULL WHERE installation_id=?",
		).bind(Date.now(), installation.installationId).run();
		await storage.setAlarm(
			Date.now() +
				(archive.pending || projection.pending || mirror.pending
					? 1_000
					: 15 * 60_000),
		);
	} catch (error) {
		const row = await db.prepare(
			"SELECT failures FROM installation_state WHERE installation_id=?",
		).bind(installation.installationId).first<{ failures: number }>();
		const failures = Math.min((row?.failures ?? 0) + 1, 10);
		const retryAt = error instanceof GitHubRateLimitError
			? Math.max(Date.now() + 1_000, error.retryAt)
			: Date.now() + Math.min(30_000 * 2 ** (failures - 1), 3_600_000);
		await db.prepare(
			"UPDATE installation_state SET failures=?,last_error=?,rate_limit_until=? WHERE installation_id=?",
		).bind(
			failures,
			error instanceof GitHubRateLimitError
				? "GitHub rate limit reached"
				: "GitHub reconciliation failed",
			retryAt,
			installation.installationId,
		).run();
		await storage.setAlarm(retryAt);
		console.error("GitHub installation reconciliation will retry", {
			installationId: installation.installationId,
			failures,
		});
	}
};

/** One object owns all provider state for exactly one GitHub App installation. */
export class GitHubInstallation extends DurableObject<GitHubEnv> {
	#db: ReturnType<typeof installationDatabase>;
	constructor(ctx: DurableObjectState, env: GitHubEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() =>
			Promise.resolve().then(() => migrateInstallation(ctx.storage, migrations))
		);
		this.#db = installationDatabase(ctx.storage);
	}
	#assertIdentity(installationId: string) {
		const namespace = this.env.GITHUB_INSTALLATIONS;
		if (
			typeof installationId !== "string" || !namespace ||
			!this.ctx.id.equals(namespace.idFromName(installationId))
		) throw new Error("Installation identity mismatch");
	}
	async claim(input: InstallationIdentity) {
		this.#assertIdentity(input.installationId);
		const current = await identity(this.#db);
		if (current && current.ownerId !== input.ownerId) {
			throw new Error("Installation ownership mismatch");
		}
		await initializeInstallation(this.#db, input);
		await this.ctx.storage.setAlarm(Date.now() + 1_000);
	}
	async start() {
		const current = await identity(this.#db);
		if (!current) throw new Error("Installation is not claimed");
		this.#assertIdentity(current.installationId);
		const alarm = await this.ctx.storage.getAlarm();
		if (alarm === null || alarm > Date.now() + 1_000) {
			await this.ctx.storage.setAlarm(Date.now() + 1_000);
		}
	}
	async receiveWebhook(
		deliveryId: string,
		event: string,
		payload: Record<string, unknown>,
	) {
		const current = await identity(this.#db);
		if (!current) throw new Error("Installation is not claimed");
		this.#assertIdentity(current.installationId);
		const result = await recordWebhook(this.#db, deliveryId, event, payload);
		if (!result.duplicate) await this.ctx.storage.setAlarm(Date.now() + 1_000);
		return result;
	}
	override alarm() {
		return runInstallation(this.ctx.storage, this.env);
	}
}
