/**
 * Centralized balance constants. EVERY price / upkeep / coefficient used by the
 * validator, the simulation and the observation MUST come from here so that
 * the agent-visible cost formula is the same one that actually applies.
 * All values are self-consistent game units invented for this project —
 * they are NOT claimed to replicate any commercial game's parameters.
 */
import type { BuildCategory, CostFormula, LegalRanges, UtilityKey } from './types.js';

export const VERSION = '0.1.0';
export const SCHEMA_VERSION = 1;
export const PROMPT_VERSION = 'mc-prompt-v1';

/** One tick = one month. Base unit of currency = "credit" (cr). */
export const COST = {
  build: {
    power_plant:     { cost: 2600, upkeep: 95,  capacity: 260 },
    water_works:     { cost: 2200, upkeep: 80,  capacity: 230 },
    sewage_plant:    { cost: 1800, upkeep: 65,  capacity: 210 },
    garbage_facility:{ cost: 1500, upkeep: 55,  capacity: 200 },
    clinic:          { cost: 1700, upkeep: 70,  capacity: 150 },
    school:          { cost: 1900, upkeep: 75,  capacity: 170 },
    fire_station:    { cost: 1400, upkeep: 60,  capacity: 160 },
    transit_hub:     { cost: 2100, upkeep: 85,  capacity: 240 },
    park:            { cost: 500,  upkeep: 15,  capacity: 90  },
    road_segment:    { cost: 320,  upkeep: 8,   capacity: 120 },
    bridge:          { cost: 2600, upkeep: 40,  capacity: 90  },
    res_zone:        { cost: 650,  upkeep: 18,  capacity: 60  },
    com_zone:        { cost: 780,  upkeep: 22,  capacity: 45  },
    ind_zone:        { cost: 900,  upkeep: 28,  capacity: 55  },
    civic_zone:      { cost: 700,  upkeep: 20,  capacity: 40  },
  } as Record<BuildCategory, { cost: number; upkeep: number; capacity: number }>,

  /** Per-capita demand for each utility per month. */
  perCapitaDemand: {
    power: 0.95, water: 1.05, sewage: 0.7, garbage: 0.55,
    health: 0.4, education: 0.45, fire: 0.3, transit: 0.6,
  } as Record<UtilityKey, number>,

  taxBase: 0.9,             // credits of tax per income-credit per month (scaled by taxRate)
  commercialYield: 0.32,
  industrialYield: 0.45,
  interestRate: 0.008,      // monthly on outstanding debt
  importPrice: 0.55,        // credits per unit of unmet demand bought externally
  serviceYield: 0.9,        // service satisfaction multiplier
  grantPerCapita: 0.10,     // intergovernmental transfer per citizen
  sampleWeight: 4,          // citizens represented by one Household sample
  maintenanceDecay: 0.0025, // quality lost per month if maintenance underfunded
  constructionUnit: 1,
  roadCapacityPerSeg: 120,
  bridgeCostMultiplier: 1,
  parkPollutionAbsorb: 0.06,
  indPollutionPerZone: 0.045,
  transitCongestionRelief: 0.07,
  floodDamage: 1800,
  droughtWaterFactor: 0.55,
  powerOutageFactor: 0.4,
  recessionDemandFactor: 0.65,
} as const;

/** Thresholds & legal ranges. */
export const BALANCE = {
  bankruptcyTreasury: -3500,      // treasury below this => bankrupt
  victoryPopulation: 6000,
  victoryHappiness: 0.62,
  victorySolvency: 0,             // treasury >= 0
  victoryMonths: 96,              // must survive at least 96 months
  maxDebtMultiple: 4,             // creditLimit = base * this
  startingCreditLimit: 12000,
  taxRateMax: 0.25,
  serviceLevelMax: 1.5,
  approvalThresholdDefault: 2200,
  maxHouseholdSamples: 900,
  mapWidth: 48, mapHeight: 48,
  historyCap: 240,
  eventCap: 200,
  ledgerCap: 400,
  pollutionDecay: 0.01,
  migrationHappinessPivot: 0.5,
  minServiceCoverage: 0.35,
} as const;

export const LEGAL_RANGES: LegalRanges = {
  taxRate: [0, BALANCE.taxRateMax],
  serviceLevel: [0, BALANCE.serviceLevelMax],
  constructionBudget: [0, 20000],
  maintenanceBudget: [0, 20000],
  envPriority: [0, 1],
  equityPriority: [0, 1],
  growthPriority: [0, 1],
  borrowMax: 6000,
  approvalThreshold: [0, 20000],
};

/** The exact cost formula exposed to agents (no hidden numbers). */
export function buildCostFormula(): CostFormula {
  return {
    build: JSON.parse(JSON.stringify(COST.build)),
    perCapitaDemand: { ...COST.perCapitaDemand },
    taxBase: COST.taxBase, interestRate: COST.interestRate,
    importPrice: COST.importPrice, serviceYield: COST.serviceYield,
    sampleWeight: COST.sampleWeight,
  };
}

/** Difficulty modifiers applied at state creation. */
export const DIFFICULTY = {
  easy:   { startTreasury: 14000, taxMultiplier: 1.15, shockMultiplier: 0.7, demandMultiplier: 0.9 },
  normal: { startTreasury: 9000,  taxMultiplier: 1.0,  shockMultiplier: 1.0, demandMultiplier: 1.0 },
  hard:   { startTreasury: 6000,  taxMultiplier: 0.88, shockMultiplier: 1.35, demandMultiplier: 1.12 },
} as const;
