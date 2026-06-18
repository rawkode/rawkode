export const miniAppScheduledWorkflowName = "run-mini-app-workflow";

export function miniAppWorkflowRoutePath(slug: string, workflowId: string): string {
	return `/apps/${slug}/_workflows/${workflowId}`;
}
