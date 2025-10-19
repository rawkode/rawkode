---
theme: seriph
title: "Extreme Microservices: One Service Per Database Column with GraphQL Federation"
class: text-left
css: ./styles.css
mdc: true
transition: slide-left
drawings:
  persist: false
info: |
  ## Extreme Microservices: One Service Per Database Column with GraphQL Federation

  How far can we push microservice decomposition? In this talk, we explore a provocative architecture: a dedicated microservice per database column. Absurd? Maybe. Insightful? Definitely. We use GraphQL Federation to compose dozens of column services into a clean, unified API — unlocking independent scaling, fine‑grained permissions, and rapid parallel development.

  You’ll see the architecture pattern, performance/caching strategies, and a live demo adding a brand‑new column by deploying a new service that automatically joins the federated graph — all without touching existing services.

  Speaker: David Flanagan / rawkode

  Slides built with Slidev, styled with Rawkode Academy branding.
---

layout: cover
class: cover-center

<div class="grid-two items-center">
  <div>
    <div class="brand-pill">Rawkode Academy</div>
    <h1 class="mt-2 brand-gradient-text">Extreme Microservices</h1>
    <p class="text-2xl opacity-80">One Service Per Database Column with GraphQL Federation</p>
    <div class="mt-6 opacity-80">
      <div><strong>David Flanagan</strong> / <strong>@rawkode</strong></div>
      <div class="text-sm">rawkode.academy</div>
    </div>
    <hr class="brand-hr mt-6" />
    <div class="mt-2 text-sm opacity-70">Slides: this repo • Built with Slidev</div>
  </div>
  <div class="flex justify-center">
    <img src="/brand/icon-gradient.svg" alt="Rawkode Academy" class="w-52 h-52" />
  </div>
</div>

---

# The Problem: Evolving a “Simple” User Service

Microservices should be simple, but change is constant.

- Today’s User service owns: `name`, `email`, `password`
- New requirements: `website`, `biography`, OAuth authentication
- Goals: small blast radius, independent teams, zero/near‑zero downtime

We have three ways forward. Each has trade‑offs.

---

# Option 1 — Extend the Existing Service (SQL migrations)

Pros
- Single codebase and DB — fewer moving parts
- Strong transactional guarantees inside one service
- Fastest path if scope is tiny and team is one

Cons
- Grows a “micro” into a mini‑monolith; tighter coupling
- Cross‑team contention on one repo/pipeline/release
- Risky deploys: schema + code must land together
- Harder to apply field‑level permissions and SLOs

---

# Option 2 — Rewrite & Migrate (Strangler/Extraction)

Pros
- Clean break to better boundaries and schema
- Opportunity to pay down tech debt and redesign storage
- Can move traffic gradually (feature flags, dual‑writes)

Cons
- Expensive and slow; long migration tail/backfills
- Complex consistency (dual‑write, replay, idempotency)
- Risk of freeze while rewriting; user impact if misplanned

---

# Option 3 — Extend via Federation (New Field Services)

Pros
- Keep “User Core” small (id, auth-critical), add field services: `website`, `biography`, `oauth`
- Independent repos, pipelines, deploys, and SLOs per field
- Fine‑grained permissions and cache hints per field
- No edits to existing services; router composes one API

Cons
- More services to observe and operate; network hops
- Requires schema governance and clear ownership by `@key`
- Cross‑field transactions need workflows/events instead of ACID

---

# A Genuinely Useful Query

What a product team actually needs from the API:

```graphql
query GetUserProfile($id: ID!) {
  user(id: $id) {
    id            # key (Core)
    name          # column service
    email         # column service
    nickname      # column service
    avatarUrl     # column service
    bio           # column service
  }
}
```

Goal: fetch many user-facing fields in one round-trip, without coupling teams or databases.

---

# How The Router Resolves It — Step 1

- Client sends one query to the router (supergraph endpoint)
- Router parses query and builds a plan against the federated schema

<FederationDiagram :stage="1" />

---

# Step 2 — Resolve Entity by Key

- Router sends a representation for `User(id)` to the owning subgraph
- Core service returns the base entity (just the key + minimal shape)

<FederationDiagram :stage="2" />

---

# Step 3 — Fan Out for Additional Fields

- Router fans out to services that own `email`, `nickname`, `avatarUrl`, `bio`, `name`
- Calls execute in parallel where possible; results are stitched by `id`

<FederationDiagram :stage="3" />

---

# Step 4 — Stitch and Return

- Router combines fields from all subgraphs into one response
- Optional caching at router and field levels reduces latency

<FederationDiagram :stage="4" />

---

# GraphQL Federation — Visual Overview

<FederationDiagram />

Key idea: the router uses an entity’s federation key (e.g., `id`) to fan out to subgraphs that each own a slice of the data — even a single column — and then stitches one response for the client.

---

# Why Go So Small?

- Sharper service boundaries by forcing explicit ownership at the field level
- Security as a first‑class concern with field‑level permissions
- Team autonomy: separate repos, pipelines, and SLAs per field
- Platform thinking: compose capabilities instead of coupling features

Note: We’ll push to the extreme (a service per column) to expose trade‑offs and patterns you can use at sane scales.

---

# The Premise

- Each database column is owned by exactly one microservice
- Each service has its own storage (D1/SQLite), schema, and lifecycle
- GraphQL Federation composes fields into coherent product APIs
- The router (e.g., Apollo/Cosmo) handles query planning and parallelism

Result: A unified graph users love; independent services teams love.

