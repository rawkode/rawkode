import type { Identity } from "../../../website/src/lib/auth.ts";
import type { SessionOutcome, SessionPermit, VoiceDevice } from "./session.ts";

/** Structurally compatible with DurableObjectStorage.transaction. The adapter
 * must provide atomic serializable transactions; plain KV is not sufficient. */
export interface VoiceTransaction {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
}
export interface VoiceStorage {
	transaction<T>(
		action: (transaction: VoiceTransaction) => Promise<T>,
	): Promise<T>;
}
export interface ReservationPolicy {
	maximumConcurrent: number;
	maximumDailyAttempts: number;
	creationLeaseMs: number;
	maximumRecords: number;
}
export const defaultReservationPolicy: ReservationPolicy = {
	maximumConcurrent: 1,
	maximumDailyAttempts: 20,
	creationLeaseMs: 30_000,
	maximumRecords: 128,
};
export type VoiceReceipt = {
	requestID: string;
	device: VoiceDevice;
	createdAt: number;
	leaseExpiresAt: number;
	state: "reserved" | "unknown" | "created" | "closed";
	sessionID?: string;
	closedAt?: number;
};
type Reservation = VoiceReceipt & { nonce: string; grantVersion: number };
type Ledger = {
	version: 1;
	ownerID: string;
	enabled: boolean;
	grantVersion: number;
	reservations: Reservation[];
};
const key = "voice-reservations-v1";
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const publicReceipt = (row: Reservation): VoiceReceipt => ({
	requestID: row.requestID,
	device: row.device,
	createdAt: row.createdAt,
	leaseExpiresAt: row.leaseExpiresAt,
	state: row.state,
	...(row.sessionID ? { sessionID: row.sessionID } : {}),
	...(row.closedAt === undefined ? {} : { closedAt: row.closedAt }),
});

/** One owner per Durable Object. Bind ownerID from verified identity, not any
 * model or request-body argument. Policy changes affect admission, not receipts. */
export const createVoiceReservations = (
	storage: VoiceStorage,
	ownerID: string,
	policy: ReservationPolicy = defaultReservationPolicy,
	clock: () => number = Date.now,
) => {
	if (
		!ownerID || ownerID.length > 256 ||
		policy.maximumRecords > 128 ||
		Object.values(policy).some((value) =>
			!Number.isSafeInteger(value) || value < 1
		)
	) throw new Error("Invalid voice policy");
	const transact = <T>(
		action: (ledger: Ledger, now: number) => T | Promise<T>,
	) =>
		storage.transaction(async (transaction) => {
			const now = clock();
			const ledger = await transaction.get<Ledger>(key) ?? {
				version: 1,
				ownerID,
				enabled: false,
				grantVersion: 1,
				reservations: [],
			};
			if (ledger.version !== 1 || ledger.ownerID !== ownerID) {
				throw new Error("Voice storage owner mismatch");
			}
			// An expired creation lease is uncertainty, not evidence of no charge.
			for (const row of ledger.reservations) {
				if (row.state === "reserved" && row.leaseExpiresAt <= now) {
					row.state = "unknown";
				}
			}
			const result = await action(ledger, now);
			await transaction.put(key, ledger);
			return result;
		});

	return {
		/** Explicit trusted feature enable/revoke; persisted and fail-closed initially. */
		setEnabled: (enabled: boolean): Promise<void> =>
			transact((ledger) => {
				if (ledger.enabled !== enabled) {
					ledger.enabled = enabled;
					ledger.grantVersion++;
				}
			}),
		reserve: async (
			identity: Identity,
			requestID: string,
			device: VoiceDevice,
		): Promise<SessionPermit | null> => {
			if (
				identity.ownerId !== ownerID ||
				!/^[a-zA-Z0-9_-]{16,80}$/.test(requestID) ||
				!["iphone", "carplay", "mac"].includes(device)
			) return null;
			const nonce = crypto.randomUUID();
			const admitted = await transact((ledger, now) => {
				if (
					!ledger.enabled || ledger.reservations.some((row) =>
						row.requestID === requestID
					) ||
					ledger.reservations.length >= policy.maximumRecords ||
					ledger.reservations.filter((row) => row.state !== "closed").length >=
						policy.maximumConcurrent ||
					ledger.reservations.filter((row) =>
							utcDay(row.createdAt) === utcDay(now)
						).length >= policy.maximumDailyAttempts
				) return false;
				ledger.reservations.push({
					requestID,
					device,
					nonce,
					grantVersion: ledger.grantVersion,
					createdAt: now,
					leaseExpiresAt: now + policy.creationLeaseMs,
					state: "reserved",
				});
				return true;
			});
			if (!admitted) return null;
			return {
				isCurrent: () =>
					transact((ledger, now) => {
						const row = ledger.reservations.find((candidate) =>
							candidate.requestID === requestID && candidate.nonce === nonce
						);
						return Boolean(
							ledger.enabled && row &&
								row.grantVersion === ledger.grantVersion &&
								(row.state === "reserved" || row.state === "created") &&
								row.leaseExpiresAt > now,
						);
					}),
				record: (outcome: SessionOutcome) =>
					transact((ledger) => {
						const row = ledger.reservations.find((candidate) =>
							candidate.requestID === requestID && candidate.nonce === nonce
						);
						if (!row) throw new Error("Unknown voice reservation");
						if (outcome.state === "created") {
							if (
								!outcome.sessionID || outcome.sessionID.length > 256 ||
								(row.sessionID && row.sessionID !== outcome.sessionID)
							) throw new Error("Conflicting voice receipt");
							if (
								row.state === "closed" && row.sessionID === outcome.sessionID
							) return;
							// A late provider response supersedes an earlier no-session
							// reconciliation. Never discard its known identifier.
							delete row.closedAt;
							row.sessionID = outcome.sessionID;
							row.state = "created";
						} else if (row.state === "reserved") row.state = "unknown";
					}),
			};
		},
		/** Reconciliation belongs to trusted lifecycle code, never generated code.
		 * A provider-close receipt must match the known session. Unknown attempts
		 * require independently verified no-session evidence before release. */
		reconcile: (
			requestID: string,
			evidence: { state: "closed"; sessionID: string } | {
				state: "notCreated";
			},
		): Promise<void> =>
			transact((ledger, now) => {
				const row = ledger.reservations.find((candidate) =>
					candidate.requestID === requestID
				);
				if (!row) throw new Error("Unknown voice reservation");
				if (evidence.state === "closed") {
					if (
						!row.sessionID || row.sessionID !== evidence.sessionID
					) throw new Error("Session receipt mismatch");
				} else if (row.sessionID || row.state === "reserved") {
					throw new Error("Cannot release an active or known session");
				}
				row.state = "closed";
				row.closedAt ??= now;
			}),
		/** Owner-scoped reconciliation view: never includes nonce, tokens or SDP. */
		receipts: (): Promise<VoiceReceipt[]> =>
			transact((ledger) => ledger.reservations.map(publicReceipt)),
	};
};
