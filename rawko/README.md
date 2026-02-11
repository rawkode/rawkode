# rawko

Run the Astro UI and Rivet runtime together:

```bash
just dev
```

Default endpoints:
- Web UI: `http://127.0.0.1:4321`
- Runtime API: `http://127.0.0.1:8788`

The repository includes a starter agent set in `.rawko/agents/`.

## Environment

Default starter agents use:
- Manager: `provider=openai` (model `gpt-5`) with `anthropic` fallback.
- Workers/Council: `provider=openai` through the Codex SDK and your local Codex auth session.

Manager provider policy:
- Manager routes are restricted to `openai` and `anthropic` so structured decision output is available.

If you add routes for other providers:
- `provider=anthropic` requires `ANTHROPIC_API_KEY` for the Anthropic SDK adapter.
- `provider=github` uses GitHub Copilot SDK auth (logged-in user or token).

You can override hosts/ports:

```bash
RAWKO_RUNTIME_HOST=127.0.0.1 RAWKO_RUNTIME_PORT=8788 WEB_HOST=127.0.0.1 WEB_PORT=4321 just dev
```

Tip: `just` is configured so that running `just` with no arguments also runs `dev` (the default recipe).

Useful runtime timeout override:
- `RAWKO_OPENAI_TIMEOUT_MS` (Codex SDK invoke timeout; default is effectively unbounded)
