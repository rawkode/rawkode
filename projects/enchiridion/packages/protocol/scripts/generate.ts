#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openAPIArtifact, protocolManifestArtifact } from "../src/artifacts";
import { generatedSwiftAPI } from "../src/swift";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputs: ReadonlyMap<string, string> = new Map([
  ["artifacts/openapi.v2.json", openAPIArtifact()],
  ["artifacts/protocol.v2.json", protocolManifestArtifact()],
  ["generated/swift/EnchiridionProtocol.swift", generatedSwiftAPI()],
]);

async function biomeFormatted(relativePath: string, contents: string): Promise<string> {
  if (!relativePath.endsWith(".json")) return contents;
  const result = Bun.spawn(["bunx", "biome", "format", "--stdin-file-path", relativePath], {
    cwd: packageRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  result.stdin.write(contents);
  result.stdin.end();
  if ((await result.exited) !== 0) throw new Error(await new Response(result.stderr).text());
  return new Response(result.stdout).text();
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  let drift = false;
  for (const [relativePath, generated] of outputs) {
    const contents = await biomeFormatted(relativePath, generated);
    const path = resolve(packageRoot, relativePath);
    let current: string | undefined;
    try { current = await readFile(path, "utf8"); } catch { /* generated below */ }
    if (current === contents) continue;
    if (check) { console.error(`generated artifact drift: ${relativePath}`); drift = true; continue; }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
    console.log(`wrote ${relativePath}`);
  }
  if (drift) process.exitCode = 1;
}

await main();
