/**
 * Fixed-tick simulation engine. ONE tick = ONE month.
 *
 * Order (deterministic, fixed):
 *   1. validate + apply all commands (the only mutation path)
 *   2. fire/expire exogenous shocks (events RNG stream, pre-scheduled by tick)
 *   3. recompute utility demand from population, apply service coverage/quality
 *   4. update economy (demand, jobs, businesses, gdp, land value, pollution)
 *   5. update traffic (road load, congestion, commute)
 *   6. update population (migration, health, happiness, education, sampling)
 *   7. FINANCE: full ledger — taxes, commercial/industrial yield, grants,
 *      maintenance, service ops, debt interest, external imports for unmet demand
 *   8. monthly report, histories, warnings, milestones, victory/bankruptcy
 *   9. tick++
 *
 * All randomness comes from the FOUR split RNG streams in state.rng. No
 * Math.random / Date.now on this path. Same (state, commands) => same result.
 */
import type { WorldState, Command, MonthlyReport, GameEvent, UtilityKey, ActiveShock, ShockSpec, PendingProposal } from './types.js';
import { COST, BALANCE, DIFFICULTY, VERSION } from './constants.js';
import { applyCommand } from './apply.js';
import { restoreRNG, serializeRNG, RNG } from './rng.js';
import { recomputeRegionPop } from './state.js';
import { validateCommand } from './validation.js';

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const UTILITY_KEYS: UtilityKey[] = ['power', 'water', 'sewage', 'garbage', 'health', 'education', 'fire', 'transit'];

let eid = 0;
function pushEvent(state: WorldState, kind: string, title: string, text: string, severity: GameEvent['severity']) {
  state.events.push({ id: 'e' + state.tick + '_' + (eid++), tick: state.tick, kind, title, text, severity });
  if (state.events.length > BALANCE.eventCap) state.events.splice(0, state.events.length - BALANCE.eventCap);
}
function pushHistory(arr: number[], v: number) { arr.push(v); if (arr.length > BALANCE.historyCap) arr.shift(); }

/** Fire scheduled shocks, expire old ones. Uses the events stream for jitter. */
function processShocks(state: WorldState, evRng: RNG) {
  const shocks = state.scenario.initial.shocks;
  while (state.shockCursor < shocks.length && shocks[state.shockCursor]!.tick <= state.tick) {
    const s = shocks[state.shockCursor]!;
    state.shockCursor++;
    const jitter = 0.9 + evRng.next() * 0.2;
    const mag = clamp(s.magnitude * jitter, 0, 1);
    const active: ActiveShock = { kind: s.kind, until: state.tick + 6, magnitude: mag, region: s.region };
    state.activeShocks.push(active);
    const titles: Record<string, string> = {
      drought: '旱季 / Drought', power_outage: '电网故障 / Power outage', flood: '洪水 / Flood',
      recession: '经济衰退 / Recession', investment_boom: '投资热潮 / Investment boom',
      migration_wave: '移民潮 / Migration wave', infra_decay: '设施老化 / Infrastructure decay',
    };
    pushEvent(state, s.kind, titles[s.kind] ?? s.kind,
      '外生冲击：' + s.kind + '（强度 ' + mag.toFixed(2) + '，持续约 6 个月' + (s.region ? '，区域 ' + s.region : '') + '）。',
      mag > 0.7 ? 'critical' : 'warn');
  }
  state.activeShocks = state.activeShocks.filter(s => s.until > state.tick);
}
function shockMag(state: WorldState, kind: string): number {
  let m = 0;
  for (const s of state.activeShocks) if (s.kind === kind) m = Math.max(m, s.magnitude);
  return m;
}

