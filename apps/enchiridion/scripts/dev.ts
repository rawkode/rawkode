import { startMockGoogle } from "./mock-google";

const root = new URL("../", import.meta.url).pathname;
const realGoogle = Bun.argv.includes("--google");
const bun = process.execPath;
async function run(args: string[], cwd = root) {
  const child = Bun.spawn([bun, ...args], { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  if (await child.exited !== 0) throw new Error(`Command failed: bun ${args.join(" ")}`);
}
const vars = Bun.file(new URL("../services/oauth/.dev.vars", import.meta.url));
if (!await vars.exists()) await run(["scripts/setup.ts", ...(realGoogle ? ["--google"] : [])]);
const configuredMock = (await vars.text()).includes("LOCAL_PROVIDER_ORIGIN=");
if (configuredMock === realGoogle) throw new Error(`Run bun run dev:setup${realGoogle ? " -- --google" : ""} to select the requested provider first.`);
for (const port of [4321, 8787, 8788, 8789, ...(realGoogle ? [] : [8790])]) {
  for (const hostname of ["127.0.0.1", "::1"]) {
    try { const probe = Bun.listen({ hostname, port, socket: { data() {} } }); probe.stop(true); }
    catch { throw new Error(`Port ${port} is already in use. Stop the existing local stack before starting another.`); }
  }
}
await run(["run", "db:migrate"]);
await run(['scripts/editor-assets.ts']);
const mock = realGoogle ? undefined : await startMockGoogle();
const children: ReturnType<typeof Bun.spawn>[] = [];
let websiteStarted = false;
let stopping = false;
let stopPromise: Promise<void> | undefined;
function stop() {
  return stopPromise ??= (async () => {
    stopping = true;
    if (websiteStarted) await run(["run", "--cwd", "website", "astro", "dev", "stop"]).catch(() => {});
    for (const child of children) child.kill("SIGTERM");
    mock?.server.stop(true);
  })();
}
process.on("SIGINT", () => { void stop().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void stop().then(() => process.exit(0)); });
async function ready(url: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await Bun.sleep(200);
  }
  throw new Error(`Service did not become ready: ${url}`);
}
try {
  for (const service of ["oauth", "google-calendar", "documents"]) {
    children.push(Bun.spawn([bun, "run", "dev"], { cwd: `${root}services/${service}`, stdout: "inherit", stderr: "inherit", stdin: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } }));
  }
  await Promise.all([ready("http://localhost:8787/health"), ready("http://localhost:8788/health"), ready("http://localhost:8789/health")]);
  await run(["run", "--cwd", "website", "dev"]); websiteStarted = true;
  await ready("http://localhost:4321/api/health");
  console.log(`\nLocal stack ready: http://localhost:4321/admin/oauth\nProvider: ${realGoogle ? "Google" : "local test provider (use any non-empty client ID and secret)"}\nRun bun run test:e2e in another terminal. Press Ctrl+C to stop the stack.`);
  const exitCode = await Promise.race(children.map((child) => child.exited));
  if (!stopping) throw new Error(`A service stopped unexpectedly (${exitCode}).`);
} finally { await stop(); }
