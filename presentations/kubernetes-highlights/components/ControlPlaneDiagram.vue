<template>
  <div class="diagram-wrapper">
    <svg viewBox="0 0 500 280" class="diagram" role="img" aria-label="Control Plane">
      <defs>
        <linearGradient id="cpGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5F5ED7" />
          <stop offset="100%" stop-color="#00CEFF" />
        </linearGradient>
      </defs>

      <!-- Control Plane Box -->
      <rect x="20" y="20" rx="16" ry="16" width="460" height="240" class="container-box" />
      <text x="250" y="55" class="container-title" text-anchor="middle">Control Plane</text>

      <!-- API Server -->
      <rect x="40" y="80" rx="10" ry="10" width="130" height="70" class="node api-server" />
      <text x="105" y="110" class="title" text-anchor="middle">API Server</text>
      <text x="105" y="132" class="sub" text-anchor="middle">kube-apiserver</text>

      <!-- etcd -->
      <rect x="185" y="80" rx="10" ry="10" width="130" height="70" class="node etcd" />
      <text x="250" y="110" class="title" text-anchor="middle">etcd</text>
      <text x="250" y="132" class="sub" text-anchor="middle">key-value store</text>

      <!-- Scheduler -->
      <rect x="330" y="80" rx="10" ry="10" width="130" height="70" class="node scheduler" />
      <text x="395" y="110" class="title" text-anchor="middle">Scheduler</text>
      <text x="395" y="132" class="sub" text-anchor="middle">kube-scheduler</text>

      <!-- Controller Manager -->
      <rect x="120" y="170" rx="10" ry="10" width="260" height="70" class="node controller" />
      <text x="250" y="200" class="title" text-anchor="middle">Controller Manager</text>
      <text x="250" y="222" class="sub" text-anchor="middle">replication, endpoints, nodes</text>
    </svg>
  </div>
</template>

<style scoped>
.diagram-wrapper { width: 100%; display: flex; justify-content: center; }
.diagram { width: auto; height: 45vh; }

.container-box {
  fill: color-mix(in oklab, var(--rk-primary) 20%, black 80%);
  stroke: var(--rk-primary);
  stroke-width: 3;
}
.container-title { font: 700 22px/1.2 'Poppins', sans-serif; fill: #fff; }

.node { stroke-width: 2; }
.api-server { fill: color-mix(in oklab, var(--rk-primary) 45%, black 55%); stroke: var(--rk-primary); }
.etcd { fill: color-mix(in oklab, var(--rk-primary) 35%, black 65%); stroke: var(--rk-primary); }
.scheduler { fill: color-mix(in oklab, var(--rk-secondary) 45%, black 55%); stroke: var(--rk-secondary); }
.controller { fill: color-mix(in oklab, var(--rk-primary) 35%, black 65%); stroke: var(--rk-primary); }

.title { font: 600 16px/1.2 'Poppins', sans-serif; fill: #fff; }
.sub { font: 400 13px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }
</style>