/** Recompute utility demand/coverage/quality and citywide service ratios. */
function updateServices(state: WorldState): { imports: number; ops: number; unmet: string[] } {
  const pop = state.population.total;
  const decay = state.scenario.initial.decay;
  const drought = shockMag(state, 'drought');
  const outage = shockMag(state, 'power_outage');
  let imports = 0, ops = 0;
  const unmet: string[] = [];
  const coverages: Record<string, number> = {};

  for (const key of UTILITY_KEYS) {
    const u = state.infra[key];
    // Demand scales sub-linearly with population (shared infrastructure).
    const popFactor = Math.pow(Math.max(1, pop) / 900, 0.78);
    let demand = 900 * popFactor * COST.perCapitaDemand[key] * DIFFICULTY[state.difficulty].demandMultiplier;
    // shocks
    if (key === 'water' && drought > 0) u.capacity *= (1 - COST.droughtWaterFactor * drought);
    if (key === 'power' && outage > 0) u.capacity *= (1 - COST.powerOutageFactor * outage);
    if (key === 'transit') demand *= 1 + state.economy.commercialDemand * 0.3;
    u.demand = Math.max(0.01, demand);
    u.coverage = clamp(u.capacity / u.demand);
    coverages[key] = u.coverage;

    // maintenance funding determines quality decay / recovery
    const buildCat = (key === 'power' ? 'power_plant' : key === 'water' ? 'water_works'
      : key === 'sewage' ? 'sewage_plant' : key === 'garbage' ? 'garbage_facility' : key === 'health' ? 'clinic'
      : key === 'education' ? 'school' : key === 'fire' ? 'fire_station' : 'transit_hub') as keyof typeof COST.build;
    const upkeepNeed = u.units * COST.build[buildCat].upkeep;
    const funded = clamp(state.policy.maintenanceBudget / Math.max(1, upkeepNeed * 4));
    const targetQuality = clamp(0.35 + 0.65 * funded - decay * 0.3 - (1 - state.policy.serviceLevel / BALANCE.serviceLevelMax) * 0.15);
    u.quality += (targetQuality - u.quality) * 0.15;
    u.quality = clamp(u.quality);
    u.upkeep = upkeepNeed;
    ops += upkeepNeed * state.policy.serviceLevel;

    // unmet demand must be imported at a real cost (no free subsidy).
    // Capacity already includes quality; do NOT multiply twice.
    const shortfall = Math.max(0, u.demand - u.capacity);
    if (shortfall > 0) {
      const cost = shortfall * COST.importPrice;
      imports += cost;
      if (u.coverage < 0.65) unmet.push(key);
    }
  }
  const s = state.services;
  s.waterReliability = clamp(coverages.water!);
  s.powerReliability = clamp(coverages.power!);
  s.healthCoverage = clamp(coverages.health!);
  s.educationCoverage = clamp(coverages.education!);
  s.fireCoverage = clamp(coverages.fire!);
  s.transitCoverage = clamp(coverages.transit!);
  const avg = (s.waterReliability + s.powerReliability + s.healthCoverage + s.educationCoverage + s.fireCoverage + s.transitCoverage) / 6;
  s.satisfaction = clamp(avg * COST.serviceYield);
  s.unmetNeeds = unmet;
  const scaledImports = imports * Math.pow(Math.max(1, state.population.total) / 900, 0.5);
  return { imports: scaledImports, ops, unmet };
}

function updateEconomy(state: WorldState, recession: number, boom: number) {
  const pop = state.population.total;
  const e = state.economy;
  // Demand responds to population, happiness, tax, service levels and shocks
  const base = clamp(0.35 + pop / 9000 - state.policy.taxRate * 1.2 + state.services.satisfaction * 0.25);
  const shockDemand = 1 - COST.recessionDemandFactor * recession + 0.25 * boom;
  e.residentialDemand = clamp(base * shockDemand * (1 + state.policy.growthPriority * 0.2));
  e.commercialDemand = clamp(base * (0.7 + state.services.transitCoverage * 0.4) * shockDemand);
  e.industrialDemand = clamp((0.45 + state.policy.growthPriority * 0.25) * shockDemand * (1 - state.policy.envPriority * 0.15));
  // jobs from built zones
  const zoneTiles = state.map.tiles.filter(t => t.landUse === 'com' || t.landUse === 'ind');
  const targetJobs = Math.max(20, zoneTiles.length * 9 + e.businesses * 6);
  e.jobs += (targetJobs - e.jobs) * 0.2;
  e.employment = clamp(e.jobs / Math.max(1, pop * 0.52));
  e.businesses += (e.commercialDemand * 6 - e.businesses * 0.1) * 0.15;
  e.businesses = Math.max(1, e.businesses);
  // pollution: industry adds, parks & env priority absorb
  const indZones = state.map.tiles.filter(t => t.landUse === 'ind').length;
  const parks = state.map.tiles.filter(t => t.landUse === 'park').length;
  const produced = indZones * COST.indPollutionPerZone * (1 - state.policy.envPriority * 0.35);
  const absorbed = parks * COST.parkPollutionAbsorb + BALANCE.pollutionDecay;
  state.infra.pollution = clamp(state.infra.pollution + produced - absorbed, 0, 1);
  e.landValue = clamp(0.32 + e.employment * 0.18 + state.services.satisfaction * 0.25 - state.infra.pollution * 0.3 - state.roads.congestion * 0.1);
  e.gdp = pop * (0.9 + e.employment * 0.7) * (1 - recession * 0.3 + boom * 0.2);
  e.imports = 0; e.exports = Math.round(e.gdp * 0.12 * e.industrialDemand);
}

