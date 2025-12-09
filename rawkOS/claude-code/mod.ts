import { defineModule, install, linkFile, source, userPath } from "@rawkode/dhd"

export default defineModule({
  name: "claude-code",
  tags: ["ai", "cli-tools", "development"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("claude-code", { manager: "brew" }),
  linkFile({
    source: source("settings.json"),
    target: userPath(".claude/settings.json"),
    force: true,
    description: "Link Claude Code settings",
  }),
  linkFile({
    source: source("agents/multi-ai-consult.md"),
    target: userPath(".claude/agents/multi-ai-consult.md"),
    force: true,
    description: "Link multi-ai-consult agent",
  }),
])
