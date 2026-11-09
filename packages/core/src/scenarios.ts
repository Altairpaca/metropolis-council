/**
 * Six benchmark scenarios. Values are EXPERIMENTAL v0.1 calibration targets,
 * NOT measured results. Public development seeds 101..110 are used by the
 * smoke suite; a separate holdout seed generator is documented in docs/.
 */
import type { ScenarioConfig, ShockSpec } from './types.js';

function shocks(list: ShockSpec[]): ShockSpec[] { return list; }

export const SCENARIOS: Record<string, ScenarioConfig> = {
  starter_town: {
    id: 'starter_town', title: '起步小镇 / Starter Town',
    description: 'Small budget, ample land, limited water. Population and jobs grow gradually; test long-horizon planning.',
    seed: 101, difficulty: 'normal', months: 120,
    initial: { treasury: 9000, debt: 0, population: 900, waterScarcity: 0.25, powerStress: 0, riverBlock: false, decay: 0, inequality: 0.1,
      shocks: shocks([
        { tick: 30, kind: 'migration_wave', magnitude: 0.5 },
        { tick: 60, kind: 'investment_boom', magnitude: 0.4 },
        { tick: 84, kind: 'recession', magnitude: 0.3 },
      ]) },
    targets: { population: 4200, gdp: 5200, happiness: 0.62, solvency: 0 },
  },
  water_industry: {
    id: 'water_industry', title: '缺水工业城 / Thirsty Industry',
    description: 'Scarce water, high industrial demand. Drought seasons pit industry against residents for water.',
    seed: 102, difficulty: 'normal', months: 120,
    initial: { treasury: 10000, debt: 0, population: 1600, waterScarcity: 0.75, powerStress: 0.1, riverBlock: false, decay: 0, inequality: 0.15,
      shocks: shocks([
        { tick: 24, kind: 'drought', magnitude: 0.7 },
        { tick: 52, kind: 'drought', magnitude: 0.85 },
        { tick: 78, kind: 'drought', magnitude: 0.6 },
      ]) },
    targets: { population: 4600, gdp: 6800, happiness: 0.58, solvency: 0 },
  },
  two_banks: {
    id: 'two_banks', title: '两岸交通 / Two Banks',
    description: 'A river blocks east-side housing from west-side jobs. Bridges are expensive; commuting demand rises.',
    seed: 103, difficulty: 'normal', months: 120,
    initial: { treasury: 11000, debt: 0, population: 1800, waterScarcity: 0.15, powerStress: 0, riverBlock: true, decay: 0, inequality: 0.2,
      shocks: shocks([
        { tick: 36, kind: 'migration_wave', magnitude: 0.6, region: 'east' },
        { tick: 66, kind: 'investment_boom', magnitude: 0.5, region: 'west' },
      ]) },
    targets: { population: 4400, gdp: 6000, happiness: 0.6, solvency: 0 },
  },
  declining_finance: {
    id: 'declining_finance', title: '衰退财政 / Declining Finance',
    description: 'Starts with heavy debt and deferred maintenance. Shrinking tax base and aging infrastructure.',
    seed: 104, difficulty: 'hard', months: 120,
    initial: { treasury: 7000, debt: 8000, population: 2400, waterScarcity: 0.2, powerStress: 0.2, riverBlock: false, decay: 0.45, inequality: 0.25,
      shocks: shocks([
        { tick: 18, kind: 'recession', magnitude: 0.5 },
        { tick: 44, kind: 'infra_decay', magnitude: 0.5 },
        { tick: 70, kind: 'recession', magnitude: 0.35 },
      ]) },
    targets: { population: 3000, gdp: 4200, happiness: 0.5, solvency: 0 },
  },
  unequal_growth: {
    id: 'unequal_growth', title: '不平等增长 / Unequal Growth',
    description: 'Two districts with large income/coverage gaps; outside investment favours the wealthy district.',
    seed: 105, difficulty: 'normal', months: 120,
    initial: { treasury: 10000, debt: 1000, population: 2200, waterScarcity: 0.2, powerStress: 0.1, riverBlock: false, decay: 0, inequality: 0.7,
      shocks: shocks([
        { tick: 30, kind: 'investment_boom', magnitude: 0.6, region: 'north_west' },
        { tick: 60, kind: 'investment_boom', magnitude: 0.5, region: 'north_west' },
      ]) },
    targets: { population: 4800, gdp: 6400, happiness: 0.58, solvency: 0 },
  },
  compound_crisis: {
    id: 'compound_crisis', title: '复合危机 / Compound Crisis',
    description: 'Moderate resources and a preparation window, then a flood and a power failure in sequence. Tests resilience.',
    seed: 106, difficulty: 'hard', months: 120,
    initial: { treasury: 12000, debt: 0, population: 2000, waterScarcity: 0.3, powerStress: 0.15, riverBlock: false, decay: 0.1, inequality: 0.2,
      shocks: shocks([
        { tick: 40, kind: 'flood', magnitude: 0.8 },
        { tick: 44, kind: 'power_outage', magnitude: 0.9 },
        { tick: 50, kind: 'flood', magnitude: 0.5 },
      ]) },
    targets: { population: 4200, gdp: 5600, happiness: 0.55, solvency: 0 },
  },
};

export const PUBLIC_DEV_SEEDS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
export function getScenario(id: string): ScenarioConfig { return SCENARIOS[id] ?? SCENARIOS.starter_town!; }
export function listScenarios(): string[] { return Object.keys(SCENARIOS); }
