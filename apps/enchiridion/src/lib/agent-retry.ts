export const generateMiniAppWorkflowName = "generate-mini-app";

export type AgentRetryMode = "build" | "update";

export type AgentRetrySource = {
	app: string;
	block: string;
	buildDeadlineAt?: unknown;
	buildId?: unknown;
	isUntrackedMiniAppBuild?: boolean;
	operation?: unknown;
	prompt?: unknown;
	runId?: unknown;
	targetSlug?: unknown;
	title?: unknown;
	workflowName?: unknown;
};

export function retryModeForAgentBlock(source: AgentRetrySource): AgentRetryMode | null {
	if (source.app !== "agent") {
		return null;
	}
	if (source.operation === "update") {
		return "update";
	}
	if (
		source.operation === "create"
		|| source.workflowName === generateMiniAppWorkflowName
		|| source.isUntrackedMiniAppBuild === true
		|| (typeof source.title === "string" && /mini app build/i.test(source.title))
	) {
		return "build";
	}
	if (source.block === "error" && typeof source.prompt === "string" && source.prompt.trim()) {
		return "build";
	}
	return null;
}

export function formatAgentBuildMeta(source: AgentRetrySource, formatDeadline: (value: string) => string): string {
	const buildId = typeof source.buildId === "string" && source.buildId.trim() ? source.buildId.trim() : "";
	const runId = typeof source.runId === "string" && source.runId.trim() ? source.runId.trim() : "";
	const deadline = typeof source.buildDeadlineAt === "string" && source.buildDeadlineAt.trim()
		? formatDeadline(source.buildDeadlineAt.trim())
		: "";
	return [
		buildId ? `build ${buildId}` : "",
		runId ? `submission ${runId}` : "",
		deadline ? `deadline ${deadline}` : "",
	].filter(Boolean).join(" · ");
}
