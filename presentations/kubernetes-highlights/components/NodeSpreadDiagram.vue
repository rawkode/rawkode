<template>
  <div class="daemonset-wrapper">
    <svg viewBox="0 0 900 400" class="diagram" role="img" aria-label="DaemonSet Node Distribution">
      <defs>
        <marker id="arrow" markerWidth="10" markerHeight="10" refX="10" refY="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#5F5ED7" />
        </marker>
        <linearGradient id="dsGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5F5ED7" />
          <stop offset="100%" stop-color="#00CEFF" />
        </linearGradient>
      </defs>

      <!-- Title -->
      <text x="450" y="32" class="diagram-title" text-anchor="middle">DaemonSet: One Pod Per Node</text>

      <!-- DaemonSet Object -->
      <g v-click class="fade-in">
        <rect x="50" y="60" rx="10" ry="10" width="140" height="80" class="daemonset-obj" />
        <text x="120" y="85" class="ds-title" text-anchor="middle">DaemonSet</text>
        <text x="120" y="102" class="ds-sub" text-anchor="middle">node-exporter</text>
        <text x="120" y="120" class="ds-sub" text-anchor="middle">3 replicas → 3 nodes</text>
      </g>

      <!-- Nodes Container -->
      <g v-click class="fade-in">
        <rect x="220" y="50" rx="12" ry="12" width="630" height="330" class="nodes-container" />
        <text x="535" y="80" class="container-title" text-anchor="middle">Cluster Nodes</text>
      </g>

      <!-- Node 1 -->
      <g v-click class="fade-in">
        <rect x="250" y="100" rx="10" ry="10" width="170" height="250" class="node-box" />
        <text x="335" y="125" class="node-title" text-anchor="middle">Worker Node 1</text>

        <!-- DaemonSet Pod -->
        <rect x="265" y="145" rx="8" ry="8" width="140" height="60" class="ds-pod" />
        <text x="335" y="170" class="pod-title" text-anchor="middle">node-exporter</text>
        <text x="335" y="188" class="pod-sub" text-anchor="middle">metrics:9100</text>

        <!-- Other Workloads -->
        <rect x="265" y="220" rx="6" ry="6" width="140" height="40" class="workload-pod" />
        <text x="335" y="245" class="workload-text" text-anchor="middle">app-pod-1</text>

        <rect x="265" y="275" rx="6" ry="6" width="140" height="40" class="workload-pod" />
        <text x="335" y="300" class="workload-text" text-anchor="middle">app-pod-2</text>
      </g>

      <!-- Node 2 -->
      <g v-click class="fade-in">
        <rect x="450" y="100" rx="10" ry="10" width="170" height="250" class="node-box" />
        <text x="535" y="125" class="node-title" text-anchor="middle">Worker Node 2</text>

        <!-- DaemonSet Pod -->
        <rect x="465" y="145" rx="8" ry="8" width="140" height="60" class="ds-pod" />
        <text x="535" y="170" class="pod-title" text-anchor="middle">node-exporter</text>
        <text x="535" y="188" class="pod-sub" text-anchor="middle">metrics:9100</text>

        <!-- Other Workloads -->
        <rect x="465" y="220" rx="6" ry="6" width="140" height="40" class="workload-pod" />
        <text x="535" y="245" class="workload-text" text-anchor="middle">api-pod-1</text>

        <rect x="465" y="275" rx="6" ry="6" width="140" height="40" class="workload-pod" />
        <text x="535" y="300" class="workload-text" text-anchor="middle">api-pod-2</text>
      </g>

      <!-- Node 3 -->
      <g v-click class="fade-in">
        <rect x="650" y="100" rx="10" ry="10" width="170" height="250" class="node-box" />
        <text x="735" y="125" class="node-title" text-anchor="middle">Worker Node 3</text>

        <!-- DaemonSet Pod -->
        <rect x="665" y="145" rx="8" ry="8" width="140" height="60" class="ds-pod" />
        <text x="735" y="170" class="pod-title" text-anchor="middle">node-exporter</text>
        <text x="735" y="188" class="pod-sub" text-anchor="middle">metrics:9100</text>

        <!-- Other Workloads -->
        <rect x="665" y="220" rx="6" ry="6" width="140" height="40" class="workload-pod" />
        <text x="735" y="245" class="workload-text" text-anchor="middle">db-pod-1</text>

        <rect x="665" y="275" rx="6" ry="6" width="140" height="40" class="workload-pod" />
        <text x="735" y="300" class="workload-text" text-anchor="middle">db-pod-2</text>
      </g>

      <!-- Controller Indicator -->
      <g v-click>
        <path d="M 190 100 L 250 175" class="control-arrow" marker-end="url(#arrow)" />
        <text x="210" y="140" class="control-text">Ensures</text>
        <text x="200" y="155" class="control-text">one pod</text>
        <text x="210" y="170" class="control-text">per node</text>
      </g>

      <!-- Node Selector Info -->
      <g v-click class="fade-in">
        <rect x="50" y="160" rx="8" ry="8" width="140" height="70" class="selector-info" />
        <text x="120" y="182" class="selector-title" text-anchor="middle">Node Selector</text>
        <text x="120" y="200" class="selector-text" text-anchor="middle">role: worker</text>
        <text x="120" y="218" class="selector-text" text-anchor="middle">(optional)</text>
      </g>

      <!-- Taint/Toleration -->
      <g v-click class="fade-in">
        <rect x="50" y="250" rx="8" ry="8" width="140" height="70" class="toleration-info" />
        <text x="120" y="272" class="selector-title" text-anchor="middle">Tolerations</text>
        <text x="120" y="290" class="selector-text" text-anchor="middle">allow on</text>
        <text x="120" y="308" class="selector-text" text-anchor="middle">master nodes</text>
      </g>

      <!-- Use Cases Panel -->
      <g v-click class="fade-in">
        <rect x="50" y="340" rx="8" ry="8" width="800" height="40" class="usecase-panel" />
        <text x="450" y="367" class="usecase-text" text-anchor="middle">
          Common Use Cases: Logging (fluentd), Monitoring (node-exporter), Networking (CNI), Storage (CSI)
        </text>
      </g>

      <!-- Legend -->
      <g v-click class="fade-in">
        <rect x="780" y="55" width="60" height="60" rx="6" class="legend" />
        <text x="810" y="75" class="legend-title" text-anchor="middle">Legend</text>

        <rect x="788" y="82" width="10" height="10" rx="2" class="legend-ds" />
        <text x="806" y="91" class="legend-text">DS</text>

        <rect x="788" y="96" width="10" height="10" rx="2" class="legend-app" />
        <text x="806" y="105" class="legend-text">App</text>
      </g>
    </svg>

    <p class="caption">DaemonSet ensures one copy runs on every node (or subset via nodeSelector)</p>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ stage?: number }>()
