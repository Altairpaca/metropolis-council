/**
 * Fixed-tick simulation engine. ONE tick = ONE month.
 *
 * Deterministic order, no wall-clock and no Math.random:
 *   1. validate + apply all commands (the only mutation path)
 *   2. fire/expire exogenous shocks (events RNG stream, pre-scheduled by tick)
 *   3. services: demand from population, capacity from built units and quality
 *   4. economy: housing / jobs / demand / land value / pollution from LAND USE
 *   5. traffic: road load, congestion, commute time
 *   6. population: migration gated by housing, jobs and utility capacity
 *   7. finance: full ledger with every credit in and out recorded
 *   8. monthly report, histories, milestones, victory/bankruptcy
 *   9. tick++
 *
 * Units are explicit so the published cost formula matches reality:
 *   housing  : 160 * density per residential tile
 *   jobs     : 0.32 per citizen + 55 per commercial tile + 70 per industrial tile
 *   demand   : population * perCapitaDemand for each utility
 *   capacity : units * build.capacity * (0.75 + 0.25 * quality)
 */
import type { WorldState, Command, MonthlyReport, GameEvent, UtilityKey } from './types.js';
import { COST, BALANCE, DIFFICULTY } from './constants.js';
import { applyCommand } from './apply.js';
import { restoreRNG, serializeRNG, RNG } from './rng.js';
import { recomputeRegionPop } from './state.js';

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const UTILITY_KEYS: UtilityKey[] = ['power', 'water', 'sewage', 'garbage', 'health', 'education', 'fire', 'transit'];

export const ECONOMY = {
  housingPerResTile: 160,
  jobsPerCitizen: 0.32,
  jobsPerComTile: 55,
  jobsPerIndTile: 70,
  taxPerCapita: 14,
  maintenancePerCapita: 1.3,
  commercialPerCapita: 0.50,
  industrialYield: 0.45,
  grantPerCapita: 0.10,
} as const;

const BUILD_OF_UTILITY: Record<UtilityKey, keyof typeof COST.build> = {
  power: 'power_plant', water: 'water_works', sewage: 'sewage_plant', garbage: 'garbage_facility',
  health: 'clinic', education: 'school', fire: 'fire_station', transit: 'transit_hub',
};

let eid = 0;
function pushEvent(state: WorldState, kind: string, title: string, text: string, severity: GameEvent['severity']) {
  state.events.push({ id: 'e' + state.tick + '_' + (eid++), tick: state.tick, kind, title, text, severity });
  if (state.events.length > BALANCE.eventCap) state.events.splice(0, state.events.length - BALANCE.eventCap);
}
function pushHistory(arr: number[], v: number) { arr.push(v); if (arr.length > BALANCE.historyCap) arr.shift(); }

function processShocks(state: WorldState, evRng: RNG) {
  const shocks = state.scenario.initial.shocks;
  while (state.shockCursor < shocks.length && shocks[state.shockCursor]!.tick <= state.tick) {
    const s = shocks[state.shockCursor]!;
    state.shockCursor++;
    const jitter = 0.9 + evRng.next() * 0.2;
    const mag = clamp(s.magnitude * jitter, 0, 1);
    state.activeShocks.push({ kind: s.kind, until: state.tick + 6, magnitude: mag, region: s.region });
    const titles: Record<string, string> = {
      drought: 'Drought', power_outage: 'Power outage', flood: 'Flood',
      recession: 'Recession', investment_boom: 'Investment boom',
      migration_wave: 'Migration wave', infra_decay: 'Infrastructure decay',
    };
    pushEvent(state, s.kind, titles[s.kind] ?? s.kind,
      'Exogenous shock: ' + s.kind + ' (magnitude ' + mag.toFixed(2) + ', about 6 months' + (s.region ? ', region ' + s.region : '') + ').',
      mag > 0.7 ? 'critical' : 'warn');
  }
  state.activeShocks = state.activeShocks.filter(s => s.until > state.tick);
}
function shockMag(state: WorldState, kind: string): number {
  let m = 0;
  for (const s of state.activeShocks) if (s.kind === kind) m = Math.max(m, s.magnitude);
  return m;
}

