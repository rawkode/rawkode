<template>
  <div class="probe-sim-wrapper">
    <svg viewBox="0 0 900 520" class="diagram" role="img" aria-label="Kubernetes Probe Simulator">
      <defs>
        <linearGradient id="simGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5F5ED7" />
          <stop offset="100%" stop-color="#00CEFF" />
        </linearGradient>
        <filter id="glowGreen">
          <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
          <feFlood flood-color="#10B981" result="glowColor"/>
          <feComposite in="glowColor" in2="coloredBlur" operator="in"/>
          <feMerge>
            <feMergeNode/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
        <filter id="glowRed">
          <feGaussianBlur stdDeviation="4" result="coloredBlur"/>
          <feFlood flood-color="#EF4444" result="glowColor"/>
          <feComposite in="glowColor" in2="coloredBlur" operator="in"/>
          <feMerge>
            <feMergeNode/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>

      <!-- Title -->
      <text x="450" y="35" class="diagram-title" text-anchor="middle">Kubernetes Probe Simulator</text>

      <!-- Deployment Container -->
      <rect x="30" y="55" rx="16" ry="16" width="840" height="300" class="deployment-box" />
      <text x="60" y="85" class="deployment-title">Deployment: my-app</text>
      <text x="820" y="85" class="replicas-badge" text-anchor="end">{{ readyCount }}/3 Ready</text>

      <!-- Pods -->
      <g v-for="(pod, idx) in pods" :key="pod.name">
        <!-- Pod Container -->
        <rect
          :x="80 + idx * 280"
          y="105"
          rx="12"
          ry="12"
          width="240"
          height="230"
          :class="['pod-box', pod.status.toLowerCase().replace(' ', '-')]"
          :style="pod.status === 'CrashLoopBackOff' ? 'animation: shake 0.3s ease-in-out;' : ''"
        />

        <!-- Pod Name -->
        <text :x="200 + idx * 280" y="135" class="pod-name" text-anchor="middle">{{ pod.name }}</text>

        <!-- Container Box -->
        <rect
          :x="105 + idx * 280"
          y="150"
          rx="8"
          ry="8"
          width="190"
          height="60"
          :class="['container-box', { crashed: pod.status === 'CrashLoopBackOff' }]"
        />
        <text :x="200 + idx * 280" y="185" class="container-label" text-anchor="middle">Container: app</text>

        <!-- Status -->
        <rect
          :x="105 + idx * 280"
          y="220"
          rx="6"
          ry="6"
          width="190"
          height="28"
          :class="['status-box', pod.status === 'Running' ? 'running' : pod.status === 'NotReady' ? 'not-ready' : 'crashed']"
        />
        <text :x="200 + idx * 280" y="239" class="status-text" text-anchor="middle">{{ pod.status }}</text>

        <!-- Restarts -->
        <text :x="200 + idx * 280" y="270" class="restarts-text" text-anchor="middle">Restarts: {{ pod.restarts }}</text>

        <!-- Buttons -->
        <foreignObject :x="105 + idx * 280" y="282" width="190" height="50">
          <div class="button-row">
            <button
              class="probe-btn liveness"
              @click="failLiveness(idx)"
              :disabled="pod.status !== 'Running'"
            >Fail Liveness</button>
            <button
              class="probe-btn readiness"
              @click="failReadiness(idx)"
              :disabled="pod.status !== 'Running'"
            >Fail Readiness</button>
          </div>
        </foreignObject>
      </g>

      <!-- Service Box -->
      <rect x="30" y="375" rx="12" ry="12" width="840" height="130" class="service-box" />
      <text x="450" y="405" class="service-title" text-anchor="middle">Service: my-app-svc (ClusterIP)</text>
      <text x="450" y="425" class="service-sub" text-anchor="middle">Endpoints receiving traffic:</text>

      <!-- Endpoint Badges -->
      <g v-for="(pod, idx) in pods" :key="'ep-' + pod.name">
        <rect
          :x="145 + idx * 250"
          y="440"
          rx="8"
          ry="8"
          width="160"
          height="50"
          :class="['endpoint-box', pod.ready ? 'ready' : 'not-ready']"
        />
        <text :x="225 + idx * 250" y="460" class="endpoint-name" text-anchor="middle">{{ pod.name }}</text>
        <text :x="225 + idx * 250" y="480" :class="['endpoint-status', pod.ready ? 'ready' : 'not-ready']" text-anchor="middle">
          {{ pod.ready ? 'Receiving Traffic' : 'Removed' }}
        </text>

        <!-- Traffic dots animation -->
        <g v-if="pod.ready" class="traffic-dots">
          <circle :cx="175 + idx * 250" cy="455" r="3" class="traffic-dot" />
          <circle :cx="190 + idx * 250" cy="455" r="3" class="traffic-dot" style="animation-delay: 0.2s" />
          <circle :cx="205 + idx * 250" cy="455" r="3" class="traffic-dot" style="animation-delay: 0.4s" />
        </g>
      </g>

      <!-- Traffic flow lines from pods to service -->
      <g v-for="(pod, idx) in pods" :key="'line-' + pod.name">
        <path
          :d="`M ${200 + idx * 280} 335 L ${225 + idx * 250} 440`"
          :class="['traffic-line', { active: pod.ready }]"
        />
      </g>
    </svg>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

