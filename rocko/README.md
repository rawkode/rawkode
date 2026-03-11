# rocko

Rocko is a [Mastra](https://mastra.ai/) project centered on a single `Executive Assistant` agent.

## Getting Started

Start the Mastra development server:

```shell
npm run dev
```

Open [http://localhost:4111](http://localhost:4111) in your browser to access [Mastra Studio](https://mastra.ai/docs/getting-started/studio). It provides an interactive UI for building and testing your agents, along with a REST API that exposes your Mastra application as a local service. This lets you start building without worrying about integration right away.

The active Mastra app for this repo lives under `src/mastra`. The development server will automatically reload whenever you make changes there.

## Agent

The active agents are:

- `Executive Assistant` on `openai/gpt-5.4`
- `News Reporter` on `openai/gpt-5.4`
- `CMO` on `openai/gpt-5.4`
- `CRO` on `openai/gpt-5.4`

They cover:

- operator support, planning, drafting, and follow-ups
- current infrastructure and developer-tooling news with live web search
- marketing strategy, messaging, and launch planning
- partner, sponsor, and revenue opportunity discovery

## Environment

Copy `.env.example` to `.env` and set:

- `ROCKO_AUTH_TOKEN`
- `OPENAI_API_KEY`

To make Google providers show up as authenticated in Mastra Studio, set either:

- `GOOGLE_GENERATIVE_AI_API_KEY`
- `GOOGLE_API_KEY`

The app normalizes those two Google env vars at startup, but `GOOGLE_GENERATIVE_AI_API_KEY` is the name Mastra Studio checks directly.

## Cloudflare Deploy

Use the Workers deploy script:

```shell
~/.bun/bin/bun run deploy:cloudflare
```

Required environment variables:

- `ROCKO_AUTH_TOKEN`
- `CLOUDFLARE_WORKER_NAME`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_D1_DATABASE_ID`
- `CLOUDFLARE_D1_DATABASE_NAME`
- `CLOUDFLARE_ZONE_NAME`
- `ROCKO_PUBLIC_URL`

Optional secrets forwarded to the worker if present:

- `OPENAI_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `GOOGLE_API_KEY`

This script deploys the Mastra backend and Mastra Studio together on Cloudflare Workers. The deployer writes a custom route into Wrangler config while disabling `workers.dev`, so the deployment has one public URL: `ROCKO_PUBLIC_URL`.

## Authentication

Mastra is configured with `SimpleAuth` for now.

- Built-in Mastra APIs require `Authorization: Bearer $ROCKO_AUTH_TOKEN`

Example:

```shell
curl https://<worker-url>/api/agents \
  -H "Authorization: Bearer $ROCKO_AUTH_TOKEN"
```

## Learn more

To learn more about Mastra, visit our [documentation](https://mastra.ai/docs/). Your bootstrapped project includes example code for [agents](https://mastra.ai/docs/agents/overview), [tools](https://mastra.ai/docs/agents/using-tools), [workflows](https://mastra.ai/docs/workflows/overview), [scorers](https://mastra.ai/docs/evals/overview), and [observability](https://mastra.ai/docs/observability/overview).

If you're new to AI agents, check out our [course](https://mastra.ai/course) and [YouTube videos](https://youtube.com/@mastra-ai). You can also join our [Discord](https://discord.gg/BTYqqHKUrf) community to get help and share your projects.
