---
theme: seriph
title: "Extreme Microservices"
mdc: true
transition: view-transition
drawings:
  persist: false
layout: cover
class: cover-center
---

<div class="grid-two items-center">
  <div>
    <div class="brand-pill">Rawkode Academy</div>
    <h1 class="mt-2 brand-gradient-text inline-block view-transition-title">Extreme Microservices</h1>
    <div class="mt-6 opacity-80">
      <div><strong>David Flanagan</strong> / <strong>@rawkode.dev</strong> 🦋 </div>
      <div class="text-sm">//rawkode.academy</div>
    </div>
    <hr class="brand-hr mt-6" />
  </div>
  <div class="flex justify-center">
    <img src="/brand/icon-gradient.svg" alt="Rawkode Academy" class="w-52 h-52" />
  </div>
 </div>

---
layout: center
class: text-center
---

<h1 class="brand-gradient-text text-6xl inline-block view-transition-title">1 Service === 1 Column</h1>

---
layout: image
image: https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExNGVxeGg2dWNoMGExNWl3bHo3Y3Z5NnhpdzNtMzRqZWplYmtjdjZxMCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/jN86rcdOyrpyo/giphy.gif
---

---
layout: center
class: text-left
---

<div class="grid-two items-center">
  <div>
    <div class="brand-pill">Speaker</div>
    <h1 class="mt-2 brand-gradient-text">David Flanagan</h1>
    <p class="text-xl opacity-90">Founder, Rawkode Academy</p>
    <div class="mt-4 text-lg opacity-90">
      <div><strong>@rawkode</strong></div>
      <div>rawkode.academy</div>
      <div>github.com/Rawkode • github.com/RawkodeAcademy</div>
    </div>
  </div>
  <div class="flex justify-center">
    <img src="/brand/icon-gradient.svg" alt="Rawkode Academy" class="w-40 h-40" />
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Traditional Microservices</div>
<h2 class="mt-2 brand-gradient-text">BitHub — Service Boundaries</h2>
<div class="grid grid-cols-3 gap-4 mt-4">
  <div class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
    <div class="font-semibold">Issues Service</div>
    <ul class="text-sm mt-1 leading-relaxed">
      <li>id (PK)</li>
      <li>authorId (FK)</li>
      <li>title, body</li>
      <li>state</li>
      <li>createdAt, updatedAt, closedAt</li>
    </ul>
  </div>
  <div class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
    <div class="font-semibold">Comments Service</div>
    <ul class="text-sm mt-1 leading-relaxed">
      <li>id (PK)</li>
      <li>issueId (FK), authorId (FK)</li>
      <li>body</li>
      <li>createdAt, updatedAt</li>
    </ul>
  </div>
  <div class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5 view-transition-projects">
    <div class="font-semibold">Projects Service</div>
    <ul class="text-sm mt-1 leading-relaxed">
      <li>id (PK)</li>
      <li>name, description</li>
      <li>createdAt, updatedAt</li>
      <li>projectIssues (project_id, issue_id)</li>
    </ul>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Question</div>
<h2 class="mt-2 brand-gradient-text view-transition-title">What is the status of the project?</h2>

<div class="mt-6 p-5 rounded-lg ring-1 ring-white/15 bg-white/5 w-96 view-transition-projects">
  <div class="font-semibold">Projects Service</div>
  <ul class="text-sm mt-1 leading-relaxed">
    <li>id (PK)</li>
    <li>name, description</li>
    <li>createdAt, updatedAt</li>
    <li>projectIssues (project_id, issue_id)</li>
    <li>status <span class="ml-2 px-2 py-0.5 rounded-full text-xs bg-emerald-500/15 text-emerald-300 border border-emerald-400/30 align-middle">NEW</span></li>
  </ul>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Schema Evolution</div>
<h2 class="mt-2 brand-gradient-text">Extending Schemas in Microservices</h2>

