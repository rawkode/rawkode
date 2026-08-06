import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";

const vaultDirectory = join(import.meta.dir, "..", "..", "..");
const wrangler = join(vaultDirectory, "node_modules", ".bin", "wrangler");

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("local Workerd port was unavailable"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });

const waitForReady = async (baseURL: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseURL);
      await response.arrayBuffer();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("local Workerd P-256 harness did not start");
};

describe("v2 device service real Workerd P-256 integration", () => {
  let serverProcess: ReturnType<typeof Bun.spawn> | undefined;
  let baseURL = "";

  beforeAll(async () => {
    const port = await freePort();
    serverProcess = Bun.spawn(
      [
        wrangler,
        "dev",
        "--config=src/v2/devices/wrangler.p256-test.jsonc",
        `--port=${port}`,
        "--local",
        "--show-interactive-dev-session=false",
      ],
      {
        cwd: vaultDirectory,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
      },
    );
    baseURL = `http://127.0.0.1:${port}`;
    await waitForReady(baseURL);
  }, 40_000);

  afterAll(async () => {
    if (serverProcess !== undefined) {
      serverProcess.kill();
      await serverProcess.exited;
    }
  });

  test("accepts the committed low-S proof and rejects its committed high-S DER twin", async () => {
    const accepted = await fetch(baseURL);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true });

    const rejected = await fetch(`${baseURL}/high-s`);
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ ok: false });
  }, 15_000);
});
