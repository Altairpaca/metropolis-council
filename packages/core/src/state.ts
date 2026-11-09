/**
 * Initial world construction. Builds a seeded map, a representative household
 * sample, starting infrastructure, roads, policy and the scenario ledger.
 */
import type { WorldState, ScenarioConfig, Difficulty, UtilityKey, Household, UtilityState, Policy, ZoneIntent } from './types.js';
import { COST, BALANCE, DIFFICULTY, LEGAL_RANGES } from './constants.js';
import { SCENARIOS, getScenario } from './scenarios.js';
import { generateMap, idx } from './map.js';
import { makeWorldRNG, serializeRNG, RNG } from './rng.js';

function utility(units: number, capacity: number, demand: number): UtilityState {
  return { units, capacity, demand, coverage: demand > 0 ? Math.min(1, capacity / demand) : 1,
    quality: 1, upkeep: units * 25 };
}

export function createInitialState(seed: number, difficulty: Difficulty = 'normal', opts?: { scenario?: ScenarioConfig }): WorldState {
  const scenario = opts?.scenario ?? { ...getScenario('starter_town'), seed, difficulty };
  // Override seed/difficulty from args while keeping scenario's shocks/targets
  const sc: ScenarioConfig = { ...scenario, seed, difficulty, initial: { ...scenario.initial, shocks: [...scenario.initial.shocks] } };
  const diff = DIFFICULTY[difficulty];
  const map = generateMap(seed, difficulty, sc);
  const rng = makeWorldRNG(seed);
  const popRng = rng.population;

  const sampleWeight = COST.sampleWeight;
  const householdCount = Math.max(24, Math.min(BALANCE.maxHouseholdSamples, Math.round(sc.initial.population / (sampleWeight * 2.6))));
  const households: Household[] = [];
  const regionIds = map.regions.map(r => r.id);
  for (let i = 0; i < householdCount; i++) {
    const region = regionIds[popRng.int(regionIds.length)]!;
    const reg = map.regions.find(r => r.id === region)!;
    const cells = reg.cells.filter(c => map.tiles[c]!.buildable);
    const homeTile = cells.length ? cells[popRng.int(cells.length)]! : map.tiles.findIndex(t => t.buildable);
    const size = 1 + popRng.int(4);
    const income = 30 + popRng.range(0, 55) * (1 - sc.initial.inequality * 0.5 * (region === 'south_east' ? 1 : 0));
    households.push({
      id: i, region, size, income, age: 20 + popRng.int(40),
      homeTile, workplace: popRng.chance(0.78) ? regionIds[popRng.int(regionIds.length)] : null,
      employed: popRng.chance(0.82), education: popRng.range(0.25, 0.75),
      health: popRng.range(0.6, 0.9), happiness: popRng.range(0.5, 0.72),
      needs: { housing: popRng.range(0.5, 0.9), shopping: popRng.range(0.45, 0.85), work: popRng.range(0.5, 0.9) },
      commute: popRng.range(8, 28),
    });
  }
  const total = Math.round(households.reduce((s, h) => s + h.size, 0) * sampleWeight);

  const startUnits = 2;
  const infra = {
    power:  utility(startUnits, startUnits * COST.build.power_plant.capacity, total * COST.perCapitaDemand.power),
    water:  utility(startUnits, startUnits * COST.build.water_works.capacity * (1 - sc.initial.waterScarcity * 0.25), total * COST.perCapitaDemand.water),
    sewage: utility(1, COST.build.sewage_plant.capacity, total * COST.perCapitaDemand.sewage),
    garbage:utility(1, COST.build.garbage_facility.capacity, total * COST.perCapitaDemand.garbage),
    health: utility(1, COST.build.clinic.capacity, total * COST.perCapitaDemand.health),
    education: utility(1, COST.build.school.capacity, total * COST.perCapitaDemand.education),
    fire:   utility(1, COST.build.fire_station.capacity, total * COST.perCapitaDemand.fire),
    transit:utility(1, COST.build.transit_hub.capacity, total * COST.perCapitaDemand.transit),
    pollution: 0.12 + sc.initial.inequality * 0.05,
  };
  for (const k of ['power','water','sewage','garbage','health','education','fire','transit'] as const) infra[k].upkeep = infra[k].units * (k === 'power' ? 95 : k === 'water' ? 80 : 55);
  const policy: Policy = {
    taxRate: 0.09, serviceLevel: 1.0,
    constructionBudget: 3500, maintenanceBudget: 1800,
    envPriority: 0.5, equityPriority: 0.5, growthPriority: 0.5,
    borrowingAllowed: true, approvalThreshold: BALANCE.approvalThresholdDefault,
  };
  const zones: Record<string, ZoneIntent> = {};
  // Every region starts unzoned. Growth only happens where the council (or the
  // player) actually designates land use, so a no-action baseline really is no-op.
  for (const r of map.regions) zones[r.id] = { id: r.id, target: 'none', priority: 0.5, maxBudget: 2000 };

  const state: WorldState = {
    schemaVersion: 1, seed, difficulty, tick: 0, map,
    rng: serializeRNG(rng),
    treasury: sc.initial.treasury > 0 ? sc.initial.treasury : diff.startTreasury,
    debt: sc.initial.debt, creditLimit: BALANCE.startingCreditLimit,
    policy, zones, infra,
    population: { total, households, byRegion: {}, happiness: 0.62, health: 0.75,
      unemployment: 0.12, netMigration: 0, commuteTime: 18 },
    economy: { gdp: total * 1.4, employment: 0.82, jobs: Math.round(total * 0.5),
      commercialDemand: 0.5, industrialDemand: 0.5, residentialDemand: 0.55,
      landValue: 0.42, imports: 0, exports: 0, businesses: Math.round(total / 120), housingCapacity: total },
    services: { satisfaction: 0.6, waterReliability: 0.9, powerReliability: 0.92,
      healthCoverage: 0.7, educationCoverage: 0.7, fireCoverage: 0.7, transitCoverage: 0.6, unmetNeeds: [] },
    roads: { nodes: [], edges: [], congestion: 0.15, connectivity: 0.5, bridgeCount: 0 },
    stats: { sampleWeight, populationHistory: [total], treasuryHistory: [sc.initial.treasury], happinessHistory: [0.62], debtHistory: [sc.initial.debt] },
    events: [{ id: 'e0', tick: 0, kind: 'founding', title: '城市奠基 / Founding',
      text: 'Council convened. Seed ' + seed + ', scenario ' + sc.id + '.', severity: 'info' }],
    milestones: [], status: 'running',
    ledger: [{ tick: 0, actor: 'system', category: 'grant', delta: sc.initial.treasury, note: 'initial treasury' }],
    lastReport: null, reportHistory: [], scenario: sc, pending: [],
    shockCursor: 0, activeShocks: [], landVersion: 1,
  };
  // Starter street grid: a small orthogonal town lattice around spawn. This is
  // a real road network (nodes + edges + tile occupancy), not decoration, so it
  // also provides the initial traffic capacity the economy relies on.
  const { x: sx, y: sy } = map.spawn;
  const SPACING = 3;
  const HALF = 3; // 7x7 intersections => 21x21 tile footprint
  const isBuildable = (x: number, y: number) => {
    if (x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1) return false;
    return map.tiles[idx(map, x, y)]!.buildable;
  };
  const nodeAt = new Map<string, number>();
  const nodes: { id: number; x: number; y: number }[] = [];
  const addNode = (x: number, y: number): number => {
    const key = x + ',' + y;
    const existing = nodeAt.get(key);
    if (existing !== undefined) return existing;
    const id = nodes.length;
    nodes.push({ id, x, y });
    nodeAt.set(key, id);
    return id;
  };
  const edges: { a: number; b: number }[] = [];
  for (let gy = -HALF; gy <= HALF; gy++) {
    for (let gx = -HALF; gx <= HALF; gx++) {
      const x = sx + gx * SPACING, y = sy + gy * SPACING;
      if (!isBuildable(x, y)) continue;
      addNode(x, y);
    }
  }
  for (let gy = -HALF; gy <= HALF; gy++) {
    for (let gx = -HALF; gx <= HALF; gx++) {
      const x = sx + gx * SPACING, y = sy + gy * SPACING;
      if (!isBuildable(x, y)) continue;
      const a = addNode(x, y);
      // connect east and south neighbours when the whole segment is buildable
      if (gx < HALF && isBuildable(x + SPACING, y) && isBuildable(x + 1, y) && isBuildable(x + 2, y)) {
        edges.push({ a, b: addNode(x + SPACING, y) });
      }
      if (gy < HALF && isBuildable(x, y + SPACING) && isBuildable(x, y + 1) && isBuildable(x, y + 2)) {
        edges.push({ a, b: addNode(x, y + SPACING) });
      }
    }
  }
  state.roads.nodes = nodes;
  state.roads.edges = edges.map((e, i) => ({
    a: e.a, b: e.b, capacity: COST.roadCapacityPerSeg, load: 0,
    type: (i % 7 === 0 ? 'avenue' : 'street') as 'street' | 'avenue' | 'bridge',
  }));
  // Occupy the street footprint (including the tile between intersections).
  for (const n of nodes) {
    for (const [ox, oy] of [[0,0],[1,0],[2,0],[0,1],[0,2]] as const) {
      const x = n.x + ox, y = n.y + oy;
      if (x < map.width && y < map.height) {
        const t = map.tiles[idx(map, x, y)];
        if (t && t.buildable && t.landUse === 'empty') { t.landUse = 'road'; }
      }
    }
  }
  // Seed zone footprints proportional to the scenario's starting population so
  // every map starts with a housed population instead of a housing crisis.
  const center = map.regions.find(r => r.id === 'center')!;
  const needRes = Math.max(10, Math.ceil((sc.initial.population / (160 * 0.6)) * 1.30));
  const needCom = Math.max(3, Math.ceil(needRes * 0.22));
  let resPlaced = 0, comPlaced = 0;
  for (const c of center.cells) {
    if (resPlaced >= needRes && comPlaced >= needCom) break;
    const t = map.tiles[c];
    if (!t || !t.buildable || t.landUse !== 'empty') continue;
    const wantCom = comPlaced < needCom && (resPlaced >= needRes || (resPlaced + comPlaced) % 5 === 0);
    if (wantCom) { t.landUse = 'com'; comPlaced++; } else { t.landUse = 'res'; resPlaced++; }
    t.density = 0.45 + ((resPlaced + comPlaced) % 3) * 0.15;
  }
  recomputeRegionPop(state);
  state.landVersion = 2;
  return state;
}

/**
 * Allocate the AUTHORITATIVE population total across regions using the
 * representative household sample as weights.
 *
 * Important: this must never recompute population.total from the sample. Doing
 * so creates a feedback loop (more households -> bigger total -> more
 * households) that makes the city grow regardless of infrastructure.
 */
export function recomputeRegionPop(state: WorldState) {
  const total = state.population.total;
  const weights: Record<string, number> = {};
  let sum = 0;
  for (const r of state.map.regions) weights[r.id] = 0;
  for (const h of state.population.households) {
    if (weights[h.region] === undefined) weights[h.region] = 0;
    weights[h.region]! += h.size;
    sum += h.size;
  }
  const by: Record<string, number> = {};
  for (const r of state.map.regions) {
    by[r.id] = sum > 0 ? Math.round(total * (weights[r.id] ?? 0) / sum) : 0;
  }
  state.population.byRegion = by;
}
