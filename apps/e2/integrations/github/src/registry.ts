import { sha256 } from "./app-auth.ts";
import type { InstallationIdentity } from "./env.ts";

const required = (value: unknown, label: string, max = 500): string => {
	if (typeof value !== "string" || !value.trim() || value.length > max) {
		throw new Error(`Invalid ${label}`);
	}
	return value.trim();
};

const installationId = (value: unknown): string => {
	const id = required(String(value), "installation ID", 32);
	if (!/^[1-9]\d{0,31}$/.test(id)) throw new Error("Invalid installation ID");
	return id;
};

const stateToken = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
};

export const beginInstallation = async (
	db: D1Database,
	ownerId: string,
	now = Date.now(),
): Promise<string> => {
	const owner = required(ownerId, "owner", 200);
	const state = stateToken();
	await db.prepare(
		"INSERT INTO github_setup_sessions(state_hash,owner_id,expires_at) VALUES (?, ?, ?)",
	).bind(await sha256(state), owner, now + 10 * 60_000).run();
	return state;
};

export const claimInstallation = async (
	db: D1Database,
	state: string,
	identity: Omit<InstallationIdentity, "ownerId">,
	now = Date.now(),
): Promise<InstallationIdentity> => {
	if (!/^[A-Za-z0-9_-]{43}$/.test(state)) {
		throw new Error("Invalid installation state");
	}
	const stateHash = await sha256(state);
	const session = await db.prepare(
		"SELECT owner_id FROM github_setup_sessions WHERE state_hash = ? AND expires_at > ?",
	).bind(stateHash, now).first<{ owner_id: string }>();
	if (!session) throw new Error("Installation state expired or already used");
	const value: InstallationIdentity = {
		installationId: installationId(identity.installationId),
		ownerId: required(session.owner_id, "owner", 200),
		accountId: required(identity.accountId, "GitHub account ID", 100),
		accountLogin: required(identity.accountLogin, "GitHub account login", 100),
		targetType: identity.targetType,
	};
	if (!["User", "Organization"].includes(value.targetType)) {
		throw new Error("Invalid GitHub installation target");
	}
	const results = await db.batch([
		db.prepare(
			"DELETE FROM github_setup_sessions WHERE state_hash = ? AND owner_id = ? AND expires_at > ?",
		).bind(stateHash, value.ownerId, now),
		db.prepare(
			`INSERT INTO github_installations
        (installation_id,owner_id,account_id,account_login,target_type,status,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET
         account_id=excluded.account_id,
         account_login=excluded.account_login,
         target_type=excluded.target_type,
         status='active',
         updated_at=excluded.updated_at
       WHERE github_installations.owner_id=excluded.owner_id`,
		).bind(
			value.installationId,
			value.ownerId,
			value.accountId,
			value.accountLogin,
			value.targetType,
			now,
			now,
		),
	]);
	if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
		throw new Error("GitHub installation is already owned by another account");
	}
	return value;
};

export const installationOwner = async (
	db: D1Database,
	value: unknown,
): Promise<InstallationIdentity | null> => {
	const row = await db.prepare(
		`SELECT installation_id,owner_id,account_id,account_login,target_type
       FROM github_installations WHERE installation_id = ?`,
	).bind(installationId(value)).first<{
		installation_id: string;
		owner_id: string;
		account_id: string;
		account_login: string;
		target_type: "User" | "Organization";
	}>();
	return row
		? {
			installationId: row.installation_id,
			ownerId: row.owner_id,
			accountId: row.account_id,
			accountLogin: row.account_login,
			targetType: row.target_type,
		}
		: null;
};

export const listInstallations = async (
	db: D1Database,
	ownerId: string,
): Promise<InstallationIdentity[]> => {
	const { results } = await db.prepare(
		`SELECT installation_id,owner_id,account_id,account_login,target_type
       FROM github_installations WHERE owner_id = ? AND status != 'deleted'
       ORDER BY account_login,installation_id`,
	).bind(required(ownerId, "owner", 200)).all<{
		installation_id: string;
		owner_id: string;
		account_id: string;
		account_login: string;
		target_type: "User" | "Organization";
	}>();
	return results.map((row) => ({
		installationId: row.installation_id,
		ownerId: row.owner_id,
		accountId: row.account_id,
		accountLogin: row.account_login,
		targetType: row.target_type,
	}));
};

export const setInstallationStatus = (
	db: D1Database,
	id: string,
	status: "active" | "suspended" | "deleted",
): Promise<D1Result<unknown>> =>
	db.prepare(
		"UPDATE github_installations SET status = ?, updated_at = ? WHERE installation_id = ?",
	).bind(status, Date.now(), installationId(id)).run();

export const deleteExpiredSetupSessions = (
	db: D1Database,
	now = Date.now(),
): Promise<D1Result<unknown>> =>
	db.prepare("DELETE FROM github_setup_sessions WHERE expires_at <= ?").bind(
		now,
	)
		.run();

export const activeInstallationIds = async (
	db: D1Database,
	limit = 100,
): Promise<string[]> => {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("Invalid installation batch size");
	}
	const { results } = await db.prepare(
		"SELECT installation_id FROM github_installations WHERE status='active' ORDER BY updated_at LIMIT ?",
	).bind(limit).all<{ installation_id: string }>();
	return results.map((row) => row.installation_id);
};

export const touchInstallation = (
	db: D1Database,
	id: string,
): Promise<D1Result<unknown>> =>
	db.prepare(
		"UPDATE github_installations SET updated_at=? WHERE installation_id=?",
	).bind(Date.now(), installationId(id)).run();
