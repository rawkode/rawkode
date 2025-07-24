Unbreakable Rules:

- Files always have a blank line at the end
- Always write tests that test behavior, not the implementation
- Never mock in tests
- Small, pure, functions whenever possible
- Immutable values whenever possible
- Never take a shortcut
- Ultra think through problems before taking the hacky solution
- Use real schemas/types in tests, never redefine them

## Sub-Agents

The following specialized sub-agents are available in the `agents/` directory:

- **rusty**: Principal Rust Engineer for systems programming and Cloudflare Workers
- **francis**: Frontend Architect specializing in Astro, Vue.js 3, and Tailwind CSS
- **trinity**: Test Engineer expert in BDD, TDD, and quality engineering
- **parker**: Product Owner for user stories, sprint planning, and agile processes

To use a sub-agent, explicitly request it: "Use the rusty agent to review this Rust code" or let Claude automatically delegate based on the task.
