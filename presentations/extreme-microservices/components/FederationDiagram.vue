<template>
  <div class="diagram-wrapper">
    <svg viewBox="0 0 920 520" class="diagram" role="img" aria-label="GraphQL Federation overview">
      <defs>
        <marker id="arrow" markerWidth="10" markerHeight="10" refX="10" refY="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#5F5ED7" />
        </marker>
        <linearGradient id="routerGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5F5ED7" />
          <stop offset="100%" stop-color="#00CEFF" />
        </linearGradient>
      </defs>

      <!-- Client -->
      <g v-click class="fade-in">
        <rect x="60" y="36" rx="10" ry="10" width="220" height="66" :class="['node','client', stage===1 ? 'hl' : '']" />
        <text x="170" y="65" class="title client-label" text-anchor="middle">Client Query</text>
        <text x="170" y="86" class="sub client-label" text-anchor="middle">product-centric shape</text>
      </g>

      <!-- Router -->
      <g v-click class="fade-in">
        <rect x="340" y="96" rx="12" ry="12" width="240" height="72" :class="['node','router', (stage===1||stage===2||stage===3||stage===4) ? 'hl' : '']" />
        <text x="460" y="124" class="title router-label" text-anchor="middle">Router</text>
        <text x="460" y="146" class="sub router-label" text-anchor="middle">supergraph • query planning</text>
      </g>

      <!-- Edge: client -> router -->
      <g v-click>
        <path d="M 280 69 C 320 69 320 132 340 132" :class="['edge', stage===1 ? 'hl' : '']" marker-end="url(#arrow)" />
      </g>

      <!-- Services row -->
      <g v-click class="fade-in">
        <rect x="120" y="320" rx="10" ry="10" width="210" height="78" :class="['node','service','service-core', stage===2 ? 'hl' : '']" />
        <text x="225" y="350" class="title service-label" text-anchor="middle">User Core</text>
        <text x="225" y="372" class="sub service-label" text-anchor="middle">owns key: id</text>
      </g>

      <g v-click class="fade-in">
        <rect x="355" y="320" rx="10" ry="10" width="210" height="78" :class="['node','service','service-email', stage===3 ? 'hl' : '']" />
        <text x="460" y="350" class="title service-label" text-anchor="middle">User Email</text>
        <text x="460" y="372" class="sub service-label" text-anchor="middle">column service</text>
      </g>

      <g v-click class="fade-in">
        <rect x="590" y="320" rx="10" ry="10" width="210" height="78" :class="['node','service','service-nickname', stage===3 ? 'hl' : '']" />
        <text x="695" y="350" class="title service-label" text-anchor="middle">User Nickname</text>
        <text x="695" y="372" class="sub service-label" text-anchor="middle">column service</text>
      </g>

      <!-- Edges: router -> services -->
      <g v-click>
        <path d="M 460 168 C 460 220 225 220 225 320" :class="['edge','strong', stage===2 ? 'hl' : '']" marker-end="url(#arrow)" />
        <path d="M 460 168 C 460 230 460 230 460 320" :class="['edge','strong', stage===3 ? 'hl' : '']" marker-end="url(#arrow)" />
        <path d="M 460 168 C 460 220 695 220 695 320" :class="['edge','strong', stage===3 ? 'hl' : '']" marker-end="url(#arrow)" />
        <text x="315" y="238" class="hint" text-anchor="middle">representations by @key(id)</text>
      </g>

      <!-- Return edges (implicit) + stitched response callout -->
      <g v-click>
        <rect x="640" y="64" rx="10" ry="10" width="220" height="64" :class="['node','response', stage===4 ? 'hl' : '']" />
        <text x="750" y="92" class="title router-label" text-anchor="middle">Stitched Response</text>
        <text x="750" y="112" class="sub router-label" text-anchor="middle">fields from multiple subgraphs</text>
        <path d="M 580 132 C 610 132 610 96 640 96" :class="['edge', stage===4 ? 'hl' : '']" marker-end="url(#arrow)" />
      </g>

      <!-- Legend -->
      <g v-click class="fade-in">
        <rect x="50" y="428" width="290" height="62" rx="8" ry="8" class="legend" />
        <rect x="64" y="442" width="16" height="16" class="legend-chip client" />
        <text x="88" y="455" class="legend-text">Client</text>
        <rect x="144" y="442" width="16" height="16" class="legend-chip router" />
        <text x="168" y="455" class="legend-text">Router / Supergraph</text>
        <rect x="300" y="442" width="16" height="16" class="legend-chip service" />
        <text x="324" y="455" class="legend-text">Subgraph service</text>
      </g>
    </svg>
  </div>
  <p class="caption">Router fans out by federation key and stitches a single response.</p>
  <p class="caption sub">Click to step through: client → router → services → stitched result.</p>
</template>

<script setup lang="ts">
const props = defineProps<{ stage?: number }>()
</script>

<style scoped>
.diagram { width: 100%; height: auto; }
.node { stroke: color-mix(in oklab, var(--rk-primary), black 25%); stroke-width: 1.2; }
.client { fill: color-mix(in oklab, var(--rk-primary) 14%, transparent); }
.router { fill: url(#routerGrad); filter: drop-shadow(0 2px 6px color-mix(in oklab, var(--rk-primary) 25%, transparent)); }
.service { fill: color-mix(in oklab, var(--rk-secondary) 14%, transparent); }
.service-core { fill: color-mix(in oklab, var(--rk-primary) 32%, transparent); }
.service-email { fill: color-mix(in oklab, var(--rk-secondary) 32%, transparent); }
.service-nickname { fill: color-mix(in oklab, var(--rk-primary) 20%, transparent); }
.response { fill: color-mix(in oklab, var(--rk-secondary) 22%, transparent); }
.edge { fill: none; stroke: var(--rk-primary); stroke-width: 2; }
.edge.strong { stroke-width: 2.5; }
.hl.edge, .edge.hl { stroke-width: 3.2; filter: drop-shadow(0 0 8px var(--rk-secondary)); }
.hl.node, .node.hl { stroke-width: 2.2; filter: drop-shadow(0 0 10px color-mix(in oklab, var(--rk-secondary) 50%, transparent)); }
.title { font: 600 14px/1.2 'Poppins', 'Quicksand', ui-sans-serif, system-ui; }
.sub { font: 400 12px/1.2 'Quicksand', ui-sans-serif, system-ui; opacity: 0.8; }
.router-label { fill: #fff; paint-order: stroke fill; stroke: rgba(0,0,0,.4); stroke-width: 1.4px; }
.client-label { fill: #fff; paint-order: stroke fill; stroke: rgba(0,0,0,.35); stroke-width: 1.2px; }
.service-label { fill: #fff; paint-order: stroke fill; stroke: rgba(0,0,0,.4); stroke-width: 1.1px; }
.hint { font: 500 12px/1.2 'Quicksand', ui-sans-serif, system-ui; fill: var(--rk-black); opacity: 0.9; }
.legend { fill: color-mix(in oklab, var(--rk-black) 6%, transparent); stroke: #0003; }
.legend-chip { stroke: #0003; }
.legend-text { font: 500 12px/1 'Quicksand', ui-sans-serif; fill: var(--rk-black); }
.fade-in { transition: opacity .2s ease-in; }
.caption { margin-top: .5rem; font-size: .9rem; opacity: .8; }
</style>
