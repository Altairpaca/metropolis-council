/**
 * Offline mock council agents.
 *
 * These are PROTOCOL TEST DOUBLE ONLY. They never touch the network and they
 * are never presented as real model results. Each behaviour exercises one
 * failure path of the adapter/validator pipeline.
 */
import type { AgentContext, CouncilAgent, Proposal, Action } from '@metropolis/core';
import { ruleProposalFor } from './agents.js';

export type MockBehavior = 'valid' | 'malformed' | 'overspend' | 'illegal' | 'timeout' | 'rate429';

export const MOCK_BEHAVIORS: MockBehavior[] = ['valid', 'malformed', 'overspend', 'illegal', 'timeout', 'rate429'];

export class MockLLMAgent implements CouncilAgent {
  readonly kind = 'llm' as const;
  readonly id: string;
  constructor(private readonly behavior: MockBehavior, private readonly role: Proposal['role'] = 'planning') {
    this.id = 'mock_' + behavior;
  }

  async decide(ctx: AgentContext): Promise<Proposal> {
    const obs = ctx.observation;
    const base = ruleProposalFor(this.role, obs);
    switch (this.behavior) {
      case 'valid':
        return { ...base, proposal_id: 'mock_valid_' + obs.tick };
      case 'malformed':
        // Simulates a model returning prose instead of JSON. The adapter would
        // reject this; the mock returns an empty-action proposal so the pipeline
        // still sees a structurally valid object with no effect.
        return { ...base, proposal_id: 'mock_malformed_' + obs.tick, actions: [{ type: 'noop' } as Action], rationale: 'MALFORMED: model returned prose, adapter fell back.', uncertainty: 1 };
      case 'overspend': {
        const actions: Action[] = [];
        for (let i = 0; i < 6; i++) actions.push({ type: 'build', category: 'power_plant' } as Action);
        return { ...base, proposal_id: 'mock_overspend_' + obs.tick, actions, expected_cost: 999999, rationale: 'OVERSPEND: proposed six plants regardless of budget.', uncertainty: 0.9 };
      }
      case 'illegal':
        return {
          ...base, proposal_id: 'mock_illegal_' + obs.tick,
          actions: [
            { type: 'set_policy', patch: { taxRate: 5 } } as Action,
            { type: 'set_zone', region: 'atlantis', target: 'res', priority: 0.5, maxBudget: 100 } as Action,
          ],
          rationale: 'ILLEGAL: out-of-range tax and a nonexistent region.', uncertainty: 0.8,
        };
      case 'timeout':
        // A deterministic stand-in for a hung request: no throwing, no network.
        return { ...base, proposal_id: 'mock_timeout_' + obs.tick + '_fallback', rationale: '[deterministic fallback: upstream timeout] ' + base.rationale, uncertainty: 0.5 };
      case 'rate429':
        return { ...base, proposal_id: 'mock_429_' + obs.tick + '_fallback', rationale: '[deterministic fallback: upstream 429] ' + base.rationale, uncertainty: 0.5 };
    }
  }
}

export function makeMockLLM(behavior: MockBehavior, role: Proposal['role'] = 'planning'): CouncilAgent {
  return new MockLLMAgent(behavior, role);
}
