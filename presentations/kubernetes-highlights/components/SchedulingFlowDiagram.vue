<template>
  <div class="diagram-wrapper">
    <svg viewBox="0 0 520 280" class="diagram" role="img" aria-label="Pod Scheduling Flow">
      <defs>
        <marker id="flowArrow" markerWidth="10" markerHeight="10" refX="10" refY="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#5F5ED7" />
        </marker>
        <linearGradient id="runningGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5F5ED7" />
          <stop offset="100%" stop-color="#00CEFF" />
        </linearGradient>
      </defs>

      <!-- Container -->
      <rect x="20" y="20" rx="14" ry="14" width="480" height="240" class="flow-container" />

      <!-- Row 1: kubectl → API Server → Scheduler -->

      <!-- Step 1: kubectl -->
      <rect x="40" y="50" rx="10" ry="10" width="130" height="70" class="flow-step" />
      <text x="105" y="80" class="title" text-anchor="middle">kubectl</text>
      <text x="105" y="102" class="sub" text-anchor="middle">create pod</text>
      <text x="105" y="138" class="step-num" text-anchor="middle">1</text>

      <!-- Arrow 1 -->
      <path d="M 170 85 L 200 85" class="arrow" marker-end="url(#flowArrow)" />

      <!-- Step 2: API Server -->
      <rect x="200" y="50" rx="10" ry="10" width="130" height="70" class="flow-step api" />
      <text x="265" y="80" class="title" text-anchor="middle">API Server</text>
      <text x="265" y="102" class="sub" text-anchor="middle">validates & stores</text>
      <text x="265" y="138" class="step-num" text-anchor="middle">2</text>

      <!-- Arrow 2 -->
      <path d="M 330 85 L 360 85" class="arrow" marker-end="url(#flowArrow)" />

      <!-- Step 3: Scheduler -->
      <rect x="360" y="50" rx="10" ry="10" width="130" height="70" class="flow-step scheduler" />
      <text x="425" y="80" class="title" text-anchor="middle">Scheduler</text>
      <text x="425" y="102" class="sub" text-anchor="middle">picks node</text>
      <text x="425" y="138" class="step-num" text-anchor="middle">3</text>

      <!-- Arrow 3: Down turn to kubelet -->
      <path d="M 425 120 L 425 145 L 185 145 L 185 160" class="arrow" marker-end="url(#flowArrow)" />

      <!-- Row 2: kubelet → Pod Running (centered) -->

      <!-- Step 4: kubelet -->
      <rect x="120" y="160" rx="10" ry="10" width="130" height="70" class="flow-step" />
      <text x="185" y="190" class="title" text-anchor="middle">kubelet</text>
      <text x="185" y="212" class="sub" text-anchor="middle">on selected node</text>
      <text x="185" y="248" class="step-num" text-anchor="middle">4</text>

      <!-- Arrow 4 -->
      <path d="M 250 195 L 280 195" class="arrow" marker-end="url(#flowArrow)" />

      <!-- Step 5: Pod Running -->
      <rect x="280" y="160" rx="10" ry="10" width="130" height="70" class="flow-step running" />
      <text x="345" y="190" class="title" text-anchor="middle">Pod Running</text>
      <text x="345" y="212" class="sub" text-anchor="middle">containers started</text>
      <text x="345" y="248" class="step-num" text-anchor="middle">5</text>
    </svg>
  </div>
</template>

<style scoped>
.diagram-wrapper { width: 100%; display: flex; justify-content: center; }
.diagram { width: auto; height: 45vh; }

.flow-container {
  fill: color-mix(in oklab, var(--rk-black) 15%, black 85%);
  stroke: #fff2;
  stroke-width: 2;
}

.flow-step {
  fill: color-mix(in oklab, var(--rk-primary) 35%, black 65%);
  stroke: var(--rk-primary);
  stroke-width: 2;
}
.flow-step.api { fill: color-mix(in oklab, var(--rk-primary) 45%, black 55%); }
.flow-step.scheduler { fill: color-mix(in oklab, var(--rk-secondary) 45%, black 55%); stroke: var(--rk-secondary); }
.flow-step.running { fill: url(#runningGrad); stroke: var(--rk-secondary); }

.title { font: 600 15px/1.2 'Poppins', sans-serif; fill: #fff; }
.sub { font: 400 12px/1.2 'Quicksand', sans-serif; fill: #fff; opacity: 0.8; }
.step-num { font: 700 16px/1 'Poppins', sans-serif; fill: var(--rk-secondary); }

.arrow { fill: none; stroke: var(--rk-primary); stroke-width: 2; }
</style>