---

# Service Anatomy (Column‑Scale)

- Data model: minimal table keyed by an entity id + the column value
- Read model: GraphQL subgraph exposing the field, federated on `id`
- Write model: Hono/Workflows for mutations, validations, and side‑effects
- Observability: per‑field metrics, errors, and SLOs

Pattern aligns with Rawkode Academy platform services.

---

# Federation: Stitching Columns into Entities

GraphQL Federation lets each service “extend” a shared entity like `User`:

```graphql
extend type User @key(fields: "id") {
  id: ID! @external
  email: String
}
```

Query planner composes many fields from many services into one response, in parallel where possible.

---

# Pothos + Apollo Subgraph (Example)

```ts
// read-model/schema.ts
import SchemaBuilder from '@pothos/core'
import federationPlugin from '@pothos/plugin-federation'
import drizzlePlugin from '@pothos/plugin-drizzle'
import { drizzle } from 'drizzle-orm/d1'
import * as data from '../data-model/schema'

export const getSchema = (env: Env) => {
  const db = drizzle(env.DB, { schema: data })
  const builder = new SchemaBuilder({
    plugins: [federationPlugin, drizzlePlugin],
    drizzle: { client: db, schema: data },
  })

  const UserRef = builder.externalRef('User', builder.selection<{ id: string }>('id'))
    .implement({ externalFields: t => ({ id: t.id() }), fields: t => ({
      email: t.string({
        resolve: async (user) => {
          const row = await db.query.userEmailTable.findFirst({
            where: (tbl, { eq }) => eq(tbl.id, user.id),
          })
          return row?.email ?? null
        },
      })
    }) })

  return builder.toSubGraphSchema({ linkUrl: 'https://specs.apollo.dev/federation/v2.6' })
}
```

---

# Data Model (Column Service)

```ts
// data-model/schema.ts
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { createId } from '@paralleldrive/cuid2'

export const userEmailTable = sqliteTable('user_email', {
  id: text('id').primaryKey().$default(createId),
  email: text('email').notNull(),
})
```

Each service only knows about its own column and the entity key.

---

# Architecture at a Glance

- Column service owns: storage, schema, API, and policies for one field
- Entity identity (`id`) is the federation key across services
- Router composes fields, enforces persisted queries and caching
- Clients query product‑centric shapes while teams remain decoupled

---

# Real‑World Benefits

- Independent scaling per hot field (e.g., `avatar`, `bio`, `email`)
- Fine‑grained permissions and auditability per field
- Safer deploys: small blast radius and clear ownership
- Parallel development across many teams with minimal merge conflicts

---

# Performance & Caching

- Router‑level full‑response and field‑level caching
- Subgraph dataloaders and batching for hot keys
- Persisted queries and cache hints per field
- Background hydration for expensive fields

Trade‑off: too many network hops if you cross fields frequently — co‑locate when necessary.

---

# Demo: Add a New Column via a New Service

Goal: Add `nickname` to `User` without touching existing services.

Plan:
1) Scaffold `user-nickname` service (data, read, write)
2) Add D1 table `user_nickname(id, nickname)`
3) Extend `User` in subgraph: expose `nickname`
4) Publish subgraph SDL
5) Router picks up schema; clients query `user { id nickname }`

---

# Why Federation for Read Models in Microservices

- Clear ownership: each team owns the fields it ships (even 1 column)
- Unified API: one endpoint, product-shaped queries, zero client coupling
- Decouple reads from writes: read models are composable, write models remain autonomous
- Performance controls: router-level caching, persisted queries, batched entity resolution
- Security & governance: field-level auth, schema checks, and change control
- Org scale: independent deploys, SLAs, and on-call per field/team

---

# Alternatives vs Federation (Trade-offs)

- REST aggregator/BFF
  - + Simple infra; – hard to scale teams; bespoke stitching logic per aggregator
- Monolithic GraphQL server
  - + Single schema; – shared ownership bottlenecks; risky deploys; coupling to one runtime
- API gateway with REST/JSON
  - + Mature; – response shaping remains bespoke; hard to evolve schema-first clients

Federation gives a schema-first composition model with a query planner, so teams own fields while clients keep one mental model.

---

# Demo Snippets (from RA patterns)

```bash
mkdir -p platform/user-nickname/{data-model,read-model}
```

```ts
// read-model/schema.ts (excerpt)
const User = builder.externalRef('User', builder.selection<{ id: string }>('id'))
  .implement({ externalFields: t => ({ id: t.id() }), fields: t => ({
    nickname: t.string({ resolve: async (u) => /* load from D1 */ null }),
  }) })
```

Router composition updates, and the field appears instantly in the supergraph.

---

# When Not To Go This Far

- Strong cross‑field invariants requiring transactions
- Tight coupling between fields (compute or latency)
- Simpler teams/product scope — avoid accidental complexity

Use this extreme as a lens; then dial back to the right granularity.

---

# Pitfalls & Mitigations

- N+1 at the router — use dataloaders, cache hints
- Schema bloat — adopt naming and ownership conventions
- Cross‑field validation — async workflows, domain events
- Observability — field‑level logs, traces, SLOs per service

---

# Practical Compromises

- One service per logical attribute group (e.g., profile, security)
- Keep the same federation/entity patterns
- Preserve independent deploy, caching, and ownership

---

# Table of Contents

<Toc maxDepth="2" />

---

# Q&A

Thanks!
• rawkode.academy
• github.com/RawkodeAcademy
• @rawkode
