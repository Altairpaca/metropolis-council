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
    sewage: utility(2, 2 * COST.build.sewage_plant.capacity, total * COST.perCapitaDemand.sewage),
    garbage:utility(2, 2 * COST.build.garbage_facility.capacity, total * COST.perCapitaDemand.garbage),
    health: utility(2, 2 * COST.build.clinic.capacity, total * COST.perCapitaDemand.health),
    education: utility(2, 2 * COST.build.school.capacity, total * COST.perCapitaDemand.education),
    fire:   utility(2, 2 * COST.build.fire_station.capacity, total * COST.perCapitaDemand.fire),
    transit:utility(2, 2 * COST.build.transit_hub.capacity, total * COST.perCapitaDemand.transit),
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
  for (const r of map.regions) zones[r.id] = { id: r.id, target: r.id === 'center' ? 'civic' : 'res', priority: 0.5, maxBudget: 2000 };

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
      landValue: 0.42, imports: 0, exports: 0, businesses: Math.round(total / 120) },
    services: { satisfaction: 0.6, waterReliability: 0.9, powerReliability: 0.92,
      healthCoverage: 0.7, educationCoverage: 0.7, fireCoverage: 0.7, transitCoverage: 0.6, unmetNeeds: [] },
    roads: { nodes: [], edges: [], congestion: 0.15, connectivity: 0.5, bridgeCount: 0 },
    stats: { sampleWeight, populationHistory: [total], treasuryHistory: [sc.initial.treasury], happinessHistory: [0.62], debtHistory: [sc.initial.debt] },
    events: [{ id: 'e0', tick: 0, kind: 'founding', title: '城市奠基 / Founding',
      text: 'Council convened. Seed ' + seed + ', scenario ' + sc.id + '.', severity: 'info' }],
    milestones: [], status: 'running',
    ledger: [{ tick: 0, actor: 'system', category: 'grant', delta: sc.initial.treasury, note: 'initial treasury' }],
    lastReport: null, reportHistory: [], scenario: sc, pending: [],
    shockCursor: 0, activeShocks: [],
  };
  // Starter roads: a connected 9-node grid near spawn (deterministic)
  const { x: sx, y: sy } = map.spawn;
  const pts: { x: number; y: number }[] = [];
  for (const [dx, dy] of [[0,0],[2,0],[4,0],[0,2],[2,2],[4,2],[0,-2],[2,-2],[4,-2]] as const) {
    const x = sx + dx, y = sy + dy;
    if (x >= 0 && y >= 0 && x < map.width && y < map.height && map.tiles[idx(map, x, y)]!.buildable) pts.push({ x, y });
  }
  state.roads.nodes = pts.map((p, i) => ({ id: i, ...p }));
  for (let i = 1; i < pts.length; i++) state.roads.edges.push({ a: i - 1, b: i, capacity: COST.roadCapacityPerSeg, load: 0, type: 'street' });
  for (const p of pts) { const t = map.tiles[idx(map, p.x, p.y)]; if (t) t.landUse = 'road'; }
  // Seed a few zone footprints so the initial render is a town, not an empty field
  const center = map.regions.find(r => r.id === 'center')!;
  let placed = 0;
  for (const c of center.cells) {
    if (placed >= 14) break;
    const t = map.tiles[c];
    if (t && t.buildable && t.landUse === 'empty') { t.landUse = placed % 4 === 0 ? 'com' : 'res'; t.density = 0.35 + (placed % 3) * 0.15; placed++; }
  }
  recomputeRegionPop(state);
  return state;
}

export function recomputeRegionPop(state: WorldState) {
  const by: Record<string, number> = {};
  for (const r of state.map.regions) by[r.id] = 0;
  for (const h of state.population.households) by[h.region] = (by[h.region] ?? 0) + h.size * state.stats.sampleWeight;
  state.population.byRegion = by;
  state.population.total = Math.round(Object.values(by).reduce((a, b) => a + b, 0));
}
