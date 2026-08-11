#!/usr/bin/env bun
// @enchiridion/codegen — regeneration entry point.
//
// Writes `generateSwiftSchema()`'s output (see ../src/index.ts) into
// apps/swift/Sources/EnchiridionSchema/Generated/, overwriting whatever is
// there. This is the "small script that calls generateSwiftSchema() and
// writes the output" referenced by every generated file's own header
// comment ("Regenerate with: bun run --cwd packages/codegen generate").
//
// Registers every `supertags/*` module that currently exports a default
// SupertagModule. `supertags/email` and `supertags/workouts` are still P0
// skeletons with zero declared supertags as of this task — included
// anyway (harmless: generateSwiftSchema() skips modules with no
// supertags) so this script doesn't need editing again the moment either
// gets real fields.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import coreModule from "@enchiridion/supertags-core";
import emailModule from "@enchiridion/supertags-email";
import workoutsModule from "@enchiridion/supertags-workouts";
// P7 "Native drawing canvas" task (plan §Core Product UI (P7), track 5) —
// registered here the same way `workoutsModule` was for its own task:
// this script is the only place a new module needs wiring for its Swift
// codegen to exist (see supertags/canvas/src/index.ts's header for why it
// is NOT also wired into `workers/vault/src/supertag-registry.ts` or
// `graphql/composed-schema.ts` — `workoutsModule` established that same
// precedent: a module can have real Swift-side field accessors without
// yet having server-side GraphQL/registry wiring, which is a separate,
// later integration step).
import canvasModule from "@enchiridion/supertags-canvas";
import { generateSwiftSchema } from "../src/index";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDir, "..", "..", "..");
const outputRoot = join(workspaceRoot, "apps", "swift", "Sources", "EnchiridionSchema", "Generated");

async function main(): Promise<void> {
  const outputs = generateSwiftSchema([coreModule, emailModule, workoutsModule, canvasModule]);

  await mkdir(outputRoot, { recursive: true });

  // Clear stale generated files first (e.g. a supertag/module renamed or
  // removed since the last run) so `Generated/` never accumulates output
  // that no longer corresponds to any registered module.
  for (const entry of await readdir(outputRoot)) {
    if (entry.endsWith(".swift")) {
      await rm(join(outputRoot, entry));
    }
  }

  for (const file of outputs) {
    const relative = file.path.startsWith("Generated/") ? file.path.slice("Generated/".length) : file.path;
    const destination = join(outputRoot, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.contents, "utf8");
    console.log(`wrote ${destination}`);
  }

  console.log(`generated ${outputs.length} file(s) from ${4} supertag module(s).`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
