# Metropolis Council — Internal Integration Contract (v0.1)

> This file is the SINGLE SOURCE OF TRUTH for the interfaces between workstreams.
> All code must conform. Lead owns this file; teammates must NOT edit it.
> Stack: TypeScript (strict, ESM), Node 24, pnpm, Vite 6, Three.js (r17x), Zod.
> No runtime deps in `core` beyond `zod` — pure deterministic TypeScript.

## Package layout (pnpm workspace)

```
metropolis-council/
  package.json            (root, private, workspaces, scripts)
  pnpm-workspace.yaml
  tsconfig.base.json
  packages/
    core/        -> @metropolis/core      (pure deterministic sim; NO DOM, NO three, NO node APIs)
    council/     -> @metropolis/council    (agents + validator + LLM adapter; depends core)
    bench/       -> @metropolis/bench     (headless runner + baselines + scoring; depends core+council)
    sim/         -> @metropolis/sim        (CLI: headless commands; depends core+council+bench)
    render/     -> @metropolis/render     (Three.js renderer; depends core)
    server/      -> @metropolis/server    (LLM proxy + static server; node-only)
  apps/web/      -> @metropolis/web        (Vite app: import core+council+render; HUD in apps/web/src/hud.ts)
  docs/  scenarios/  results/  tools/
```

## Core contract (packages/core/src/index.ts exports)

All types are plain TypeScript interfaces/types with Zod schemas where noted.

### Geometry / map
- `type Tile = { x:number; y:number; height:number; water:number; slope:number; resource:'none'|'fertile'|'ore'|'water'; buildable:boolean; landUse:'empty'|'road'|'res'|'com'|'ind'|'civic'|'park'; }`
- `WorldMap = { width:number; height:number; seed:number; tiles: Tile[]; riverCells:number[]; spawn:{x:number;y:number}; regions: Region[] }`
- `Region = { id:string; name:string; cells:number[]; center:{x:number;y:number} }` (4 quadrants + center)
- `generateMap(seed:number, difficulty:Difficulty): WorldMap` — pure, deterministic, retries internally.
- Tile index helper: `idx(map,x,y)=y*map.width+x`.

### RNG (deterministic, split streams)
- `class RNG { constructor(seed:number); next():number; int(n:number):number; range(a,b):number; pick<T>(a:T[]):T; state():number; static fromState(n:number):RNG }`
  - xorshift32-based. `next()` returns float in [0,1). `state()` returns the full uint32.
- `WorldRNG = { terrain:RNG; events:RNG; population:RNG; economy:RNG }` — each `RNG` seeded deterministically from base seed + salt. All four states must be serialized in saves.

### WorldState (plain JSON-serializable object)
```ts
interface WorldState {
  schemaVersion: 1;
  seed: number;
  difficulty: Difficulty;   // 'easy'|'normal'|'hard'
  tick: number;             // month index, starts 0
  map: WorldMap;
  rng: { terrain:number; events:number; population:number; economy:number }; // uint32 states
  treasury: number; debt: number; creditLimit: number;
  policy: Policy;
  zones: Record<string, ZoneIntent>;
  infra: InfraState;
  population: PopulationState;
  economy: EconomyState;
  services: ServiceState;
  roads: RoadNetwork;
  stats: StatState;
  events: GameEvent[];       // last 200
  milestones: string[];      // achieved milestone ids
  status: 'running'|'victory'|'bankrupt';
  ledger: LedgerEntry[];     // last 400
  lastReport: MonthlyReport|null;
  scenario: ScenarioConfig;  // active scenario (saved for replay/determinism)
  pending: PendingProposal[]; // proposals awaiting player approval (approval mode)
}
```

- `Policy = { taxRate:number; serviceLevel:number; constructionBudget:number; maintenanceBudget:number; envPriority:number; equityPriority:number; growthPriority:number; borrowingAllowed:boolean; approvalThreshold:number }`
  - taxRate 0..0.25, serviceLevel 0..1.5, budgets >=0, priorities 0..1, threshold 0..Infinity.
- `ZoneIntent = { id:string; target:'res'|'com'|'ind'|'park'|'civic'|'none'; priority:number; maxBudget:number }`
- `InfraState = { power: UtilityState; water: UtilityState; sewage: UtilityState; garbage: UtilityState; health: UtilityState; education: UtilityState; fire: UtilityState; transit: UtilityState; pollution:number }`
  - `UtilityState = { capacity:number; demand:number; coverage:number; quality:number; upkeep:number; units:number }`
