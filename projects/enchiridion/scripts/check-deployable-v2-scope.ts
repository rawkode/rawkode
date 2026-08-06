#!/usr/bin/env bun

/**
 * The deployable-v2 lint manifest is deliberately fail-closed. `lint` may
 * only narrow when this list and its documented ownership debt change in the
 * same review. E2-07 must replace this temporary registry with the Alchemy
 * deployment manifest before it enables a deployment.
 */
import { Glob } from "bun";
import { resolve } from "node:path";
import { deployableTypeScriptRoots } from "./check-deployable-v2-roots";

const projectRoot = resolve(import.meta.dir, "..");
/** This literal is independent of the editable manifest below. */
const requiredRuntimeRoot = "packages/runtime";
const requiredRuntimePackageName = "@enchiridion/runtime";
const requiredProtocolRoot = "packages/protocol";
const requiredProtocolPackageName = "@enchiridion/protocol";
const transitionalWorkerRoots = {
  "workers/vault": "E2-03 Vault",
  "workers/gatekeeper-google": "E2-04 Gatekeeper",
  "workers/gadget-host": "E2-06 Gadget",
} as const;

const failures: string[] = [];
const rootPackage = await Bun.file(resolve(projectRoot, "package.json")).json();
const lintCommand = rootPackage.scripts?.["lint:deployable-v2"];
const requiredLintCommand =
  "bun scripts/check-deployable-v2-scope.ts && bun scripts/check-effect-promise-boundaries.ts";

if (deployableTypeScriptRoots.length === 0) {
  failures.push("deployable-v2 lint scope must never be empty.");
}
if (!deployableTypeScriptRoots.some(({ path }) => path === requiredRuntimeRoot)) {
  failures.push(`${requiredRuntimeRoot} is an immutable required deployable-v2 lint root.`);
}
if (!deployableTypeScriptRoots.some(({ path }) => path === requiredProtocolRoot)) {
  failures.push(`${requiredProtocolRoot} is an immutable required deployable-v2 lint root.`);
}

if (typeof lintCommand !== "string") {
  failures.push("package.json must define the deployable-v2 lint command.");
} else if (lintCommand !== requiredLintCommand) {
  failures.push(
    "deployable-v2 lint must run scope and AST Promise/cast checks in the immutable approved order.",
  );
}

for (const deployableRoot of deployableTypeScriptRoots) {
  const packageFile = Bun.file(resolve(projectRoot, deployableRoot.path, "package.json"));
  if (!(await packageFile.exists())) {
    failures.push(`declared deployable TypeScript root is missing: ${deployableRoot.path}`);
    continue;
  }
  const packageDefinition = await packageFile.json();
  if (packageDefinition.name !== deployableRoot.packageName) {
    failures.push(`${deployableRoot.path} must remain ${deployableRoot.packageName}.`);
  }
  if (
    deployableRoot.path === requiredRuntimeRoot &&
    packageDefinition.name !== requiredRuntimePackageName
  ) {
    failures.push(`${requiredRuntimeRoot} must remain ${requiredRuntimePackageName}.`);
  }
  if (
    deployableRoot.path === requiredProtocolRoot &&
    packageDefinition.name !== requiredProtocolPackageName
  ) {
    failures.push(`${requiredProtocolRoot} must remain ${requiredProtocolPackageName}.`);
  }
}

const workerRoots = new Set<string>();
for await (const path of new Glob("workers/*/package.json").scan({ cwd: projectRoot })) {
  workerRoots.add(path.slice(0, -"/package.json".length));
}

const declaredWorkers = new Set(Object.keys(transitionalWorkerRoots));
for (const root of workerRoots) {
  if (!declaredWorkers.has(root)) {
    failures.push(`worker ${root} is neither strict-linted nor assigned temporary deployment debt.`);
  }
}

for (const root of declaredWorkers) {
  if (!workerRoots.has(root)) {
    failures.push(`transitional deployment-debt root no longer exists: ${root}`);
  }
}

for await (const path of new Glob("workers/*/wrangler.jsonc").scan({ cwd: projectRoot })) {
  const root = path.slice(0, -"/wrangler.jsonc".length);
  if (!declaredWorkers.has(root)) {
    failures.push(`Wrangler configuration outside the deployment-debt registry: ${path}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

/** The scope checker, not a mutable package-script substring, owns this target. */
for (const deployableRoot of deployableTypeScriptRoots) {
  const biome = Bun.spawn(["bunx", "biome", "check", deployableRoot.path], {
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const biomeExit = await biome.exited;
  if (biomeExit !== 0) process.exit(biomeExit);
}
