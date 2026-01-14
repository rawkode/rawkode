<template>
  <div class="diagram-wrapper">
    <svg viewBox="0 0 920 480" class="diagram" role="img" aria-label="Kubernetes Architecture Overview">
      <defs>
        <marker id="arrow" markerWidth="10" markerHeight="10" refX="10" refY="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#5F5ED7" />
        </marker>
        <linearGradient id="podGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5F5ED7" />
          <stop offset="100%" stop-color="#00CEFF" />
        </linearGradient>
      </defs>

      <!-- Control Plane Box -->
      <rect x="40" y="30" rx="12" ry="12" width="400" height="200" class="container-box control-plane" />
      <text x="240" y="58" class="container-title" text-anchor="middle">Control Plane</text>

      <rect x="60" y="80" rx="8" ry="8" width="120" height="60" class="node api-server" />
      <text x="120" y="105" class="title" text-anchor="middle">API Server</text>
      <text x="120" y="125" class="sub" text-anchor="middle">kube-apiserver</text>

      <rect x="200" y="80" rx="8" ry="8" width="100" height="60" class="node etcd" />
      <text x="250" y="105" class="title" text-anchor="middle">etcd</text>
      <text x="250" y="125" class="sub" text-anchor="middle">key-value store</text>

      <rect x="320" y="80" rx="8" ry="8" width="100" height="60" class="node scheduler" />
      <text x="370" y="105" class="title" text-anchor="middle">Scheduler</text>
      <text x="370" y="125" class="sub" text-anchor="middle">kube-scheduler</text>

      <rect x="140" y="155" rx="8" ry="8" width="160" height="55" class="node controller" />
      <text x="220" y="180" class="title" text-anchor="middle">Controller Manager</text>
      <text x="220" y="198" class="sub" text-anchor="middle">replication, endpoints</text>

      <!-- Worker Nodes Box -->
      <rect x="480" y="30" rx="12" ry="12" width="400" height="200" class="container-box worker-nodes" />
      <text x="680" y="58" class="container-title" text-anchor="middle">Worker Nodes</text>

      <rect x="500" y="75" rx="8" ry="8" width="170" height="140" class="node worker-node" />
      <text x="585" y="95" class="title" text-anchor="middle">Node 1</text>
      <rect x="515" y="105" rx="6" ry="6" width="65" height="40" class="inner-node kubelet" />
      <text x="548" y="130" class="small-title" text-anchor="middle">kubelet</text>
      <rect x="590" y="105" rx="6" ry="6" width="65" height="40" class="inner-node kube-proxy" />
      <text x="623" y="130" class="small-title" text-anchor="middle">kube-proxy</text>
      <rect x="515" y="155" rx="6" ry="6" width="140" height="50" class="inner-node pods" />
      <text x="585" y="180" class="title pod-label" text-anchor="middle">Pods</text>

      <rect x="690" y="75" rx="8" ry="8" width="170" height="140" class="node worker-node" />
      <text x="775" y="95" class="title" text-anchor="middle">Node 2</text>
      <rect x="705" y="105" rx="6" ry="6" width="65" height="40" class="inner-node kubelet" />
      <text x="738" y="130" class="small-title" text-anchor="middle">kubelet</text>
      <rect x="780" y="105" rx="6" ry="6" width="65" height="40" class="inner-node kube-proxy" />
      <text x="813" y="130" class="small-title" text-anchor="middle">kube-proxy</text>
      <rect x="705" y="155" rx="6" ry="6" width="140" height="50" class="inner-node pods" />
      <text x="775" y="180" class="title pod-label" text-anchor="middle">Pods</text>

      <!-- Connection Arrow -->
      <path d="M 440 130 L 480 130" class="edge" marker-end="url(#arrow)" />
      <text x="460" y="118" class="hint" text-anchor="middle">API</text>

      <!-- Scheduling Flow -->
      <rect x="40" y="260" rx="10" ry="10" width="840" height="100" class="flow-container" />
      <text x="460" y="285" class="flow-title" text-anchor="middle">Pod Scheduling Flow</text>

      <rect x="60" y="305" rx="6" ry="6" width="100" height="40" class="flow-step" />
      <text x="110" y="330" class="small-title" text-anchor="middle">kubectl</text>
      <path d="M 160 325 L 190 325" class="edge" marker-end="url(#arrow)" />

      <rect x="190" y="305" rx="6" ry="6" width="100" height="40" class="flow-step api" />
      <text x="240" y="330" class="small-title" text-anchor="middle">API Server</text>
      <path d="M 290 325 L 320 325" class="edge" marker-end="url(#arrow)" />

      <rect x="320" y="305" rx="6" ry="6" width="100" height="40" class="flow-step scheduler" />
      <text x="370" y="330" class="small-title" text-anchor="middle">Scheduler</text>
      <path d="M 420 325 L 450 325" class="edge" marker-end="url(#arrow)" />

      <rect x="450" y="305" rx="6" ry="6" width="100" height="40" class="flow-step" />
      <text x="500" y="330" class="small-title" text-anchor="middle">kubelet</text>
      <path d="M 550 325 L 580 325" class="edge" marker-end="url(#arrow)" />

      <rect x="580" y="305" rx="6" ry="6" width="120" height="40" class="flow-step running" />
      <text x="640" y="330" class="small-title" text-anchor="middle">Pod Running</text>
    </svg>
  </div>
