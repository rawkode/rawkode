export async function mapWithConcurrency<TInput, TOutput>(
  inputs: TInput[],
  limit: number,
  worker: (input: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (limit < 1) {
    throw new Error("Concurrency limit must be >= 1");
  }

  const results: TOutput[] = new Array(inputs.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, inputs.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= inputs.length) {
        return;
      }
      results[index] = await worker(inputs[index]);
    }
  });

  await Promise.all(runners);
  return results;
}
