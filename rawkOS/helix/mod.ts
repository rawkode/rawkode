import { defineModule, install, linkFile, source, userConfig, runCommand } from "@rawkode/dhd"

export default defineModule({
  name: "helix",
  tags: ["editor", "development"],
  dependsOn: [],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install helix editor
  install("helix", { brew: "helix" }),

  // Install language servers and tools
  // Note: Some LSPs need to be installed separately via npm, cargo, etc.
  install([
    // Core tools
    "biome",
    "helix-gpt",

    // Language servers (available via package managers)
    "bash-language-server",
    "dockerfile-language-server-nodejs",
    "taplo",
    "yaml-language-server",

    // Formatters
    "prettier",
    "sql-formatter",
  ]),

  // Link helix config
  linkFile({
    source: source("config.toml"),
    target: userConfig("helix/config.toml"),
    force: true,
    description: "Link helix editor config",
  }),

  // Link languages config
  linkFile({
    source: source("languages.toml"),
    target: userConfig("helix/languages.toml"),
    force: true,
    description: "Link helix languages config",
  }),

  // Note: The following LSPs typically need manual installation:
  // - gopls, golangci-lint, golangci-lint-langserver (go install)
  // - typescript-language-server, vscode-langservers-extracted (npm install -g)
  // - rust-analyzer (rustup component add)
  // - python-lsp-server, python-lsp-ruff, ruff (pip install)
  // - tailwindcss-language-server (npm install -g)
  // - terraform-ls (install via terraform or package manager)
  // - marksman (Linux only, install separately)

  runCommand('echo "Note: Some language servers require manual installation. See mod.ts for details."', {
    description: "Display LSP installation note",
  }),
])