<div class="mt-8 text-center">
  <div class="text-2xl font-semibold text-emerald-400">Add New Column</div>
  <p class="text-xl mt-4 opacity-90">ALTER TABLE projects ADD COLUMN status VARCHAR(50)</p>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Challenge</div>
<h2 class="mt-2 brand-gradient-text">Table Locks During Schema Changes</h2>

<div class="mt-6 grid grid-cols-2 gap-6">
  <div class="p-4 rounded-lg ring-1 ring-orange-500/30 bg-orange-500/10">
    <div class="text-lg font-semibold text-orange-400">MySQL / InnoDB</div>
    <ul class="mt-3 text-sm space-y-2 opacity-90">
      <li>• Table rebuild locks writes</li>
      <li>• MySQL 8.0+ "instant ADD COLUMN":</li>
      <li class="ml-4">✓ Column at end of table</li>
      <li class="ml-4">✓ Default NULL or constant</li>
      <li class="ml-4">✓ No constraints/generated</li>
      <li>• Otherwise: blocking DDL</li>
    </ul>
  </div>

  <div class="p-4 rounded-lg ring-1 ring-blue-500/30 bg-blue-500/10">
    <div class="text-lg font-semibold text-blue-400">PostgreSQL</div>
    <ul class="mt-3 text-sm space-y-2 opacity-90">
      <li>• NULL default: fast, non-blocking</li>
      <li class="ml-4">Just updates metadata</li>
      <li>• Non-NULL default: table rewrite</li>
      <li class="ml-4">ACCESS EXCLUSIVE LOCK</li>
      <li class="ml-4">I/O cost ∝ table size</li>
      <li>• Type/constraint changes: blocking</li>
    </ul>
  </div>
</div>

<div class="mt-6 p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
  <div class="text-base font-semibold text-red-400">Summary</div>
  <div class="mt-2 text-sm opacity-90">
    <strong>MySQL:</strong> Blocking unless "instant" conditions met &nbsp;|&nbsp;
    <strong>PostgreSQL:</strong> Safe if default NULL, blocking if non-NULL
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Challenge</div>
<h2 class="mt-2 brand-gradient-text">Complex Schema Changes</h2>

<div class="mt-6 grid grid-cols-2 gap-4">
  <div class="p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
    <div class="font-semibold text-red-400">❌ Renaming Columns</div>
    <p class="text-sm mt-1 opacity-90">Old code breaks immediately</p>
    <p class="text-xs mt-1 opacity-70">Requires dual-write strategy</p>
  </div>

  <div class="p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
    <div class="font-semibold text-red-400">❌ Changing Column Types</div>
    <p class="text-sm mt-1 opacity-90">Full table rewrite + locks</p>
    <p class="text-xs mt-1 opacity-70">VARCHAR → INT blocks access</p>
  </div>

  <div class="p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
    <div class="font-semibold text-red-400">❌ Removing Columns</div>
    <p class="text-sm mt-1 opacity-90">Multi-phase deployment needed</p>
    <p class="text-xs mt-1 opacity-70">All services must stop reading first</p>
  </div>

  <div class="p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
    <div class="font-semibold text-red-400">❌ Adding Constraints</div>
    <p class="text-sm mt-1 opacity-90">Validation scan + table lock</p>
    <p class="text-xs mt-1 opacity-70">NOT NULL, UNIQUE, FOREIGN KEY</p>
  </div>
</div>

<div class="mt-6 text-center text-lg opacity-90">
  <strong>Result:</strong> Minutes to hours of downtime on large tables
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Solution</div>
<h2 class="mt-2 brand-gradient-text">What If Status Was Its Own Microservice?</h2>

