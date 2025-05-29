import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("claude")
  .description("Claude AI CLI")
  .tags("cli", "ai", "development")
  .packageInstall({
    manager: "bun",
    packages: ["@anthropic-ai/claude-code"],
  })
  .build();
