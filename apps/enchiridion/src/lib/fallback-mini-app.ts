import type { ExtensionManifest } from "./types";

export const fallbackMiniAppDescription =
	"Static fallback mini app generated after autonomous app-builder repair attempts failed.";

interface FallbackContent {
	kicker: string;
	intro: string;
	sections: FallbackSection[];
}

interface FallbackSection {
	title: string;
	body?: string;
	bullets?: string[];
	code?: string;
}

export function isFallbackMiniAppManifest(manifest: Pick<ExtensionManifest, "description" | "bindings" | "hostApis">): boolean {
	return manifest.description.startsWith("Static fallback mini app")
		&& manifest.bindings.length === 0
		&& manifest.hostApis.length === 0;
}

export function fallbackPromptDescription(prompt: string): string {
	return `Static fallback request: ${normalizePrompt(prompt).slice(0, 500)}`;
}

export function fallbackPromptFromManifest(manifest: Pick<ExtensionManifest, "name" | "routes">): string {
	const routeDescription = manifest.routes
		.map((route) => route.description)
		.find((description): description is string => typeof description === "string" && description.startsWith("Static fallback request:"));

	if (routeDescription) {
		return routeDescription.replace(/^Static fallback request:\s*/, "").trim() || manifest.name;
	}

	return manifest.name;
}

export function fallbackSlugFromPrompt(prompt: string): string {
	const words = prompt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter((word) => word.length > 1 && !fallbackSlugStopWords.has(word));
	const slug = words.slice(0, 6).join("-");
	return slug || "mini-app";
}

export function normalizeSlug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 54)
		.replace(/-+$/g, "") || "mini-app";
}

