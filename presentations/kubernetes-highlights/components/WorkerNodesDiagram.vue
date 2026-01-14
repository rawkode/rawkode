<template>
  <div class="diagram-wrapper">
    <svg viewBox="0 0 520 300" class="diagram" role="img" aria-label="Worker Nodes">
      <defs>
        <linearGradient id="podGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5F5ED7" />
          <stop offset="100%" stop-color="#00CEFF" />
        </linearGradient>
      </defs>

      <!-- Worker Nodes Box -->
      <rect x="20" y="20" rx="16" ry="16" width="480" height="260" class="container-box" />
      <text x="260" y="55" class="container-title" text-anchor="middle">Worker Nodes</text>

      <!-- Node 1 -->
      <rect x="40" y="75" rx="10" ry="10" width="210" height="185" class="node worker-node" />
      <text x="145" y="100" class="node-title" text-anchor="middle">Node 1</text>

      <rect x="55" y="115" rx="8" ry="8" width="85" height="50" class="inner-node kubelet" />
      <text x="98" y="145" class="small-title" text-anchor="middle">kubelet</text>

      <rect x="150" y="115" rx="8" ry="8" width="85" height="50" class="inner-node kube-proxy" />
      <text x="193" y="145" class="small-title" text-anchor="middle">kube-proxy</text>

      <rect x="55" y="175" rx="8" ry="8" width="180" height="70" class="inner-node pods" />
      <text x="145" y="205" class="title pod-label" text-anchor="middle">Pods</text>
      <text x="145" y="227" class="sub pod-label" text-anchor="middle">containers</text>

      <!-- Node 2 -->
      <rect x="270" y="75" rx="10" ry="10" width="210" height="185" class="node worker-node" />
      <text x="375" y="100" class="node-title" text-anchor="middle">Node 2</text>

      <rect x="285" y="115" rx="8" ry="8" width="85" height="50" class="inner-node kubelet" />
      <text x="328" y="145" class="small-title" text-anchor="middle">kubelet</text>

      <rect x="380" y="115" rx="8" ry="8" width="85" height="50" class="inner-node kube-proxy" />
      <text x="423" y="145" class="small-title" text-anchor="middle">kube-proxy</text>

      <rect x="285" y="175" rx="8" ry="8" width="180" height="70" class="inner-node pods" />
      <text x="375" y="205" class="title pod-label" text-anchor="middle">Pods</text>
      <text x="375" y="227" class="sub pod-label" text-anchor="middle">containers</text>
    </svg>
  </div>
</template>

<style scoped>
.diagram-wrapper { width: 100%; display: flex; justify-content: center; }
.diagram { width: auto; height: 45vh; }

.container-box {
  fill: color-mix(in oklab, var(--rk-secondary) 20%, black 80%);
  stroke: var(--rk-secondary);
  stroke-width: 3;
}
.container-title { font: 700 22px/1.2 'Poppins', sans-serif; fill: #fff; }

.node { stroke-width: 2; }
.worker-node { fill: color-mix(in oklab, var(--rk-secondary) 25%, black 75%); stroke: var(--rk-secondary); }
.node-title { font: 600 16px/1.2 'Poppins', sans-serif; fill: #fff; }

.inner-node { stroke: #fff4; stroke-width: 1.5; }
.kubelet { fill: color-mix(in oklab, var(--rk-primary) 45%, black 55%); }
.kube-proxy { fill: color-mix(in oklab, var(--rk-secondary) 40%, black 60%); }
.pods { fill: url(#podGrad); }

.title { font: 600 16px/1.2 'Poppins', sans-serif; fill: #fff; }
.small-title { font: 500 14px/1.2 'Quicksand', sans-serif; fill: #fff; }
.sub { font: 400 13px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }
.pod-label { fill: #fff; }
</style>
