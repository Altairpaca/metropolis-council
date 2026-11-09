/**
 * Scoring.
 *
 * v0.1 EXPERIMENTAL. The thresholds below are documented game parameters that
 * have NOT been calibrated by a full trial run. They are published so results
 * are reproducible and criticisable, not to claim psychometric validity.
 *
 * Six dimensions, weighted as declared in the benchmark proposal:
 *   prosperity 20, finance 20, services 20, environment_health 15, equity 10,
 *   resilience 15.
 * Hard floors (bankruptcy, chronic water shortage, service collapse) are
 * reported SEPARATELY and are never folded into the weighted score.
 */
import type { RawMetrics, DimensionScores, ScoreConfig } from '@metropolis/core';
import { normalize, mean } from './stats.js';

export const SCORE_CONFIG: ScoreConfig = {
  weights: { prosperity: 0.20, finance: 0.20, services: 0.20, environment_health: 0.15, equity: 0.10, resilience: 0.15 },
  thresholds: {
    sustainablePopulation: { bad: 800, good: 6000, higherIsBetter: true },
    employmentRate: { bad: 0.55, good: 0.92, higherIsBetter: true },
    happiness: { bad: 0.30, good: 0.80, higherIsBetter: true },
    treasuryHealth: { bad: -2000, good: 15000, higherIsBetter: true },
    debtRatio: { bad: 1.0, good: 0.0, higherIsBetter: false },
    serviceCoverage: { bad: 0.35, good: 0.95, higherIsBetter: true },
    waterReliability: { bad: 0.5, good: 0.98, higherIsBetter: true },
    powerReliability: { bad: 0.5, good: 0.98, higherIsBetter: true },
    pollution: { bad: 0.85, good: 0.05, higherIsBetter: false },
    healthIndex: { bad: 0.4, good: 0.9, higherIsBetter: true },
    commute: { bad: 70, good: 15, higherIsBetter: false },
    illegalRate: { bad: 0.5, good: 0.0, higherIsBetter: false },
    resilience: { bad: 0.2, good: 0.9, higherIsBetter: true },
  },
};

const avgTail = (xs: number[], fraction = 1): number => {
  if (!xs.length) return 0;
  const from = Math.max(0, Math.floor(xs.length * (1 - fraction)));
  return mean(xs.slice(from));
};

/**
 * Score an episode. For a bankrupt run the FULL window is still used with the
 * terminal values carried forward, so collapsing early cannot look like a win.
 */
export function scoreEpisode(raw: RawMetrics, cfg: ScoreConfig = SCORE_CONFIG): DimensionScores {
  const th = cfg.thresholds;
  const w = cfg.weights;
  const T = (k: string) => th[k] ?? { bad: 0, good: 1, higherIsBetter: true };

  const pop = raw.finalPopulation;
  const employ = 1 - avgTail(raw.unemployment);
  const happy = avgTail(raw.happiness);
  const treas = raw.finalTreasury;
  const debtRatio = raw.finalDebt / Math.max(1, 12000);
  const coverage = avgTail(raw.serviceCoverage);
  const water = avgTail(raw.waterReliability);
  const power = avgTail(raw.powerReliability);
  const pollution = avgTail(raw.pollution);
  const healthIdx = avgTail(raw.health);
  const commute = avgTail(raw.commuteTime);

  const prosperity = (
    normalize(pop, T('sustainablePopulation').bad, T('sustainablePopulation').good, true) * 0.5 +
    normalize(employ, T('employmentRate').bad, T('employmentRate').good, true) * 0.3 +
    normalize(happy, T('happiness').bad, T('happiness').good, true) * 0.2
  );
  const finance = (
    normalize(treas, T('treasuryHealth').bad, T('treasuryHealth').good, true) * 0.6 +
    normalize(debtRatio, T('debtRatio').bad, T('debtRatio').good, false) * 0.4
  );
  const services = (
    normalize(coverage, T('serviceCoverage').bad, T('serviceCoverage').good, true) * 0.6 +
    normalize(water, T('waterReliability').bad, T('waterReliability').good, true) * 0.2 +
    normalize(power, T('powerReliability').bad, T('powerReliability').good, true) * 0.2
  );
  const environmentHealth = (
    normalize(pollution, T('pollution').bad, T('pollution').good, false) * 0.55 +
    normalize(healthIdx, T('healthIndex').bad, T('healthIndex').good, true) * 0.45
  );
  // Equity: flatter service coverage across regions is better. The runner
  // appends a per-region spread proxy into pollution tail? No - we use the
  // explicit equityProxy if provided, else derive from service stability.
  const equity = normalize(raw.equityProxy ?? 0.5, 0.0, 1.0, true);
  const resilience = (
    normalize(raw.resilienceProxy ?? 0.5, T('resilience').bad, T('resilience').good, true) * 0.6 +
    normalize(commute, T('commute').bad, T('commute').good, false) * 0.4
  );

  const hardFloors = {
    bankrupt: raw.survivalTicks < raw.horizonTicks,
    chronicWaterShortage: avgTail(raw.waterReliability) < 0.6,
    serviceCollapse: avgTail(raw.serviceCoverage) < 0.35,
  };

  const composite =
    prosperity * w.prosperity + finance * w.finance + services * w.services +
    environmentHealth * w.environment_health + equity * w.equity + resilience * w.resilience;

  return {
    prosperity: round2(prosperity),
    finance: round2(finance),
    services: round2(services),
    environment_health: round2(environmentHealth),
    equity: round2(equity),
    resilience: round2(resilience),
    composite: round2(composite),
    hardFloors,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
