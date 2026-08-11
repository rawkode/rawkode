import { expect, test } from "bun:test";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

/**
 * Regression: the boundary scanner's embedded fixture self-tests (including
 * the provenance-checked fixed Durable Object client grammar) must pass, and
 * the P06-03c lifecycle/transport modules must stay clean. Other files may
 * still be listed while concurrent packages land their own fixes, so this
 * asserts on the scanner's own health and this package's files rather than on
 * the process exit code.
 */
test(
  "boundary scanner self-tests pass and lifecycle stays clean",
  () => {
    const result = Bun.spawnSync({
      cmd: ["bun", resolve(projectRoot, "scripts/check-effect-promise-boundaries.ts")],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    expect(output).not.toContain("boundary checker");
    expect(output).not.toContain("directory/lifecycle.ts");
    expect(output).not.toContain("runtime/owner-vault-control-client.ts");
    expect(output).not.toContain("entry/index.ts");
  },
  { timeout: 300_000 },
);