<div class="mt-6 grid grid-cols-2 gap-6 items-start">
  <div class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
    <div class="font-semibold text-gray-400">Projects Service (Unchanged)</div>
    <ul class="text-sm mt-2 leading-relaxed">
      <li>id (PK)</li>
      <li>name, description</li>
      <li>createdAt, updatedAt</li>
      <li>projectIssues (project_id, issue_id)</li>
    </ul>
  </div>

  <div class="p-4 rounded-lg ring-1 ring-emerald-500/30 bg-emerald-500/10">
    <div class="font-semibold text-emerald-400">Project Status Service (NEW)</div>
    <ul class="text-sm mt-2 leading-relaxed">
      <li>projectId (PK, FK)</li>
      <li>status</li>
      <li>updatedAt</li>
    </ul>
  </div>
</div>

<div class="mt-8 space-y-3">
  <div class="flex items-center gap-3">
    <div class="text-emerald-400 text-xl">✓</div>
    <div class="text-sm opacity-90">No schema migration on existing Projects table</div>
  </div>
  <div class="flex items-center gap-3">
    <div class="text-emerald-400 text-xl">✓</div>
    <div class="text-sm opacity-90">Zero downtime deployment</div>
  </div>
  <div class="flex items-center gap-3">
    <div class="text-emerald-400 text-xl">✓</div>
    <div class="text-sm opacity-90">Independent scaling and deployment</div>
  </div>
</div>

---
layout: center
class: text-center
---

<h1 class="brand-gradient-text text-6xl inline-block view-transition-title">GraphQL Federation</h1>

<p class="mt-6 text-2xl opacity-80">Extending Microservices, Correctly</p>

---
layout: center
class: text-left
---

<div class="brand-pill">Architecture</div>
<h2 class="mt-2 brand-gradient-text">Many Column Services → GraphQL Subgraphs</h2>

<div class="mt-6">
  <FederationDiagram />
</div>

<div class="mt-6 text-center text-sm opacity-80">
  Each service owns a subset of columns and exposes them as a GraphQL subgraph
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Federation Directives</div>
<h2 class="mt-2 brand-gradient-text">@key — Define Entity Identity</h2>

<div class="mt-8">
  <div class="p-6 rounded-lg ring-1 ring-blue-500/30 bg-blue-500/10">
    <div class="text-lg font-semibold text-blue-400 mb-4">Projects Service</div>
    <pre class="text-base opacity-90"><code>type Project @key(fields: "id") {
  id: ID!
  name: String!
  description: String
  createdAt: DateTime!
}</code></pre>
  </div>
</div>

<div class="mt-8 space-y-3">
  <div class="flex items-start gap-3">
    <div class="text-blue-400 text-xl">•</div>
    <div class="text-base opacity-90">Marks <code>Project</code> as a federated entity</div>
  </div>
  <div class="flex items-start gap-3">
    <div class="text-blue-400 text-xl">•</div>
    <div class="text-base opacity-90">The <code>id</code> field is the unique identifier</div>
  </div>
  <div class="flex items-start gap-3">
    <div class="text-blue-400 text-xl">•</div>
    <div class="text-base opacity-90">Other services can extend this entity using the same key</div>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Federation Directives</div>
<h2 class="mt-2 brand-gradient-text">@requires — Declare Field Dependencies</h2>

<div class="mt-8">
  <div class="p-6 rounded-lg ring-1 ring-purple-500/30 bg-purple-500/10">
    <div class="text-lg font-semibold text-purple-400 mb-4">Status Service</div>
    <pre class="text-base opacity-90"><code>extend type Project @key(fields: "id") {
  id: ID! @external
  status: String! @requires(fields: "id")
  updatedAt: DateTime!
}</code></pre>
  </div>
</div>

<div class="mt-8 space-y-3">
  <div class="flex items-start gap-3">
    <div class="text-purple-400 text-xl">•</div>
    <div class="text-base opacity-90"><code>@external</code> marks fields this service doesn't own</div>
  </div>
  <div class="flex items-start gap-3">
    <div class="text-purple-400 text-xl">•</div>
    <div class="text-base opacity-90"><code>@requires</code> declares what fields are needed to resolve <code>status</code></div>
  </div>
  <div class="flex items-start gap-3">
    <div class="text-purple-400 text-xl">•</div>
    <div class="text-base opacity-90">Router ensures required fields are fetched first</div>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Federation Directives</div>
