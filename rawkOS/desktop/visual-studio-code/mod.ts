import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("visual-studio-code")
  .description("Code editor")
  .tags("desktop", "development", "editor")
  .with(() => [
    packageInstall({
      names: ["visual-studio-code-bin"],
    }),
    linkDotfile({
      source: "argv.json",
      // For some weird reason, VSCode doesn't use XDG_CONFIG_HOME
      target: "~/.vscode/argv.json",
    }),
  ]);
