package claudecode

import "github.com/rawkode/rawkcue/schema"

"claude-code": schema.#Module & {
	name: "claude-code"
	tags: ["ai", "cli-tools", "development"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "claude-code", brew: "claude-code"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "settings.json"}
			target:      {kind: "User", path: ".claude/settings.json"}
			force:       true
			description: "Link Claude Code settings"
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "agents/multi-ai-consult.md"}
			target:      {kind: "User", path: ".claude/agents/multi-ai-consult.md"}
			force:       true
			description: "Link multi-ai-consult agent"
		},
	]
}
