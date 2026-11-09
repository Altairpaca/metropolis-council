/**
 * Metropolis Council — core type definitions.
 * Pure data contracts. No runtime dependencies, no DOM, no Node APIs.
 * This file is the shared vocabulary for every package. See CONTRACT.md.
 */

export type Difficulty = 'easy' | 'normal' | 'hard';
export type LandUse = 'empty' | 'road' | 'res' | 'com' | 'ind' | 'civic' | 'park';
export type ResourceKind = 'none' | 'fertile' | 'ore' | 'water';
export type UtilityKey = 'power' | 'water' | 'sewage' | 'garbage' | 'health' | 'education' | 'fire' | 'transit';
export type ZoneTarget = 'res' | 'com' | 'ind' | 'park' | 'civic' | 'none';
export type BuildCategory =
  | 'power_plant' | 'water_works' | 'sewage_plant' | 'garbage_facility'
  | 'clinic' | 'school' | 'fire_station' | 'transit_hub' | 'park'
  | 'road_segment' | 'bridge' | 'res_zone' | 'com_zone' | 'ind_zone' | 'civic_zone';
export type Role = 'planning' | 'finance' | 'transport' | 'welfare' | 'industry_env';
export type Track = 'mayor' | 'council';
export type Actor = 'player' | 'rule' | 'llm' | 'system' | 'baseline';
export type GameStatus = 'running' | 'victory' | 'bankrupt';

export interface Tile {
  x: number; y: number;
  height: number;       // 0..1 elevation
  water: number;        // 0..1 water coverage (1 = full water)
  slope: number;        // 0..1
  resource: ResourceKind;
  buildable: boolean;
  landUse: LandUse;
  density: number;       // 0..1 built density, drives 3D building height
  pollution: number;     // 0..1 local
  landValue: number;     // 0..1
}

export interface Region {
  id: string;
  name: string;
  cells: number[];              // tile indices
  center: { x: number; y: number };
}

export interface WorldMap {
  width: number; height: number; seed: number;
  tiles: Tile[];
  riverCells: number[];
  spawn: { x: number; y: number };
  regions: Region[];
  seaLevel: number;
}

export interface RNGState { terrain: number; events: number; population: number; economy: number; }

export interface Policy {
  taxRate: number;              // 0..0.25
  serviceLevel: number;         // 0..1.5
  constructionBudget: number;   // credits / month cap
  maintenanceBudget: number;    // credits / month cap
  envPriority: number;          // 0..1
  equityPriority: number;       // 0..1
  growthPriority: number;       // 0..1
  borrowingAllowed: boolean;
  approvalThreshold: number;    // cost above which a proposal needs player approval; Infinity = auto
}

export interface ZoneIntent {
  id: string;
  target: ZoneTarget;
  priority: number;   // 0..1
  maxBudget: number;  // credits
}

export interface UtilityState {
  capacity: number; demand: number; coverage: number;
  quality: number;    // 0..1, decays if maintenance underfunded
  upkeep: number;     // credits / month / effective unit
  units: number;
}

export interface InfraState {
  power: UtilityState; water: UtilityState; sewage: UtilityState; garbage: UtilityState;
  health: UtilityState; education: UtilityState; fire: UtilityState; transit: UtilityState;
  pollution: number;  // 0..1 citywide
}

export interface Household {
  id: number;
  region: string;
  size: number;              // persons in this representative household
  income: number;            // credits / month
  age: number;               // months of head of household
  homeTile: number;
  workplace: string | null;  // region id or null
  employed: boolean;
  education: number;         // 0..1
  health: number;            // 0..1
  happiness: number;         // 0..1
  needs: { housing: number; shopping: number; work: number }; // 0..1 satisfaction
  commute: number;           // minutes
}

export interface PopulationState {
  total: number;                       // citizens (sum of household.size * sampleWeight)
  households: Household[];             // representative sample
  byRegion: Record<string, number>;
  happiness: number; health: number; unemployment: number;
  netMigration: number; commuteTime: number;
}

export interface EconomyState {
  gdp: number; employment: number; jobs: number;
  commercialDemand: number; industrialDemand: number; residentialDemand: number;
  landValue: number; imports: number; exports: number; businesses: number;
}

export interface ServiceState {
  satisfaction: number;
  waterReliability: number; powerReliability: number;
  healthCoverage: number; educationCoverage: number; fireCoverage: number; transitCoverage: number;
  unmetNeeds: string[];
}

