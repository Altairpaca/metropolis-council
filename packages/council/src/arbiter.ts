/**
 * Deterministic arbiter.
 *
 * Takes the department proposals, scores them on public information only, and
 * selects at most one within the remaining budget. Every rejection carries a
 * machine-readable reason so the council log is auditable.
 */
import type { Observation, Proposal, Action } from '@metropolis/core';

export interface RankedProposal {
  proposal_id: string;
  role: string;
  score: number;
  reason: string;
  accepted: boolean;
}
export interface ArbitrationResult {
  winner: Proposal | null;
  ranked: RankedProposal[];
  totalCost: number;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Mirror of the core budget rule so the arbiter never proposes the impossible. */
function affordability(obs: Observation, p: Proposal): { ok: boolean; cost: number; why: string } {
  let cost = 0;
  for (const a of p.actions) {
    if (a.type === 'build') {
      const row = (obs.costFormula.build as Record<string, { cost: number }>)[a.category];
      cost += row ? row.cost : Number.POSITIVE_INFINITY;
    } else if (a.type === 'repay') {
      cost += a.amount;
    }
  }
  const available = obs.treasury + Math.max(0, obs.creditLimit - obs.debt);
  if (!Number.isFinite(cost)) return { ok: false, cost, why: 'unknown build category' };
  if (cost > obs.policy.constructionBudget && p.actions.some(a => a.type === 'build')) {
    return { ok: false, cost, why: 'exceeds constructionBudget ' + obs.policy.constructionBudget };
  }
  if (cost > available) return { ok: false, cost, why: 'exceeds available funds ' + Math.round(available) };
  return { ok: true, cost, why: '' };
}

/** Public-information utility of a proposal, in [0,1]-ish units. */
function utility(obs: Observation, p: Proposal): number {
  const demands = obs.economy.demands;
  const coverage = obs.coverage;
  const pollution = obs.services.pollution ?? 0;
  let u = 0;
  for (const a of p.actions) {
    if (a.type === 'noop') { u += 0.02; continue; }
    if (a.type === 'set_policy') {
      const patch = a.patch as Record<string, unknown>;
      if (typeof patch.taxRate === 'number') {
        const delta = (patch.taxRate as number) - obs.policy.taxRate;
        u += obs.treasury < 0 ? Math.max(0, delta) * 6 : -Math.abs(delta) * 2;
      }
      if (typeof patch.serviceLevel === 'number') {
        u += obs.debt > obs.creditLimit * 0.7 ? 0.15 : 0.05;
      }
      if (typeof patch.equityPriority === 'number' || typeof patch.envPriority === 'number' || typeof patch.growthPriority === 'number') u += 0.05;
    } else if (a.type === 'build') {
      switch (a.category) {
        case 'water_works': u += Math.max(0, 0.85 - coverage.water) * 1.6; break;
        case 'power_plant': u += Math.max(0, 0.85 - coverage.power) * 1.5; break;
        case 'clinic': u += Math.max(0, 0.8 - coverage.health) * 1.2; break;
        case 'school': u += Math.max(0, 0.8 - coverage.education) * 1.1; break;
        case 'transit_hub': u += obs.congestion * 0.9; break;
        case 'road_segment': u += Math.max(0, obs.congestion - 0.5) * 0.7; break;
        case 'bridge': u += Math.max(0, 0.6 - obs.connectivity) * 1.5; break;
        case 'park': u += Math.max(0, pollution - 0.3) * 1.1 + Math.max(0, 0.5 - obs.population.happiness) * 0.5; break;
        case 'res_zone': u += Math.max(0, demands.res - 0.4) * 0.9; break;
        case 'com_zone': u += Math.max(0, demands.com - 0.4) * 0.8; break;
        case 'ind_zone': u += Math.max(0, demands.ind - 0.45) * 0.7 - pollution * 0.3; break;
        case 'garbage_facility': u += Math.max(0, 0.8 - (obs.infra.garbage?.coverage ?? 1)) * 0.9; break;
        case 'sewage_plant': u += Math.max(0, 0.8 - (obs.infra.sewage?.coverage ?? 1)) * 0.8; break;
        case 'fire_station': u += Math.max(0, 0.8 - coverage.transit) * 0.5; break;
        default: u += 0.02;
      }
    } else if (a.type === 'repay') {
      u += obs.debt > 0 ? 0.25 : 0;
    } else if (a.type === 'borrow') {
      u += obs.treasury < 0 ? 0.1 : -0.05;
    }
  }
  // priority alignment: equity / environment / growth
  const equityGap = obs.regions.length
    ? Math.max(...obs.regions.map(r => r.serviceCoverage)) - Math.min(...obs.regions.map(r => r.serviceCoverage))
    : 0;
  if (p.role === 'welfare') u += equityGap * obs.policy.equityPriority * 0.8;
  if (p.role === 'industry_env') u += pollution * obs.policy.envPriority * 0.6;
  if (p.role === 'planning') u += (demands.res + demands.com + demands.ind) / 3 * obs.policy.growthPriority * 0.5;
  return clamp(u, 0, 3);
}

export class DeterministicArbiter {
  select(proposals: Proposal[], obs: Observation, budget: number): ArbitrationResult {
    const ranked: RankedProposal[] = [];
    let winner: Proposal | null = null;
    let bestScore = -Infinity;
    let totalCost = 0;

    for (const p of proposals) {
      const aff = affordability(obs, p);
      const aff2 = aff.cost > budget ? { ok: false, cost: aff.cost, why: 'exceeds remaining council budget ' + Math.round(budget) } : aff;
      const u = utility(obs, p);
      if (!aff2.ok) {
        ranked.push({ proposal_id: p.proposal_id, role: p.role, score: 0, reason: 'REJECTED: ' + aff2.why, accepted: false });
        continue;
      }
      // Cost is penalised in proportion to how much of the available cash it eats.
      const available = Math.max(1, obs.treasury + Math.max(0, obs.creditLimit - obs.debt));
      const costPenalty = (aff2.cost / available) * 0.6;
      const uncertaintyPenalty = clamp(p.uncertainty) * 0.35;
      const score = u - costPenalty - uncertaintyPenalty;
      ranked.push({ proposal_id: p.proposal_id, role: p.role, score, reason: 'utility ' + u.toFixed(3) + ', cost ' + Math.round(aff2.cost) + ', uncertainty ' + p.uncertainty.toFixed(2), accepted: false });
      if (score > bestScore) { bestScore = score; winner = p; }
    }
    if (winner) {
      totalCost = affordability(obs, winner).cost;
      const row = ranked.find(r => r.proposal_id === winner!.proposal_id);
      if (row) row.accepted = true;
    }
    ranked.sort((a, b) => Number(b.accepted) - Number(a.accepted) || b.score - a.score);
    return { winner, ranked, totalCost };
  }
}

/** Merge several actions into a single command action list, de-duplicating noop. */
export function mergeActions(actions: Action[]): Action[] {
  const real = actions.filter(a => a.type !== 'noop');
  return real.length ? real : [{ type: 'noop' }];
}