- `PopulationState = { total:number; households: Household[]; byRegion: Record<string,number>; happiness:number; health:number; unemployment:number; netMigration:number; commuteTime:number }`
  - Each `Household` is a **representative sample**: `{ id, region, size, income, age, homeTile, workplace:string|null, employed:boolean, education:number, health:number, happiness:number, needs:{housing,shopping,work}, commute:number }`. **1 household = SAMPLE_WEIGHT(=1..20) citizens**, scaling is `state.stats.sampleWeight`. Document that this is aggregated sampling, NOT per-citizen LLM.
- `EconomyState = { gdp:number; employment:number; jobs:number; commercialDemand:number; industrialDemand:number; residentialDemand:number; landValue:number; imports:number; exports:number; businesses:number }`
- `ServiceState = { satisfaction:number; waterReliability:number; powerReliability:number; healthCoverage:number; educationCoverage:number; fireCoverage:number; transitCoverage:number; unmetNeeds:string[] }`
- `RoadNetwork = { nodes:RoadNode[]; edges:RoadEdge[]; congestion:number; connectivity:number; bridgeCount:number }`
  - `RoadNode = { id:number; x:number; y:number }`, `RoadEdge = { a:number; b:number; capacity:number; load:number; type:'street'|'avenue'|'bridge' }`
- `StatState = { sampleWeight:number; populationHistory:number[]; treasuryHistory:number[]; happinessHistory:number[]; debtHistory:number[] }` (histories capped at 240)
- `LedgerEntry = { tick:number; actor:string; category:string; delta:number; note:string }`
- `MonthlyReport = { tick, income, expenses, net, breakdown:{taxes,commercial,industrial,grants,maintenance,construction,serviceOps,debtInterest,imports}, population, services:{...}, warnings:string[] }`
- `GameEvent = { id, tick, kind, title, text, severity:'info'|'warn'|'critical', data?:Record<string,number> }`
- `PendingProposal = { id:string; tick:number; role:string; actions:Action[]; expected_cost:number; rationale:string; uncertainty:number }`

### Command queue (THE ONLY mutation path)
- `type Action =`
  - `{ type:'set_policy'; patch: Partial<Policy> }`
  - `{ type:'set_zone'; region:string; target:ZoneIntent['target']; priority:number; maxBudget:number }`
  - `{ type:'build'; category:BuildCategory; region?:string; tile?:number; level?:number }`
    - `BuildCategory = 'power_plant'|'water_works'|'sewage_plant'|'garbage_facility'|'clinic'|'school'|'fire_station'|'transit_hub'|'park'|'road_segment'|'bridge'|'res_zone'|'com_zone'|'ind_zone'|'civic_zone'`
  - `{ type:'borrow'; amount:number }`
  - `{ type:'repay'; amount:number }`
  - `{ type:'set_service_level'; level:number }`
  - `{ type:'approve_proposal'; proposalId:string }`
  - `{ type:'reject_proposal'; proposalId:string }`
  - `{ type:'noop' }`
- `type Command = { id:string; tick:number; actor:'player'|'rule'|'llm'|'system'|'baseline'; role?:string; actions:Action[]; rationale?:string; uncertainty?:number }`
- `type ValidationResult = { ok:boolean; errors:string[]; accepted:Action[]; rejected:{action:Action; reason:string}[] }`
- `validateCommand(state:WorldState, cmd:Command): ValidationResult` — pure, checks budget, ranges, region existence, whitelist, affordability, borrowing limits. **Never mutates.**
- `applyCommand(state:WorldState, cmd:Command): { state:WorldState; result:ValidationResult }` — recomputes derived costs; returns NEW state (structural clone), logs ledger+events.
- `stepWorld(state:WorldState, cmds:Command[]): WorldState` — fixed tick: (1) validate+apply all commands in order, (2) run exogenous events, (3) run population/economy/services/traffic update, (4) compute monthly report, (5) increment tick, (6) check victory/bankruptcy. Pure function; caller replaces state.
- `createInitialState(seed:number, difficulty:Difficulty, opts?:{scenario?:ScenarioConfig}): WorldState`
- `getObservation(state:WorldState): Observation` — **the ONLY info given to agents/baselines**. No hidden RNG, no future events, no internal arrays beyond aggregates.
  - `Observation = { tick, month, year, treasury, debt, creditLimit, policy, population:{total,happiness,health,unemployment,netMigration,commuteTime}, economy:{gdp,jobs,employment,landValue,demands:{res,com,ind}}, services:Record<string,number>, infra:{...capacities/demands}, congestion, coverage:{...}, regions: RegionObservation[], warnings:string[], recentReports:MonthlyReport[], candidateActions:CandidateAction[], legalRanges:LegalRanges, costFormula:CostFormula }`
  - `CandidateAction = { id, label, category:BuildCategory, region?:string, estCost:number, estUpkeep:number, description }`
  - `LegalRanges`: min/max for every policy field + budget ceiling.
  - `CostFormula`: named constants with numeric values (build costs, upkeep, tax yield, service demand per capita, etc.) — same numbers used by validator.
