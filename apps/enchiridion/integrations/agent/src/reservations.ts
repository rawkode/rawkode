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
	recoveredAt?: number;
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
	...(row.recoveredAt === undefined ? {} : { recoveredAt: row.recoveredAt }),
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
		action: (
			ledger: Ledger,
			now: number,
			transaction: VoiceTransaction,
		) => T | Promise<T>,
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
			const result = await action(ledger, now, transaction);
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
			const admitted = await transact(async (ledger, now, transaction) => {
				if (await transaction.get(`voice-closed:${requestID}`)) return false;
				// Move prior-day closed receipts out of the bounded hot ledger without
				// forgetting request IDs. Same-day rows retain daily-attempt accounting.
				const archived = ledger.reservations.filter((row) =>
					row.state === "closed" && utcDay(row.createdAt) !== utcDay(now)
				);
				for (const row of archived) {
					await transaction.put(`voice-closed:${row.requestID}`, row);
				}
				ledger.reservations = ledger.reservations.filter((row) =>
					!archived.includes(row)
				);
				if (archived.some((row) => row.requestID === requestID)) return false;
				if (
					!ledger.enabled || ledger.reservations.some((row) =>
						row.requestID === requestID
					) ||
					ledger.reservations.length >= policy.maximumRecords ||
					ledger.reservations.filter((row) =>
							row.state !== "closed" &&
							!(row.state === "unknown" && !row.sessionID &&
								row.recoveredAt !== undefined)
						).length >=
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
							ledger.enabled && row && row.recoveredAt === undefined &&
								row.grantVersion === ledger.grantVersion &&
								(row.state === "reserved" || row.state === "created") &&
								row.leaseExpiresAt > now,
						);
					}),
				record: (outcome: SessionOutcome) =>
					transact(async (ledger, now, transaction) => {
						let row = ledger.reservations.find((candidate) =>
							candidate.requestID === requestID && candidate.nonce === nonce
						);
						if (!row) {
							const archived = await transaction.get<Reservation>(
								`voice-closed:${requestID}`,
							);
							if (archived?.nonce === nonce) {
								if (
									archived.sessionID ===
										(outcome.state === "created"
											? outcome.sessionID
											: undefined)
								) return;
								row = archived;
								ledger.reservations.push(row);
							}
							if (!row) throw new Error("Unknown voice reservation");
						}
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
						} else if (outcome.state === "rejected") {
							if (row.sessionID) {
								throw new Error("Cannot reject a created session");
							}
							// An explicit provider rejection confirms that no session exists.
							// Retain the closed receipt for daily quota and replay protection.
							row.state = "closed";
							row.closedAt ??= now;
						} else if (row.state === "reserved") row.state = "unknown";
					}),
			};
		},
		/** Explicit owner acceptance of uncertainty; never a provider-close receipt. */
		recoverUnknown: (
			identity: Identity,
			requestID: string,
			acknowledgeUnconfirmedSession: boolean,
		): Promise<boolean> => {
			if (
				identity.ownerId !== ownerID || acknowledgeUnconfirmedSession !== true
			) return Promise.resolve(false);
			return transact((ledger, now) => {
				const row = ledger.reservations.find((row) =>
					row.requestID === requestID
				);
				if (
					!row || row.state !== "unknown" || row.sessionID ||
					row.leaseExpiresAt > now
				) return false;
				row.recoveredAt ??= now;
				return true;
			});
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
		/** Ongoing authorization is independent of the short creation lease. */
		isSessionActive: (sessionID: string): Promise<boolean> =>
			transact((ledger) =>
				ledger.enabled &&
				ledger.reservations.some((row) =>
					row.sessionID === sessionID && row.state === "created" &&
					row.recoveredAt === undefined &&
					row.grantVersion === ledger.grantVersion
				)
			),
		/** Owner-scoped reconciliation view: never includes nonce, tokens or SDP. */
		receipts: (): Promise<VoiceReceipt[]> =>
			transact((ledger) => ledger.reservations.map(publicReceipt)),
	};
};
