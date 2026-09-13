import { strict as assert } from "node:assert";
import {
	attachLiveSideband,
	type LiveControlSocket,
	type SidebandOptions,
	type VoiceDelegationRequest,
} from "../src/sideband.ts";
const fixture = () => {
	const listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
	const sent: Record<string, unknown>[] = [];
	let accepted = false, disconnected = false;
	const socket: LiveControlSocket = {
		accept: () => {
			accepted = true;
		},
		close: () => {
			disconnected = true;
		},
		send: (text) => {
			sent.push(JSON.parse(text));
		},
		addEventListener: (type, listener) => {
			const set = listeners.get(type) ?? new Set();
			set.add(listener);
			listeners.set(type, set);
		},
		removeEventListener: (type, listener) => {
			listeners.get(type)?.delete(listener);
		},
	};
	const emit = (event: unknown) => {
		for (const listener of listeners.get("message") ?? []) {
			listener({ data: JSON.stringify(event) });
		}
	};
	const lost = () => {
		for (const listener of listeners.get("close") ?? []) listener({});
	};
	const finish = () =>
		emit({
			type: "session.closed",
			session: { id: "sess_private" },
			usage: { seconds: 12 },
			reason: "close_requested",
		});
	return {
		socket,
		sent,
		emit,
		lost,
		finish,
		accepted: () => accepted,
		disconnected: () => disconnected,
	};
};
const base = (
	f: ReturnType<typeof fixture>,
	extra: Partial<SidebandOptions> = {},
): SidebandOptions => ({
	sessionID: "sess_private",
	apiKey: "never-return-this",
	authorize: () => Promise.resolve(true),
	execute: () => Promise.resolve("Your next event is at 14:00."),
	onClosed: () => Promise.resolve(),
	connect: () => Promise.resolve(f.socket),
	limits: { closeMs: 10, workMs: 20 },
	...extra,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const delegate = (f: ReturnType<typeof fixture>, id = "item_opaque") =>
	f.emit({
		type: "session.delegation.created",
		event_id: `event_${id}`,
		offset_ms: 2000,
		delegation: { id, type: "delegation", target: "client" },
	});
Deno.test("sideband attaches before return, orders transcripts, executes one owner and correlates results", async () => {
	const f = fixture();
	const requests: VoiceDelegationRequest[] = [];
	const control = await attachLiveSideband(base(f, {
		execute: (request) => {
			requests.push(request);
			return Promise.resolve("Verified calendar result.");
		},
	}));
	assert.equal(f.accepted(), true);
	f.emit({ type: "session.input_audio.append", audio: "SECRET_RAW_AUDIO" });
	f.emit({
		type: "session.input_transcript.delta",
		event_id: "e2",
		delta: "next?",
		start_ms: 1500,
		end_ms: 1800,
	});
	f.emit({
		type: "session.input_transcript.delta",
		event_id: "e1",
		delta: "What's ",
		start_ms: 1000,
		end_ms: 1500,
	});
	f.emit({
		type: "session.input_transcript.delta",
		event_id: "e1",
		delta: "What's ",
		start_ms: 1000,
		end_ms: 1500,
	});
	f.emit({
		type: "session.input_transcript.delta",
		delta: "Future",
		start_ms: 3000,
		end_ms: 4000,
	});
	delegate(f);
	delegate(f);
	await tick();
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0].transcript.map((row) => row.text), [
		"What's ",
		"next?",
	]);
	assert.equal(f.sent[0].type, "session.commentary.append");
	assert.equal(f.sent[0].delegation_id, "item_opaque");
	assert.equal(JSON.stringify(requests).includes("SECRET_RAW_AUDIO"), false);
	assert.equal(JSON.stringify(f.sent).includes("never-return-this"), false);
	f.finish();
	assert.equal((await control.finished).finalized, true);
});
Deno.test("sideband close preserves transport until provider finalization and saves exact receipt", async () => {
	const f = fixture();
	let saved = 0;
	const control = await attachLiveSideband(base(f, {
		onClosed: (result) => {
			saved++;
			assert.equal(result.seconds, 12);
			return Promise.resolve();
		},
	}));
	const pending = control.close();
	assert.equal(f.disconnected(), false);
	assert.equal(f.sent[0].type, "session.close");
	f.finish();
	assert.equal((await pending).finalized, true);
	assert.equal(saved, 1);
	assert.equal(f.disconnected(), true);
});
Deno.test("socket loss and close timeout never manufacture a provider receipt", async () => {
	for (const lose of [true, false]) {
		const f = fixture();
		let saved = 0;
		const control = await attachLiveSideband(base(f, {
			onClosed: () => {
				saved++;
				return Promise.resolve();
			},
		}));
		if (lose) f.lost();
		else void control.close();
		assert.equal((await control.finished).finalized, false);
		assert.equal(saved, 0);
	}
});
Deno.test("revocation while work runs closes and suppresses the late result", async () => {
	const f = fixture();
	let authorized = true;
	let complete!: (value: string) => void;
	const control = await attachLiveSideband(
		base(f, {
			authorize: () => Promise.resolve(authorized),
			execute: () =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		}),
	);
	delegate(f);
	await tick();
	authorized = false;
	complete("private late result");
	await tick();
	assert.deepEqual(f.sent.map((event) => event.type), ["session.close"]);
	f.finish();
	await control.finished;
});
Deno.test("closing cancels work and suppresses late completion even if executor ignores signal", async () => {
	const f = fixture();
	let complete!: (value: string) => void;
	const control = await attachLiveSideband(
		base(f, {
			execute: () =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		}),
	);
	delegate(f);
	await tick();
	void control.close();
	complete("late result");
	await tick();
	assert.deepEqual(f.sent.map((event) => event.type), ["session.close"]);
	f.finish();
	await control.finished;
});
Deno.test("oversized or failed results are redacted and wrong-session close cannot reconcile", async () => {
	const f = fixture();
	let saved = 0;
	const control = await attachLiveSideband(
		base(f, {
			execute: () => Promise.resolve("x".repeat(481)),
			onClosed: () => {
				saved++;
				return Promise.resolve();
			},
		}),
	);
	delegate(f);
	await tick();
	assert.equal(String(f.sent[0].content).includes("couldn't verify"), true);
	f.emit({ type: "session.closed", session: { id: "someone_else" } });
	assert.equal((await control.finished).finalized, false);
	assert.equal(saved, 0);
});
Deno.test("work and attach deadlines terminate adapters that ignore cancellation", async () => {
	const f = fixture();
	await assert.rejects(
		attachLiveSideband(base(f, {
			connect: () => new Promise(() => {}),
			limits: { attachMs: 5 },
		})),
	);
	const control = await attachLiveSideband(
		base(f, { execute: () => new Promise(() => {}) }),
	);
	delegate(f);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(String(f.sent[0].content).includes("couldn't verify"), true);
	f.finish();
	await control.finished;
});
Deno.test("failed initial authorization never connects", async () => {
	const f = fixture();
	let connects = 0;
	await assert.rejects(
		attachLiveSideband(base(f, {
			authorize: () => Promise.resolve(false),
			connect: () => {
				connects++;
				return Promise.resolve(f.socket);
			},
		})),
	);
	assert.equal(connects, 0);
});

Deno.test("successful WebSocket upgrade keeps its fetch signal alive until socket cleanup", async () => {
	const f = fixture();
	let connectedSignal: AbortSignal | undefined;
	const controller = await attachLiveSideband(base(f, {
		connect: (_id, _key, signal) => {
			connectedSignal = signal;
			signal.addEventListener("abort", () => f.socket.close());
			return Promise.resolve(f.socket);
		},
	}));
	assert.ok(connectedSignal);
	assert.equal(connectedSignal.aborted, false);
	assert.equal(f.disconnected(), false);
	f.finish();
	assert.equal((await controller.finished).finalized, true);
	assert.equal(f.disconnected(), true);
});