function updateTraffic(state: WorldState) {
  const r = state.roads;
  const pop = state.population.total;
  const baseLoad = pop * 0.035 * (1 + state.economy.commercialDemand * 0.35);
  const totalCap = Math.max(1, r.edges.reduce((s, e) => s + e.capacity, 0)) + r.bridgeCount * 90;
  r.congestion = clamp(baseLoad / totalCap, 0.05, 1);
  r.connectivity = clamp(0.35 + r.edges.length * 0.01 + r.bridgeCount * 0.06 - (state.scenario.initial.riverBlock ? 0.2 : 0));
  for (const e of r.edges) e.load = Math.round(baseLoad / Math.max(1, r.edges.length));
  const transitRelief = 1 - state.services.transitCoverage * COST.transitCongestionRelief;
  const bridgePenalty = (state.scenario.initial.riverBlock && r.bridgeCount === 0) ? 18 : 0;
  state.population.commuteTime = 10 + r.congestion * 40 * Math.max(0.2, transitRelief) + bridgePenalty;
}

/** Population: representative-household sampling, migration, health, happiness. */
function updatePopulation(state: WorldState, popRng: RNG, migrationWave: number) {
  const p = state.population;
  const services = state.services.satisfaction;
  const jobs = state.economy.employment;
  const happinessTarget = clamp(0.30 + services * 0.45 + jobs * 0.15 - state.policy.taxRate * 0.7
    - state.infra.pollution * 0.18 - state.roads.congestion * 0.08 - state.population.unemployment * 0.12);
  p.happiness += (happinessTarget - p.happiness) * 0.25;
  p.health = clamp(p.health + (services * 0.55 + 0.2 - state.infra.pollution * 0.3 - p.health) * 0.18);
  p.unemployment = clamp(1 - state.economy.employment);

  // Net migration: proportional to (happiness - pivot) plus shock.
  // Service capacity acts as a HARD CEILING: a city cannot grow beyond what
  // its water/power can serve. This makes infrastructure investment matter.
  const drift = (p.happiness - BALANCE.migrationHappinessPivot) * 0.022 + migrationWave * 0.012;
  // Convert capacity (demand units) into a population ceiling using the same
  // sub-linear popFactor as updateServices.
  const popFactor = Math.pow(Math.max(1, p.total) / 900, 0.78) / (Math.max(1, p.total) / 900) || 1;
  const waterPop = state.infra.water.capacity / (COST.perCapitaDemand.water * Math.max(0.01, popFactor));
  const powerPop = state.infra.power.capacity / (COST.perCapitaDemand.power * Math.max(0.01, popFactor));
  const servedCap = Math.min(waterPop, powerPop) * 1.05;
  let targetTotal = Math.min(p.total * (1 + drift), servedCap);
  if (p.happiness < BALANCE.migrationHappinessPivot) targetTotal = Math.min(targetTotal, p.total * (1 + Math.min(0, drift)));
  const delta = Math.round(Math.max(-p.total * 0.03, Math.min(p.total * 0.025, targetTotal - p.total)));
  p.netMigration = delta;
  p.total = Math.max(0, p.total + delta);

  // Rescale representative household sample toward the new total (aggregate sampling)
  const sampleWeight = state.stats.sampleWeight;
  const desiredHouseholds = Math.max(12, Math.min(BALANCE.maxHouseholdSamples, Math.round(p.total / (sampleWeight * 2.6))));
  const hh = p.households;
  const regionIds = state.map.regions.map(r => r.id);
  while (hh.length < desiredHouseholds) {
    const src = hh[popRng.int(hh.length)] ?? hh[0]!;
    hh.push({ ...src, id: hh.length + popRng.int(100000), region: regionIds[popRng.int(regionIds.length)]!,
      happiness: p.happiness, health: p.health,
      income: Math.max(10, src.income * (0.8 + popRng.next() * 0.4)) });
  }
  while (hh.length > desiredHouseholds) hh.pop();
  // Update each sample's state deterministically
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
  state.economy.gdp *= (1 + drift * 0.3);
  recomputeRegionPop(state);
  return incomeSum / Math.max(1, hh.length); // average sampled income (tax base proxy)
}

