/**
 * Deterministic rule agents - the default municipal council.
 *
 * Each department reads ONLY the public Observation (the same view an LLM
 * gets) and emits a bounded Proposal. No hidden state, no Math.random.
 */
import type { Observation, Proposal, Role, CouncilAgent, AgentContext, Action } from '@metropolis/core';

export const ROLES: Role[] = ['planning', 'finance', 'transport', 'welfare', 'industry_env'];

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

function cost(obs: Observation, category: string): number {
  const row = (obs.costFormula.build as Record<string, { cost: number; upkeep: number }>)[category];
  return row ? row.cost : 0;
}

function makeProposal(role: Role, tick: number, actions: Action[], expectedCost: number, rationale: string, uncertainty: number, conflicts: string[], observations: string[]): Proposal {
  return {
    proposal_id: role + '_' + tick,
    role, tick,
    observations,
    actions,
    expected_cost: expectedCost,
    rationale,
    uncertainty: clamp(uncertainty),
    conflicts,
  };
}

/** Building menu helpers: only propose what the cost formula actually lists. */
function buildAction(category: string, region?: string): Action {
  return region ? { type: 'build', category, region } as Action : { type: 'build', category } as Action;
}

function worstService(obs: Observation): { key: string; value: number } {
  let key = 'water', value = 1;
  for (const k of ['water', 'power', 'health', 'education', 'fire', 'transit']) {
    const v = obs.coverage[k] ?? 1;
    if (v < value) { value = v; key = k; }
  }
  return { key, value };
}

function worstRegion(obs: Observation): { id: string; coverage: number } | null {
  let best: { id: string; coverage: number } | null = null;
  for (const r of obs.regions) {
    if (r.zoneTarget === 'none') continue;
    if (!best || r.serviceCoverage < best.coverage) best = { id: r.id, coverage: r.serviceCoverage };
  }
  return best;
}