</template>

<style scoped>
.diagram-wrapper { width: 100%; }
.diagram { width: 100%; height: auto; }

.container-box { stroke-width: 3; }
.control-plane { fill: color-mix(in oklab, var(--rk-primary) 20%, black 80%); stroke: var(--rk-primary); }
.worker-nodes { fill: color-mix(in oklab, var(--rk-secondary) 20%, black 80%); stroke: var(--rk-secondary); }
.container-title { font: 700 16px/1.2 'Poppins', sans-serif; fill: #fff; }

.node { stroke-width: 2; }
.api-server { fill: color-mix(in oklab, var(--rk-primary) 45%, black 55%); stroke: var(--rk-primary); }
.etcd { fill: color-mix(in oklab, var(--rk-primary) 35%, black 65%); stroke: var(--rk-primary); }
.scheduler { fill: color-mix(in oklab, var(--rk-secondary) 45%, black 55%); stroke: var(--rk-secondary); }
.controller { fill: color-mix(in oklab, var(--rk-primary) 35%, black 65%); stroke: var(--rk-primary); }
.worker-node { fill: color-mix(in oklab, var(--rk-secondary) 25%, black 75%); stroke: var(--rk-secondary); }

.inner-node { stroke: #fff4; stroke-width: 1.5; }
.kubelet { fill: color-mix(in oklab, var(--rk-primary) 45%, black 55%); }
.kube-proxy { fill: color-mix(in oklab, var(--rk-secondary) 40%, black 60%); }
.pods { fill: url(#podGrad); }

.flow-container { fill: color-mix(in oklab, var(--rk-black) 15%, black 85%); stroke: #fff2; stroke-width: 2; }
.flow-title { font: 600 14px/1.2 'Poppins', sans-serif; fill: #fff; }
.flow-step { fill: color-mix(in oklab, var(--rk-primary) 35%, black 65%); stroke: var(--rk-primary); stroke-width: 2; }
.flow-step.api { fill: color-mix(in oklab, var(--rk-primary) 45%, black 55%); }
.flow-step.scheduler { fill: color-mix(in oklab, var(--rk-secondary) 45%, black 55%); stroke: var(--rk-secondary); }
.flow-step.running { fill: url(#podGrad); stroke: var(--rk-secondary); }

.title { font: 600 13px/1.2 'Poppins', sans-serif; fill: #fff; }
.sub { font: 400 11px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }
.small-title { font: 500 11px/1.2 'Quicksand', sans-serif; fill: #fff; }
.pod-label { fill: #fff; }
.hint { font: 500 11px/1.2 'Quicksand', sans-serif; fill: var(--rk-secondary); }
.edge { fill: none; stroke: var(--rk-primary); stroke-width: 2; }
</style>