/** Finance: complete ledger. Every credit in/out is recorded.
 *  Design: a balanced city at ~2000 pop with taxRate 0.10 roughly breaks even.
 *  Revenue ~= pop * taxRate * TAX_PER_CAPITA (credits/citizen/percentage-point).
 *  Costs scale with population AND with built infrastructure, so growth without
 *  investment is not free money. */
const TAX_PER_CAPITA = 22;   // credits per citizen per 1.0 taxRate per month
const MAINT_PER_CAPITA = 0.9; // baseline municipal payroll per citizen per month
function updateFinance(state: WorldState, avgIncome: number, imports: number, ops: number, construction: number): MonthlyReport {
  const pop = state.population.total;
  const diff = DIFFICULTY[state.difficulty];
  const popFactor = Math.pow(Math.max(1, pop) / 900, 0.78);
  const taxes = 900 * popFactor * state.policy.taxRate * TAX_PER_CAPITA * diff.taxMultiplier * (0.85 + avgIncome / 200);
  const commercial = 900 * popFactor * state.economy.commercialDemand * COST.commercialYield;
  const industrial = state.economy.exports * COST.industrialYield;
  const grants = 900 * popFactor * COST.grantPerCapita * (state.scenario.initial.decay > 0.3 ? 1.4 : 1);
  // Municipal payroll scales with population; infrastructure upkeep scales with units.
  const payroll = 900 * popFactor * MAINT_PER_CAPITA;
  const realBill = ops + payroll;
  // Underfunding (budget < bill) is allowed but degrades quality (handled in
  // updateServices via 'funded'); the full bill is still owed.
  const maintenance = realBill;
  const serviceOps = 0; // maintenance IS the service operation cost; avoid double-charging
  const debtInterest = state.debt * COST.interestRate;
  const floodLoss = state.activeShocks.some(a => a.kind === 'flood' && a.until === state.tick + 6) ? shockMag(state, 'flood') * COST.floodDamage : 0;

  const income = taxes + commercial + industrial + grants;
  const expenses = maintenance + serviceOps + debtInterest + imports + construction + floodLoss;
  const net = income - expenses;
  state.treasury += net;

  const b = { taxes, commercial, industrial, grants, maintenance, construction, serviceOps, debtInterest, imports };
  // ledger entries (one per category, rounded to 2dp)
  const actor = 'system';
  for (const [k, v] of Object.entries(b)) {
    if (v > 0.005) state.ledger.push({ tick: state.tick, actor, category: k, delta: Math.round((k === 'taxes' || k === 'commercial' || k === 'industrial' || k === 'grants' ? v : -v) * 100) / 100, note: k });
  }
  if (floodLoss > 0) state.ledger.push({ tick: state.tick, actor, category: 'disaster', delta: -Math.round(floodLoss * 100) / 100, note: 'flood damage' });
  if (state.ledger.length > BALANCE.ledgerCap) state.ledger.splice(0, state.ledger.length - BALANCE.ledgerCap);

  const warnings: string[] = [];
  if (state.treasury < 0) warnings.push('treasury negative');
  if (state.services.waterReliability < 0.6) warnings.push('water reliability below 60%');
  if (state.services.powerReliability < 0.6) warnings.push('power reliability below 60%');
  if (state.infra.pollution > 0.55) warnings.push('high pollution');
  if (state.roads.congestion > 0.7) warnings.push('severe congestion');
  if (state.debt > state.creditLimit * 0.8) warnings.push('near credit limit');
  if (state.services.unmetNeeds.length) warnings.push('unmet: ' + state.services.unmetNeeds.join(','));

  const report: MonthlyReport = {
    tick: state.tick, income, expenses, net,
    breakdown: { taxes, commercial, industrial, grants, maintenance, construction, serviceOps, debtInterest, imports },
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
      pushEvent(state, 'milestone', '里程碑 / Milestone', title, 'info');
    }
  };
  if (state.population.total >= 2000) add('town', '人口达到 2,000：小镇成型');
  if (state.population.total >= 4000) add('city', '人口达到 4,000：正式建市');
  if (state.population.total >= BALANCE.victoryPopulation) add('metropolis', '人口达到 6,000：大都会');
  if (state.economy.gdp >= 5000) add('economy', '月 GDP 突破 5,000 cr');
  if (state.roads.bridgeCount >= 1 && state.scenario.initial.riverBlock) add('bridge', '跨河大桥通车');
}