export function fallbackNameFromSlug(slug: string): string {
	return slug
		.split("-")
		.filter(Boolean)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

export function renderFallbackMiniAppHtml(input: { name: string; prompt: string; notice?: string }): string {
	const prompt = normalizePrompt(input.prompt) || input.name;
	const content = buildFallbackContent(prompt);

	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>${escapeHtml(input.name)}</title>
		<style>
			:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
			body { margin: 0; background: #f7f8f3; color: #20211d; }
			main { max-width: 920px; margin: 0 auto; padding: 48px 24px 64px; }
			header { border-bottom: 1px solid #d6d9cd; padding-bottom: 24px; margin-bottom: 28px; }
			p { line-height: 1.65; }
			.notice { border: 1px solid #d8cf9d; background: #fff7d6; border-radius: 8px; padding: 14px 16px; margin: 0 0 18px; color: #4f4416; }
			.panel { border: 1px solid #d6d9cd; background: #ffffff; border-radius: 8px; padding: 22px; margin: 18px 0; }
			pre { background: #1f241f; color: #f5f7ef; border-radius: 8px; overflow-x: auto; padding: 18px; line-height: 1.55; }
			.kicker { color: #5f6b2d; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
			.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
			.item { border-left: 3px solid #6b7f32; padding-left: 14px; }
			code { background: #eef0e6; border-radius: 4px; padding: 2px 5px; }
		</style>
	</head>
	<body>
		<main>
			${input.notice ? `<div class="notice">${escapeHtml(input.notice)}</div>` : ""}
			<header>
				<div class="kicker">${escapeHtml(content.kicker)}</div>
				<h1>${escapeHtml(input.name)}</h1>
				<p>${escapeHtml(content.intro)}</p>
			</header>
			<section class="panel">
				<h2>Request</h2>
				<p>${escapeHtml(prompt)}</p>
			</section>
			<section class="grid" aria-label="Fallback content">
				${content.sections.map(renderFallbackSection).join("")}
			</section>
		</main>
	</body>
</html>`;
}

function buildFallbackContent(prompt: string): FallbackContent {
	const normalized = prompt.toLowerCase();
	if (normalized.includes("kubernetes") && normalized.includes("topology") && normalized.includes("spread")) {
		return kubernetesTopologySpreadFallback();
	}

	if (/\b(how to|how-to|tutorial|learn|guide)\b/i.test(prompt)) {
		const topic = promptTopic(prompt);
		return {
			kicker: "Generated static tutorial",
			intro: `A compact starter tutorial for ${topic}. This page is deterministic fallback content, so it favors clear structure over generated interactivity.`,
			sections: [
				{
					title: "Learning Path",
					bullets: [
						`Define the goal for ${topic} in one sentence before adding tools or automation.`,
						"Write the smallest runnable example and keep it visible while expanding the workflow.",
						"Add one verification step for each concept so the page can become an executable checklist later.",
					],
				},
				{
					title: "Practice Loop",
					bullets: [
						"Read the core concept.",
						"Apply it to a small sample.",
						"Record the result, failure mode, and next question.",
					],
				},
				{
					title: "Next Upgrade",
					body: "Ask Enchiridion to update this mini app with examples, commands, saved notes, or host-native components once the shape is useful.",
				},
			],
		};
	}

	return {
		kicker: "Enchiridion fallback mini app",
		intro: "This static app was generated because the autonomous Worker candidates did not pass validation or smoke testing.",
		sections: [
			{
				title: "Use It Now",
				body: "The route is live and can be replaced by asking the agent to update this mini app with more specific behavior.",
			},
			{
				title: "Make It Richer",
				body: "Add data capture, commands, editor blocks, or host API access once the workflow requirements are clear.",
			},
			{
				title: "Promote Later",
				body: "If this becomes important, promote it into host-native UI through an explicit rebuild.",
			},
		],
	};
}

function kubernetesTopologySpreadFallback(): FallbackContent {
	return {
		kicker: "Generated static tutorial",
		intro: "Topology spread constraints tell Kubernetes how to distribute matching Pods across failure domains such as nodes, zones, or regions.",
		sections: [
			{
				title: "Mental Model",
				bullets: [
					"Choose a topology key that exists on every eligible node, such as kubernetes.io/hostname for node spread or topology.kubernetes.io/zone for zone spread.",
					"Use a label selector that matches only the Pods you want balanced together.",
					"Set maxSkew to the largest acceptable difference between the busiest and emptiest matching domains.",
					"Pick whenUnsatisfiable: DoNotSchedule for hard placement or ScheduleAnyway for a soft preference.",
				],
			},
			{
				title: "Minimal Deployment Example",
				code: [
					"apiVersion: apps/v1",
					"kind: Deployment",
					"metadata:",
					"  name: web",
					"spec:",
					"  replicas: 6",
					"  selector:",
					"    matchLabels:",
					"      app: web",
					"  template:",
					"    metadata:",
					"      labels:",
					"        app: web",
					"    spec:",
					"      topologySpreadConstraints:",
					"        - maxSkew: 1",
					"          topologyKey: kubernetes.io/hostname",
					"          whenUnsatisfiable: DoNotSchedule",
					"          labelSelector:",
					"            matchLabels:",
					"              app: web",
					"      containers:",
					"        - name: web",
					"          image: nginx:1.27",
				].join("\n"),
			},
			{
				title: "Verification Checklist",
				bullets: [
					"Confirm the selected topology label is present on all target nodes.",
					"Apply the workload and inspect Pod placement with kubectl get pods -o wide.",
					"Scale replicas up and down to see whether skew remains within the configured bound.",
					"If Pods stay Pending, check scheduler events for missing labels, too few domains, or an overly strict maxSkew.",
				],
			},
			{
				title: "Common Failure Modes",
				bullets: [
					"The selector is too broad and balances unrelated Pods together.",
					"DoNotSchedule is used before the cluster has enough labeled domains to satisfy the constraint.",
					"Zone spread is requested but nodes are missing topology.kubernetes.io/zone labels.",
				],
			},
		],
	};
}

function promptTopic(prompt: string): string {
	const topic = prompt
		.replace(/\b(web|mini|worker)?\s*app\b/gi, " ")
		.replace(/\b(how to|how-to|tutorial|learn|guide|create|build|make|simple|new)\b/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	return topic || "this topic";
}

function renderFallbackSection(section: FallbackSection): string {
	return `<div class="item">
	<h2>${escapeHtml(section.title)}</h2>
	${section.body ? `<p>${escapeHtml(section.body)}</p>` : ""}
	${section.bullets ? `<ul>${section.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
	${section.code ? `<pre><code>${escapeHtml(section.code)}</code></pre>` : ""}
</div>`;
}

function normalizePrompt(prompt: string): string {
	return prompt.replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const fallbackSlugStopWords = new Set([
	"a",
	"an",
	"and",
	"app",
	"for",
	"how",
	"make",
	"mini",
	"new",
	"page",
	"simple",
	"site",
	"the",
	"to",
	"tool",
	"web",
	"with",
]);