// ---------------------------------------------------------------- planning
export function planningProposal(obs: Observation, capitalBudget?: number): Proposal {
  const actions: Action[] = [];
  let spend = 0;
  const conflicts: string[] = [];
  const reasons: string[] = [];
  const cash = obs.treasury + Math.max(0, obs.creditLimit - obs.debt);
  const budget = Math.max(0, Math.min(capitalBudget ?? Number.POSITIVE_INFINITY, cash * 0.5, obs.policy.constructionBudget));
  const demands = obs.economy.demands;
  const target = worstRegion(obs)?.id ?? 'center';
  const canAfford = (c: number) => spend + c <= budget;
  const SATURATED = 0.92;

  // Capacity before demand. If the binding utility is saturated, adding more
  // housing only digs the hole deeper - so save for the plant first. When it is
  // unaffordable the council correctly spends NOTHING and accumulates cash,
  // which the arbiter sees as a rejected package rather than a silent mistake.
  const waterTight = obs.coverage.water > SATURATED;
  const powerTight = obs.coverage.power > SATURATED;
  if (demands.res > 0.28 && (waterTight || powerTight)) {
    const need = waterTight ? 'water_works' : 'power_plant';
    const c = cost(obs, need);
    if (canAfford(c)) { actions.push(buildAction(need, target)); spend += c; reasons.push(need + ' is the binding constraint at ' + (Math.max(obs.coverage.water, obs.coverage.power) * 100).toFixed(0) + '% coverage'); }
    else { actions.push({ type: 'noop' }); reasons.push('saving for ' + need + ' (' + c + ' cr vs envelope ' + Math.round(budget) + ')'); }
    if (spend > 0) conflicts.push('capacity spend delays housing');
    return makeProposal('planning', obs.tick, actions, spend,
      'Capacity-first planning. ' + reasons.join('; '), 0.2, conflicts, reasons);
  }

  // 1. Housing: designate land use (unlocks densification) and convert land.
  if (demands.res > 0.28) {
    actions.push({ type: 'set_zone', region: target, target: 'res', priority: 0.75, maxBudget: Math.min(4000, Math.max(500, budget * 0.6)) } as Action);
    reasons.push('designate residential in ' + target + ' (housing demand ' + demands.res.toFixed(2) + ')');
    const c = cost(obs, 'res_zone');
    if (canAfford(c)) { actions.push(buildAction('res_zone', target)); spend += c; reasons.push('convert land to housing'); }
  }
  // 2. Jobs and tax base so new residents can be employed and taxed.
  if (demands.com > 0.45 && canAfford(cost(obs, 'com_zone'))) {
    actions.push({ type: 'set_zone', region: target, target: 'com', priority: 0.55, maxBudget: Math.min(3000, Math.max(300, budget * 0.4)) } as Action);
    actions.push(buildAction('com_zone', target));
    spend += cost(obs, 'com_zone');
    reasons.push('commercial base (demand ' + demands.com.toFixed(2) + ')');
  }
  if (demands.ind > 0.55 && canAfford(cost(obs, 'ind_zone'))) {
    actions.push({ type: 'set_zone', region: target, target: 'ind', priority: 0.50, maxBudget: Math.min(3000, Math.max(300, budget * 0.4)) } as Action);
    actions.push(buildAction('ind_zone', target));
    spend += cost(obs, 'ind_zone');
    reasons.push('industrial base (demand ' + demands.ind.toFixed(2) + ')');
  }
  // 3. Congestion relief through capacity, cheaply.
  if (obs.congestion > 0.60 && canAfford(cost(obs, 'road_segment'))) {
    actions.push(buildAction('road_segment', target));
    spend += cost(obs, 'road_segment');
    reasons.push('congestion ' + (obs.congestion * 100).toFixed(0) + '%');
  }
  if (actions.length === 0) {
    actions.push({ type: 'noop' });
    reasons.push('no zoning or capacity action is justified this period');
  }
  if (spend > 0) conflicts.push('capital spend delays debt reduction');
  return makeProposal('planning', obs.tick, actions, spend,
    'Land-use planning. ' + reasons.join('; '),
    spend > cash * 0.4 ? 0.35 : 0.15, conflicts, reasons);
}

// ----------------------------------------------------------------- finance
export function financeProposal(obs: Observation): Proposal {
  const actions: Action[] = [];
  const reasons: string[] = [];
  const conflicts: string[] = [];
  const cash = obs.treasury;
  const debtRatio = obs.debt / Math.max(1, obs.creditLimit);
  const patch: Record<string, number | boolean> = {};

  const recent = obs.recentReports.slice(-3);
  const avgNet = recent.length ? recent.reduce((a, r) => a + r.net, 0) / recent.length : 0;
  if (cash < 0 || (avgNet < -40 && obs.policy.taxRate < obs.legalRanges.taxRate[1] - 1e-9)) {
    patch.taxRate = Math.min(obs.legalRanges.taxRate[1], obs.policy.taxRate + 0.02);
    reasons.push(cash < 0
      ? 'treasury ' + Math.round(cash) + ' cr is negative'
      : 'three-month average net ' + Math.round(avgNet) + ' cr');
    conflicts.push('higher tax suppresses demand');
  } else if (debtRatio > 0.7) {
    patch.serviceLevel = Math.max(obs.legalRanges.serviceLevel[0], obs.policy.serviceLevel - 0.1);
    patch.maintenanceBudget = Math.max(0, obs.policy.maintenanceBudget * 0.85);
    reasons.push('debt at ' + (debtRatio * 100).toFixed(0) + '% of credit limit');
    conflicts.push('service cuts degrade infrastructure quality');
  } else if (cash > obs.policy.constructionBudget * 4) {
    const repay = Math.min(obs.debt, Math.floor(cash * 0.2));
    if (repay > 0) {
      actions.push({ type: 'repay', amount: repay });
      reasons.push('idle cash ' + Math.round(cash) + ' cr; repaying ' + repay + ' cr');
    }
  }
  if (Object.keys(patch).length) actions.push({ type: 'set_policy', patch } as Action);
  if (actions.length === 0) {
    actions.push({ type: 'noop' });
    reasons.push('budget balanced at taxRate ' + obs.policy.taxRate.toFixed(3));
  }
  return makeProposal('finance', obs.tick, actions, 0,
    'Solvency-first budget stance. ' + reasons.join('; '),
    0.1, conflicts, reasons);
}

