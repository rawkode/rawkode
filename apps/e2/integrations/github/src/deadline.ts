/** Stop waiting at the caller's shared deadline; late failures are consumed. */
export const beforeDeadline = async <T>(
	promise: Promise<T>,
	deadline: number,
): Promise<T | undefined> => {
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		void promise.catch(() => {});
		return undefined;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), remaining);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};