/** Land-use census, recomputed each tick (48x48, cheap). */
interface LandCensus { resTiles: number; comTiles: number; indTiles: number; parkTiles: number; roadTiles: number; housing: number; }
function census(state: WorldState): LandCensus {
  let resTiles = 0, comTiles = 0, indTiles = 0, parkTiles = 0, roadTiles = 0, housing = 0;
  for (const t of state.map.tiles) {
    switch (t.landUse) {
      case 'res': resTiles++; housing += ECONOMY.housingPerResTile * Math.max(0.35, t.density); break;
      case 'com': comTiles++; break;
      case 'ind': indTiles++; break;
      case 'park': parkTiles++; break;
      case 'road': roadTiles++; break;
      default: break;
    }
  }
  return { resTiles, comTiles, indTiles, parkTiles, roadTiles, housing: Math.round(housing) };
}

/** Services: demand from population, capacity from built units and quality. */
function updateServices(state: WorldState): { imports: number; ops: number; unmet: string[] } {
  const pop = state.population.total;
  const drought = shockMag(state, 'drought');
  const outage = shockMag(state, 'power_outage');
  const mult = DIFFICULTY[state.difficulty].demandMultiplier;
  let imports = 0, ops = 0;
  const unmet: string[] = [];

  for (const key of UTILITY_KEYS) {
    const u = state.infra[key];
    const spec = COST.build[BUILD_OF_UTILITY[key]];
    let capacity = u.units * spec.capacity * (0.75 + 0.25 * u.quality);
    if (key === 'water' && drought > 0) capacity *= (1 - COST.droughtWaterFactor * drought);
    if (key === 'power' && outage > 0) capacity *= (1 - COST.powerOutageFactor * outage);
    u.capacity = capacity;

    const demand = Math.max(1, pop * COST.perCapitaDemand[key] * mult);
    u.demand = demand;
    u.coverage = clamp(capacity / demand);
    u.upkeep = u.units * spec.upkeep;
    ops += u.upkeep;

    const targetQuality = clamp(0.30 + 0.70 * clamp(state.policy.serviceLevel / BALANCE.serviceLevelMax)
      - state.scenario.initial.decay * 0.25);
    u.quality += (targetQuality - u.quality) * 0.12;
    u.quality = clamp(u.quality);

    const shortfall = Math.max(0, demand - capacity);
    if (shortfall > 0) {
      imports += shortfall * COST.importPrice;
      if (u.coverage < 0.65) unmet.push(key);
    }
  }
  const s = state.services;
  s.waterReliability = clamp(state.infra.water.coverage);
  s.powerReliability = clamp(state.infra.power.coverage);
  s.healthCoverage = clamp(state.infra.health.coverage);
  s.educationCoverage = clamp(state.infra.education.coverage);
  s.fireCoverage = clamp(state.infra.fire.coverage);
  s.transitCoverage = clamp(state.infra.transit.coverage);
  const avg = (s.waterReliability + s.powerReliability + s.healthCoverage + s.educationCoverage + s.fireCoverage + s.transitCoverage) / 6;
  s.satisfaction = clamp(avg * COST.serviceYield);
  s.unmetNeeds = unmet;
  return { imports, ops, unmet };
}

/** Economy: derived entirely from land use and population. */
function updateEconomy(state: WorldState, recession: number, boom: number): LandCensus {
  const pop = state.population.total;
  const e = state.economy;
  const c = census(state);

  e.housingCapacity = Math.max(220, c.housing);
  const occupancy = clamp(pop / Math.max(1, e.housingCapacity));
  e.residentialDemand = clamp((1 - occupancy) * 1.3 + pop / 14000);
  e.commercialDemand = clamp(0.22 + pop / 9000 + state.services.satisfaction * 0.25 - state.policy.taxRate * 1.5);
  e.industrialDemand = clamp(0.28 + state.policy.growthPriority * 0.35 - state.policy.envPriority * 0.20);

  const shockDemand = 1 - COST.recessionDemandFactor * recession + 0.25 * boom;
  const jobs = pop * ECONOMY.jobsPerCitizen
    + c.comTiles * ECONOMY.jobsPerComTile * e.commercialDemand
    + c.indTiles * ECONOMY.jobsPerIndTile * e.industrialDemand;
  e.jobs = Math.max(1, Math.round(jobs * shockDemand));
  e.employment = clamp(e.jobs / Math.max(1, pop * 0.45));
  e.businesses = c.comTiles + c.indTiles * 2;

  const produced = c.indTiles * COST.indPollutionPerZone * (1 - state.policy.envPriority * 0.35);
  const absorbed = c.parkTiles * COST.parkPollutionAbsorb + BALANCE.pollutionDecay;
  state.infra.pollution = clamp(state.infra.pollution + produced - absorbed);

  // Zoning intent drives organic densification: land the council designates for a
  // use intensifies toward it while demand exists. This is what turns a low-rise
  // starter town into a skyline over decades, and it makes set_zone matter.
  const demandOf: Record<string, number> = {
    res: e.residentialDemand, com: e.commercialDemand, ind: e.industrialDemand,
  };
  for (const region of state.map.regions) {
    const z = state.zones[region.id];
    if (!z || z.target === 'none') continue;
    const d = demandOf[z.target] ?? 0;
    if (d <= 0.1) continue;
    const step = 0.0022 * z.priority * d;
    for (const ci of region.cells) {
      const t = state.map.tiles[ci]!;
      if (t.landUse === z.target) t.density = clamp(t.density + step, 0, 1);
    }
  }

  e.landValue = clamp(0.32 + e.employment * 0.18 + state.services.satisfaction * 0.25
    - state.infra.pollution * 0.30 - state.roads.congestion * 0.10);
  e.gdp = Math.max(1, pop * (0.9 + e.employment * 0.7) * (1 - recession * 0.3 + boom * 0.2));
  e.exports = Math.round(e.gdp * 0.12 * e.industrialDemand);
  return c;
}

