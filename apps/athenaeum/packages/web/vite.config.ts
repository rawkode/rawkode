import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

// `wasm()` (Daily notes stage addition): `@automerge/automerge`'s browser entrypoint
// (`fullfat_bundler.js`, selected automatically by Vite's default "browser" resolve condition)
// does `import * as wasm from "./automerge_wasm_bg.wasm"` — the still-experimental WASM/ESM-
// integration proposal browsers don't support natively (automerge's own README: "you must use a
// bundler"). Plain Vite doesn't rewrite that import form on its own; `vite-plugin-wasm` does, for
// both the dev-server transform and esbuild's dependency pre-bundling pass, compiling it to a real
// instantiated module with the resulting top-level `await` left as native ESM top-level await
// (supported by this project's target browsers and by Vite/Rollup's own default build target —
// see below for why the commonly-paired `vite-plugin-top-level-await` was tried and dropped).
//
// `vite-plugin-top-level-await` was tried first (the combination automerge+Vite guides usually
// recommend) but its 1.6.0 release throws `[vite-plugin-top-level-await] missing field 'type'`
// during `vite build` against this workspace's Vite 7/Rollup 4/@swc-core versions — a real,
// reproduced incompatibility (see the Daily notes stage's own verification notes), not a
// hypothetical one. It's dropped rather than pinned to an older, untested combination: Vite's
// default build target already supports native top-level await, so `vite-plugin-wasm` alone is
// sufficient for both `vite dev` (native ESM, no transform needed at all) and `vite build`
// (verified below).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  const backendHost = env.VITE_BACKEND_HOST?.trim() || "localhost:8787";

  return {
    plugins: [react(), wasm()],
    server: {
      port: 3000,
      host: true,
      proxy: {
        "/api": `http://${backendHost}`,
      },
    },
  };
});
