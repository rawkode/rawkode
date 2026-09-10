export const workerName = (name: string, stage: string): string =>
	`apsides-${name}${stage === "production" ? "" : `-${stage}`}`;