</script>

<style scoped>
.diagram { width: 100%; height: auto; }

.diagram-title { font: 700 18px/1.2 'Poppins', 'Quicksand', sans-serif; fill: #fff; }

/* DaemonSet Object */
.daemonset-obj { fill: color-mix(in oklab, var(--rk-primary) 25%, transparent); stroke: var(--rk-primary); stroke-width: 1.5; }
.ds-title { font: 600 13px/1.2 'Poppins', sans-serif; fill: #fff; }
.ds-sub { font: 400 10px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }

/* Nodes Container */
.nodes-container { fill: color-mix(in oklab, var(--rk-black) 6%, transparent); stroke: var(--rk-primary); stroke-width: 1.2; }
.container-title { font: 600 14px/1.2 'Poppins', sans-serif; fill: var(--rk-secondary); }

/* Node boxes */
.node-box { fill: color-mix(in oklab, var(--rk-black) 8%, transparent); stroke: #fff4; stroke-width: 1.2; }
.node-title { font: 600 12px/1.2 'Poppins', sans-serif; fill: #fff; }

/* DaemonSet Pods */
.ds-pod { fill: url(#dsGrad); stroke: var(--rk-primary); stroke-width: 1.5; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); }
.pod-title { font: 600 12px/1.2 'Poppins', sans-serif; fill: #fff; }
.pod-sub { font: 400 10px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.85; }

/* Other Workload Pods */
.workload-pod { fill: color-mix(in oklab, #10B981 20%, transparent); stroke: #10B981; stroke-width: 1; }
.workload-text { font: 400 10px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }

/* Control arrow */
.control-arrow { fill: none; stroke: var(--rk-secondary); stroke-width: 2; stroke-dasharray: 5,5; }
.control-text { font: 400 10px/1.2 'Quicksand', sans-serif; fill: var(--rk-secondary); }

/* Info boxes */
.selector-info { fill: color-mix(in oklab, var(--rk-secondary) 15%, transparent); stroke: var(--rk-secondary); stroke-width: 1; }
.toleration-info { fill: color-mix(in oklab, var(--rk-secondary) 15%, transparent); stroke: var(--rk-secondary); stroke-width: 1; }
.selector-title { font: 600 11px/1.2 'Poppins', sans-serif; fill: #fff; }
.selector-text { font: 400 10px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.85; }

/* Use cases panel */
.usecase-panel { fill: color-mix(in oklab, var(--rk-black) 8%, transparent); stroke: #fff2; }
.usecase-text { font: 500 12px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.9; }

/* Legend */
.legend { fill: color-mix(in oklab, var(--rk-black) 8%, transparent); stroke: #fff2; }
.legend-title { font: 600 10px/1 'Poppins', sans-serif; fill: #fff; opacity: 0.9; }
.legend-ds { fill: url(#dsGrad); stroke: var(--rk-primary); }
.legend-app { fill: color-mix(in oklab, #10B981 40%, transparent); stroke: #10B981; }
.legend-text { font: 400 9px/1 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }

/* Animations */
.fade-in { transition: opacity .2s ease-in; }
.caption { margin-top: .5rem; font-size: .85rem; opacity: .7; text-align: center; }
</style>
