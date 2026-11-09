/**
 * getObservation — the ONLY information channel to any agent (rule, greedy,
 * LLM, baseline). Deliberately omits: hidden RNG states, future shocks, raw
 * household arrays, internal tile arrays, pending queue internals.
 * The cost formula exposed here is the SAME one the validator uses.
 */
import type { Observation, WorldState, CandidateAction, BuildCategory, UtilityKey, RegionObservation } from './types.js';
import { COST, BALANCE, LEGAL_RANGES, buildCostFormula } from './constants.js';

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const UTILITY_KEYS: UtilityKey[] = ['power', 'water', 'sewage', 'garbage', 'health', 'education', 'fire', 'transit'];

export function getObservation(state: WorldState): Observation {
  const s = state;
  const infra: Observation['infra'] = {} as Observation['infra'];
  for (const k of UTILITY_KEYS) {
    const u = s.infra[k];
    infra[k] = { capacity: u.capacity, demand: u.demand, coverage: u.coverage, quality: u.quality };
  }
  const services: Record<string, number> = {
    satisfaction: s.services.satisfaction, waterReliability: s.services.waterReliability,
    powerReliability: s.services.powerReliability, healthCoverage: s.services.healthCoverage,
    educationCoverage: s.services.educationCoverage, fireCoverage: s.services.fireCoverage,
    transitCoverage: s.services.transitCoverage, pollution: s.infra.pollution,
  };
  const warnings = s.lastReport?.warnings ?? [];

  const regions: RegionObservation[] = s.map.regions.map(r => {
    const pop = s.population.byRegion[r.id] ?? 0;
    const regionTiles = r.cells.map(c => s.map.tiles[c]!).filter(Boolean);
    const roads = regionTiles.filter(t => t.landUse === 'road').length;
    const pollution = regionTiles.reduce((a, t) => a + t.pollution, 0) / Math.max(1, regionTiles.length);
    const landValue = regionTiles.reduce((a, t) => a + t.landValue, 0) / Math.max(1, regionTiles.length);
    const coverage = (s.services.waterReliability + s.services.healthCoverage) / 2;
    const happy = s.population.happiness * (0.85 + 0.15 * (r.id === 'north_west' ? 1.05 : 1));
    return {
      id: r.id, name: r.name, population: Math.round(pop), happiness: clamp(happy),
      serviceCoverage: clamp(coverage), landValue: clamp(landValue), pollution: clamp(pollution),
      zoneTarget: s.zones[r.id]?.target ?? 'none', roadCount: roads,
      inequality: clamp(s.scenario.initial.inequality * (r.id === 'south_east' || r.id === 'north_east' ? 1 : 0.4)),
    };
  });

  // Candidate actions: bounded menu shared by rule council and LLM (no hidden info).
  const candidates: CandidateAction[] = [];
  const buildMenu: { cat: BuildCategory; label: string; desc: string }[] = [
    { cat: 'power_plant', label: '发电厂 Power plant', desc: '新增供电容量' },
    { cat: 'water_works', label: '水厂 Water works', desc: '新增供水容量' },
    { cat: 'sewage_plant', label: '污水处理厂', desc: '提升排污覆盖' },
    { cat: 'garbage_facility', label: '垃圾处理站', desc: '提升垃圾处理' },
    { cat: 'clinic', label: '诊所 Clinic', desc: '提升医疗覆盖' },
    { cat: 'school', label: '学校 School', desc: '提升教育覆盖' },
    { cat: 'fire_station', label: '消防站', desc: '提升消防覆盖' },
    { cat: 'transit_hub', label: '交通枢纽', desc: '缓解拥堵、缩短通勤' },
    { cat: 'park', label: '公园 Park', desc: '吸收污染、提升幸福' },
    { cat: 'road_segment', label: '道路段', desc: '提高路网容量' },
    { cat: 'bridge', label: '跨河大桥', desc: '连接两岸（昂贵）' },
    { cat: 'res_zone', label: '住宅分区', desc: '增加住房与人口容量' },
    { cat: 'com_zone', label: '商业分区', desc: '增加商业与就业' },
    { cat: 'ind_zone', label: '工业分区', desc: '增加产出（有污染）' },
    { cat: 'civic_zone', label: '公共设施分区', desc: ' civic 用地' },
  ];
  for (const b of buildMenu) {
    const spec = COST.build[b.cat];
    candidates.push({ id: 'build_' + b.cat, label: b.label, category: b.cat,
      estCost: spec.cost, estUpkeep: spec.upkeep, description: b.desc });
  }
  for (const r of s.map.regions) {
    candidates.push({ id: 'zone_' + r.id + '_res', label: '划定 ' + r.name + ' 住宅区', category: 'res_zone', region: r.id,
      estCost: COST.build.res_zone.cost, estUpkeep: COST.build.res_zone.upkeep, description: 'zone intent: residential' });
    candidates.push({ id: 'zone_' + r.id + '_ind', label: '划定 ' + r.name + ' 工业区', category: 'ind_zone', region: r.id,
      estCost: COST.build.ind_zone.cost, estUpkeep: COST.build.ind_zone.upkeep, description: 'zone intent: industrial' });
  }
  candidates.push({ id: 'policy_tax_up', label: '提高税率 +0.01', category: 'civic_zone', estCost: 0, estUpkeep: 0, description: 'policy: taxRate + 0.01' });
  candidates.push({ id: 'policy_tax_down', label: '降低税率 -0.01', category: 'civic_zone', estCost: 0, estUpkeep: 0, description: 'policy: taxRate - 0.01' });
  candidates.push({ id: 'borrow_2000', label: '举债 2000 cr', category: 'civic_zone', estCost: 0, estUpkeep: COST.interestRate * 2000, description: 'borrow 2000' });

  return {
    tick: s.tick, month: (s.tick % 12) + 1, year: Math.floor(s.tick / 12) + 1,
    treasury: s.treasury, debt: s.debt, creditLimit: s.creditLimit,
    policy: { ...s.policy },
    population: { total: s.population.total, happiness: s.population.happiness, health: s.population.health,
      unemployment: s.population.unemployment, netMigration: s.population.netMigration, commuteTime: s.population.commuteTime },
    economy: { gdp: s.economy.gdp, jobs: s.economy.jobs, employment: s.economy.employment,
      landValue: s.economy.landValue, demands: { res: s.economy.residentialDemand, com: s.economy.commercialDemand, ind: s.economy.industrialDemand } },
    services, infra, congestion: s.roads.congestion, connectivity: s.roads.connectivity,
    coverage: { water: s.services.waterReliability, power: s.services.powerReliability,
      health: s.services.healthCoverage, education: s.services.educationCoverage, transit: s.services.transitCoverage },
    regions, warnings,
    recentReports: s.reportHistory.slice(-6),
    candidateActions: candidates,
    legalRanges: JSON.parse(JSON.stringify(LEGAL_RANGES)),
    costFormula: buildCostFormula(),
  };
}
