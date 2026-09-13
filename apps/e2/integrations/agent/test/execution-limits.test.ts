import { expect } from "expect";
import {
	boundedVoiceLoader,
	boundedVoiceToolResult,
	createBoundedVoiceExecutor,
} from "../src/execution-limits.ts";

Deno.test("voice sandbox overrides unrestricted loader network and CPU settings", async () => {
	const seen: WorkerLoaderWorkerCode[] = [];
	let deferred:
		| (() => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>)
		| undefined;
	const loader: WorkerLoader = {
		load: (code) => {
			seen.push(code);
			return {} as WorkerStub;
		},
		get: (_name, factory) => {
			deferred = factory;
			return {} as WorkerStub;
		},
	};
	const code: WorkerLoaderWorkerCode = {
		mainModule: "main.js",
		modules: { "main.js": "export default {}" },
		compatibilityDate: "2026-07-11",
		globalOutbound: undefined,
		limits: { cpuMs: 100_000, subRequests: 1000 },
	};
	const bounded = boundedVoiceLoader(loader);
	bounded.load(code);
	bounded.get("sample", () => code);
	seen.push(await deferred!());
	for (const result of seen) {
		expect(result.globalOutbound).toBeNull();
		expect(result.limits).toEqual({ cpuMs: 50, subRequests: 10 });
		expect(result.modules).toEqual(code.modules);
	}
});

Deno.test("voice code results drop generated logs and reject oversized UTF8 data", () => {
	expect(
		boundedVoiceToolResult({
			result: { events: [] },
			logs: ["private debug data"],
		}),
	).toEqual({ result: { events: [] } });
	expect(() => boundedVoiceToolResult({ result: "界".repeat(10_000) }))
		.toThrow();
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	expect(() => boundedVoiceToolResult({ result: cyclic })).toThrow();
});

Deno.test("voice host deadline disposes outstanding entrypoint and worker handles", async () => {
	const disposed: string[] = [];
	const entrypoint = {
		[Symbol.dispose]: () => {
			disposed.push("entrypoint");
		},
	};
	const worker = {
		getEntrypoint: () => entrypoint,
		[Symbol.dispose]: () => {
			disposed.push("worker");
		},
	} as unknown as WorkerStub;
	const loader = { load: () => worker, get: () => worker } as WorkerLoader;
	const executor = createBoundedVoiceExecutor(
		loader,
		(tracked) => ({
			execute: () => {
				tracked.load({
					mainModule: "a.js",
					modules: { "a.js": "" },
					compatibilityDate: "2026-07-11",
				}).getEntrypoint();
				return new Promise(() => {});
			},
		}),
		{ timeoutMs: 5 },
	);
	const result = await executor.execute("async()=>{}", []);
	expect(result.error).toContain("deadline");
	expect(disposed).toEqual(["entrypoint", "worker"]);
});
Deno.test("voice host abort disposes handles without waiting for an uncooperative executor", async () => {
	const abort = new AbortController();
	let disposed = false;
	const worker = {
		[Symbol.dispose]: () => {
			disposed = true;
		},
	} as unknown as WorkerStub;
	const loader = { load: () => worker, get: () => worker } as WorkerLoader;
	const executor = createBoundedVoiceExecutor(
		loader,
		(tracked) => ({
			execute: () => {
				tracked.load({
					mainModule: "a.js",
					modules: { "a.js": "" },
					compatibilityDate: "2026-07-11",
				});
				abort.abort();
				return new Promise(() => {});
			},
		}),
		{ signal: abort.signal },
	);
	expect((await executor.execute("async()=>{}", [])).error).toContain(
		"cancellation",
	);
	expect(disposed).toBe(true);
});
