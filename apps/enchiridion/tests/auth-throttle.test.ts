import { describe, expect, it } from "vitest";
import app from "../src/app";
import {
	checkPasswordAuthThrottle,
	clearPasswordAuthFailures,
	recordPasswordAuthFailure,
} from "../src/lib/auth-throttle";
import type { Env } from "../src/lib/types";

interface AuthFailureRow {
	key_hash: string;
	failed_count: number;
	first_failed_at: string;
	last_failed_at: string;
	locked_until: string | null;
}

describe("password auth throttling", () => {
	it("locks a client key after repeated failed Basic auth attempts", async () => {
		const { env } = authThrottleEnv();
		const request = passwordRequest();
		const now = Date.parse("2026-06-18T02:00:00.000Z");
		const initial = await checkPasswordAuthThrottle(env, request, now);

		expect(initial).toMatchObject({ limited: false });
		expect(initial.keyHash).toBeTruthy();

		for (let attempt = 1; attempt < 5; attempt += 1) {
			const result = await recordPasswordAuthFailure(env, initial.keyHash!, now + attempt);
			expect(result.limited).toBe(false);
		}

		const locked = await recordPasswordAuthFailure(env, initial.keyHash!, now + 5);
		expect(locked).toMatchObject({
			limited: true,
			retryAfterSeconds: 900,
		});

		const blocked = await checkPasswordAuthThrottle(env, request, now + 1_000);
		expect(blocked.limited).toBe(true);
		expect(blocked.retryAfterSeconds).toBe(900);

		const afterLock = await checkPasswordAuthThrottle(env, request, now + 901_000);
		expect(afterLock.limited).toBe(false);
	});

	it("clears failed attempts after a successful password auth", async () => {
		const { env, rows } = authThrottleEnv();
		const request = passwordRequest();
		const initial = await checkPasswordAuthThrottle(env, request);

		await recordPasswordAuthFailure(env, initial.keyHash!);
		expect(rows.size).toBe(1);

		await clearPasswordAuthFailures(env, initial.keyHash!);
		expect(rows.size).toBe(0);
	});

	it("ignores local development and non-Basic auth requests", async () => {
		const { env } = authThrottleEnv();
		const localRequest = new Request("http://localhost:8787/api/bootstrap", {
			headers: { authorization: `Basic ${btoa("rawkode:wrong")}` },
		});
		const missingAuth = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap");

		expect(await checkPasswordAuthThrottle(env, localRequest)).toEqual({ limited: false });
		expect(await checkPasswordAuthThrottle(env, missingAuth)).toEqual({ limited: false });
	});

	it("returns 429 from the app after repeated failed password attempts", async () => {
		const { env, rows } = authThrottleEnv();
		const request = () => passwordRequest();

		for (let attempt = 1; attempt < 5; attempt += 1) {
			const response = await app.fetch(request(), env);
			expect(response.status).toBe(401);
		}

		const locked = await app.fetch(request(), env);
		expect(locked.status).toBe(429);
		expect(locked.headers.get("retry-after")).toBe("900");
		expect(await locked.json()).toEqual({ error: "Too many failed password attempts" });
		expect(Array.from(rows.values())[0]?.failed_count).toBe(5);
	});
});

function passwordRequest(): Request {
	return new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap", {
		headers: {
			authorization: `Basic ${btoa("rawkode:wrong")}`,
			"cf-connecting-ip": "203.0.113.10",
		},
	});
}

function authThrottleEnv(): { env: Env; rows: Map<string, AuthFailureRow> } {
	const rows = new Map<string, AuthFailureRow>();
	const env = {
		ENCHIRIDION_PASSWORD: "secret-password",
		DB: {
			prepare(sql: string) {
				let params: unknown[] = [];
				const statement = {
					bind(...values: unknown[]) {
						params = values;
						return statement;
					},
					async first() {
						if (/SELECT \* FROM auth_failures WHERE key_hash = \?/.test(sql)) {
							return rows.get(String(params[0])) ?? null;
						}
						return null;
					},
					async run() {
						if (/INSERT INTO auth_failures/.test(sql)) {
							rows.set(String(params[0]), {
								key_hash: String(params[0]),
								failed_count: Number(params[1]),
								first_failed_at: String(params[2]),
								last_failed_at: String(params[3]),
								locked_until: params[4] === null ? null : String(params[4]),
							});
						}
						if (/DELETE FROM auth_failures WHERE key_hash = \?/.test(sql)) {
							rows.delete(String(params[0]));
						}
						return { success: true };
					},
				};
				return statement;
			},
		},
	} as unknown as Env;

	return { env, rows };
}
