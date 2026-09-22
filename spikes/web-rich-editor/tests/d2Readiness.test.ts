import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { d2Readiness } from "../scripts/d2-readiness.mjs";

const id = "/node_modules/@terrastruct/d2/dist/browser/index.js";
const source = readFileSync(new URL("../node_modules/@terrastruct/d2/dist/browser/index.js", import.meta.url), "utf8");
const patched = d2Readiness().transform(source, id)!;
const body = patched.slice(patched.indexOf("async function initWasmBrowser("), patched.indexOf("setupMessageHandler(false, self, initWasmBrowser);"));

function initializer(run: () => Promise<void>, api: Record<string, unknown>) {
  return new Function("Go", "WebAssembly", "self", `${body}; return initWasmBrowser;`)(
    class { importObject = {}; run = run; },
    { instantiate: async () => ({ instance: {} }) }, api,
  );
}

test("D2 waits for asynchronous API registration instead of reporting false readiness", async () => {
  const api: Record<string, unknown> = {};
  const render = { compile() {}, render() {} };
  const initialize = initializer(() => {
    setTimeout(() => { api.d2 = render; }, 15);
    return new Promise(() => {});
  }, api);
  assert.equal(await initialize(new Uint8Array()), render);
});

test("D2 propagates startup rejection and premature runtime exit", async () => {
  await assert.rejects(initializer(async () => { throw new Error("WASM startup failed"); }, {})(new Uint8Array()), /WASM startup failed/);
  await assert.rejects(initializer(async () => {}, {})(new Uint8Array()), /exited during startup/);
});

test("D2 patch fails closed when the pinned upstream implementation changes", () => {
  assert.throws(() => d2Readiness().transform("changed source", id), /Pinned D2 startup changed/);
  assert.equal(d2Readiness().transform("unrelated", "/src/app.js"), undefined);
});
