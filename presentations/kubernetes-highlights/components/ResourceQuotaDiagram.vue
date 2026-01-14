<template>
	<div class="resource-wrapper">
		<svg viewBox="0 0 900 480" class="diagram" role="img" aria-label="Resource Quota Allocation">
			<defs>
				<marker id="arrow" markerWidth="10" markerHeight="10" refX="10" refY="5" orient="auto-start-reverse">
					<path d="M0,0 L10,5 L0,10 z" fill="#5F5ED7" />
				</marker>
				<linearGradient id="resourceGrad" x1="0" y1="0" x2="1" y2="1">
					<stop offset="0%" stop-color="#5F5ED7" />
					<stop offset="100%" stop-color="#00CEFF" />
				</linearGradient>
				<linearGradient id="usedGrad" x1="0" y1="0" x2="1" y2="0">
					<stop offset="0%" stop-color="#10B981" />
					<stop offset="100%" stop-color="#34D399" />
				</linearGradient>
			</defs>

			<!-- Title -->
			<text x="450" y="32" class="diagram-title" text-anchor="middle">Namespace Resource Quota</text>

			<!-- Namespace Boundary -->
			<g v-click class="fade-in">
				<rect x="40" y="50" rx="12" ry="12" width="820" height="400" class="namespace-box" />
				<text x="60" y="80" class="namespace-label">Namespace: production</text>

				<!-- ResourceQuota Object -->
				<rect x="720" y="65" rx="8" ry="8" width="120" height="55" class="quota-obj" />
				<text x="780" y="90" class="quota-title" text-anchor="middle">ResourceQuota</text>
				<text x="780" y="108" class="quota-sub" text-anchor="middle">CPU: 4 cores</text>
				<text x="780" y="122" class="quota-sub" text-anchor="middle">Mem: 8Gi</text>
			</g>

			<!-- Resource Usage Bars -->
			<g v-click class="fade-in">
				<text x="70" y="145" class="section-title">CPU Allocation</text>

				<!-- CPU Bar Background -->
				<rect x="70" y="160" width="620" height="30" rx="6" ry="6" class="bar-bg" />
				<text x="700" y="180" class="bar-label">4 cores limit</text>

				<!-- CPU Used Bar -->
				<rect x="70" y="160" width="434" height="30" rx="6" ry="6" class="bar-used cpu" />
				<text x="530" y="180" class="bar-value">2.8 cores (70%)</text>
			</g>

			<g v-click class="fade-in">
				<text x="70" y="225" class="section-title">Memory Allocation</text>

				<!-- Memory Bar Background -->
				<rect x="70" y="240" width="620" height="30" rx="6" ry="6" class="bar-bg" />
				<text x="700" y="260" class="bar-label">8Gi limit</text>

				<!-- Memory Used Bar -->
				<rect x="70" y="240" width="527" height="30" rx="6" ry="6" class="bar-used memory" />
				<text x="615" y="260" class="bar-value">6.8Gi (85%)</text>
			</g>

			<g v-click class="fade-in">
				<text x="70" y="305" class="section-title">Pod Count</text>

				<!-- Pod Count Bar Background -->
				<rect x="70" y="320" width="620" height="30" rx="6" ry="6" class="bar-bg" />
				<text x="700" y="340" class="bar-label">20 pods limit</text>

				<!-- Pod Count Used Bar -->
				<rect x="70" y="320" width="465" height="30" rx="6" ry="6" class="bar-used pods" />
				<text x="550" y="340" class="bar-value">15 pods (75%)</text>
			</g>

			<!-- Pod Breakdown -->
			<g v-click class="fade-in">
				<text x="70" y="390" class="section-title">Pod Resource Breakdown</text>

				<!-- Pod 1 -->
				<rect x="70" y="410" rx="6" ry="6" width="180" height="25" class="pod-row" />
				<text x="85" y="427" class="pod-name">frontend-pod</text>
				<text x="170" y="427" class="pod-usage">500m / 1Gi</text>

				<!-- Pod 2 -->
				<rect x="260" y="410" rx="6" ry="6" width="180" height="25" class="pod-row" />
				<text x="275" y="427" class="pod-name">api-pod</text>
				<text x="360" y="427" class="pod-usage">1.0 / 2Gi</text>

				<!-- Pod 3 -->
				<rect x="450" y="410" rx="6" ry="6" width="180" height="25" class="pod-row" />
				<text x="465" y="427" class="pod-name">worker-pod</text>
				<text x="545" y="427" class="pod-usage">1.0 / 2Gi</text>

				<!-- Pod 4 -->
				<rect x="640" y="410" rx="6" ry="6" width="180" height="25" class="pod-row" />
				<text x="655" y="427" class="pod-name">db-pod</text>
				<text x="740" y="427" class="pod-usage">300m / 1.8Gi</text>
			</g>

			<!-- Warning Indicator -->
			<g v-click>
				<rect x="720" y="240" rx="8" ry="8" width="120" height="50" class="warning-box" />
				<text x="780" y="262" class="warning-title" text-anchor="middle">⚠ Warning</text>
				<text x="780" y="280" class="warning-text" text-anchor="middle">Memory at 85%</text>
			</g>
		</svg>

		<p class="caption">ResourceQuota enforces limits per namespace to prevent resource exhaustion</p>
	</div>