<h2 class="mt-2 brand-gradient-text">@provides — Optimize Data Fetching</h2>

<div class="mt-8">
  <div class="p-6 rounded-lg ring-1 ring-emerald-500/30 bg-emerald-500/10">
    <div class="text-lg font-semibold text-emerald-400 mb-4">Projects Service Query</div>
    <pre class="text-base opacity-90"><code>type Query {
  project(id: ID!): Project @provides(fields: "status")
  projects: [Project!]!
}</code></pre>
  </div>
</div>

<div class="mt-8 space-y-3">
  <div class="flex items-start gap-3">
    <div class="text-emerald-400 text-xl">•</div>
    <div class="text-base opacity-90">Hints that this resolver can return <code>status</code> field</div>
  </div>
  <div class="flex items-start gap-3">
    <div class="text-emerald-400 text-xl">•</div>
    <div class="text-base opacity-90">Reduces roundtrips by fetching from a single service</div>
  </div>
  <div class="flex items-start gap-3">
    <div class="text-emerald-400 text-xl">•</div>
    <div class="text-base opacity-90">Optional optimization — not required for federation</div>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Router Workflow</div>
<h2 class="mt-2 brand-gradient-text">How Federation Stitches It Together</h2>

<div class="mt-6 space-y-4">
  <div class="flex items-start gap-4">
    <div class="flex-shrink-0 w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400 font-semibold">1</div>
    <div>
      <div class="font-semibold">Client Query → Router</div>
      <p class="text-sm opacity-80 mt-1">GraphQL query requests project with status</p>
    </div>
  </div>

  <div class="flex items-start gap-4">
    <div class="flex-shrink-0 w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center text-purple-400 font-semibold">2</div>
    <div>
      <div class="font-semibold">Query Planning</div>
      <p class="text-sm opacity-80 mt-1">Router analyzes schema, determines which services to call</p>
    </div>
  </div>

  <div class="flex items-start gap-4">
    <div class="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 font-semibold">3</div>
    <div>
      <div class="font-semibold">Entity Resolution</div>
      <p class="text-sm opacity-80 mt-1">Projects Service returns base data, Status Service extends with status field</p>
    </div>
  </div>

  <div class="flex items-start gap-4">
    <div class="flex-shrink-0 w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center text-orange-400 font-semibold">4</div>
    <div>
      <div class="font-semibold">Response Composition</div>
      <p class="text-sm opacity-80 mt-1">Router merges results into single unified response</p>
    </div>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Benefits</div>
<h2 class="mt-2 brand-gradient-text">Independence, Caching, Fault Boundaries</h2>

<div class="mt-6 grid grid-cols-3 gap-4">
  <div class="p-4 rounded-lg ring-1 ring-blue-500/30 bg-blue-500/10">
    <div class="text-2xl mb-2">🔄</div>
    <div class="font-semibold text-blue-400">Independence</div>
    <ul class="text-sm mt-2 space-y-1 opacity-90">
      <li>• Deploy separately</li>
      <li>• Scale independently</li>
      <li>• Own schemas</li>
    </ul>
  </div>

  <div class="p-4 rounded-lg ring-1 ring-purple-500/30 bg-purple-500/10">
    <div class="text-2xl mb-2">⚡</div>
    <div class="font-semibold text-purple-400">Caching</div>
    <ul class="text-sm mt-2 space-y-1 opacity-90">
      <li>• Router-level cache</li>
      <li>• Entity-level cache</li>
      <li>• Per-service cache</li>
    </ul>
  </div>

  <div class="p-4 rounded-lg ring-1 ring-emerald-500/30 bg-emerald-500/10">
    <div class="text-2xl mb-2">🛡️</div>
    <div class="font-semibold text-emerald-400">Fault Boundaries</div>
    <ul class="text-sm mt-2 space-y-1 opacity-90">
      <li>• Partial responses</li>
      <li>• Graceful degradation</li>
      <li>• Service isolation</li>
    </ul>
  </div>
