# rawko runtime

Rivet actor runtime for manager/worker/council orchestration with native provider SDK adapters.

## Run

From repo root:

```bash
make dev
```

Or runtime only:

```bash
deno run -A --config runtime/deno.json runtime/src/main.ts --host 127.0.0.1 --port 8788 --no-stdin --no-prewarm
```

## HTTP API

- `GET /health`
- `GET /api/runtime/state`
- `GET /api/runtime/events` (SSE)
- `POST /api/runtime/objective` with `{ "text": "..." }`
- `POST /api/runtime/message` with `{ "text": "..." }`
- `POST /api/runtime/control/stop`

## Agent source

Runtime loads agents from:
- `./.rawko/agents/*.mdx`
- `<git-root>/.rawko/agents/*.mdx`

## Provider environment variables

- `provider=openai` uses Codex SDK local auth/session by default (no `OPENAI_API_KEY` required).
- `ANTHROPIC_API_KEY` is required only for `provider=anthropic`.
- Optional timeouts:
  - `RAWKO_OPENAI_TIMEOUT_MS`
  - `RAWKO_ANTHROPIC_TIMEOUT_MS`
  - `RAWKO_GITHUB_TIMEOUT_MS`
