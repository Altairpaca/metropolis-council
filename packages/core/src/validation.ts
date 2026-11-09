/**
 * The single command queue gate. Pure: never mutates state.
 * Every mutation path in the whole project (GUI, rule agents, LLM, CLI) goes
 * through validateCommand -> applyCommand. Enforces whitelist, ranges, region
 * existence, budget caps and borrowing limits.
 */
import type { Action, Command, ValidationResult, WorldState, Policy } from './types.js';
import { COST, BALANCE, LEGAL_RANGES } from './constants.js';
import { getScenario } from './scenarios.js';

const BUILD_CATEGORIES = new Set(Object.keys(COST.build));
const ZONE_TARGETS = new Set(['res', 'com', 'ind', 'park', 'civic', 'none']);
const POLICY_BOUNDS: Record<keyof Policy, [number, number]> = {
  taxRate: LEGAL_RANGES.taxRate, serviceLevel: LEGAL_RANGES.serviceLevel,
  constructionBudget: LEGAL_RANGES.constructionBudget, maintenanceBudget: LEGAL_RANGES.maintenanceBudget,
  envPriority: LEGAL_RANGES.envPriority, equityPriority: LEGAL_RANGES.equityPriority,
  growthPriority: LEGAL_RANGES.growthPriority, borrowingAllowed: [0, 1], approvalThreshold: LEGAL_RANGES.approvalThreshold,
};

export function actionCost(a: Action, state: WorldState): number {
  if (a.type === 'build') return COST.build[a.category]?.cost ?? 0;
  if (a.type === 'borrow') return 0;      // increases debt, not cash cost
  if (a.type === 'repay') return a.amount; // cash out
  return 0;
}

export function validateCommand(state: WorldState, cmd: Command): ValidationResult {
  const errors: string[] = [];
  const accepted: Action[] = [];
  const rejected: { action: Action; reason: string }[] = [];
  if (!Array.isArray(cmd.actions)) return { ok: false, errors: ['actions must be an array'], accepted: [], rejected: [] };
  let constructionSpend = 0;
  let cashSpend = 0;
  let borrowTotal = 0;
  const regionIds = new Set(state.map.regions.map(r => r.id));

  for (const a of cmd.actions) {
    let reason = '';
    switch (a.type) {
      case 'noop': break;
      case 'set_policy': {
        if (!a.patch || typeof a.patch !== 'object') { reason = 'patch must be object'; break; }
        for (const [k, v] of Object.entries(a.patch)) {
          if (!(k in POLICY_BOUNDS)) { reason = 'unknown policy key ' + k; break; }
          if (typeof v === 'number') {
            const [lo, hi] = POLICY_BOUNDS[k as keyof Policy]!;
            if (!Number.isFinite(v) || v < lo || v > hi) { reason = 'policy ' + k + ' out of range [' + lo + ',' + hi + ']'; break; }
          } else if (k === 'borrowingAllowed' && typeof v !== 'boolean') { reason = 'borrowingAllowed must be boolean'; break; }
          else if (k !== 'borrowingAllowed' && typeof v !== 'number') { reason = 'policy ' + k + ' must be number'; break; }
        }
        break;
      }
      case 'set_zone': {
        if (!regionIds.has(a.region)) reason = 'unknown region ' + a.region;
        else if (!ZONE_TARGETS.has(a.target)) reason = 'invalid zone target';
        else if (!Number.isFinite(a.priority) || a.priority < 0 || a.priority > 1) reason = 'priority out of 0..1';
        else if (!Number.isFinite(a.maxBudget) || a.maxBudget < 0) reason = 'maxBudget must be >= 0';
        break;
      }
      case 'build': {
        if (!BUILD_CATEGORIES.has(a.category)) reason = 'non-whitelisted build category';
        else if (a.region && !regionIds.has(a.region)) reason = 'unknown region ' + a.region;
        else if (a.tile !== undefined && (!Number.isInteger(a.tile) || a.tile < 0 || a.tile >= state.map.tiles.length)) reason = 'tile index out of range';
        else if (a.tile !== undefined && !state.map.tiles[a.tile]!.buildable && a.category !== 'bridge') reason = 'tile not buildable';
        else {
          const cost = COST.build[a.category]!.cost;
          if (constructionSpend + cost > state.policy.constructionBudget && cmd.actor !== 'system') {
            reason = 'exceeds monthly constructionBudget (' + state.policy.constructionBudget + ')';
          } else constructionSpend += cost;
        }
        break;
      }
      case 'borrow': {
        if (!Number.isFinite(a.amount) || a.amount <= 0) reason = 'borrow amount must be > 0';
        else if (!state.policy.borrowingAllowed) reason = 'borrowing disabled by policy';
        else if (borrowTotal + a.amount > LEGAL_RANGES.borrowMax) reason = 'borrow exceeds per-command cap';
        else if (state.debt + borrowTotal + a.amount > state.creditLimit) reason = 'borrow exceeds credit limit';
        else borrowTotal += a.amount;
        break;
      }
      case 'repay': {
        if (!Number.isFinite(a.amount) || a.amount <= 0) reason = 'repay amount must be > 0';
        else if (a.amount > state.debt) reason = 'repay exceeds outstanding debt';
        else cashSpend += a.amount;
        break;
      }
      case 'set_service_level': {
        if (!Number.isFinite(a.level) || a.level < LEGAL_RANGES.serviceLevel[0] || a.level > LEGAL_RANGES.serviceLevel[1]) reason = 'service level out of range';
        break;
      }
      case 'approve_proposal': {
        if (!state.pending.some(p => p.id === a.proposalId)) reason = 'proposal not found in pending queue';
        break;
      }
      case 'reject_proposal': {
        if (!state.pending.some(p => p.id === a.proposalId)) reason = 'proposal not found in pending queue';
        else { /* rejecting a proposal whose cost exceeds budget is always allowed */ }
        break;
      }
      default: reason = 'unknown action type';
    }
    if (reason) { errors.push(reason); rejected.push({ action: a, reason }); }
    else accepted.push(a);
  }
  // Affordability: accepted construction + repay must fit treasury + available credit
  const available = state.treasury + Math.max(0, state.creditLimit - state.debt);
  if (cashSpend + constructionSpend > available + 1e-9) {
    errors.push('insufficient funds');
    // reject the accepted actions that cost money, keep no-op / policy ones
    const kept: Action[] = [];
    for (const a of accepted) {
      const c = actionCost(a, state);
      if (c > 0 && cashSpend + constructionSpend - c <= available) { /* keep */ kept.push(a); }
      else if (c > 0) { rejected.push({ action: a, reason: 'insufficient funds' }); }
      else kept.push(a);
    }
    // Simpler & stricter: mark ALL money-spending actions rejected
    for (let i = accepted.length - 1; i >= 0; i--) {
      if (actionCost(accepted[i]!, state) > 0) rejected.push({ action: accepted[i]!, reason: 'insufficient funds' });
    }
    const free = accepted.filter(a => actionCost(a, state) === 0 && a.type !== 'repay');
    return { ok: false, errors, accepted: free, rejected };
  }
  return { ok: errors.length === 0, errors, accepted, rejected };
}
