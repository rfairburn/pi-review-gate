/** Compute the exponential cap and optional downward jitter for one retry. */
export function computeRetryDelay(base: number, max: number, jitter: boolean, retry: number): number {
  const ceiling = Math.min(max, base * 2 ** Math.max(0, retry - 1));
  return jitter ? Math.floor(ceiling * (0.5 + Math.random() * 0.5)) : ceiling;
}