- `serializeState(state): string`, `deserializeState(json:string): WorldState` (validates schemaVersion), `stateHash(state): string` (stable SHA-256-like hash over canonical JSON; implement pure JS FNV-1a 64-bit → hex, deterministic).

### Constants (packages/core/src/constants.ts)
Export `COST` object with every price/upkeep/demand coefficient. Both validator AND simulation AND observation must use these. Export `BALANCE` with thresholds (bankruptcy treasury < -X, victory pop >= Y & milestones). Export `SCENARIOS` (scenario configs) from scenarios.ts.

### Scenario
`ScenarioConfig = { id:string; title:string; description:string; seed:number; difficulty:Difficulty; months:number; initial:{ treasury, debt, population, waterScarcity:number, powerStress:number, riverBlock:boolean, decay:number, inequality:number, shocks: ShockSpec[] }; targets:{ population, gdp, happiness, solvency }; }`
`ShockSpec = { tick:number; kind:'drought'|'power_outage'|'flood'|'recession'|'investment_boom'|'migration_wave'|'infra_decay'; magnitude:number; region?:string }`
`SCENARIOS` must include: `starter_town`, `water_industry`, `two_banks`, `declining_finance`, `unequal_growth`, `compound_crisis`. Public dev seeds 101..110.

## Council contract (packages/council/src/index.ts exports)

- `type Role = 'planning'|'finance'|'transport'|'welfare'|'industry_env'`
- `type Proposal = { proposal_id:string; role:Role; tick:number; observations:string[]; actions:Action[]; expected_cost:number; rationale:string; uncertainty:number; conflicts:string[] }`
  - **This is the ONLY shape an LLM may produce.** Bounded, whitelist actions, no free text execution.
- `type AgentContext = { observation:Observation; role:Role|'mayor'; history:Proposal[]; budgetRemaining:number; callsRemaining:number }`
- `interface CouncilAgent { readonly id:string; readonly kind:'rule'|'noop'|'greedy'|'llm'; decide(ctx:AgentContext): Promise<Proposal|null> }`
- `makeRuleCouncil(): CouncilAgent[]` — 5 role agents, pure deterministic scoring over candidates.
- `makeNoopAgent(): CouncilAgent`, `makeGreedyAgent(): CouncilAgent`
- `class DeterministicArbiter { select(proposals:Proposal[], obs:Observation, budget:number): { winner:Proposal|null; ranked:{proposal_id:string; score:number; reason:string}[] } }`
  - pure, score = f(expected utility, cost, uncertainty, policy priorities, legality); record rejection reasons.
- `proposalsToCommand(proposals:Proposal[], tick:number, actor:'rule'|'llm'|'baseline'): Command`
- `class LLMAdapter { constructor(cfg:LLMConfig); propose(ctx:AgentContext): Promise<{proposal:Proposal|null; meta:CallMeta}> }`
  - `LLMConfig = { baseUrl:string; model:string; apiKey?:string; timeoutMs:number; maxTokens:number; maxCallsPerMinute:number; maxCostUSD:number; pricePer1kIn:number; pricePer1kOut:number; temperature:number }`
  - Calls OpenAI-compatible `POST {baseUrl}/chat/completions`. **Only through the local proxy** (`/api/llm`), never with a raw browser key.
  - `CallMeta = { ok:boolean; latencyMs:number; promptTokens:number; completionTokens:number; costUSD:number; error?:string; retries:number; raw?:string }`
  - Robust: JSON schema in system prompt, strip code fences, Zod-validate response, **on ANY failure → deterministic fallback** (rule proposal). Never throws. Rate-limit + cost cap enforced locally.
  - `makeMockLLM(behavior:'valid'|'malformed'|'overspend'|'illegal'|'timeout'|'rate429'): CouncilAgent` for protocol tests.
