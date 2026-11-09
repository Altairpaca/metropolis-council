/**
 * Episode runner.
 *
 * One episode = (simulator version, scenario, seed, agent, budgets, horizon).
 * The runner:
 *  - builds the initial state deterministically,
 *  - calls the agent at a fixed decision period with the public Observation,
 *  - validates every command through the SAME validator the game uses,
 *  - steps the fixed-tick world,
 *  - records hashes before/after each command so the run can be replayed,
 *  - accumulates raw metrics for scoring.
 *
 * Two tracks:
 *  - 'mayor':  the tested agent sets policy; a FIXED rule council executes
 *              capital planning within the budget the mayor leaves room for.
 *  - 'council': a FIXED scripted mayor maintains a stable policy envelope; the
 *              tested agent is the council and controls the actual actions.
 */
import {
  createInitialState, stepWorld, stateHash, getObservation, validateCommand,
  getScenario, SCENARIOS,
} from '@metropolis/core';
import type {
  RunConfig, EpisodeResult, GovernanceAgent, AgentMeta, Observation, Command, Action,
  RawMetrics, SnapshotRecord, ActionRecord, ReplayRecord, WorldState,
} from '@metropolis/core';
import { runRuleCouncil } from '@metropolis/council';
import { scoreEpisode, SCORE_CONFIG } from './scoring.js';
import { mean } from './stats.js';

export const SIMULATOR_VERSION = '0.1.0';

export const DEFAULT_RUN_CONFIG: Omit<RunConfig, 'scenarioId' | 'seed' | 'agentId'> = {
  track: 'council',
  maxDecisionCalls: 40,
  maxTokens: 0,
  months: 120,
  decisionPeriod: 3,
};

/** Fixed mayor policy envelope used on the council track (deterministic script). */
function scriptedMayorCommand(tick: number, state: WorldState): Command {
  const actions: Action[] = [];
  if (tick === 0) {
    actions.push({ type: 'set_policy', patch: { taxRate: 0.10, serviceLevel: 1.0, constructionBudget: 3200, maintenanceBudget: 1900 } });
  }
  if (tick > 0 && tick % 24 === 0 && state.treasury > 6000) {
    actions.push({ type: 'set_policy', patch: { constructionBudget: Math.min(6000, state.policy.constructionBudget + 400) } });
  }
  if (actions.length === 0) actions.push({ type: 'noop' });
  return { id: 'mayor_script_' + tick, tick, actor: 'system', role: 'mayor', actions, rationale: 'Fixed mayor script for the council track.' };
}

function emptyMeta(): AgentMeta {
  return { callCount: 0, tokensIn: 0, tokensOut: 0, costUSD: 0, latencyMs: 0, errors: [], fallbackUsed: false };
}