// --------------------------------------------------------------- transport
export function transportProposal(obs: Observation, capitalBudget?: number): Proposal {
  const actions: Action[] = [];
  const reasons: string[] = [];
  const conflicts: string[] = [];
  let spend = 0;
  const cash = obs.treasury + Math.max(0, obs.creditLimit - obs.debt);
  const budget = Math.max(0, Math.min(capitalBudget ?? Number.POSITIVE_INFINITY, cash * 0.45, obs.policy.constructionBudget));

  if (obs.congestion > 0.6) {
    const hub = cost(obs, 'transit_hub');
    const road = cost(obs, 'road_segment');
    if (hub <= budget) { actions.push(buildAction('transit_hub', worstRegion(obs)?.id)); spend += hub; reasons.push('congestion ' + (obs.congestion * 100).toFixed(0) + '% - transit relief chosen over more lanes'); }
    else if (road <= budget) { actions.push(buildAction('road_segment', worstRegion(obs)?.id)); spend += road; reasons.push('congestion ' + (obs.congestion * 100).toFixed(0) + '% - road capacity'); }
    conflicts.push('transit hubs have high upkeep');
  } else if (obs.connectivity < 0.55) {
    const bridge = cost(obs, 'bridge');
    if (bridge <= budget) { actions.push(buildAction('bridge')); spend += bridge; reasons.push('connectivity ' + obs.connectivity.toFixed(2) + ' below 0.55'); conflicts.push('bridge is the single most expensive item'); }
    else { actions.push({ type: 'noop' }); reasons.push('bridge unaffordable (' + bridge + ' cr vs budget ' + Math.round(budget) + ')'); }
  } else {
    actions.push({ type: 'noop' });
    reasons.push('congestion ' + (obs.congestion * 100).toFixed(0) + '% and connectivity ' + obs.connectivity.toFixed(2) + ' are acceptable');
  }
  return makeProposal('transport', obs.tick, actions, spend,
    'Mobility diagnosis: ' + reasons.join('; '),
    0.2, conflicts, reasons);
}

// ----------------------------------------------------------------- welfare
export function welfareProposal(obs: Observation, capitalBudget?: number): Proposal {
  const actions: Action[] = [];
  const reasons: string[] = [];
  const conflicts: string[] = [];
  let spend = 0;
  const cash = obs.treasury + Math.max(0, obs.creditLimit - obs.debt);
  const budget = Math.max(0, Math.min(capitalBudget ?? Number.POSITIVE_INFINITY, cash * 0.5, obs.policy.constructionBudget));

  const worst = worstService(obs);
  const map: Record<string, string> = { water: 'water_works', power: 'power_plant', health: 'clinic', education: 'school', fire: 'fire_station', transit: 'transit_hub' };
  if (worst.value < 0.8) {
    const cat = map[worst.key] ?? 'clinic';
    const c = cost(obs, cat);
    if (c <= budget) {
      actions.push(buildAction(cat, worstRegion(obs)?.id));
      spend += c;
      reasons.push(worst.key + ' coverage ' + (worst.value * 100).toFixed(0) + '% is the weakest service');
    } else {
      actions.push({ type: 'set_policy', patch: { equityPriority: Math.min(1, obs.policy.equityPriority + 0.1) } } as Action);
      reasons.push(worst.key + ' coverage ' + (worst.value * 100).toFixed(0) + '% but ' + cat + ' unaffordable');
    }
  }
  if (obs.population.happiness < 0.5) {
    const park = cost(obs, 'park');
    if (spend + park <= budget) { actions.push(buildAction('park', worstRegion(obs)?.id)); spend += park; reasons.push('happiness ' + obs.population.happiness.toFixed(2) + ' below 0.50'); }
    conflicts.push('parks trade capital for slow wellbeing gains');
  }
  if (actions.length === 0) { actions.push({ type: 'noop' }); reasons.push('all service coverage above 80%'); }
  return makeProposal('welfare', obs.tick, actions, spend,
    'Service-first stance. ' + reasons.join('; '),
    0.2, conflicts, reasons);
}

