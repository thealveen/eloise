export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(ms));
    }, ms);
  });

  try {
    return await Promise.race([run(controller.signal), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
