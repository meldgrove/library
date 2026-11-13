import { errorMessage, logger } from "@/lib/logger";

/**
 * Runs `run` now and every `intervalMs`, never twice at once. Returns a
 * function that stops and waits for the current run.
 */
export function startPolling(name: string, run: () => Promise<unknown>, intervalMs: number): () => Promise<void> {
  let running: Promise<unknown> | undefined;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = run()
      .catch((error: unknown) => logger.error({ error: errorMessage(error) }, `${name} failed`))
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
