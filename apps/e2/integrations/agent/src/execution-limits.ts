export class VoiceExecutionError extends Error {
	constructor(
		readonly code:
			| "executor_failed"
			| "executor_deadline"
			| "executor_cancelled"
			| "invalid_result"
			| "result_too_large",
	) {
		super(code);
		this.name = "VoiceExecutionError";
	}
}
/** Apply runtime CPU/network limits even if a library forgets them. */
export const boundedVoiceLoader = (loader: WorkerLoader): WorkerLoader => {
	const constrain = (code: WorkerLoaderWorkerCode): WorkerLoaderWorkerCode => ({
		...code,
		globalOutbound: null,
		limits: { cpuMs: 50, subRequests: 10 },
	});
	return {
		load: (code) => loader.load(constrain(code)),
		get: (name, getCode) =>
			loader.get(name, async () => constrain(await getCode())),
	};
};

export const boundedVoiceToolResult = (value: unknown): { result: unknown } => {
	if (value && typeof value === "object" && "error" in value && value.error) {
		const code = value.error === "Voice execution deadline or cancellation"
			? "executor_deadline"
			: value.error === "Voice execution canceled"
			? "executor_cancelled"
			: "executor_failed";
		throw new VoiceExecutionError(code);
	}
	const result = value && typeof value === "object" && "result" in value
		? value.result
		: null;
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(result);
	} catch {
		throw new VoiceExecutionError("invalid_result");
	}
	if (!serialized) throw new VoiceExecutionError("invalid_result");
	if (!serialized || new TextEncoder().encode(serialized).byteLength > 20_480) {
		throw new VoiceExecutionError("result_too_large");
	}
	// Generated console output is neither needed for the answer nor retained.
	return { result: JSON.parse(serialized) };
};

/** The parent owns a deadline and disposes native worker/RPC handles on cancellation. */
export const createBoundedVoiceExecutor = (
	loader: WorkerLoader,
	create: (loader: WorkerLoader) => import("@cloudflare/codemode").Executor,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): import("@cloudflare/codemode").Executor => ({
	execute: async (code, providers, executionOptions) => {
		const resources = new Set<object>();
		const disposed = new Set<object>();
		let ended = false;
		const dispose = (resource: object) => {
			if (disposed.has(resource)) return;
			disposed.add(resource);
			const method = Reflect.get(resource, Symbol.dispose);
			if (typeof method === "function") {
				try {
					method.call(resource);
				} catch { /* Preserve the execution outcome. */ }
			}
		};
		const track = <T extends object>(resource: T): T => {
			resources.add(resource);
			if (ended) dispose(resource);
			return resource;
		};
		const worker = (stub: WorkerStub): WorkerStub => {
			track(stub);
			return {
				getEntrypoint: (name, opts) => track(stub.getEntrypoint(name, opts)),
				getDurableObjectClass: (name, opts) =>
					stub.getDurableObjectClass(name, opts),
			};
		};
		const bounded = boundedVoiceLoader(loader);
		const tracked: WorkerLoader = {
			load: (config) => worker(bounded.load(config)),
			get: (name, config) => worker(bounded.get(name, config)),
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		let cancel = () => {};
		try {
			if (options.signal?.aborted) {
				return { result: undefined, error: "Voice execution canceled" };
			}
			const timeout = options.timeoutMs ?? 5000;
			if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 5000) {
				throw new Error("Invalid execution deadline");
			}
			return await Promise.race([
				Promise.resolve().then(() =>
					create(tracked).execute(code, providers, executionOptions)
				),
				new Promise<import("@cloudflare/codemode").ExecuteResult>((resolve) => {
					cancel = () => {
						ended = true;
						for (const resource of [...resources].reverse()) dispose(resource);
						resolve({
							result: undefined,
							error: "Voice execution deadline or cancellation",
						});
					};
					options.signal?.addEventListener("abort", cancel, { once: true });
					timer = setTimeout(cancel, timeout);
				}),
			]);
		} catch {
			return { result: undefined, error: "Voice execution failed" };
		} finally {
			ended = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
			for (const resource of [...resources].reverse()) dispose(resource);
		}
	},
});
