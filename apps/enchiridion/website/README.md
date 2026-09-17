# Enchiridion website

Astro website and admin interface, deployed as a Cloudflare Worker. OAuth credentials belong to `../services/oauth`; synced calendar events belong to `../services/google-calendar`.

Run `bun install` and `bun dev` from the Enchiridion root to start all three services and the local test provider. Open http://localhost:4321/admin/oauth. See the [workspace README](../README.md) for real Google testing, RPC contracts, verification, and deployment.

The website can be managed independently from this directory:

```sh
bun run dev
bun run astro dev status
bun run astro dev logs
bun run astro dev stop
```

OAuth and Calendar must also be running for admin operations. All scripts use Bun.
