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

### Core Development

- **rust**: Rust & Cloudflare Workers specialist
- **frontend**: Frontend Architect (Astro, Vue.js, Tailwind CSS)
- **typescript-backend**: Node.js backend development (Express, Fastify, NestJS)
- **fullstack**: Full-stack TypeScript (Next.js, Remix, SvelteKit)
- **cloudflare-workers**: Edge computing with Workers, KV, Durable Objects

### Quality & Process

- **testing**: Test Engineer & QA (BDD, TDD, quality engineering)
- **product**: Product Owner (user stories, sprint planning, agile)

### Infrastructure & DevOps

- **docker**: Containerization & Docker Compose
- **ci-cd**: GitHub Actions, GitLab CI, deployment pipelines
- **nix-packages**: Nix flakes, derivations, reproducible builds

To use a sub-agent, explicitly request it: "Use the rust agent to review this Rust code" or let Claude automatically delegate based on the task.
