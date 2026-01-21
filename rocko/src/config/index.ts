import { join } from "path";
import { RockoConfigSchema, type RockoConfig } from "./schema.ts";

const CONFIG_FILES = [
  "rocko.config.ts",
  "rocko.config.js",
  "rocko.config.mjs",
];

export async function findConfig(cwd: string = process.cwd()): Promise<string | null> {
  for (const filename of CONFIG_FILES) {
    const configPath = join(cwd, filename);
    const file = Bun.file(configPath);
    if (await file.exists()) {
      return configPath;
    }
  }
  return null;
}

export async function loadConfig(cwd: string = process.cwd()): Promise<RockoConfig> {
  const configPath = await findConfig(cwd);

  if (!configPath) {
    throw new Error(
      "No rocko.config.ts found. Run `rocko init` to create one."
    );
  }

  const configModule = await import(configPath);
  const rawConfig = configModule.default ?? configModule;

  return RockoConfigSchema.parse(rawConfig);
}

export function defineConfig(config: RockoConfig): RockoConfig {
  return RockoConfigSchema.parse(config);
}

export const CONFIG_TEMPLATE = `import { defineConfig } from "rocko";

export default defineConfig({
  adapter: {
    type: "markdown",
    path: "TASKS.md",
  },
  maxIterations: 5,
  git: {
    autoCommit: true,
    commitPrefix: "rocko:",
  },
  github: {
    addComments: true,
    updateLabels: true,
    closeOnComplete: true,
  },
  ai: {
    model: "claude-sonnet-4-20250514",
    maxTurns: 20,
  },
});
`;

export const GITHUB_CONFIG_TEMPLATE = `import { defineConfig } from "rocko";

export default defineConfig({
  adapter: {
    type: "github-issues",
    owner: "YOUR_USERNAME",
    repo: "YOUR_REPO",
    labels: ["rocko"],
    aiSelectsIssue: true,
  },
  maxIterations: 5,
  git: {
    autoCommit: true,
    commitPrefix: "rocko:",
  },
  github: {
    addComments: true,
    updateLabels: true,
    closeOnComplete: true,
  },
  ai: {
    model: "claude-sonnet-4-20250514",
    maxTurns: 20,
  },
});
`;

export * from "./schema.ts";