export interface RoadNode { id: number; x: number; y: number; }
export interface RoadEdge { a: number; b: number; capacity: number; load: number; type: 'street' | 'avenue' | 'bridge'; }
export interface RoadNetwork {
  nodes: RoadNode[]; edges: RoadEdge[];
  congestion: number; connectivity: number; bridgeCount: number;
}

export interface StatState {
  sampleWeight: number;
  populationHistory: number[]; treasuryHistory: number[]; happinessHistory: number[]; debtHistory: number[];
}

export interface LedgerEntry { tick: number; actor: string; category: string; delta: number; note: string; }

export interface MonthlyReport {
  tick: number; income: number; expenses: number; net: number;
  breakdown: {
    taxes: number; commercial: number; industrial: number; grants: number;
    maintenance: number; construction: number; serviceOps: number; debtInterest: number; imports: number;
  };
  population: number;
  services: Record<string, number>;
  warnings: string[];
}

export interface GameEvent {
  id: string; tick: number; kind: string; title: string; text: string;
  severity: 'info' | 'warn' | 'critical';
  data?: Record<string, number>;
}

export interface PendingProposal {
  id: string; tick: number; role: string; actions: Action[];
  expected_cost: number; rationale: string; uncertainty: number;
}

export type ShockKind = 'drought' | 'power_outage' | 'flood' | 'recession' | 'investment_boom' | 'migration_wave' | 'infra_decay';
export interface ShockSpec { tick: number; kind: ShockKind; magnitude: number; region?: string; }

export interface ScenarioConfig {
  id: string; title: string; description: string;
  seed: number; difficulty: Difficulty; months: number;
  initial: {
    treasury: number; debt: number; population: number;
    waterScarcity: number; powerStress: number; riverBlock: boolean;
    decay: number; inequality: number;
    shocks: ShockSpec[];
  };
  targets: { population: number; gdp: number; happiness: number; solvency: number };
}

export interface WorldState {
  schemaVersion: 1;
  seed: number;
  difficulty: Difficulty;
  tick: number;                 // month index, starts 0
  map: WorldMap;
  rng: RNGState;
  treasury: number; debt: number; creditLimit: number;
  policy: Policy;
  zones: Record<string, ZoneIntent>;
  infra: InfraState;
  population: PopulationState;
  economy: EconomyState;
  services: ServiceState;
  roads: RoadNetwork;
  stats: StatState;
  events: GameEvent[];          // last 200
  milestones: string[];
  status: GameStatus;
  ledger: LedgerEntry[];        // last 400
  lastReport: MonthlyReport | null;
  reportHistory: MonthlyReport[];  // last 240
  scenario: ScenarioConfig;
  pending: PendingProposal[];
  shockCursor: number;           // index into scenario.initial.shocks already fired
  activeShocks: ActiveShock[];   // timed exogenous effects, expire at 'until'
}

export interface ActiveShock { kind: ShockKind; until: number; magnitude: number; region?: string; }

// ---------------- Actions / Commands ----------------
export type Action =
  | { type: 'set_policy'; patch: Partial<Policy> }
  | { type: 'set_zone'; region: string; target: ZoneTarget; priority: number; maxBudget: number }
  | { type: 'build'; category: BuildCategory; region?: string; tile?: number; level?: number }
  | { type: 'borrow'; amount: number }
  | { type: 'repay'; amount: number }
  | { type: 'set_service_level'; level: number }
  | { type: 'approve_proposal'; proposalId: string }
  | { type: 'reject_proposal'; proposalId: string }
  | { type: 'noop' };

export interface Command {
  id: string; tick: number; actor: Actor; role?: string;
  actions: Action[]; rationale?: string; uncertainty?: number;
}

export interface ValidationResult {
  ok: boolean; errors: string[];
  accepted: Action[];
  rejected: { action: Action; reason: string }[];
}

