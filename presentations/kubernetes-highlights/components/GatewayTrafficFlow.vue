<template>
  <div class="gateway-wrapper">
    <svg viewBox="0 0 920 500" class="diagram" role="img" aria-label="Gateway API Traffic Flow">
      <defs>
        <marker id="arrow" markerWidth="10" markerHeight="10" refX="10" refY="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#5F5ED7" />
        </marker>
        <linearGradient id="gatewayGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5F5ED7" />
          <stop offset="100%" stop-color="#00CEFF" />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>

      <!-- Title -->
      <text x="460" y="32" class="diagram-title" text-anchor="middle">Gateway API Traffic Flow</text>

      <!-- Internet / External Traffic -->
      <g v-click class="fade-in">
        <rect x="40" y="80" rx="12" ry="12" width="120" height="80" class="external-box" />
        <text x="100" y="115" class="external-title" text-anchor="middle">Internet</text>
        <text x="100" y="138" class="external-sub" text-anchor="middle">External Users</text>
      </g>

      <!-- Arrow: Internet to Gateway -->
      <g v-click>
        <path d="M 160 120 L 200 120" class="arrow" marker-end="url(#arrow)" />
        <text x="180" y="110" class="hint" text-anchor="middle">HTTPS</text>
      </g>

      <!-- Gateway API Components -->
      <g v-click class="fade-in">
        <rect x="200" y="50" rx="12" ry="12" width="320" height="280" class="gateway-container" />
        <text x="360" y="80" class="container-title" text-anchor="middle">Gateway API Components</text>

        <!-- GatewayClass -->
        <rect x="220" y="100" rx="8" ry="8" width="280" height="45" :class="['component', 'gatewayclass', stage===1 ? 'hl' : '']" />
        <text x="360" y="125" class="component-title" text-anchor="middle">GatewayClass</text>
        <text x="360" y="138" class="component-sub" text-anchor="middle">Infrastructure-level config (nginx, envoy)</text>

        <!-- Gateway -->
        <rect x="220" y="160" rx="8" ry="8" width="280" height="45" :class="['component', 'gateway', stage===2 ? 'hl' : '']" />
        <text x="360" y="185" class="component-title" text-anchor="middle">Gateway</text>
        <text x="360" y="198" class="component-sub" text-anchor="middle">Listener config (ports, TLS, addresses)</text>

        <!-- Route -->
        <rect x="220" y="220" rx="8" ry="8" width="280" height="45" :class="['component', 'route', stage===3 ? 'hl' : '']" />
        <text x="360" y="245" class="component-title" text-anchor="middle">HTTPRoute / TLSRoute</text>
        <text x="360" y="258" class="component-sub" text-anchor="middle">Routing rules (headers, paths, backends)</text>

        <!-- Arrow connections between components -->
        <path d="M 360 145 L 360 160" class="inner-arrow" />
        <path d="M 360 205 L 360 220" class="inner-arrow" />
      </g>

      <!-- Arrow: Gateway to Service -->
      <g v-click>
        <path d="M 520 190 L 560 190" class="arrow" marker-end="url(#arrow)" />
        <text x="540" y="180" class="hint" text-anchor="middle">Routes</text>
      </g>

      <!-- Service -->
      <g v-click class="fade-in">
        <rect x="560" y="50" rx="12" ry="12" width="140" height="130" :class="['service-box', stage===4 ? 'hl' : '']" />
        <text x="630" y="85" class="service-title" text-anchor="middle">Service</text>
        <text x="630" y="105" class="service-sub" text-anchor="middle">Load Balancing</text>
        <rect x="580" y="120" rx="6" ry="6" width="100" height="45" class="pod-group" />
        <text x="630" y="147" class="pod-label" text-anchor="middle">Pods</text>
      </g>

      <!-- Pods detail -->
      <g v-click class="fade-in">
        <rect x="580" y="200" rx="6" ry="6" width="45" height="130" class="pod-container" />
        <text x="602" y="225" class="pod-title" text-anchor="middle">Pod A</text>
        <rect x="585" y="240" width="35" height="25" class="container" />
        <text x="602" y="258" class="container-label" text-anchor="middle">App</text>

        <rect x="635" y="200" rx="6" ry="6" width="45" height="130" class="pod-container" />
        <text x="657" y="225" class="pod-title" text-anchor="middle">Pod B</text>
        <rect x="640" y="240" width="35" height="25" class="container" />
        <text x="657" y="258" class="container-label" text-anchor="middle">App</text>

        <rect x="690" y="200" rx="6" ry="6" width="45" height="130" class="pod-container" />
        <text x="712" y="225" class="pod-title" text-anchor="middle">Pod C</text>
        <rect x="695" y="240" width="35" height="25" class="container" />
        <text x="712" y="258" class="container-label" text-anchor="middle">App</text>
      </g>

      <!-- Arrow: Service to Pods -->
      <g v-click>
        <path d="M 630 180 L 630 200" class="arrow" marker-end="url(#arrow)" />
      </g>

      <!-- Key Benefits Panel -->
      <g v-click class="fade-in">
        <rect x="40" y="350" rx="10" ry="10" width="840" height="120" class="benefits-panel" />

        <g>
          <rect x="60" y="370" rx="6" ry="6" width="250" height="85" class="benefit-box" />
          <text x="185" y="395" class="benefit-title" text-anchor="middle">Role-Based</text>
          <text x="185" y="415" class="benefit-text" text-anchor="middle">Infrastructure providers</text>
          <text x="185" y="430" class="benefit-text" text-anchor="middle">manage GatewayClass</text>
        </g>

        <g>
          <rect x="335" y="370" rx="6" ry="6" width="250" height="85" class="benefit-box" />
          <text x="460" y="395" class="benefit-title" text-anchor="middle">Cluster Operators</text>
          <text x="460" y="415" class="benefit-text" text-anchor="middle">manage Gateway</text>
          <text x="460" y="430" class="benefit-text" text-anchor="middle">(listeners, TLS, IPs)</text>
        </g>

        <g>
          <rect x="610" y="370" rx="6" ry="6" width="250" height="85" class="benefit-box" />
          <text x="735" y="395" class="benefit-title" text-anchor="middle">App Developers</text>
          <text x="735" y="415" class="benefit-text" text-anchor="middle">manage Routes</text>
          <text x="735" y="430" class="benefit-text" text-anchor="middle">(traffic rules, backends)</text>
        </g>
      </g>

      <!-- Legend -->
      <g v-click class="fade-in">
        <rect x="760" y="60" width="100" height="100" rx="8" class="legend" />
        <text x="810" y="82" class="legend-title" text-anchor="middle">Legend</text>

        <rect x="770" y="92" width="12" height="12" rx="2" class="legend-gateway" />
        <text x="790" y="102" class="legend-text">Gateway API</text>

        <rect x="770" y="110" width="12" height="12" rx="2" class="legend-service" />
        <text x="790" y="120" class="legend-text">Service</text>

        <rect x="770" y="128" width="12" height="12" rx="2" class="legend-pod" />
        <text x="790" y="138" class="legend-text">Pod</text>
      </g>
    </svg>

    <p class="caption">Gateway API provides separation of concerns across roles, unlike Ingress</p>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ stage?: number }>()
