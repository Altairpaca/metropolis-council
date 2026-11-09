/**
 * Baseline governance agents.
 *
 * Each baseline sees exactly the same Observation as any model would, is
 * called at the same frequency, and receives the same call budget. None of them
 * touches the network.
 */
import type { Command, GovernanceAgent, AgentMeta, Observation } from '@metropolis/core';
import { runNoop, runGreedy, runRuleCouncil } from '@metropolis/council';

export type BaselineId = 'noop' | 'finance_greedy' | 'rule_council';

function freshMeta(): AgentMeta {
  return { callCount: 0, tokensIn: 0, tokensOut: 0, costUSD: 0, latencyMs: 0, errors: [], fallbackUsed: false };
}

export class BaselineAgent implements GovernanceAgent {
  readonly id: string;
  readonly meta: AgentMeta = freshMeta();

  constructor(readonly kind: BaselineId) {
    this.id = 'baseline_' + kind;
  }

  async decide(obs: Observation, ctx: { tick: number; track: 'mayor' | 'council'; callsLeft: number }): Promise<{ command: Command; meta: AgentMeta }> {
    const t0 = Date.now();
    let command: Command;
    if (this.kind === 'noop') {
      command = runNoop(ctx.tick);
    } else if (this.kind === 'finance_greedy') {
      command = runGreedy(obs);
    } else {
      const budget = Math.max(0, obs.treasury + Math.max(0, obs.creditLimit - obs.debt) * 0.5);
      command = runRuleCouncil(obs, ctx.tick, budget);
    }
    const dt = Date.now() - t0;
    this.meta.callCount += 1;
    this.meta.latencyMs += dt;
    return { command, meta: { ...this.meta } };
  }
}

export function makeBaseline(id: BaselineId): GovernanceAgent {
  return new BaselineAgent(id);
}
