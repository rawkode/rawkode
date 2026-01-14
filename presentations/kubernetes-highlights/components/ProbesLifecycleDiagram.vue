<template>
  <div class="probes-wrapper">
    <svg viewBox="0 0 900 420" class="diagram" role="img" aria-label="Pod Lifecycle Probes">
      <defs>
        <linearGradient id="probeGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5F5ED7" />
          <stop offset="100%" stop-color="#00CEFF" />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>

      <!-- Title -->
      <text x="450" y="32" class="diagram-title" text-anchor="middle">Pod Lifecycle with Probes</text>

      <!-- Main Container -->
      <rect x="50" y="50" rx="16" ry="16" width="800" height="280" class="pod-container" />

      <!-- Probe Timeline Header -->
      <g v-click="stage >= 1">
        <rect x="50" y="50" rx="16" ry="16" width="800" height="50" class="timeline-header" />
        <text x="450" y="82" class="timeline-label" text-anchor="middle">Probe Execution Timeline</text>
      </g>

      <!-- Phase 1: Startup Probe -->
      <g v-click="stage >= 2" :class="['phase', { hl: stage === 2 }]">
        <rect x="70" y="120" rx="10" ry="10" width="220" height="80" class="probe-box startup" />
        <text x="180" y="148" class="probe-title" text-anchor="middle">Startup Probe</text>
        <text x="180" y="170" class="probe-sub" text-anchor="middle">Runs once at container start</text>
        <text x="180" y="188" class="probe-detail" text-anchor="middle">Delays liveness/readiness</text>

        <!-- Icon -->
        <circle cx="100" cy="160" r="20" class="probe-icon" />
        <text x="100" y="166" class="probe-icon-text" text-anchor="middle">1</text>
      </g>

      <!-- Arrow 1 -->
      <g v-click="stage >= 2">
        <path d="M 290 160 L 340 160" class="arrow" marker-end="url(#arrow)" />
      </g>

      <!-- Phase 2: Readiness Probe -->
      <g v-click="stage >= 3" :class="['phase', { hl: stage === 3 }]">
        <rect x="350" y="120" rx="10" ry="10" width="220" height="80" class="probe-box readiness" />
        <text x="460" y="148" class="probe-title" text-anchor="middle">Readiness Probe</text>
        <text x="460" y="170" class="probe-sub" text-anchor="middle">Checks if ready for traffic</text>
        <text x="460" y="188" class="probe-detail" text-anchor="middle">Removes from endpoints if fails</text>

        <!-- Icon -->
        <circle cx="380" cy="160" r="20" class="probe-icon" />
        <text x="380" y="166" class="probe-icon-text" text-anchor="middle">2</text>
      </g>

      <!-- Endpoint Status Indicator - Before Readiness -->
      <g v-click="stage >= 3">
        <rect x="350" y="210" width="220" height="40" rx="6" class="endpoint-box out" />
        <text x="460" y="235" class="endpoint-text" text-anchor="middle">Service Endpoints: <tspan class="status out">NOT RECEIVING TRAFFIC</tspan></text>
      </g>

      <!-- Arrow 2 -->
      <g v-click="stage >= 3">
        <path d="M 570 160 L 620 160" class="arrow" marker-end="url(#arrow)" />
      </g>

      <!-- Phase 3: Liveness Probe -->
      <g v-click="stage >= 4" :class="['phase', { hl: stage === 4 }]">
        <rect x="630" y="120" rx="10" ry="10" width="220" height="80" class="probe-box liveness" />
        <text x="740" y="148" class="probe-title" text-anchor="middle">Liveness Probe</text>
        <text x="740" y="170" class="probe-sub" text-anchor="middle">Checks if container is alive</text>
        <text x="740" y="188" class="probe-detail" text-anchor="middle">Kills & restarts if fails</text>

        <!-- Icon -->
        <circle cx="660" cy="160" r="20" class="probe-icon" />
        <text x="660" y="166" class="probe-icon-text" text-anchor="middle">3</text>
      </g>

      <!-- Endpoint Status Indicator - After Readiness Passes -->
      <g v-click="stage >= 5">
        <rect x="350" y="260" width="220" height="40" rx="6" class="endpoint-box in" />
        <text x="460" y="285" class="endpoint-text" text-anchor="middle">Service Endpoints: <tspan class="status in">RECEIVING TRAFFIC</tspan></text>
      </g>

      <!-- Running State -->
      <g v-click="stage >= 5">
        <rect x="630" y="210" width="220" height="90" rx="10" class="running-state" />
        <text x="740" y="245" class="running-title" text-anchor="middle">Container Running</text>
        <text x="740" y="268" class="running-sub" text-anchor="middle">Probes passing, traffic flowing</text>

        <!-- Traffic dots animation -->
        <circle cx="650" cy="285" r="4" class="traffic-dot" />
        <circle cx="665" cy="285" r="4" class="traffic-dot" />
        <circle cx="680" cy="285" r="4" class="traffic-dot" />
        <circle cx="695" cy="285" r="4" class="traffic-dot" />
        <circle cx="710" cy="285" r="4" class="traffic-dot" />
      </g>

      <!-- Failure Scenarios Panel -->
      <g v-click="stage >= 6">
        <rect x="70" y="320" rx="10" ry="10" width="760" height="80" class="failure-panel" />

        <text x="250" y="348" class="failure-title" text-anchor="middle">Readiness Fails</text>
        <text x="250" y="368" class="failure-detail" text-anchor="middle">Pod isolated, no restart</text>
        <text x="250" y="386" class="failure-detail" text-anchor="middle">Traffic → other pods</text>

        <text x="600" y="348" class="failure-title" text-anchor="middle">Liveness Fails</text>
        <text x="600" y="368" class="failure-detail" text-anchor="middle">Container killed</text>
        <text x="600" y="386" class="failure-detail" text-anchor="middle">Pod restarts</text>
      </g>

      </g>
    </svg>

    <p class="caption">Click to step through: Startup → Readiness → Liveness → Running → Failure Behaviors</p>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ stage?: number }>()
