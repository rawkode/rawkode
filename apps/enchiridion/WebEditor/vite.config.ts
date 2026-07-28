import { defineConfig, type Plugin } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";

function singleFileEditor(): Plugin {
  return {
    name: "enchiridion-single-file-editor",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = bundle["index.html"]
      const entry = Object.values(bundle).find(output => output.type === "chunk" && output.isEntry)
      const stylesheet = Object.values(bundle).find(
        output => output.type === "asset" && output.fileName.endsWith(".css")
      )
      if (!html || html.type !== "asset" || !entry || entry.type !== "chunk") {
        throw new Error("Editor single-file build could not find its HTML or entry chunk")
      }
      let source = String(html.source)
      const safeEntryCode = entry.code
        .replace(/<\/script/gi, "<\\/script")
        .replace(/<!--/g, "<\\!--")
        .replace(/\n?\/\/# sourceMappingURL=.*$/, "")
      source = source.replace(
        /<script type="module"[^>]*src="[^"]+"><\/script>/,
        () => `<script type="module" nonce="enchiridion-bootstrap">${safeEntryCode}</script>`
      )
      if (stylesheet?.type === "asset") {
        source = source.replace(
          /<link rel="stylesheet"[^>]*href="[^"]+">/,
          () => `<style nonce="enchiridion-bootstrap">${String(stylesheet.source)}</style>`
        )
        delete bundle[stylesheet.fileName]
      }
      html.source = source
      delete bundle[entry.fileName]
      for (const output of Object.values(bundle)) {
        if (output.fileName.endsWith(".map")) delete bundle[output.fileName]
      }
    },
    writeBundle(options) {
      // Vite performs a final HTML serialization after generateBundle. Protect
      // closing-script text embedded in JavaScript strings after that pass so
      // WebKit cannot mistake it for the end of the editor module.
      const outputPath = resolve(options.dir ?? "dist", "index.html")
      let source = readFileSync(outputPath, "utf8")
      source = source
        .replace(/<\/script>(\s*<script type="module")/i, "__BOOTSTRAP_CLOSE__$1")
        .replace(/<\/script>(\s*<style nonce="enchiridion-bootstrap")/i, "__EDITOR_CLOSE__$1")
        .replace(/<\/script/gi, "<\\/script")
        .replace("__BOOTSTRAP_CLOSE__", "</script>")
        .replace("__EDITOR_CLOSE__", "</script>")
      writeFileSync(outputPath, source)
    },
  }
}

export default defineConfig({
  base: "./",
  plugins: [wasm(), topLevelAwait(), singleFileEditor()],
  build: {
    outDir: "../Sources/SharedUI/Resources/Editor",
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: true,
    target: "es2022",
    // WKWebView cannot fetch a separate WASM asset from a file:// module graph.
    assetsInlineLimit: 4 * 1024 * 1024
  }
});