function updateTraffic(state: WorldState) {
  const r = state.roads;
  const pop = state.population.total;
  const baseLoad = pop * 0.035 * (1 + state.economy.commercialDemand * 0.35);
  const totalCap = Math.max(1, r.edges.reduce((s, e) => s + e.capacity, 0));
  r.congestion = clamp(baseLoad / totalCap, 0.05, 1);
  r.connectivity = clamp(0.35 + r.edges.length * 0.01 + r.bridgeCount * 0.06
    - (state.scenario.initial.riverBlock ? 0.20 : 0));
  for (const e of r.edges) e.load = Math.round(baseLoad / Math.max(1, r.edges.length));
  const transitRelief = 1 - state.services.transitCoverage * COST.transitCongestionRelief;
  const bridgePenalty = (state.scenario.initial.riverBlock && r.bridgeCount === 0) ? 18 : 0;
  state.population.commuteTime = 10 + r.congestion * 40 * Math.max(0.2, transitRelief) + bridgePenalty;
}

/**
 * Population. population.total is AUTHORITATIVE, driven by migration and
 * bounded by housing, jobs and utility capacity. The household array is a
 * REPRESENTATIVE SAMPLE used for regional distribution; it never feeds back
 * into the total.
 */
function updatePopulation(state: WorldState, popRng: RNG, migrationWave: number): number {
  const p = state.population;
  const services = state.services.satisfaction;
  const jobs = state.economy.employment;
  const happinessTarget = clamp(0.30 + services * 0.45 + jobs * 0.15 - state.policy.taxRate * 0.70
    - state.infra.pollution * 0.18 - state.roads.congestion * 0.08 - p.unemployment * 0.12);
  p.happiness += (happinessTarget - p.happiness) * 0.25;
  p.health = clamp(p.health + (services * 0.55 + 0.20 - state.infra.pollution * 0.30 - p.health) * 0.18);
  p.unemployment = clamp(1 - state.economy.employment);

  const drift = (p.happiness - BALANCE.migrationHappinessPivot) * 0.030
    + (0.55 - p.unemployment) * 0.010
    + migrationWave * 0.020;

  const waterPop = state.infra.water.capacity / Math.max(0.01, COST.perCapitaDemand.water);
  const powerPop = state.infra.power.capacity / Math.max(0.01, COST.perCapitaDemand.power);
  const ceiling = Math.min(
    state.economy.housingCapacity,
    waterPop * 1.02,
    powerPop * 1.02,
    Math.max(150, state.economy.jobs / 0.38),
  );

  const target = Math.min(p.total * (1 + drift), ceiling);
  const delta = Math.round(Math.max(-p.total * 0.025, Math.min(p.total * 0.025, target - p.total)));
  p.netMigration = delta;
  p.total = Math.max(0, p.total + delta);

  const sampleWeight = state.stats.sampleWeight;
  const desired = Math.max(12, Math.min(BALANCE.maxHouseholdSamples, Math.round(p.total / (sampleWeight * 2.6))));
  const hh = p.households;
  const regionIds = state.map.regions.map(r => r.id);
  while (hh.length < desired && hh.length > 0) {
    const src = hh[popRng.int(hh.length)]!;
    hh.push({ ...src, id: hh.length + popRng.int(100000), region: regionIds[popRng.int(regionIds.length)]!,
      happiness: p.happiness, health: p.health,
      income: Math.max(10, src.income * (0.8 + popRng.next() * 0.4)) });
  }
  while (hh.length > desired) hh.pop();

  let incomeSum = 0, commuteSum = 0;
  for (const h of hh) {
    h.happiness = clamp(h.happiness * 0.6 + p.happiness * 0.4 + (h.employed ? 0.02 : -0.02));
    h.health = clamp(h.health * 0.7 + p.health * 0.3);
    h.education = clamp(h.education + state.services.educationCoverage * 0.01);
    h.employed = h.workplace !== null && popRng.chance(state.economy.employment);
    h.commute = state.population.commuteTime * (0.8 + popRng.next() * 0.4);
    h.needs.housing = clamp(state.economy.residentialDemand * 0.5 + 0.3);
    h.needs.shopping = clamp(state.services.satisfaction * 0.5 + 0.25);
    h.needs.work = clamp(h.employed ? 0.8 : 0.3);
    incomeSum += h.income; commuteSum += h.commute;
  }
  p.commuteTime = commuteSum / Math.max(1, hh.length);
  recomputeRegionPop(state);
  return incomeSum / Math.max(1, hh.length);
}