// ------------------------------------------------------------ industry_env
export function industryEnvProposal(obs: Observation, capitalBudget?: number): Proposal {
  const actions: Action[] = [];
  const reasons: string[] = [];
  const conflicts: string[] = [];
  let spend = 0;
  const cash = obs.treasury + Math.max(0, obs.creditLimit - obs.debt);
  const budget = Math.max(0, Math.min(capitalBudget ?? Number.POSITIVE_INFINITY, cash * 0.45, obs.policy.constructionBudget));
  const pollution = obs.services.pollution ?? 0;

  if (pollution > 0.45) {
    const park = cost(obs, 'park');
    const garbage = cost(obs, 'garbage_facility');
    if (park <= budget) { actions.push(buildAction('park', worstRegion(obs)?.id)); spend += park; reasons.push('pollution ' + (pollution * 100).toFixed(0) + '% - green buffer'); }
    else if (garbage <= budget) { actions.push(buildAction('garbage_facility')); spend += garbage; reasons.push('pollution ' + (pollution * 100).toFixed(0) + '% - waste handling'); }
    conflicts.push('green buffers consume buildable land');
  }
  if (obs.economy.demands.ind > 0.55) {
    const ind = cost(obs, 'ind_zone');
    if (spend + ind <= budget) { actions.push(buildAction('ind_zone', worstRegion(obs)?.id)); spend += ind; reasons.push('industrial demand ' + obs.economy.demands.ind.toFixed(2)); }
    conflicts.push('industry adds pollution');
  }
  if (actions.length === 0) { actions.push({ type: 'noop' }); reasons.push('pollution ' + (pollution * 100).toFixed(0) + '% and industrial demand ' + obs.economy.demands.ind.toFixed(2) + ' need no action'); }
  return makeProposal('industry_env', obs.tick, actions, spend,
    'Balanced growth stance. ' + reasons.join('; '),
    0.25, conflicts, reasons);
}

const PROPOSERS: Record<Role, (obs: Observation, capitalBudget?: number) => Proposal> = {
  planning: planningProposal,
  finance: financeProposal,
  transport: transportProposal,
  welfare: welfareProposal,
  industry_env: industryEnvProposal,
};

export class RuleAgent implements CouncilAgent {
  readonly kind = 'rule' as const;
  constructor(readonly id: string, private readonly role: Role) {}
  async decide(ctx: AgentContext): Promise<Proposal> {
    return PROPOSERS[this.role](ctx.observation);
  }
}

export function makeRuleCouncil(): CouncilAgent[] {
  return ROLES.map(r => new RuleAgent('rule_' + r, r));
}

export class NoopAgent implements CouncilAgent {
  readonly kind = 'noop' as const;
  readonly id = 'noop';
  async decide(ctx: AgentContext): Promise<Proposal> {
    return makeProposal('planning', ctx.observation.tick, [{ type: 'noop' }], 0,
      'No action: observation reviewed and no intervention justified.', 0, [], []);
  }
}
export function makeNoopAgent(): CouncilAgent { return new NoopAgent(); }

export function ruleProposalFor(role: Role, obs: Observation, capitalBudget?: number): Proposal {
  return PROPOSERS[role](obs, capitalBudget);
}
