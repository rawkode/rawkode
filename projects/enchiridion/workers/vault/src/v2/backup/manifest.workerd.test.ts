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
        reject(new Error("expected TCP address"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });

let process: ReturnType<typeof Bun.spawn> | undefined;
let baseURL = "";

const ready = async (): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseURL}/current`)).ok) return;
    } catch {
      // Workerd has not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("manifest Workerd fixture did not become ready");
};

beforeAll(async () => {
  const port = await freePort();
  baseURL = `http://127.0.0.1:${port}`;
  process = Bun.spawn(
    [
      wrangler,
      "dev",
      "--config=src/v2/backup/wrangler.manifest-workerd-test.jsonc",
      `--port=${port}`,
      "--local",
      "--show-interactive-dev-session=false",
    ],
    { cwd: vaultDirectory, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  await ready();
}, 45_000);

afterAll(async () => {
  process?.kill();
  if (process !== undefined) await process.exited;
});

describe("v2 backup manifest P-256 on real Workerd", () => {
  test("accepts current/prior and rejects revoked, tampered, and high-S manifest signatures", async () => {
    for (const path of ["current", "prior", "revoked", "tamper", "high-s"]) {
      const response = await fetch(`${baseURL}/${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(path);
    }
  }, 45_000);
});