/** Finance: every credit in and out is recorded in the ledger. */
function updateFinance(state: WorldState, avgIncome: number, imports: number, ops: number, construction: number): MonthlyReport {
  const pop = state.population.total;
  const diff = DIFFICULTY[state.difficulty];
  const taxes = pop * state.policy.taxRate * ECONOMY.taxPerCapita * diff.taxMultiplier * (0.85 + avgIncome / 200);
  const commercial = pop * state.economy.commercialDemand * ECONOMY.commercialPerCapita;
  const industrial = state.economy.exports * ECONOMY.industrialYield;
  const grants = pop * ECONOMY.grantPerCapita * (state.scenario.initial.decay > 0.3 ? 1.4 : 1);

  const payroll = pop * ECONOMY.maintenancePerCapita;
  const bill = payroll + ops;
  const funded = bill > 0 ? clamp(state.policy.maintenanceBudget / bill) : 1;
  const maintenance = bill * (0.55 + 0.45 * funded);

  const debtInterest = state.debt * COST.interestRate;
  const isFloodTurn = state.activeShocks.some(a => a.kind === 'flood' && a.until === state.tick + 6);
  const floodLoss = isFloodTurn ? shockMag(state, 'flood') * COST.floodDamage : 0;

  const income = taxes + commercial + industrial + grants;
  const expenses = maintenance + debtInterest + imports + construction + floodLoss;
  const net = income - expenses;
  state.treasury += net;

  const b = { taxes, commercial, industrial, grants, maintenance, construction, serviceOps: 0, debtInterest, imports };
  for (const [k, v] of Object.entries(b)) {
    if (v > 0.005) {
      const signed = (k === 'taxes' || k === 'commercial' || k === 'industrial' || k === 'grants') ? v : -v;
      state.ledger.push({ tick: state.tick, actor: 'system', category: k, delta: Math.round(signed * 100) / 100, note: k });
    }
  }
  if (floodLoss > 0) state.ledger.push({ tick: state.tick, actor: 'system', category: 'disaster', delta: -Math.round(floodLoss * 100) / 100, note: 'flood damage' });
  if (state.ledger.length > BALANCE.ledgerCap) state.ledger.splice(0, state.ledger.length - BALANCE.ledgerCap);

  const warnings: string[] = [];
  if (state.treasury < 0) warnings.push('treasury negative');
  if (state.services.waterReliability < 0.6) warnings.push('water reliability below 60%');
  if (state.services.powerReliability < 0.6) warnings.push('power reliability below 60%');
  if (state.infra.pollution > 0.55) warnings.push('high pollution');
  if (state.roads.congestion > 0.70) warnings.push('severe congestion');
  if (state.debt > state.creditLimit * 0.8) warnings.push('near credit limit');
  if (state.economy.housingCapacity < state.population.total) warnings.push('housing shortage');
  if (state.economy.employment < 0.6) warnings.push('high unemployment');
  if (state.services.unmetNeeds.length) warnings.push('unmet: ' + state.services.unmetNeeds.join(','));

  const report: MonthlyReport = {
    tick: state.tick, income, expenses, net,
    breakdown: { taxes, commercial, industrial, grants, maintenance, construction, serviceOps: 0, debtInterest, imports },
    population: pop,
    services: {
      satisfaction: state.services.satisfaction, water: state.services.waterReliability,
      power: state.services.powerReliability, health: state.services.healthCoverage,
      education: state.services.educationCoverage, transit: state.services.transitCoverage,
    },
    warnings,
  };
  state.lastReport = report;
  state.reportHistory.push(report);
  if (state.reportHistory.length > BALANCE.historyCap) state.reportHistory.shift();
  return report;
}