</div>

<div class="mt-6 p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
  <p class="text-sm opacity-90">
    <strong>Key Point:</strong> Status service failure doesn't bring down project data
  </p>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Request Flow</div>
<h2 class="mt-2 brand-gradient-text">Router → Resolver → Cache</h2>

<div class="mt-6">
  <div class="flex items-center justify-between gap-4">
    <div class="flex-1 p-4 rounded-lg ring-1 ring-blue-500/30 bg-blue-500/10 text-center">
      <div class="font-semibold text-blue-400">Client</div>
      <div class="text-xs mt-1 opacity-70">GraphQL Query</div>
    </div>
    <div class="text-2xl opacity-50">→</div>
    <div class="flex-1 p-4 rounded-lg ring-1 ring-purple-500/30 bg-purple-500/10 text-center">
      <div class="font-semibold text-purple-400">Router</div>
      <div class="text-xs mt-1 opacity-70">Query Planning</div>
    </div>
    <div class="text-2xl opacity-50">→</div>
    <div class="flex-1 p-4 rounded-lg ring-1 ring-emerald-500/30 bg-emerald-500/10 text-center">
      <div class="font-semibold text-emerald-400">Cache</div>
      <div class="text-xs mt-1 opacity-70">Check Cache</div>
    </div>
  </div>

  <div class="mt-6 flex items-center justify-between gap-4">
    <div class="flex-1 p-4 rounded-lg ring-1 ring-orange-500/30 bg-orange-500/10 text-center">
      <div class="font-semibold text-orange-400">Projects Service</div>
      <div class="text-xs mt-1 opacity-70">Resolve Entity</div>
    </div>
    <div class="text-2xl opacity-50">+</div>
    <div class="flex-1 p-4 rounded-lg ring-1 ring-orange-500/30 bg-orange-500/10 text-center">
      <div class="font-semibold text-orange-400">Status Service</div>
      <div class="text-xs mt-1 opacity-70">Extend Entity</div>
    </div>
  </div>

  <div class="mt-6 text-center">
    <div class="text-2xl opacity-50">↓</div>
    <div class="mt-4 p-4 rounded-lg ring-1 ring-blue-500/30 bg-blue-500/10 inline-block">
      <div class="font-semibold text-blue-400">Unified Response</div>
      <div class="text-xs mt-1 opacity-70">Merged data back to client</div>
    </div>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Operational Realities</div>
<h2 class="mt-2 brand-gradient-text">Caching Tiers</h2>

<div class="mt-6 space-y-4">
  <div class="p-4 rounded-lg ring-1 ring-blue-500/30 bg-blue-500/10">
    <div class="font-semibold text-blue-400">Router-Level Cache</div>
    <p class="text-sm mt-2 opacity-90">Cache entire query results and entity resolutions</p>
    <p class="text-xs mt-1 opacity-70">Reduces calls to downstream services</p>
  </div>

  <div class="p-4 rounded-lg ring-1 ring-purple-500/30 bg-purple-500/10">
    <div class="font-semibold text-purple-400">CDN Cache</div>
    <p class="text-sm mt-2 opacity-90">Edge caching for public GraphQL queries</p>
    <p class="text-xs mt-1 opacity-70">Serve responses from closest geographic location</p>
  </div>

  <div class="p-4 rounded-lg ring-1 ring-emerald-500/30 bg-emerald-500/10">
    <div class="font-semibold text-emerald-400">Service-Local Cache</div>
    <p class="text-sm mt-2 opacity-90">Each column service caches its own data</p>
    <p class="text-xs mt-1 opacity-70">Redis, in-memory, or database query cache</p>
  </div>
</div>

