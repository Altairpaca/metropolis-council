/**
 * Statistical helpers. All randomness comes from the deterministic core RNG so
 * a bootstrap interval is reproducible given the same inputs.
 */
import { RNG } from '@metropolis/core';

export interface CI {
  mean: number;
  lo: number;
  hi: number;
  n: number;
}

export function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const v = values.reduce((a, b) => a + (b - m) * (b - m), 0) / (values.length - 1);
  return Math.sqrt(v);
}

/**
 * Percentile bootstrap 95% CI for the mean.
 * Seeded so the same input always yields the same interval.
 */
export function bootstrapCI(values: number[], n = 2000, seed = 0x5eed1234): CI {
  if (!values.length) return { mean: 0, lo: 0, hi: 0, n: 0 };
  if (values.length === 1) return { mean: values[0]!, lo: values[0]!, hi: values[0]!, n: 1 };
  const rng = new RNG(seed);
  const means = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < values.length; j++) s += values[rng.int(values.length)]!;
    means[i] = s / values.length;
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(n * 0.025)] ?? means[0]!;
  const hi = means[Math.min(n - 1, Math.floor(n * 0.975))] ?? means[n - 1]!;
  return { mean: mean(values), lo, hi, n: values.length };
}

/** Linear normalisation into 0..100, clamped at both ends. */
export function normalize(x: number, bad: number, good: number, higherIsBetter = true): number {
  if (!Number.isFinite(x)) return 0;
  if (good === bad) return x >= good ? 100 : 0;
  const t = higherIsBetter ? (x - bad) / (good - bad) : (bad - x) / (bad - good);
  return Math.max(0, Math.min(100, t * 100));
}

/** Sum with a stable order so floating point noise does not vary run to run. */
export function stableSum(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}
