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
	assert.equal(f.sent[1].type, "session.commentary.append");
	assert.equal(f.sent[1].delegation_id, "item_opaque");
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
	assert.equal(f.sent[1].type, "session.close");
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
	assert.deepEqual(f.sent.map((event) => event.type), [
		"session.instructions.append",
		"session.close",
	]);
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
	assert.deepEqual(f.sent.map((event) => event.type), [
		"session.instructions.append",
		"session.close",
	]);
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
	assert.equal(String(f.sent[1].content).includes("couldn't verify"), true);
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
	assert.equal(String(f.sent[1].content).includes("couldn't verify"), true);
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

Deno.test("voice delegation preserves typed history before new speech with untrusted speaker roles", async () => {
	const f = fixture();
	const requests: VoiceDelegationRequest[] = [];
	const control = await attachLiveSideband(base(f, {
		history: [{ role: "user", content: "Create task Ship" }, {
			role: "assistant",
			content: "Due tomorrow?",
		}],
		execute: (request) => {
			requests.push(request);
			return Promise.resolve("Created.");
		},
	}));
	f.emit({
		type: "session.input_transcript.delta",
		event_id: "new-speech",
		delta: "Yes",
		start_ms: 1,
		end_ms: 2,
	});
	delegate(f);
	await tick();
	assert.deepEqual(
		requests[0].transcript.map((row) => [row.speaker, row.text]),
		[["user", "Create task Ship"], ["assistant", "Due tomorrow?"], [
			"user",
			"Yes",
		]],
	);
	f.finish();
	await control.finished;
});

Deno.test("sideband diagnostics expose stages without transcript, IDs, keys or provider errors", async () => {
	const f = fixture();
	const events: unknown[] = [];
	const control = await attachLiveSideband(
		base(f, { diagnostic: (event) => events.push(event) }),
	);
	f.emit({
		type: "error",
		message: "private error contents",
		session_id: "private-session",
	});
	f.emit({
		type: "session.input_transcript.delta",
		delta: "private transcript",
		start_ms: 0,
		end_ms: 500,
	});
	delegate(f);
	await tick();
	await tick();
	const serialized = JSON.stringify(events);
	assert.ok(serialized.includes("socket_accepted"));
	assert.ok(serialized.includes("provider_error"));
	assert.ok(serialized.includes("transcript_accepted"));
	assert.ok(serialized.includes("delegation_accepted"));
	assert.ok(serialized.includes("execution_completed"));
	assert.ok(serialized.includes("commentary_sent"));
	for (const privateValue of ["private", "sess_", "item_", "never-return"]) {
		assert.ok(!serialized.includes(privateValue));
	}
	f.finish();
	await control.finished;
});

Deno.test("sideband diagnostics distinguish ignored delegation and timed out work", async () => {
	const f = fixture();
	const events: { stage: string; code?: string }[] = [];
	const control = await attachLiveSideband(
		base(f, {
			diagnostic: (event) => events.push(event),
			execute: () => new Promise(() => {}),
			limits: { workMs: 5 },
		}),
	);
	f.emit({
		type: "session.delegation.created",
		delegation: { id: "secret", target: "client" },
	});
	delegate(f);
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.ok(
		events.some((row) =>
			row.stage === "delegation_ignored" && row.code === "invalid_delegation"
		),
	);
	assert.ok(
		events.some((row) =>
			row.stage === "execution_failed" && row.code === "deadline_or_cancelled"
		),
	);
	assert.ok(
		events.some((row) =>
			row.stage === "commentary_sent" && row.code === "fallback"
		),
	);
	f.finish();
	await control.finished;
});

