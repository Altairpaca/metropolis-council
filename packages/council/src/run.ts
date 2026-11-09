/**
 * Baseline / council runners.
 *
 * These are the functions the benchmark and the game both call. They are pure
 * and deterministic (except runLLM, which degrades to a deterministic path).
 */
import type { Observation, Command, Proposal, Action, AgentContext, LLMConfig } from '@metropolis/core';
import { ROLES, ruleProposalFor } from './agents.js';
import { DeterministicArbiter, mergeActions } from './arbiter.js';
import { runLLM as runLLMImpl, type RunLLMResult } from './llm.js';

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

export function runNoop(tick: number): Command {
  return {
    id: 'noop_' + tick, tick, actor: 'baseline',
    actions: [{ type: 'noop' }],
    rationale: 'No-op baseline: observes only.',
  };
}

/**
 * Finance-greedy baseline. Uses ONLY cash and debt visible in the observation:
 * no geography, no service quality, no demand signal. This is deliberately
 * shallow so it forms an honest lower bound rather than a strawman.
 */
export function runGreedy(obs: Observation): Command {
  const patch: Record<string, number | boolean> = {};
  const actions: Action[] = [];
  const [taxLo, taxHi] = obs.legalRanges.taxRate;
  const [svcLo, svcHi] = obs.legalRanges.serviceLevel;

  if (obs.treasury < 0 || obs.debt > obs.creditLimit * 0.6) {
    patch.taxRate = clamp(obs.policy.taxRate + 0.02, taxLo, taxHi);
    patch.serviceLevel = clamp(obs.policy.serviceLevel - 0.1, svcLo, svcHi);
    patch.constructionBudget = Math.max(0, obs.policy.constructionBudget * 0.85);
    patch.maintenanceBudget = Math.max(0, obs.policy.maintenanceBudget * 0.9);
  } else if (obs.treasury > obs.policy.constructionBudget * 5 && obs.debt > 0) {
    actions.push({ type: 'repay', amount: Math.min(obs.debt, Math.floor(obs.treasury * 0.25)) });
  } else if (obs.treasury > obs.policy.constructionBudget * 8) {
    patch.taxRate = clamp(obs.policy.taxRate - 0.01, taxLo, taxHi);
  }
  if (Object.keys(patch).length) actions.push({ type: 'set_policy', patch } as Action);
  if (actions.length === 0) actions.push({ type: 'noop' });
  return {
    id: 'greedy_' + obs.tick, tick: obs.tick, actor: 'baseline', actions,
    rationale: 'Finance-greedy: reacts to cash and debt only.',
  };
}

/**
 * The rule council: five departments propose from the public observation, a
 * deterministic arbiter ranks them, and exactly one command is emitted.
 * Never proposes more than the city can pay for.
 */
export function runRuleCouncil(
  obs: Observation,
  tick: number,
  budgetRemaining: number,
  history: Proposal[] = [],
): Command {
  // Fiscal discipline: a real council does not spend cash it needs to survive.
  // The envelope is the most conservative of:
  //   - the caller's remaining budget,
  //   - the legal monthly construction cap,
  //   - what recent cash flow can actually sustain while keeping a reserve.
  const recent = obs.recentReports.slice(-3);
  const avgNet = recent.length ? recent.reduce((a, r) => a + r.net, 0) / recent.length : 0;
  const cash = obs.treasury;
  const reserve = Math.max(800, cash * 0.12);
  const headroom = Math.max(0, cash - reserve);
  // Emergency spending is allowed when a service is failing or housing is full:
  // a city that will not invest while taps run dry is not being conservative,
  // it is just failing slowly.
  const weakest = Math.min(...Object.values(obs.coverage));
  const housingPressure = obs.economy.demands.res;
  const emergency = weakest < 0.70 || housingPressure > 0.55;
  const flowBudget = avgNet > 0
    ? avgNet * 4 + headroom * 0.35
    : headroom * (emergency ? 0.55 : 0.25);
  const budget = Math.max(0, Math.min(
    budgetRemaining,
    obs.policy.constructionBudget,
    cash + Math.max(0, obs.creditLimit - obs.debt),
    flowBudget,
  ));

  // Departments propose INSIDE the envelope, otherwise every package is rejected.
  const proposals: Proposal[] = ROLES.map(role => ruleProposalFor(role, obs, budget));
  const arbiter = new DeterministicArbiter();
  const result = arbiter.select(proposals, obs, budget);
  const winner = result.winner;
  const actions: Action[] = winner ? mergeActions(winner.actions) : [{ type: 'noop' }];
  const ranked = result.ranked.slice(0, 3).map(r => r.role + '=' + r.score.toFixed(2)).join(', ');
  void history;
  return {
    id: 'rule_' + tick,
    tick,
    actor: 'rule',
    role: winner ? winner.role : 'planning',
    actions,
    rationale: winner
      ? '[' + winner.role + '] ' + winner.rationale + ' | ranked: ' + ranked
      : 'No proposal cleared the arbiter.',
    uncertainty: winner ? winner.uncertainty : 1,
  };
}

/** Merge several proposals into one command (used by multi-agent experiments). */
export function proposalsToCommand(proposals: Proposal[], tick: number, actor: Command['actor']): Command {
  const actions: Action[] = proposals.length
    ? mergeActions(proposals.flatMap(p => p.actions))
    : [{ type: 'noop' }];
  const lead = proposals[0];
  return {
    id: actor + '_' + tick,
    tick,
    actor,
    role: lead?.role,
    actions,
    rationale: proposals.map(p => '[' + p.role + '] ' + p.rationale).join(' || ').slice(0, 900),
    uncertainty: proposals.length ? Math.max(...proposals.map(p => p.uncertainty)) : 1,
  };
}

export async function runLLM(ctx: AgentContext, cfg?: Partial<LLMConfig>): Promise<RunLLMResult> {
  return runLLMImpl(ctx, cfg);
}

export { DeterministicArbiter, mergeActions } from './arbiter.js';
export type { RankedProposal, ArbitrationResult } from './arbiter.js';