// ---------------- Observation (the ONLY agent-visible view) ----------------
export interface CandidateAction {
  id: string; label: string; category: BuildCategory; region?: string;
  estCost: number; estUpkeep: number; description: string;
}
export interface LegalRanges {
  taxRate: [number, number]; serviceLevel: [number, number];
  constructionBudget: [number, number]; maintenanceBudget: [number, number];
  envPriority: [number, number]; equityPriority: [number, number]; growthPriority: [number, number];
  borrowMax: number; approvalThreshold: [number, number];
}
export interface CostFormula {
  build: Record<BuildCategory, { cost: number; upkeep: number; capacity: number }>;
  perCapitaDemand: Record<UtilityKey, number>;
  taxBase: number; interestRate: number; importPrice: number;
  serviceYield: number; sampleWeight: number;
}
export interface RegionObservation {
  id: string; name: string; population: number; happiness: number;
  serviceCoverage: number; landValue: number; pollution: number;
  zoneTarget: ZoneTarget; roadCount: number; inequality: number;
}
export interface Observation {
  tick: number; month: number; year: number;
  treasury: number; debt: number; creditLimit: number;
  policy: Policy;
  population: { total: number; happiness: number; health: number; unemployment: number; netMigration: number; commuteTime: number };
  economy: { gdp: number; jobs: number; employment: number; landValue: number; demands: { res: number; com: number; ind: number } };
  services: Record<string, number>;
  infra: Record<UtilityKey, { capacity: number; demand: number; coverage: number; quality: number }>;
  congestion: number; connectivity: number;
  coverage: Record<string, number>;
  regions: RegionObservation[];
  warnings: string[];
  recentReports: MonthlyReport[];
  candidateActions: CandidateAction[];
  legalRanges: LegalRanges;
  costFormula: CostFormula;
}

// ---------------- Council ----------------
export interface Proposal {
  proposal_id: string; role: Role; tick: number;
  observations: string[]; actions: Action[];
  expected_cost: number; rationale: string; uncertainty: number; conflicts: string[];
}
export interface AgentContext {
  observation: Observation; role: Role | 'mayor'; history: Proposal[];
  budgetRemaining: number; callsRemaining: number;
}
export interface CallMeta {
  ok: boolean; latencyMs: number; promptTokens: number; completionTokens: number;
  costUSD: number; error?: string; retries: number; raw?: string;
}
export interface LLMConfig {
  baseUrl: string; model: string; apiKey?: string; timeoutMs: number;
  maxTokens: number; maxCallsPerMinute: number; maxCostUSD: number;
  pricePer1kIn: number; pricePer1kOut: number; temperature: number;
}
export interface CouncilAgent {
  readonly id: string;
  readonly kind: 'rule' | 'noop' | 'greedy' | 'llm';
  decide(ctx: AgentContext): Promise<Proposal | null>;
}

// ---------------- Bench ----------------
export interface AgentMeta {
  callCount: number; tokensIn: number; tokensOut: number; costUSD: number;
  latencyMs: number; errors: string[]; fallbackUsed: boolean;
}
export interface RunConfig {
  scenarioId: string; seed: number; track: Track; agentId: string;
  maxDecisionCalls: number; maxTokens: number; months: number; decisionPeriod: number;
}
export interface GovernanceAgent {
  id: string;
  decide(obs: Observation, ctx: { tick: number; track: Track; callsLeft: number }): Promise<{ command: Command; meta: AgentMeta }>;
}
export interface RawMetrics {
  population: number[]; treasury: number[]; debt: number[]; gdp: number[];
  happiness: number[]; health: number[]; unemployment: number[]; commuteTime: number[];
  serviceCoverage: number[]; pollution: number[]; netMigration: number[];
  illegalActionRate: number; buildSpend: number; maintenanceSpend: number;
  survivalTicks: number; finalPopulation: number; finalTreasury: number; finalDebt: number;
  waterReliability: number[]; powerReliability: number[];
}
export interface DimensionScores {
  prosperity: number; finance: number; services: number;
  environment_health: number; equity: number; resilience: number;
  composite: number; hardFloors: { bankrupt: boolean; chronicWaterShortage: boolean; serviceCollapse: boolean };
}
export interface ScoreConfig {
  weights: { prosperity: number; finance: number; services: number; environment_health: number; equity: number; resilience: number };
  thresholds: Record<string, { bad: number; good: number; higherIsBetter: boolean }>;
}
export interface SnapshotRecord { tick: number; stateHash: string; treasury: number; population: number; }
export interface ActionRecord { tick: number; command: Command; hashBefore: string; hashAfter: string; validation: ValidationResult; }
export interface ReplayRecord { scenarioId: string; seed: number; difficulty: Difficulty; entries: { tick: number; command: Command; hashBefore: string; hashAfter: string }[]; finalHash: string; version: string; }
export interface EpisodeResult {
  config: RunConfig; version: string; stateHashFinal: string;
  snapshots: SnapshotRecord[]; actions: ActionRecord[];
  metrics: RawMetrics; scores: DimensionScores | null;
  failure: { kind: string; tick: number } | null;
  cost: AgentMeta; elapsedMs: number; replay: ReplayRecord;
}
export interface SuiteReport {
  version: string; createdAt: string; episodes: EpisodeResult[];
  summary: Record<string, { mean: Record<string, number>; ci: Record<string, { lo: number; hi: number }>; failures: number }>;
  elapsedMs: number;
}