interface PodState {
  name: string
  status: 'Running' | 'CrashLoopBackOff' | 'NotReady'
  restarts: number
  ready: boolean
}

const pods = ref<PodState[]>([
  { name: 'Pod A', status: 'Running', restarts: 0, ready: true },
  { name: 'Pod B', status: 'Running', restarts: 0, ready: true },
  { name: 'Pod C', status: 'Running', restarts: 0, ready: true },
])

const readyCount = computed(() => pods.value.filter(p => p.ready).length)

function failLiveness(idx: number) {
  const pod = pods.value[idx]
  if (pod.status !== 'Running') return

  pod.status = 'CrashLoopBackOff'
  pod.ready = false

  // Auto-recover after 2s (container restart)
  setTimeout(() => {
    pod.restarts++
    pod.status = 'Running'
    pod.ready = true
  }, 2000)
}

function failReadiness(idx: number) {
  const pod = pods.value[idx]
  if (pod.status !== 'Running') return

  pod.status = 'NotReady'
  pod.ready = false

  // Auto-recover after 3s
  setTimeout(() => {
    pod.status = 'Running'
    pod.ready = true
  }, 3000)
}
</script>

<style scoped>
.probe-sim-wrapper {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.diagram {
  width: 80vw;
  max-width: 1000px;
  height: auto;
}

.diagram-title {
  font: 700 22px/1.2 'Poppins', sans-serif;
  fill: #fff;
}

/* Deployment */
.deployment-box {
  fill: color-mix(in oklab, var(--rk-primary) 12%, transparent);
  stroke: var(--rk-primary);
  stroke-width: 2;
}

.deployment-title {
  font: 600 16px/1.2 'Poppins', sans-serif;
  fill: var(--rk-secondary);
}

.replicas-badge {
  font: 600 14px/1.2 'Quicksand', sans-serif;
  fill: #10B981;
}

/* Pods */
.pod-box {
  fill: color-mix(in oklab, var(--rk-black) 8%, transparent);
  stroke: #fff3;
  stroke-width: 1.5;
  transition: all 0.3s ease;
}

.pod-box.crashloopbackoff {
  stroke: #EF4444;
  stroke-width: 2;
  filter: url(#glowRed);
}

.pod-box.notready {
  stroke: #F59E0B;
  stroke-width: 2;
}

.pod-name {
  font: 600 14px/1.2 'Poppins', sans-serif;
  fill: #fff;
}

/* Container */
.container-box {
  fill: color-mix(in oklab, #10B981 20%, transparent);
  stroke: #10B981;
  stroke-width: 1.5;
  transition: all 0.3s ease;
}

.container-box.crashed {
  fill: color-mix(in oklab, #EF4444 30%, transparent);
  stroke: #EF4444;
  animation: pulse-red 0.5s ease-in-out infinite;
}

.container-label {
  font: 500 12px/1.2 'Quicksand', sans-serif;
  fill: #fff;
  opacity: 0.9;
}

/* Status */
.status-box {
  transition: all 0.3s ease;
}

.status-box.running {
  fill: color-mix(in oklab, #10B981 25%, transparent);
  stroke: #10B981;
}

.status-box.not-ready {
  fill: color-mix(in oklab, #F59E0B 25%, transparent);
  stroke: #F59E0B;
}

.status-box.crashed {
  fill: color-mix(in oklab, #EF4444 25%, transparent);
  stroke: #EF4444;
}

.status-text {
  font: 600 11px/1.2 'Quicksand', sans-serif;
  fill: #fff;
}

.restarts-text {
  font: 500 12px/1.2 'Quicksand', sans-serif;
  fill: #fff;
  opacity: 0.8;
}

/* Buttons */
.button-row {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.probe-btn {
  padding: 6px 10px;
  border-radius: 6px;
  font: 600 10px/1.2 'Quicksand', sans-serif;
  cursor: pointer;
  border: none;
  transition: all 0.2s ease;
}

.probe-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.probe-btn.liveness {
  background: color-mix(in oklab, #EF4444 80%, black);
  color: white;
}

.probe-btn.liveness:hover:not(:disabled) {
  background: #EF4444;
  transform: scale(1.05);
}

.probe-btn.readiness {
  background: color-mix(in oklab, #F59E0B 80%, black);
  color: white;
}

.probe-btn.readiness:hover:not(:disabled) {
  background: #F59E0B;
  transform: scale(1.05);
}

/* Service */
.service-box {
  fill: color-mix(in oklab, var(--rk-secondary) 10%, transparent);
  stroke: var(--rk-secondary);
  stroke-width: 1.5;
}

.service-title {
  font: 600 15px/1.2 'Poppins', sans-serif;
  fill: var(--rk-secondary);
}

.service-sub {
  font: 400 12px/1.2 'Quicksand', sans-serif;
  fill: #fff;
  opacity: 0.8;
}

/* Endpoints */
.endpoint-box {
  transition: all 0.3s ease;
}

.endpoint-box.ready {
  fill: color-mix(in oklab, #10B981 20%, transparent);
  stroke: #10B981;
  stroke-width: 1.5;
}

.endpoint-box.not-ready {
  fill: color-mix(in oklab, #EF4444 15%, transparent);
  stroke: #EF4444;
  stroke-width: 1;
  stroke-dasharray: 4 2;
}

.endpoint-name {
  font: 600 11px/1.2 'Poppins', sans-serif;
  fill: #fff;
}

.endpoint-status {
  font: 500 10px/1.2 'Quicksand', sans-serif;
}

.endpoint-status.ready {
  fill: #10B981;
}

.endpoint-status.not-ready {
  fill: #EF4444;
}

/* Traffic animation */
.traffic-line {
  fill: none;
  stroke: #fff2;
  stroke-width: 2;
  stroke-dasharray: 4 4;
  transition: all 0.3s ease;
}

.traffic-line.active {
  stroke: var(--rk-secondary);
  animation: dash 1s linear infinite;
}

.traffic-dot {
  fill: var(--rk-secondary);
  animation: pulse-traffic 1s ease-in-out infinite;
}

@keyframes dash {
  to {
    stroke-dashoffset: -8;
  }
}

@keyframes pulse-traffic {
  0%, 100% { opacity: 0.3; r: 3; }
  50% { opacity: 1; r: 4; }
}

@keyframes pulse-red {
  0%, 100% { opacity: 0.8; }
  50% { opacity: 1; }
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-5px); }
  75% { transform: translateX(5px); }
}
</style>