- `class LLMProxy` lives in packages/server — reads `.env.local`, holds keys, forwards to upstream, returns response. Config via env vars `MC_LLM_BASE_URL`, `MC_LLM_API_KEY`, `MC_LLM_MODEL`. Key never logged, never in save/log/browser bundle.
- `promptTemplate(obs,role,history): {system:string; user:string}` — exported for bench reproducibility; versioned `PROMPT_VERSION='mc-prompt-v1'`.

### Council convenience functions (REQUIRED — these are what bench wraps)
- `runNoop(tick:number): Command` — actor `baseline`, actions `[{type:'noop'}]`.
- `runGreedy(obs:Observation, tick:number): Command` — finance-greedy: only reacts to visible cash/debt: raises taxRate toward cap when cash low, cuts serviceLevel/constructionBudget when debt high, repays debt when cash high. No hidden info. Deterministic.
- `runRuleCouncil(obs:Observation, tick:number, budgetRemaining:number, history?:Proposal[]): Command` — pure deterministic: build 5 role proposals over `obs.candidateActions`, score them, `DeterministicArbiter` ranks, emit ONE command (actor `rule`) with accepted actions. Must be self-funding-aware (never propose actions that exceed visible treasury+credit) and diverse across roles. This is the default in-game council AND the `rule_council` baseline.
- `runLLM(ctx:AgentContext, cfg:LLMConfig): Promise<{command:Command; meta:CallMeta; proposal:Proposal|null}>` — wraps LLMAdapter + fallback; never throws.
- All `run*` functions are PURE (no Math.random, no Date.now except latency measurement inside LLMAdapter meta).

### Package mechanics (ALL workstreams)
- Each `packages/<x>/package.json` declares `{"name":"@metropolis/<x>","version":"0.1.0","type":"module","main":"./src/index.ts"}`. **No per-package tsconfig** — the root `tsconfig.json` maps `@metropolis/*` to `./packages/*/src/index.ts`.
- Runtime deps `three` and `zod` are installed at the ROOT. Do not add separate installs; imports resolve via root node_modules.
- CLI/tests run through `tsx` (no compile step). Web builds with Vite from `apps/web/vite.config.ts` (root `--config`).

## Bench contract (packages/bench/src/index.ts exports)

- `type Track = 'mayor'|'council'`
- `type RunConfig = { scenarioId:string; seed:number; track:Track; agentId:string; maxDecisionCalls:number; maxTokens:number; months:number; decisionPeriod:number }`
- `interface GovernanceAgent { id:string; decide(obs:Observation, ctx:{tick:number;track:Track;callsLeft:number}): Promise<{command:Command; meta:AgentMeta}> }`
  - `AgentMeta = { callCount:number; tokensIn:number; tokensOut:number; costUSD:number; latencyMs:number; errors:string[]; fallbackUsed:boolean }`
- `makeBaseline(id:'noop'|'finance_greedy'|'rule_council'): GovernanceAgent`
- `runEpisode(cfg:RunConfig, agent:GovernanceAgent): Promise<EpisodeResult>`
- `EpisodeResult = { config, version, stateHashFinal, snapshots:SnapshotRecord[], actions:ActionRecord[], metrics:RawMetrics, scores:DimensionScores|null, failure:{kind:string;tick:number}|null, cost:AgentMeta, elapsedMs:number, replay:ReplayRecord }`
- `scoreEpisode(raw:RawMetrics, cfg:ScoreConfig): DimensionScores` — 6 dims: prosperity(20), finance(20), services(20), environment_health(15), equity(10), resilience(15). Each 0..100 linear [bad,good] clamp. Hard floors reported separately. **v0.1 experimental, thresholds in `SCORE_CONFIG`; do not claim calibration.**
- `RawMetrics` per tick: population, treasury, debt, gdp, happiness, health, unemployment, commuteTime, service coverage rates, pollution, netMigration, illegalActionRate, buildSpend, maintenanceSpend.
- `bootstrapCI(values:number[], n:number): {mean:number; lo:number; hi:number}` — seed-paired bootstrap 95% CI.
- `runSmokeSuite(): Promise<SuiteReport>` — 3 baselines × 3 scenarios × 5 seeds = 45 episodes, real measured results, JSON + CSV + Markdown into `results/`.
- Replay: `recordReplay(...) : ReplayRecord` (list of {tick,command,stateHashBefore,stateHashAfter}), `replayFromActions(replay, scenarioId): WorldState` — reproduces final hash deterministically for recorded actions only.