function checkMilestones(state: WorldState) {
  const add = (id: string, title: string) => {
    if (!state.milestones.includes(id)) {
      state.milestones.push(id);
      pushEvent(state, 'milestone', 'Milestone', title, 'info');
    }
  };
  if (state.population.total >= 2000) add('town', 'Population 2,000: a real town');
  if (state.population.total >= 4000) add('city', 'Population 4,000: city charter');
  if (state.population.total >= BALANCE.victoryPopulation) add('metropolis', 'Population 6,000: metropolis');
  if (state.economy.gdp >= 5000) add('economy', 'Monthly GDP above 5,000 cr');
  if (state.roads.bridgeCount >= 1 && state.scenario.initial.riverBlock) add('bridge', 'River bridge opened');
}

function checkEndConditions(state: WorldState) {
  if (state.status !== 'running') return;
  if (state.treasury < BALANCE.bankruptcyTreasury) {
    state.status = 'bankrupt';
    pushEvent(state, 'bankruptcy', 'Bankruptcy',
      'Treasury fell below ' + BALANCE.bankruptcyTreasury + ' cr in month ' + state.tick + '.', 'critical');
    return;
  }
  if (state.tick >= BALANCE.victoryMonths
      && state.population.total >= BALANCE.victoryPopulation
      && state.population.happiness >= BALANCE.victoryHappiness
      && state.treasury >= BALANCE.victorySolvency) {
    state.status = 'victory';
    pushEvent(state, 'victory', 'Metropolis achieved',
      'Population ' + state.population.total + ', happiness ' + state.population.happiness.toFixed(2) + ', solvent.', 'info');
  }
}

/** The fixed tick. Pure: returns a NEW WorldState. */
export function stepWorld(state: WorldState, cmds: Command[] = []): WorldState {
  let s: WorldState = JSON.parse(JSON.stringify(state)) as WorldState;
  let construction = 0;
  for (const cmd of cmds) {
    const { state: next, result } = applyCommand(s, cmd);
    s = next;
    for (const a of result.accepted) if (a.type === 'build') construction += COST.build[a.category]!.cost;
  }
  if (s.status !== 'running') return s;

  const rngs = restoreRNG(s.rng);
  processShocks(s, rngs.events);
  const recession = shockMag(s, 'recession');
  const boom = shockMag(s, 'investment_boom');
  const migrationWave = shockMag(s, 'migration_wave');
  const infraDecay = shockMag(s, 'infra_decay');
  if (infraDecay > 0) for (const k of UTILITY_KEYS) s.infra[k].quality = clamp(s.infra[k].quality - infraDecay * 0.03);

  const { imports, ops } = updateServices(s);
  updateEconomy(s, recession, boom);
  updateTraffic(s);
  const avgIncome = updatePopulation(s, rngs.population, migrationWave);
  updateFinance(s, avgIncome, imports, ops, construction);

  pushHistory(s.stats.populationHistory, s.population.total);
  pushHistory(s.stats.treasuryHistory, s.treasury);
  pushHistory(s.stats.happinessHistory, s.population.happiness);
  pushHistory(s.stats.debtHistory, s.debt);
  checkMilestones(s);
  checkEndConditions(s);

  s.rng = serializeRNG({ ...rngs, terrain: RNG.fromState(s.rng.terrain) });
  s.tick += 1;
  return s;
}

export function runMonths(state: WorldState, months: number, supplier: (s: WorldState, tick: number) => Command[]): WorldState {
  let s = state;
  for (let i = 0; i < months && s.status === 'running'; i++) s = stepWorld(s, supplier(s, s.tick));
  return s;
}
