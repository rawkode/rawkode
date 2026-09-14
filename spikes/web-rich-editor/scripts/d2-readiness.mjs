// @terrastruct/d2 0.1.33 announces readiness before observing Go startup errors.
// Keep this patch shared by Astro and the bundled SwiftUI build.
export function d2Readiness() {
  return {
    name: "d2-wasm-readiness",
    enforce: "pre",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/@terrastruct/d2/dist/browser/index.js")) return;
      const before = "  go.run(result.instance);\n  return self.d2;";
      if (!code.includes(before)) throw new Error("Pinned D2 startup changed; review the readiness patch.");
      return code.replace(before, `  let startupError;
  go.run(result.instance).then(
    () => { startupError = new Error("D2 runtime exited during startup"); },
    (error) => { startupError = error; },
  );
  const deadline = Date.now() + 10000;
  while (typeof self.d2?.compile !== "function" || typeof self.d2?.render !== "function") {
    if (startupError) throw startupError;
    if (Date.now() > deadline) throw new Error("D2 runtime did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return self.d2;`);
    },
  };
}
