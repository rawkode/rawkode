export const workerName = (name: string, stage: string): string =>
	`enchiridion-${name}${stage === "production" ? "" : `-${stage}`}`;