<div class="mt-6 text-center text-sm opacity-80">
  Multi-tier caching dramatically reduces latency overhead
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Operational Realities</div>
<h2 class="mt-2 brand-gradient-text">Independent Scaling & Security</h2>

<div class="mt-6 grid grid-cols-2 gap-6">
  <div>
    <div class="p-4 rounded-lg ring-1 ring-blue-500/30 bg-blue-500/10">
      <div class="font-semibold text-blue-400 mb-3">🔄 Independent Scaling</div>
      <ul class="text-sm space-y-2 opacity-90">
        <li>• Hot column? Scale just that service</li>
        <li>• Status service under load? Add replicas</li>
        <li>• Core project data stable? Keep 2 instances</li>
        <li>• Autoscale based on per-service metrics</li>
      </ul>
    </div>
  </div>

  <div>
    <div class="p-4 rounded-lg ring-1 ring-purple-500/30 bg-purple-500/10">
      <div class="font-semibold text-purple-400 mb-3">🔒 Per-Column Access Control</div>
      <ul class="text-sm space-y-2 opacity-90">
        <li>• PII isolation at service boundary</li>
        <li>• Email service requires auth token</li>
        <li>• Public fields = public services</li>
        <li>• Fine-grained security policies</li>
      </ul>
    </div>
  </div>
</div>

<div class="mt-6 p-4 rounded-lg ring-1 ring-emerald-500/30 bg-emerald-500/10">
  <div class="font-semibold text-emerald-400 mb-2">⚡ Deployment: CI/CD Spins Up New Service</div>
  <p class="text-sm opacity-90">
    New column = new service deployment. Router auto-discovers and integrates the subgraph.
    No manual coordination required.
  </p>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Operational Realities</div>
<h2 class="mt-2 brand-gradient-text">Trade-offs</h2>

<div class="mt-6 grid grid-cols-2 gap-6">
  <div class="space-y-4">
    <div class="p-4 rounded-lg ring-1 ring-emerald-500/30 bg-emerald-500/10">
      <div class="font-semibold text-emerald-400 mb-2">✓ Autonomy</div>
      <ul class="text-sm space-y-1 opacity-90">
        <li>• Teams own their columns</li>
        <li>• Deploy independently</li>
        <li>• No schema migration hell</li>
        <li>• Fault isolation</li>
      </ul>
    </div>

    <div class="p-4 rounded-lg ring-1 ring-emerald-500/30 bg-emerald-500/10">
      <div class="font-semibold text-emerald-400 mb-2">✓ Scalability</div>
      <ul class="text-sm space-y-1 opacity-90">
        <li>• Scale what needs scaling</li>
        <li>• Technology flexibility</li>
        <li>• Clear boundaries</li>
      </ul>
    </div>
  </div>

  <div class="space-y-4">
    <div class="p-4 rounded-lg ring-1 ring-orange-500/30 bg-orange-500/10">
      <div class="font-semibold text-orange-400 mb-2">⚠ Latency</div>
      <ul class="text-sm space-y-1 opacity-90">
        <li>• Multiple service calls</li>
        <li>• Network hops increase</li>
        <li>• Mitigated by caching</li>
      </ul>
    </div>

    <div class="p-4 rounded-lg ring-1 ring-orange-500/30 bg-orange-500/10">
      <div class="font-semibold text-orange-400 mb-2">⚠ Observability</div>
      <ul class="text-sm space-y-1 opacity-90">
        <li>• More services to monitor</li>
        <li>• Distributed tracing essential</li>
        <li>• Complex query planning</li>
      </ul>
    </div>
  </div>
</div>

<div class="mt-6 text-center text-base opacity-90">
  <strong>Key:</strong> Measure and decide based on your needs
</div>

---
layout: center
class: text-center
---

<h1 class="brand-gradient-text text-5xl inline-block">Live Demo</h1>

<p class="mt-6 text-2xl opacity-80">Adding a New Column in Production</p>

