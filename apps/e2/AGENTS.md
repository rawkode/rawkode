# e2 conventions

- Use functional modules, arrow functions, and explicit dependencies. Prefer
  immutable transformations. Keep state at the boundary that owns it.
- Keep classes only for framework requirements such as Cloudflare entrypoints,
  Durable Objects, RPC targets, and typed errors. Put business logic in
  factories and functions; runtime adapters should delegate through prototype
  methods.
- Each Worker owns its deployment in its own `alchemy.ts`, including bindings,
  migrations, secrets, and schedules. The root `alchemy.run.ts` only composes
  them.
- Define database schemas in each Worker's `schema.ts`; use Drizzle Kit to
  generate its `migrations/` directory and keep SQL plus snapshots together.
  Alchemy applies OAuth D1 migrations; Google bundles generated migrations for
  transactional application within each account DO. Do not use Drizzle
  push/migrate or hand-edit generated artifacts.
- Declare generated secrets in the owning Worker's deployment and bind them
  through Cloudflare Secrets Store. Keep stable random resource IDs and retain
  old encryption keys during rotation; do not duplicate secret values in `.env`.
- Manage Cloudflare deployments and migrations through Alchemy v2. Use Deno for
  workspace dependency management, checks, formatting, and tests; Alchemy's CLI
  and its Worker runtime tooling run under Node.
- OAuth owns credentials, encrypted tokens, provider authorization, and service
  grants. Integration Workers request access through the named OAuth binding.
- Keep admin RPC entrypoints private. Only trusted callers may assert an owner.