function checkEndConditions(state: WorldState, report: MonthlyReport) {
  if (state.status !== 'running') return;
  if (state.treasury < BALANCE.bankruptcyTreasury) {
    state.status = 'bankrupt';
    pushEvent(state, 'bankruptcy', '城市破产 / Bankruptcy',
      '财政崩溃：国库低于 ' + BALANCE.bankruptcyTreasury + ' cr。第 ' + state.tick + ' 月终止。', 'critical');
    return;
  }
  if (state.tick >= BALANCE.victoryMonths && state.population.total >= BALANCE.victoryPopulation
      && state.population.happiness >= BALANCE.victoryHappiness && state.treasury >= BALANCE.victorySolvency) {
    state.status = 'victory';
    pushEvent(state, 'victory', '大都会达成 / Metropolis',
      '连续治理达成：人口 ' + state.population.total + '，幸福度 ' + state.population.happiness.toFixed(2) + '，财政稳健。', 'info');
  }
}

/** The fixed tick. Pure: returns a NEW WorldState. */
export function stepWorld(state: WorldState, cmds: Command[] = []): WorldState {
  let s: WorldState = JSON.parse(JSON.stringify(state)) as WorldState;
  // 1. commands through the single queue
  let construction = 0;
  for (const cmd of cmds) {
    const { state: next, result } = applyCommand(s, cmd);
    s = next;
    for (const a of result.accepted) if (a.type === 'build') construction += COST.build[a.category]!.cost;
  }
  if (s.status !== 'running') return s;

  const rngs = restoreRNG(s.rng);
  // 2. exogenous shocks
  processShocks(s, rngs.events);
  const recession = shockMag(s, 'recession');
  const boom = shockMag(s, 'investment_boom');
  const migrationWave = shockMag(s, 'migration_wave');
  const infraDecay = shockMag(s, 'infra_decay');
  if (infraDecay > 0) for (const k of UTILITY_KEYS) s.infra[k].quality = clamp(s.infra[k].quality - infraDecay * 0.03);

  // 3. services
  const { imports, ops } = updateServices(s);
  // 4. economy
  updateEconomy(s, recession, boom);
  // 5. traffic
  updateTraffic(s);
  // 6. population
  const avgIncome = updatePopulation(s, rngs.population, migrationWave);
  // 7. finance
  const report = updateFinance(s, avgIncome, imports, ops, construction);
  // 8. histories, milestones, end conditions
  pushHistory(s.stats.populationHistory, s.population.total);
  pushHistory(s.stats.treasuryHistory, s.treasury);
  pushHistory(s.stats.happinessHistory, s.population.happiness);
  pushHistory(s.stats.debtHistory, s.debt);
  checkMilestones(s);
  checkEndConditions(s, report);
  // persist RNG states (determinism across save/load & replay)
  s.rng = serializeRNG({ ...rngs, terrain: RNG.fromState(s.rng.terrain) });
  s.tick += 1;
  return s;
}

/** Convenience: run N months with a per-tick command supplier. */
export function runMonths(state: WorldState, months: number, supplier: (s: WorldState, tick: number) => Command[]): WorldState {
  let s = state;
  for (let i = 0; i < months && s.status === 'running'; i++) s = stepWorld(s, supplier(s, s.tick));
  return s;
}
export { VERSION };