export async function runEpisode(cfg: RunConfig, agent: GovernanceAgent): Promise<EpisodeResult> {
  const started = Date.now();
  const scenario = getScenario(cfg.scenarioId);
  const months = cfg.months ?? scenario.months;
  const decisionPeriod = Math.max(1, cfg.decisionPeriod ?? 3);
  let state = createInitialState(cfg.seed, scenario.difficulty, { scenario: { ...scenario, seed: cfg.seed } });
  const regionIds = state.map.regions.map(r => r.id);

  const snapshots: SnapshotRecord[] = [];
  const actions: ActionRecord[] = [];
  const replayEntries: ReplayRecord['entries'] = [];
  const cost = emptyMeta();

  const population: number[] = [];
  const treasury: number[] = [];
  const debt: number[] = [];
  const gdp: number[] = [];
  const happiness: number[] = [];
  const health: number[] = [];
  const unemployment: number[] = [];
  const commuteTime: number[] = [];
  const serviceCoverage: number[] = [];
  const pollution: number[] = [];
  const netMigration: number[] = [];
  const waterReliability: number[] = [];
  const powerReliability: number[] = [];
  const regionCoverage: number[][] = [];
  let illegalSeen = 0;
  let buildSpend = 0;
  let maintenanceSpend = 0;
  let decisions = 0;
  let failure: EpisodeResult['failure'] = null;
  let pendingAgentRecord: ActionRecord | null = null;

  const coverageOf = (obs: Observation) => mean(['water', 'power', 'health', 'education', 'fire', 'transit'].map(k => obs.coverage[k] ?? 0));

  for (let m = 0; m < months; m++) {
    if (state.status !== 'running') {
      failure = { kind: state.status, tick: state.tick };
      break;
    }
    const obs = getObservation(state);
    const cmds: Command[] = [];

    const mayDecide = state.tick % decisionPeriod === 0 && decisions < cfg.maxDecisionCalls;
    if (mayDecide) {
      let agentCommand: Command | null = null;
      if (cfg.track === 'mayor') {
        const r = await agent.decide(obs, { tick: state.tick, track: 'mayor', callsLeft: cfg.maxDecisionCalls - decisions });
        agentCommand = r.command;
        accumulate(cost, r.meta);
        // The mayor's policy envelope constrains the fixed council executor.
        cmds.push(agentCommand);
        const councilBudget = Math.max(0, Math.min(agentCommand.actions.some(a => a.type === 'set_policy')
          ? obs.policy.constructionBudget : obs.policy.constructionBudget, obs.treasury * 0.6));
        cmds.push(runRuleCouncil(obs, state.tick, councilBudget));
        decisions++;
      } else {
        cmds.push(scriptedMayorCommand(state.tick, state));
        const r = await agent.decide(obs, { tick: state.tick, track: 'council', callsLeft: cfg.maxDecisionCalls - decisions });
        agentCommand = r.command;
        accumulate(cost, r.meta);
        cmds.push(agentCommand);
        decisions++;
      }
      // Validation record for the agent command (the addressable decision).
      if (agentCommand) {
        const v = validateCommand(state, agentCommand);
        if (v.rejected.length) illegalSeen += 1;
        for (const a of v.accepted) {
          if (a.type === 'build') {
            const row = obs.costFormula.build[a.category];
            buildSpend += row ? row.cost : 0;
          }
          if (a.type === 'set_policy' && typeof a.patch.maintenanceBudget === 'number') maintenanceSpend += a.patch.maintenanceBudget;
        }
        const before = stateHash(state);
        pendingAgentRecord = {
          tick: state.tick, command: agentCommand,
          hashBefore: before, hashAfter: '',
          validation: v,
        };
      }
    } else if (cfg.track === 'council') {
      // Keep the fixed mayor envelope active every month, not only on decision ticks.
      cmds.push(scriptedMayorCommand(state.tick, state));
    }

    // Replay must record EVERY command applied in this step, otherwise the
    // recorded trajectory cannot reproduce the state hash.
    const hashBeforeStep = stateHash(state);
    for (const c of cmds) {
      replayEntries.push({ tick: state.tick, command: c, hashBefore: hashBeforeStep, hashAfter: '' });
    }
    state = stepWorld(state, cmds);
    const afterStep = stateHash(state);
    for (let i = Math.max(0, replayEntries.length - cmds.length); i < replayEntries.length; i++) {
      replayEntries[i]!.hashAfter = afterStep;
    }
    if (pendingAgentRecord) {
      pendingAgentRecord.hashAfter = afterStep;
      actions.push(pendingAgentRecord);
      pendingAgentRecord = null;
    }

    // Metrics AFTER the step (state.tick has already advanced).
    const obsAfter = getObservation(state);
    population.push(state.population.total);
    treasury.push(state.treasury);
    debt.push(state.debt);
    gdp.push(state.economy.gdp);
    happiness.push(state.population.happiness);
    health.push(state.population.health);
    unemployment.push(state.population.unemployment);
    commuteTime.push(state.population.commuteTime);
    serviceCoverage.push(coverageOf(obsAfter));
    pollution.push(state.infra.pollution);
    netMigration.push(state.population.netMigration);
    waterReliability.push(state.services.waterReliability);
    powerReliability.push(state.services.powerReliability);
    regionCoverage.push(regionIds.map(id => {
      const r = obsAfter.regions.find(x => x.id === id);
      return r ? r.serviceCoverage : 0;
    }));

    if (state.tick % 12 === 0 || m === months - 1) {
      snapshots.push({ tick: state.tick, stateHash: afterStep, treasury: round2(state.treasury), population: state.population.total });
    }
  }

  // Equity proxy: 1 - normalised spread of service coverage across regions.
  const spread = regionCoverage.length
    ? mean(regionCoverage.map(row => Math.max(...row) - Math.min(...row)))
    : 0;
  const equityProxy = Math.max(0, Math.min(1, 1 - spread * 2));
  // Resilience proxy: how well the city held services through its worst month.
  const worstCoverage = serviceCoverage.length ? Math.min(...serviceCoverage) : 0;
  const resilienceProxy = Math.max(0, Math.min(1, worstCoverage));

  const raw: RawMetrics = {
    population, treasury, debt, gdp, happiness, health, unemployment, commuteTime,
    serviceCoverage, pollution, netMigration, waterReliability, powerReliability,
    illegalActionRate: decisions ? illegalSeen / decisions : 0,
    buildSpend, maintenanceSpend,
    survivalTicks: state.tick,
    finalPopulation: state.population.total,
    finalTreasury: state.treasury,
    finalDebt: state.debt,
    horizonTicks: months,
    equityProxy, resilienceProxy, regionCoverage, regionIds,
  };

  const finalHash = stateHash(state);
  const scores = scoreEpisode(raw, SCORE_CONFIG);
  const replay: ReplayRecord = {
    scenarioId: cfg.scenarioId, seed: cfg.seed, difficulty: scenario.difficulty,
    entries: replayEntries, finalHash, version: SIMULATOR_VERSION,
  };

  return {
    config: { ...cfg, months },
    version: SIMULATOR_VERSION,
    stateHashFinal: finalHash,
    snapshots, actions, metrics: raw, scores,
    failure: failure ?? (state.status !== 'running' ? { kind: state.status, tick: state.tick } : null),
    cost,
    elapsedMs: Date.now() - started,
    replay,
  };
}

function accumulate(acc: AgentMeta, m: AgentMeta): void {
  acc.callCount += m.callCount;
  acc.tokensIn += m.tokensIn;
  acc.tokensOut += m.tokensOut;
  acc.costUSD += m.costUSD;
  acc.latencyMs += m.latencyMs;
  acc.fallbackUsed = acc.fallbackUsed || m.fallbackUsed;
  for (const e of m.errors) if (!acc.errors.includes(e)) acc.errors.push(e);
}
function round2(n: number): number { return Math.round(n * 100) / 100; }

export function resolveScenario(id: string) {
  return SCENARIOS[id] ?? getScenario(id);
}