</template>

<script setup lang="ts">
	const props = defineProps<{ stage?: number }>();
</script>

<style scoped>
	.diagram {
		width: 100%;
		height: auto;
	}

	.diagram-title {
		font:
			700 18px/1.2 "Poppins",
			"Quicksand",
			sans-serif;
		fill: #fff;
	}

	/* Namespace */
	.namespace-box {
		fill: color-mix(in oklab, var(--rk-black) 6%, transparent);
		stroke: var(--rk-primary);
		stroke-width: 1.5;
	}
	.namespace-label {
		font:
			600 14px/1.2 "Poppins",
			sans-serif;
		fill: #fff;
	}

	/* ResourceQuota Object */
	.quota-obj {
		fill: color-mix(in oklab, var(--rk-secondary) 20%, transparent);
		stroke: var(--rk-secondary);
		stroke-width: 1.2;
	}
	.quota-title {
		font:
			600 12px/1.2 "Poppins",
			sans-serif;
		fill: #fff;
	}
	.quota-sub {
		font:
			400 10px/1.2 "Quicksand",
			sans-serif;
		fill: #fff;
		opacity: 0.8;
	}

	/* Section titles */
	.section-title {
		font:
			600 13px/1.2 "Poppins",
			sans-serif;
		fill: var(--rk-secondary);
	}

	/* Resource bars */
	.bar-bg {
		fill: color-mix(in oklab, var(--rk-black) 10%, transparent);
		stroke: #fff3;
	}
	.bar-used {
		fill: url(#resourceGrad);
	}
	.bar-used.cpu {
		fill: color-mix(in oklab, #8b5cf6 40%, transparent);
		stroke: #8b5cf6;
	}
	.bar-used.memory {
		fill: color-mix(in oklab, #ec4899 50%, transparent);
		stroke: #ec4899;
	}
	.bar-used.pods {
		fill: color-mix(in oklab, #10b981 40%, transparent);
		stroke: #10b981;
	}

	.bar-label {
		font:
			400 11px/1 "Quicksand",
			sans-serif;
		fill: #fff;
		opacity: 0.7;
	}
	.bar-value {
		font:
			600 11px/1 "Poppins",
			sans-serif;
		fill: #fff;
	}

	/* Pod rows */
	.pod-row {
		fill: color-mix(in oklab, var(--rk-black) 8%, transparent);
		stroke: #fff4;
		stroke-width: 1;
	}
	.pod-name {
		font:
			500 10px/1 "Quicksand",
			sans-serif;
		fill: #fff;
	}
	.pod-usage {
		font:
			400 10px/1 "Quicksand",
			sans-serif;
		fill: #fff;
		opacity: 0.8;
	}

	/* QoS indicators */
	.qos-guaranteed {
		fill: #10b981;
	}
	.qos-burstable {
		fill: #f59e0b;
	}
	.qos-label {
		font:
			500 10px/1 "Quicksand",
			sans-serif;
		fill: #fff;
		opacity: 0.9;
	}

	/* Warning */
	.warning-box {
		fill: color-mix(in oklab, #ef4444 20%, transparent);
		stroke: #ef4444;
		stroke-width: 1.2;
	}
	.warning-title {
		font:
			600 12px/1.2 "Poppins",
			sans-serif;
		fill: #ef4444;
	}
	.warning-text {
		font:
			400 10px/1.2 "Quicksand",
			sans-serif;
		fill: #fff;
	}

	/* Animations */
	.fade-in {
		transition: opacity 0.2s ease-in;
	}
	.caption {
		margin-top: 0.5rem;
		font-size: 0.85rem;
		opacity: 0.7;
		text-align: center;
	}
</style>