</script>

<style scoped>
.diagram { width: 100%; height: auto; }

.diagram-title { font: 700 18px/1.2 'Poppins', 'Quicksand', sans-serif; fill: #fff; }

/* External traffic */
.external-box { fill: color-mix(in oklab, #6366F1 20%, transparent); stroke: #6366F1; stroke-width: 1.5; }
.external-title { font: 600 14px/1.2 'Poppins', sans-serif; fill: #fff; }
.external-sub { font: 400 11px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }

/* Gateway API container */
.gateway-container { fill: color-mix(in oklab, var(--rk-black) 6%, transparent); stroke: var(--rk-primary); stroke-width: 1.5; }
.container-title { font: 600 15px/1.2 'Poppins', sans-serif; fill: var(--rk-secondary); }

/* Gateway API components */
.component { stroke-width: 1.2; }
.component.gatewayclass { fill: color-mix(in oklab, #8B5CF6 25%, transparent); stroke: #8B5CF6; }
.component.gateway { fill: color-mix(in oklab, var(--rk-primary) 30%, transparent); stroke: var(--rk-primary); }
.component.route { fill: color-mix(in oklab, var(--rk-secondary) 30%, transparent); stroke: var(--rk-secondary); }

.component-title { font: 600 12px/1.2 'Poppins', sans-serif; fill: #fff; }
.component-sub { font: 400 10px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.75; }

.component.hl { stroke-width: 2; filter: drop-shadow(0 0 6px var(--rk-secondary)); }

/* Service */
.service-box { fill: color-mix(in oklab, var(--rk-secondary) 15%, transparent); stroke: var(--rk-secondary); stroke-width: 1.2; }
.service-title { font: 600 14px/1.2 'Poppins', sans-serif; fill: #fff; }
.service-sub { font: 400 11px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }

.service-box.hl { stroke-width: 2; filter: drop-shadow(0 0 8px var(--rk-secondary)); }

.pod-group { fill: color-mix(in oklab, var(--rk-black) 8%, transparent); stroke: #fff4; }

/* Pods */
.pod-container { fill: color-mix(in oklab, var(--rk-primary) 20%, transparent); stroke: #fff6; stroke-width: 1; }
.pod-title { font: 600 10px/1.2 'Poppins', sans-serif; fill: #fff; }
.container { fill: color-mix(in oklab, #10B981 30%, transparent); stroke: #10B981; stroke-width: 1; }
.container-label { font: 500 9px/1.2 'Quicksand', sans-serif; fill: #fff; }
.pod-label { font: 500 11px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }

/* Arrows */
.arrow { fill: none; stroke: var(--rk-primary); stroke-width: 2; }
.inner-arrow { fill: none; stroke: #fff6; stroke-width: 1.5; marker-end: url(#arrow); }
.hint { font: 500 10px/1.2 'Quicksand', sans-serif; fill: var(--rk-secondary); }

/* Benefits panel */
.benefits-panel { fill: color-mix(in oklab, var(--rk-black) 8%, transparent); stroke: #fff2; }
.benefit-box { fill: color-mix(in oklab, var(--rk-black) 6%, transparent); stroke: #fff3; stroke-width: 1; }
.benefit-title { font: 600 12px/1.2 'Poppins', sans-serif; fill: var(--rk-secondary); }
.benefit-text { font: 400 10px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }

/* Legend */
.legend { fill: color-mix(in oklab, var(--rk-black) 8%, transparent); stroke: #fff2; }
.legend-title { font: 600 11px/1 'Poppins', sans-serif; fill: #fff; opacity: 0.9; }
.legend-gateway { fill: var(--rk-primary); }
.legend-service { fill: var(--rk-secondary); }
.legend-pod { fill: #10B981; }
.legend-text { font: 400 10px/1 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }

/* Animations */
.fade-in { transition: opacity .2s ease-in; }
.caption { margin-top: .5rem; font-size: .85rem; opacity: .7; text-align: center; }
</style>
