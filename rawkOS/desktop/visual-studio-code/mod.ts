import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall([
  "visual-studio-code-bin",
]);

ensureHomeSymlink(import.meta.dirname + "/argv.json", ".vscode/argv.json");
