export function buildFollowUpPrompt(input: {
	contextPrompt?: string;
	contextResponse?: string;
	prompt: string;
}): string {
	const contextPrompt = input.contextPrompt?.trim();
	const contextResponse = input.contextResponse?.trim();
	if (!contextPrompt && !contextResponse) {
		return input.prompt;
	}

	return [
		"Continue this prior Enchiridion agent exchange.",
		contextPrompt ? `Previous request:\n${contextPrompt}` : "",
		contextResponse ? `Previous response:\n${contextResponse}` : "",
		`Follow-up request:\n${input.prompt}`,
	].filter(Boolean).join("\n\n");
}