## Sim CLI contract (packages/sim/src/cli.ts)

`node dist/cli.js <command> [options]` (built via tsup or plain tsc). Commands:
- `new --seed 101 --scenario starter_town --out save.json` — create initial save
- `run --save save.json --months 120 --out save.json --jsonl trace.jsonl --csv metrics.csv` — headless deterministic run with rule council by default (or `--agent noop|finance_greedy|rule_council`)
- `show --save save.json` — print observation
- `hash --save save.json` — state hash
- `replay --replay replay.json --out save.json` — verify determinism
- `bench --suite smoke --out results/` — run smoke suite
- `selfcheck` — roundtrip save/load, illegal action rejection, no-network fallback, multiple maps, bankruptcy
- `serve --port 4173` — static server + LLM proxy + API for web app

## Render contract (packages/render/src/index.ts)

- `class CityRenderer { constructor(canvas:HTMLCanvasElement, opts?:{width,height}); update(state:WorldState, view?:ViewState): void; dispose():void; }`
- `ViewState = { mode:'standard'|'finance'|'traffic'|'pollution'|'services'|'landvalue'; zoom:number; rotation:number; panX:number; panY:number; timeOfDay:number; showLabels:boolean }`
- Pure three.js, reads WorldState, builds terrain mesh from tile heights/water, road ribbons, buildings by landUse + density, trees, river plane, buildings lit by day/night, instanced meshes for perf. **Original procedural geometry only** — no external models/textures needed. Returns a `getStats()` with draw calls + triangle count for perf reporting.
- `renderToDataURL(state, view): string` optional helper for screenshot tests.

## Server contract (packages/server/src/index.ts)

- `createServer(opts): { app, start(port), stop() }` — Node http (no express): serves `apps/web/dist`, `/api/state` (GET current save), `/api/step` (POST actions → new state), `/api/llm` (POST chat-completions proxy using env key, cost/rate caps, redaction), `/api/health`.
- `.env.example` with MC_LLM_* placeholders. Never commit real keys.

## Frontend architecture (render + web owner)
- **core is pure TS with zero Node/DOM APIs, so the ENTIRE simulation runs in the browser.** The web app imports `@metropolis/core` and `@metropolis/council` directly and runs the fixed-tick loop client-side. This is why the game is fully playable offline with no server.
- The server is OPTIONAL and used only for (a) static file serving and (b) the `/api/llm` proxy that holds API keys. `LLMAdapter` in `@metropolis/council` must default its endpoint to the RELATIVE URL `/api/llm` so it works from the browser without exposing keys; an absolute override is allowed for headless CLI use.
- `packages/render` exports `CityRenderer` (three.js). `apps/web` owns `main.ts`, `hud.ts` (DOM HUD: dashboards, council log, overlays, tutorial, controls, approve/reject), the Vite config, and `index.html`. No separate `packages/ui` package.
- All 3D assets are ORIGINAL procedural geometry generated at runtime. No external models/textures/sounds. Document tool + license in THIRD_PARTY.md.

## Determinism rules (ALL workstreams)
- No `Math.random()`, no `Date.now()` in core/council/bench decision paths (only for measuring latency/cost, which is recorded separately). Use `RNG` from state.
- No floating point accumulated in hash input: canonical JSON with numbers rounded to 6 decimals before hashing.
- Same seed + same command sequence ⇒ identical `stateHash`. This is the核心 acceptance test.

## License / attribution
- Autonomous implementation, **Apache-2.0** for our code. Egregoria (GPL-3.0, commit ae65c857) was **inspected only, NOT incorporated**. Record in THIRD_PARTY.md.
- three.js MIT, vite MIT, zod MIT, typescript Apache-2.0 — record versions in THIRD_PARTY.md.
- All art is procedural/organic geometry generated at runtime by our own code; no external assets.
