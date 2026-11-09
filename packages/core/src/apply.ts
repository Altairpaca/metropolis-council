/**
 * applyCommand: the ONLY function that mutates a WorldState. It clones,
 * validates, applies accepted actions to the clone, writes ledger + events,
 * and returns the new state. Pure from the caller's perspective.
 */
import type { Action, Command, ValidationResult, WorldState, UtilityKey, BuildCategory, GameEvent } from './types.js';
import { COST, BALANCE, DIFFICULTY } from './constants.js';
import { validateCommand } from './validation.js';
import { idx } from './map.js';

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

const UTILITY_OF: Partial<Record<BuildCategory, UtilityKey>> = {
  power_plant: 'power', water_works: 'water', sewage_plant: 'sewage', garbage_facility: 'garbage',
  clinic: 'health', school: 'education', fire_station: 'fire', transit_hub: 'transit',
};

let eventCounter = 0;
function ev(state: WorldState, kind: string, title: string, text: string, severity: GameEvent['severity'], data?: Record<string, number>): GameEvent {
  return { id: 'e' + (state.tick) + '_' + (eventCounter++), tick: state.tick, kind, title, text, severity, data };
}
function log(state: WorldState, actor: string, category: string, delta: number, note: string) {
  state.ledger.push({ tick: state.tick, actor, category, delta, note });
  if (state.ledger.length > BALANCE.ledgerCap) state.ledger.splice(0, state.ledger.length - BALANCE.ledgerCap);
}

/** Recompute derived capacity of a utility from its built units. */
function recomputeCapacity(state: WorldState, key: UtilityKey) {
  const u = state.infra[key];
  const spec = COST.build[(Object.keys(UTILITY_OF) as BuildCategory[]).find(k => UTILITY_OF[k] === key)!];
  u.capacity = u.units * spec.capacity * (0.75 + 0.25 * u.quality);
}