<div class="mt-12 text-left max-w-2xl mx-auto space-y-3">
  <div class="flex items-center gap-3">
    <div class="text-emerald-400 text-2xl">1</div>
    <div class="text-lg opacity-90">Review existing federated schema</div>
  </div>
  <div class="flex items-center gap-3">
    <div class="text-emerald-400 text-2xl">2</div>
    <div class="text-lg opacity-90">Scaffold new column service</div>
  </div>
  <div class="flex items-center gap-3">
    <div class="text-emerald-400 text-2xl">3</div>
    <div class="text-lg opacity-90">Deploy to production</div>
  </div>
  <div class="flex items-center gap-3">
    <div class="text-emerald-400 text-2xl">4</div>
    <div class="text-lg opacity-90">Router auto-integrates new subgraph</div>
  </div>
</div>

<div class="mt-12 p-4 rounded-lg ring-1 ring-emerald-500/30 bg-emerald-500/10 inline-block">
  <p class="text-sm opacity-90">
    <strong>Zero coupling.</strong> No code edits elsewhere.
  </p>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Key Takeaways</div>
<h2 class="mt-2 brand-gradient-text">What We Learned</h2>

<div class="mt-8 space-y-6">
  <div class="p-5 rounded-lg ring-1 ring-blue-500/30 bg-blue-500/10">
    <div class="text-lg font-semibold text-blue-400 mb-2">GraphQL is a Wonderful IDL</div>
    <p class="text-base opacity-90">
      Describes microservice architectures with clarity and type safety.
      No need to understand platform-specific constraints.
    </p>
  </div>

  <div class="p-5 rounded-lg ring-1 ring-purple-500/30 bg-purple-500/10">
    <div class="text-lg font-semibold text-purple-400 mb-2">Federation Makes It Scale</div>
    <p class="text-base opacity-90">
      Sophisticated routers handle composition, caching, and fault isolation.
      Performance and scalability—technically and socially.
    </p>
  </div>

  <div class="p-5 rounded-lg ring-1 ring-emerald-500/30 bg-emerald-500/10">
    <div class="text-lg font-semibold text-emerald-400 mb-2">Independence Scales Teams & Systems</div>
    <p class="text-base opacity-90">
      Even if you never go per-column, the mindset reveals better boundaries.
      Extending your architecture should never block on schema migrations.
    </p>
  </div>
</div>

<div class="mt-8 text-center text-lg opacity-90">
  <strong>Experiment. Measure. Decide.</strong>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Final Thoughts</div>
<h2 class="mt-2 brand-gradient-text">The Real Message</h2>

<div class="mt-10 space-y-8 text-lg">
  <div class="p-6 rounded-lg ring-1 ring-white/15 bg-white/5">
    <p class="opacity-90">
      <strong class="text-emerald-400">GraphQL</strong> provides a wonderful IDL for describing microservice architectures
    </p>
  </div>

  <div class="p-6 rounded-lg ring-1 ring-white/15 bg-white/5">
    <p class="opacity-90">
      <strong class="text-purple-400">Federation</strong> and sophisticated routers make it performant and scalable—
      both technically and socially
    </p>
  </div>

  <div class="p-6 rounded-lg ring-1 ring-white/15 bg-white/5">
    <p class="opacity-90">
      <strong class="text-blue-400">Extending your architecture</strong> should never require understanding 
      platform-specific constraints like table locks or schema migrations
    </p>
  </div>
</div>

<div class="mt-12 text-center text-2xl opacity-90">
  Build systems that <span class="brand-gradient-text font-semibold">empower teams</span>
</div>

---
layout: center
class: text-center
---

<h1 class="brand-gradient-text text-6xl inline-block">Questions?</h1>

<div class="mt-12">
  <FederationDiagram />
</div>

<div class="mt-12 opacity-80">
  <div><strong>David Flanagan</strong> / <strong>@rawkode.dev</strong> 🦋</div>
  <div class="text-sm mt-2">//rawkode.academy</div>
</div>
