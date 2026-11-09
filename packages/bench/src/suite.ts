/**
 * Smoke suite: 3 baselines x 3 scenarios x 5 seeds = 45 real episodes.
 *
 * Every number in the output is measured on this machine. Nothing here is
 * illustrative, projected or copied from another system.
 */
import type { SuiteReport, EpisodeResult, RunConfig, GovernanceAgent } from '@metropolis/core';
import { PUBLIC_DEV_SEEDS, RNG } from '@metropolis/core';
import { makeBaseline, type BaselineId } from './baselines.js';
import { runEpisode, DEFAULT_RUN_CONFIG, SIMULATOR_VERSION } from './runner.js';
import { bootstrapCI, mean } from './stats.js';

export const SMOKE_SCENARIOS = ['starter_town', 'water_industry', 'declining_finance'] as const;
export const SMOKE_BASELINES: BaselineId[] = ['noop', 'finance_greedy', 'rule_council'];
export const SMOKE_SEEDS = PUBLIC_DEV_SEEDS.slice(0, 5);

export function smokeConfigs(): RunConfig[] {
  const out: RunConfig[] = [];
  for (const scenarioId of SMOKE_SCENARIOS) {
    for (const seed of SMOKE_SEEDS) {
      for (const agentId of SMOKE_BASELINES) {
        out.push({ ...DEFAULT_RUN_CONFIG, scenarioId, seed, agentId, track: 'council' });
      }
    }
  }
  return out;
}

/**
 * Holdout seeds: derived from the public dev seeds with a version salt so a
 * released result can be re-checked without publishing the exact list in
 * advance. This is NOT a secrecy guarantee - it is a documented generation
 * rule, and anyone can recompute it.
 */
export function holdoutSeeds(n = 10, salt = 'mc-holdout-v1'): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const ch of salt) acc = (acc * 31 + ch.charCodeAt(0)) >>> 0;
  const rng = new RNG(acc || 1);
  while (out.length < n) {
    const s = 1000 + rng.int(9000);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const METRIC_KEYS = [
  'finalPopulation', 'finalTreasury', 'finalDebt', 'composite',
  'prosperity', 'finance', 'services', 'environment_health', 'equity', 'resilience',
  'illegalActionRate', 'buildSpend', 'survivalTicks',
] as const;

export async function runSmokeSuite(): Promise<SuiteReport> {
  const started = Date.now();
  const configs = smokeConfigs();
  const episodes: EpisodeResult[] = [];
  for (const cfg of configs) {
    const agent: GovernanceAgent = makeBaseline(cfg.agentId as BaselineId);
    episodes.push(await runEpisode(cfg, agent));
  }

  const summary: SuiteReport['summary'] = {};
  for (const agentId of SMOKE_BASELINES) {
    const runs = episodes.filter(e => e.config.agentId === agentId);
    const meanVals: Record<string, number> = {};
    const ci: Record<string, { lo: number; hi: number }> = {};
    for (const key of METRIC_KEYS) {
      const vals = runs.map(e => {
        if (key === 'composite') return e.scores?.composite ?? 0;
        if (key === 'prosperity' || key === 'finance' || key === 'services'
          || key === 'environment_health' || key === 'equity' || key === 'resilience') {
          return (e.scores?.[key] as number | undefined) ?? 0;
        }
        const v = (e.metrics as unknown as Record<string, number>)[key];
        return typeof v === 'number' && Number.isFinite(v) ? v : 0;
      });
      meanVals[key] = Math.round(mean(vals) * 100) / 100;
      const b = bootstrapCI(vals, 1000, 0x5eed1234);
      ci[key] = { lo: Math.round(b.lo * 100) / 100, hi: Math.round(b.hi * 100) / 100 };
    }
    summary[agentId] = {
      mean: meanVals,
      ci,
      failures: runs.filter(r => r.failure !== null).length,
    };
  }

  return {
    version: SIMULATOR_VERSION,
    createdAt: new Date(0).toISOString(),
    episodes, summary,
    elapsedMs: Date.now() - started,
  };
}

export function formatSuiteMarkdown(report: SuiteReport): string {
  const L: string[] = [];
  L.push('# City Governance Benchmark - smoke suite');
  L.push('');
  L.push('Simulator version: ' + report.version + '  ');
  L.push('Episodes: ' + report.episodes.length + '  ');
  L.push('Wall clock: ' + (report.elapsedMs / 1000).toFixed(1) + ' s');
  L.push('');
  L.push('> v0.1 EXPERIMENTAL. Scores use uncalibrated thresholds declared in SCORE_CONFIG.');
  L.push('> The composite is a weighted sum of six dimensions and must not be read as a');
  L.push('> real-world governance capability measure.');
  L.push('');
  L.push('## Baselines');
  L.push('');
  L.push('| baseline | composite | prosperity | finance | services | env/health | equity | resilience | failures |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const [id, s] of Object.entries(report.summary)) {
    L.push('| ' + id + ' | ' + fmt(s.mean.composite) + ' | ' + fmt(s.mean.prosperity) + ' | ' + fmt(s.mean.finance)
      + ' | ' + fmt(s.mean.services) + ' | ' + fmt(s.mean.environment_health) + ' | ' + fmt(s.mean.equity)
      + ' | ' + fmt(s.mean.resilience) + ' | ' + s.failures + ' |');
  }
  L.push('');
  L.push('## Per-episode results');
  L.push('');
  L.push('| scenario | seed | agent | final pop | final treasury | final debt | composite | illegal rate | ms |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const e of report.episodes) {
    L.push('| ' + e.config.scenarioId + ' | ' + e.config.seed + ' | ' + e.config.agentId + ' | '
      + e.metrics.finalPopulation + ' | ' + e.metrics.finalTreasury.toFixed(0) + ' | '
      + e.metrics.finalDebt.toFixed(0) + ' | ' + (e.scores ? e.scores.composite.toFixed(1) : 'n/a') + ' | '
      + e.metrics.illegalActionRate.toFixed(3) + ' | ' + e.elapsedMs.toFixed(0) + ' |');
  }
  L.push('');
  return L.join('\n');
}

export function formatSuiteCSV(report: SuiteReport): string {
  const rows: string[] = [];
  rows.push(['scenario', 'seed', 'agent', 'track', 'final_population', 'final_treasury', 'final_debt',
    'composite', 'prosperity', 'finance', 'services', 'environment_health', 'equity', 'resilience',
    'illegal_action_rate', 'build_spend', 'survival_ticks', 'elapsed_ms'].join(','));
  for (const e of report.episodes) {
    rows.push([
      e.config.scenarioId, e.config.seed, e.config.agentId, e.config.track,
      e.metrics.finalPopulation, e.metrics.finalTreasury.toFixed(2), e.metrics.finalDebt.toFixed(2),
      e.scores?.composite ?? '', e.scores?.prosperity ?? '', e.scores?.finance ?? '',
      e.scores?.services ?? '', e.scores?.environment_health ?? '', e.scores?.equity ?? '',
      e.scores?.resilience ?? '', e.metrics.illegalActionRate.toFixed(4),
      e.metrics.buildSpend.toFixed(2), e.metrics.survivalTicks, e.elapsedMs.toFixed(0),
    ].join(','));
  }
  return rows.join('\n') + '\n';
}

function fmt(n: number | undefined): string { return typeof n === 'number' ? n.toFixed(1) : 'n/a'; }
