import { defineConfig } from "rocko";

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
    model: "sonnet",
    maxTurns: 20,
  },
});