</script>

<style scoped>
.diagram { width: 100%; height: auto; }

.diagram-title { font: 700 18px/1.2 'Poppins', 'Quicksand', sans-serif; fill: #fff; }

.pod-container { fill: color-mix(in oklab, var(--rk-black) 5%, transparent); stroke: #fff2; stroke-width: 1; }

.timeline-header { fill: color-mix(in oklab, var(--rk-primary) 15%, transparent); }
.timeline-label { font: 600 14px/1.2 'Poppins', sans-serif; fill: #fff; }

.probe-box { stroke-width: 1.5; }
.probe-box.startup { fill: color-mix(in oklab, #F59E0B 20%, transparent); stroke: #F59E0B; }
.probe-box.readiness { fill: color-mix(in oklab, #10B981 20%, transparent); stroke: #10B981; }
.probe-box.liveness { fill: color-mix(in oklab, #EF4444 20%, transparent); stroke: #EF4444; }

.probe-box.hl { stroke-width: 3; filter: drop-shadow(0 0 8px var(--rk-secondary)); }

.probe-title { font: 600 14px/1.2 'Poppins', sans-serif; fill: #fff; }
.probe-sub { font: 400 11px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.85; }
.probe-detail { font: 400 10px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.7; }

.probe-icon { fill: var(--rk-primary); stroke: #fff; stroke-width: 1; }
.probe-icon-text { font: 600 12px/1 sans-serif; fill: #fff; }

.arrow { fill: none; stroke: var(--rk-primary); stroke-width: 2; }

.endpoint-box { stroke-width: 1; }
.endpoint-box.in { fill: color-mix(in oklab, #10B981 15%, transparent); stroke: #10B981; }
.endpoint-box.out { fill: color-mix(in oklab, #EF4444 15%, transparent); stroke: #EF4444; }

.endpoint-text { font: 500 11px/1.2 'Quicksand', sans-serif; fill: #fff; }
.endpoint-text .status.in { fill: #10B981; font-weight: 600; }
.endpoint-text .status.out { fill: #EF4444; font-weight: 600; }

.running-state { fill: url(#controlPlaneGrad); stroke: var(--rk-secondary); stroke-width: 2; }
.running-title { font: 600 14px/1.2 'Poppins', sans-serif; fill: #fff; }
.running-sub { font: 400 11px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.9; }

.traffic-dot { fill: #fff; animation: pulse 1s ease-in-out infinite; }
.traffic-dot:nth-child(2) { animation-delay: 0.1s; }
.traffic-dot:nth-child(3) { animation-delay: 0.2s; }
.traffic-dot:nth-child(4) { animation-delay: 0.3s; }
.traffic-dot:nth-child(5) { animation-delay: 0.4s; }

@keyframes pulse {
  0%, 100% { opacity: 0.5; transform: translateX(0); }
  50% { opacity: 1; transform: translateX(5px); }
}

.failure-panel { fill: color-mix(in oklab, var(--rk-black) 8%, transparent); stroke: #fff2; }
.failure-title { font: 600 13px/1.2 'Poppins', sans-serif; fill: #fff; }
.failure-detail { font: 400 10px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }

.fade-in { transition: opacity .2s ease-in; }
.caption { margin-top: .5rem; font-size: .85rem; opacity: .7; text-align: center; }
</style>
