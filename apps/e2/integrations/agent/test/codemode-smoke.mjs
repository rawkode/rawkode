import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
const requireAlchemy = createRequire(import.meta.resolve("alchemy"));
const runtimePackage = requireAlchemy.resolve(
	"@alchemy.run/cloudflare-runtime/package.json",
);
const runtimeManifest = JSON.parse(await readFile(runtimePackage, "utf8"));
const runtimeImport = (subpath) =>
	import(
		new URL(
			runtimeManifest.exports[`./${subpath}`].import,
			pathToFileURL(runtimePackage),
		).href
	);
const {
	Runtime,
	RuntimeLive,
	layerLocalBindings,
	layerLoopback,
	layerStorage,
	layerRegistry,
	layerProxy,
} = await runtimeImport("core");
const { Docker } = await runtimeImport("core/Docker");
const { Globals, Internet } = await runtimeImport("core/globals");
const { WorkerdLive } = await runtimeImport("core/workerd/Workerd");
const { PathsLive } = await import(
	new URL("dist/core/node/internal/Paths.mjs", pathToFileURL(runtimePackage))
		.href
);
// The convenience layer eagerly starts a detached Docker proxy. These Workers
// need only local services; reject container use and omit remote/cloud layers.
const localRuntime = (directory) =>
	RuntimeLive.pipe(
		Layer.provideMerge(layerLocalBindings()),
		Layer.provideMerge(layerProxy()),
		Layer.provide(Globals.GlobalsLive),
		Layer.provideMerge(layerLoopback()),
		Layer.provide(layerStorage({ directory })),
		Layer.provide(Internet.InternetLive),
		Layer.provideMerge(layerRegistry()),
		Layer.provide(PathsLive),
		Layer.provide(Layer.succeed(
			Docker,
			new Proxy({}, {
				get: () => {
					throw new Error("Containers are outside this smoke test");
				},
			}),
		)),
		Layer.provide(WorkerdLive),
	);

const { WorkerLoader } = await runtimeImport("core/bindings");
const esbuild = requireAlchemy("esbuild");
const temporary = await mkdtemp(join(tmpdir(), "e2-voice-code-smoke-"));
for (const kind of ["CACHE", "CONFIG", "DATA", "STATE"]) {
	process.env[`XDG_${kind}_HOME`] = join(temporary, kind.toLowerCase());
}
// The actual installed SDK and production loader wrapper run inside workerd.
// Only day data is a fixture; no OpenAI endpoint or key is used.
const source = `
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createBoundedVoiceExecutor } from "./integrations/agent/src/execution-limits.ts";
export default {
 async fetch(request, env) {
  const mode = new URL(request.url).pathname.slice(1);
  const executor = createBoundedVoiceExecutor(env.LOADER, loader => new DynamicWorkerExecutor({ loader, globalOutbound: null, timeout: 100 }), {timeoutMs:50});
  const owner = "fixture-alice";
  const codes = {
   day: 'async () => { const row = await enchiridion.day({date: "2026-09-13"}); return {title:row.title,owner:row.owner}; }',
   network: 'async () => { try { await fetch("https://example.com"); return "network-allowed"; } catch { return "network-denied"; } }',
   secrets: 'async () => ({ env: typeof env, process: typeof process === "undefined" ? "undefined" : typeof process.env.OPENAI_API_KEY })',
   timeout: 'async () => await new Promise(() => {})',
   cpu: 'async () => { const until = Date.now()+300; let n=0; while(Date.now()<until) n++; return "cpu-limit-not-enforced"; }',
  };
  try {
   const result = await executor.execute(codes[mode], [{name:"enchiridion",fns:{day: async(input)=>({owner,title:"Fixture meeting",date:input.date})}}]);
   return Response.json(result);
  } catch { return Response.json({error:"executor-rejected"}); }
 }
};`;
const bundle = await esbuild.build({
	stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
	bundle: true,
	write: false,
	format: "esm",
	platform: "neutral",
	target: "es2022",
	external: ["cloudflare:workers", "node:*"],
	conditions: ["workerd", "worker", "browser"],
});
const config = {
	name: "voice-code-smoke",
	compatibilityDate: "2026-07-11",
	compatibilityFlags: ["nodejs_compat"],
	modules: [{
		name: "index.js",
		type: "ESModule",
		content: bundle.outputFiles[0].text,
	}],
	bindings: [WorkerLoader.local("LOADER")],
};
try {
	await Runtime.pipe(
		Effect.flatMap((runtime) => runtime.start(config)),
		Effect.flatMap((url) =>
			Effect.promise(async () => {
				const run = async (name) => {
					const response = await fetch(new URL(name, url), {
						signal: AbortSignal.timeout(6000),
					});
					return response.json();
				};
				const day = await run("day");
				assert.deepEqual(day.result, {
					title: "Fixture meeting",
					owner: "fixture-alice",
				});
				console.log("PASS real SDK generated code -> owner-bound fixture day");
				assert.equal((await run("network")).result, "network-denied");
				console.log("PASS outbound fetch denied by real workerd");
				const secrets = await run("secrets");
				assert.equal(secrets.result.env, "undefined");
				assert.equal(secrets.result.process, "undefined");
				console.log("PASS generated code has no host env/key binding");
				assert.ok((await run("timeout")).error);
				console.log("PASS unresolved generated promise times out");
				const cpu = await run("cpu");
				assert.ok(
					cpu.error,
					"Local workerd did not enforce the configured50ms CPU limit; CPU-bound cancellation remains unverified",
				);
				console.log("PASS CPU-bound execution rejected");
			})
		),
		Effect.scoped,
		Effect.provide(localRuntime(join(temporary, "storage"))),
		Effect.provide(FetchHttpClient.layer),
		Effect.provide(NodeServices.layer),
		Effect.runPromise,
	);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