Deno.test("sideband correlates commentary acknowledgement and allowlists provider rejection fields", async () => {
	const f = fixture();
	const events: {
		stage: string;
		providerCode?: string;
		providerParam?: string;
		correlated?: boolean;
	}[] = [];
	const control = await attachLiveSideband(
		base(f, { diagnostic: (event) => events.push(event) }),
	);
	delegate(f);
	await tick();
	await tick();
	const sent = f.sent[1];
	f.emit({
		type: "session.commentary.appended",
		client_event_id: sent.event_id,
	});
	assert.ok(
		events.some((row) => row.stage === "commentary_accepted" && row.correlated),
	);
	delegate(f, "second");
	await tick();
	await tick();
	f.emit({
		type: "error",
		error: {
			client_event_id: f.sent[2].event_id,
			code: "invalid_delegation_id",
			type: "invalid_request_error",
			param: "delegation_id",
			message: "private provider context",
		},
	});
	assert.ok(
		events.some((row) =>
			row.stage === "commentary_rejected" &&
			row.providerCode === "invalid_delegation_id" &&
			row.providerParam === "delegation_id" && row.correlated
		),
	);
	f.emit({
		type: "error",
		error: {
			client_event_id: "private-id",
			code: "private-secret",
			type: "private-secret",
			param: "private-secret",
			message: "private message",
		},
	});
	assert.ok(
		events.some((row) =>
			row.stage === "provider_error" && row.providerCode === "other" &&
			!row.correlated
		),
	);
	assert.ok(!JSON.stringify(events).includes("private"));
	assert.ok(!JSON.stringify(events).includes(String(sent.event_id)));
	f.finish();
	await control.finished;
});

Deno.test("routine reflected audio and unrelated events do not emit diagnostics", async () => {
	const f = fixture();
	const events: unknown[] = [];
	const control = await attachLiveSideband(
		base(f, { diagnostic: (event) => events.push(event) }),
	);
	const before = events.length;
	for (let index = 0; index < 100; index++) {
		f.emit({
			type: "session.input_audio.append",
			audio: "private reflected audio",
		});
		f.emit({ type: "session.usage.updated", usage: { seconds: index } });
	}
	assert.equal(events.length, before);
	delegate(f);
	await tick();
	await tick();
	assert.ok(events.length > before);
	f.finish();
	await control.finished;
});

Deno.test("sideband sends one English greeting for new and resumed sessions without graph work", async () => {
	for (
		const history of [[], [{
			role: "user" as const,
			content: "Private earlier question",
		}, { role: "assistant" as const, content: "Private earlier answer" }]]
	) {
		const f = fixture();
		let executions = 0;
		const diagnostics: unknown[] = [];
		const control = await attachLiveSideband(
			base(f, {
				history,
				diagnostic: (event) => diagnostics.push(event),
				execute: () => {
					executions++;
					return Promise.resolve("unused");
				},
			}),
		);
		assert.equal(f.sent.length, 1);
		const greeting = f.sent[0];
		assert.equal(greeting.type, "session.instructions.append");
		assert.equal(greeting.delegation_id, null);
		assert.ok(
			String(greeting.content).includes("Choose your own brief wording"),
		);
		assert.ok(String(greeting.content).includes("conversation so far"));
		assert.ok(String(greeting.content).includes("English"));
		assert.ok(String(greeting.content).includes("Then pause and listen"));
		assert.ok(!String(greeting.content).includes("Private"));
		f.emit({ type: "session.started" });
		f.emit({ type: "session.started" });
		f.emit({
			type: "session.instructions.appended",
			client_event_id: greeting.event_id,
		});
		f.emit({
			type: "session.instructions.appended",
			client_event_id: greeting.event_id,
		});
		await tick();
		assert.equal(f.sent.length, 1);
		assert.equal(executions, 0);
		assert.equal(
			diagnostics.filter((event) =>
				(event as { stage: string }).stage === "greeting_accepted"
			).length,
			1,
		);
		assert.ok(!JSON.stringify(diagnostics).includes(String(greeting.event_id)));
		f.finish();
		await control.finished;
	}
});

Deno.test("a rejected greeting is not retried and does not disable normal delegation", async () => {
	const f = fixture();
	const diagnostics: { stage: string }[] = [];
	const control = await attachLiveSideband(
		base(f, { diagnostic: (event) => diagnostics.push(event) }),
	);
	f.emit({
		type: "error",
		error: {
			client_event_id: f.sent[0].event_id,
			code: "server_error",
			type: "server_error",
			message: "private",
		},
	});
	delegate(f);
	await tick();
	await tick();
	assert.equal(
		f.sent.filter((row) => row.type === "session.instructions.append").length,
		1,
	);
	assert.equal(
		f.sent.filter((row) => row.type === "session.commentary.append").length,
		1,
	);
	assert.ok(diagnostics.some((row) => row.stage === "greeting_rejected"));
	assert.equal(f.disconnected(), false);
	f.finish();
	await control.finished;
});