function applyOne(state: WorldState, a: Action, cmd: Command) {
  const actor = cmd.actor + (cmd.role ? ':' + cmd.role : '');
  switch (a.type) {
    case 'noop': break;
    case 'set_policy': {
      Object.assign(state.policy, a.patch);
      log(state, actor, 'policy', 0, 'policy updated: ' + Object.keys(a.patch).join(','));
      break;
    }
    case 'set_zone': {
      state.zones[a.region] = { id: a.region, target: a.target, priority: a.priority, maxBudget: a.maxBudget };
      log(state, actor, 'zoning', 0, 'zone ' + a.region + ' -> ' + a.target);
      break;
    }
    case 'build': {
      const spec = COST.build[a.category]!;
      const cost = spec.cost;
      state.treasury -= cost;
      log(state, actor, 'construction', -cost, 'build ' + a.category + (a.region ? ' @' + a.region : ''));
      const key = UTILITY_OF[a.category];
      if (key) { state.infra[key].units += 1; recomputeCapacity(state, key); }
      if (a.category === 'road_segment' || a.category === 'bridge') {
        const n = state.roads.nodes.length;
        const r = a.region ?? 'center';
        const reg = state.map.regions.find(x => x.id === r) ?? state.map.regions[4]!;
        state.roads.nodes.push({ id: n + 1, x: Math.round(reg.center.x), y: Math.round(reg.center.y) });
        const prev = Math.max(0, n - 1);
        state.roads.edges.push({ a: prev, b: n + 1, capacity: spec.capacity, load: 0, type: a.category === 'bridge' ? 'bridge' : 'street' });
        if (a.category === 'bridge') state.roads.bridgeCount += 1;
      }
      // Spatial footprint: mark up to 6 buildable tiles in/near the region
      const regionId = a.region ?? 'center';
      const reg = state.map.regions.find(x => x.id === regionId);
      const cells = reg ? reg.cells : state.map.regions[4]!.cells;
      let placed = 0;
      for (const c of cells) {
        if (placed >= 6) break;
        const t = state.map.tiles[c];
        if (t && t.buildable && t.landUse === 'empty') {
          t.landUse = a.category.endsWith('_zone') ? a.category.slice(0, 3) as typeof t.landUse
            : (a.category === 'park' ? 'park' : 'civic');
          t.density = Math.min(1, t.density + 0.25);
          placed++;
        }
      }
      // Roads also seed a connected starter grid around spawn on first build
      if (state.roads.edges.length <= 2) seedStarterRoads(state);
      state.landVersion += 1;
      break;
    }
    case 'borrow': {
      state.debt += a.amount; state.treasury += a.amount;
      log(state, actor, 'borrow', a.amount, 'loan drawn');
      state.events.push(ev(state, 'finance', 'Loan drawn', 'Borrowed ' + Math.round(a.amount) + ' cr; debt now ' + Math.round(state.debt) + ' cr.', 'warn', { amount: a.amount }));
      break;
    }
    case 'repay': {
      state.treasury -= a.amount; state.debt -= a.amount;
      log(state, actor, 'repay', -a.amount, 'debt repayment');
      break;
    }
    case 'set_service_level': {
      state.policy.serviceLevel = a.level;
      // serviceLevel scales effective capacity
      for (const k of Object.keys(UTILITY_OF).map(k => UTILITY_OF[k as BuildCategory]!) as UtilityKey[]) {
        const u = state.infra[k]; u.coverage = Math.min(1, u.coverage * (0.7 + 0.3 * a.level));
      }
      log(state, actor, 'policy', 0, 'service level -> ' + a.level);
      break;
    }
    case 'approve_proposal': {
      const p = state.pending.find(x => x.id === a.proposalId);
      if (p) {
        state.pending = state.pending.filter(x => x.id !== a.proposalId);
        // Execute the proposal's actions through the SAME validator recursively
        const sub: Command = { id: 'approved_' + p.id, tick: state.tick, actor: 'player', actions: p.actions, rationale: p.rationale };
        const subRes = applyCommand(state, sub);
        Object.assign(state, subRes.state);
        state.events.push(ev(state, 'council', 'Proposal approved', p.rationale, 'info'));
      }
      break;
    }
    case 'reject_proposal': {
      state.pending = state.pending.filter(x => x.id !== a.proposalId);
      state.events.push(ev(state, 'council', 'Proposal rejected', 'Player rejected proposal ' + a.proposalId, 'info'));
      break;
    }
  }
}

/** A small connected road grid around spawn so early city is traversable. */
function seedStarterRoads(state: WorldState) {
  const { x: sx, y: sy } = state.map.spawn;
  const pts: { x: number; y: number }[] = [];
  for (const [dx, dy] of [[0,0],[2,0],[4,0],[0,2],[2,2],[4,2],[0,-2],[2,-2],[4,-2]] as const) {
    const x = sx + dx, y = sy + dy;
    if (x >= 0 && y >= 0 && x < state.map.width && y < state.map.height && state.map.tiles[idx(state.map, x, y)]!.buildable) pts.push({ x, y });
  }
  if (pts.length < 2) return;
  state.roads.nodes = pts.map((p, i) => ({ id: i, ...p }));
  state.roads.edges = [];
  for (let i = 1; i < pts.length; i++) state.roads.edges.push({ a: i - 1, b: i, capacity: COST.roadCapacityPerSeg, load: 0, type: 'street' });
  for (const p of pts) {
    const t = state.map.tiles[idx(state.map, p.x, p.y)];
    if (t) t.landUse = 'road';
  }
}

export function applyCommand(state: WorldState, cmd: Command): { state: WorldState; result: ValidationResult } {
  const result = validateCommand(state, cmd);
  const next = clone(state);
  for (const a of result.accepted) applyOne(next, a, cmd);
  // record rejected reasons as events (LLM must see why)
  if (result.rejected.length) {
    next.events.push(ev(next, 'validation', 'Actions rejected',
      result.rejected.map(r => r.reason).join('; '), 'warn', { count: result.rejected.length }));
    if (next.events.length > BALANCE.eventCap) next.events.splice(0, next.events.length - BALANCE.eventCap);
  }
  if (next.events.length > BALANCE.eventCap) next.events.splice(0, next.events.length - BALANCE.eventCap);
  return { state: next, result };
}
