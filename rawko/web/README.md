# rawko web

Astro + Vue + Ark UI frontend for manager chat and live agent task visibility.

## Development

From repo root:

```bash
make dev
```

Or run only the web app:

```bash
cd web
PUBLIC_RUNTIME_URL=http://127.0.0.1:8788 deno task dev
```

## Runtime endpoint

The UI reads runtime data from `PUBLIC_RUNTIME_URL` and defaults to:

- `http://127.0.0.1:8788`
