/** Hard wait bound for adapters such as Secrets Store that expose no AbortSignal. */
export const withinVoiceDeadline = async <T>(
	action: () => Promise<T>,
	milliseconds = 5000,
): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(action),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Voice operation deadline")),
					milliseconds,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};
