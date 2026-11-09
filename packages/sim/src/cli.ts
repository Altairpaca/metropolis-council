#!/usr/bin/env node
/**
 * Metropolis Council - headless CLI.
 *
 * Every command is deterministic and works offline. This is the reproducible
 * entry point used by the acceptance tests and the benchmark suite.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
  createInitialState, stepWorld, stateHash, getObservation,
  serializeState, deserializeState, validateCommand, SCENARIOS, getScenario,
} from '@metropolis/core';
import type { Command, WorldState, AgentContext, RunConfig, GovernanceAgent, AgentMeta } from '@metropolis/core';
import { runRuleCouncil, makeMockLLM } from '@metropolis/council';
import {
  makeBaseline, runEpisode, runSmokeSuite, formatSuiteMarkdown, formatSuiteCSV,
  verifyReplay, DEFAULT_RUN_CONFIG,
} from '@metropolis/bench';

const VERSION = '0.1.0';
const SCHEMA = 1;
const NL = String.fromCharCode(10);

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(3);
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith('--')) {
      const k = a[i]!.slice(2);
      const v = a[i + 1] && !a[i + 1]!.startsWith('--') ? a[++i]! : 'true';
      out[k] = v;
    }
  }
  return out;
}
function ensureDir(p: string) { const d = dirname(resolve(p)); if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function write(p: string, s: string) { ensureDir(p); writeFileSync(p, s); }
function read(p: string): string { return readFileSync(resolve(p), 'utf8'); }

function makeState(seed: number, scenarioId: string, difficulty?: string): WorldState {
  const sc = getScenario(scenarioId);
  const d = (difficulty ?? sc.difficulty) as WorldState['difficulty'];
  return createInitialState(seed, d, { scenario: { ...sc, seed, difficulty: d } });
}

/** Offline mock agent wrapping the protocol test doubles. Never a real model. */
function mockAgent(behavior: string): GovernanceAgent {
  const m = makeMockLLM(behavior as Parameters<typeof makeMockLLM>[0]);
  return {
    id: 'mock_' + behavior,
    async decide(obs, ctx) {
      const p = await m.decide({ observation: obs, role: 'planning', history: [], budgetRemaining: 10000, callsRemaining: ctx.callsLeft } as AgentContext);
      const command: Command = p
        ? { id: 'mock_' + ctx.tick, tick: ctx.tick, actor: 'llm', role: p.role, actions: p.actions, rationale: p.rationale, uncertainty: p.uncertainty }
        : { id: 'mocknoop_' + ctx.tick, tick: ctx.tick, actor: 'baseline', actions: [{ type: 'noop' }] };
      const meta: AgentMeta = { callCount: 1, tokensIn: 0, tokensOut: 0, costUSD: 0, latencyMs: 0, errors: [], fallbackUsed: behavior !== 'valid' };
      return { command, meta };
    },
  };
}

function agentFor(id: string): GovernanceAgent {
  if (id === 'noop' || id === 'finance_greedy' || id === 'rule_council') return makeBaseline(id);
  if (id.startsWith('mock_')) return mockAgent(id.slice(5));
  throw new Error('unknown agent id: ' + id + ' (use noop | finance_greedy | rule_council | mock_<behavior>)');
}

function cmdNew(a: Record<string, string>) {
  const seed = Number(a.seed ?? 101);
  const scenarioId = a.scenario ?? 'starter_town';
  const s = makeState(seed, scenarioId, a.difficulty);
  const out = a.out ?? 'save.json';
  write(out, serializeState(s));
  console.log('NEW SAVE', out, 'seed', seed, 'scenario', scenarioId, 'pop', s.population.total, 'hash', stateHash(s));
}

function cmdShow(a: Record<string, string>) {
  const s = deserializeState(read(a.save ?? 'save.json'));
  const o = getObservation(s);
  console.log('=== METROPOLIS COUNCIL STATE ===');
  console.log('schema', s.schemaVersion, 'cli', VERSION, 'seed', s.seed, 'scenario', s.scenario.id, 'difficulty', s.difficulty);
  console.log('tick', s.tick, '(year ' + o.year + ' month ' + o.month + ')', 'status', s.status);
  console.log('population', s.population.total, 'happiness', s.population.happiness.toFixed(3), 'health', s.population.health.toFixed(3));
  console.log('treasury', s.treasury.toFixed(1), 'debt', s.debt.toFixed(1), 'creditLimit', s.creditLimit);
  console.log('services', JSON.stringify(o.services));
  console.log('congestion', s.roads.congestion.toFixed(3), 'commute', s.population.commuteTime.toFixed(1), 'pollution', s.infra.pollution.toFixed(3));
  console.log('milestones', s.milestones.join(',') || '(none)');
  console.log('warnings', o.warnings.join('; ') || '(none)');
  console.log('hash', stateHash(s));
  if (a.json === 'true') console.log(JSON.stringify(o, null, 2));
}

function cmdHash(a: Record<string, string>) {
  console.log(stateHash(deserializeState(read(a.save ?? 'save.json'))));
}

async function cmdRun(a: Record<string, string>) {
  const savePath = a.save ?? 'save.json';
  let s = deserializeState(read(savePath));
  const months = Number(a.months ?? 120);
  const agent = agentFor(a.agent ?? 'rule_council');
  const period = Number(a.period ?? 3);
  const maxCalls = Number(a.maxcalls ?? 40);
  const jsonl: string[] = [];
  const csv: string[] = ['tick,year,month,population,treasury,debt,gdp,happiness,health,waterReliability,powerReliability,unemployment,commuteTime,pollution,serviceCoverage,netMigration,status'];
  let decisions = 0;
  const started = Date.now();
  for (let i = 0; i < months && s.status === 'running'; i++) {
    const cmds: Command[] = [];
    if (s.tick % period === 0 && decisions < maxCalls) {
      const r = await agent.decide(getObservation(s), { tick: s.tick, track: (a.track ?? 'council') as 'mayor' | 'council', callsLeft: maxCalls - decisions });
      const v = validateCommand(s, r.command);
      jsonl.push(JSON.stringify({ tick: s.tick, command: r.command, ok: v.ok, rejected: v.rejected, hashBefore: stateHash(s) }));
      cmds.push(r.command);
      decisions++;
    }
    s = stepWorld(s, cmds);
    const st = s.services;
    const cov = (st.waterReliability + st.powerReliability + st.healthCoverage + st.educationCoverage + st.fireCoverage + st.transitCoverage) / 6;
    csv.push([s.tick - 1, Math.floor((s.tick - 1) / 12) + 1, ((s.tick - 1) % 12) + 1, s.population.total,
      s.treasury.toFixed(2), s.debt.toFixed(2), s.economy.gdp.toFixed(2), s.population.happiness.toFixed(4),
      s.population.health.toFixed(4), st.waterReliability.toFixed(4), st.powerReliability.toFixed(4),
      s.population.unemployment.toFixed(4), s.population.commuteTime.toFixed(2), s.infra.pollution.toFixed(4),
      cov.toFixed(4), s.population.netMigration, s.status].join(','));
  }
  const elapsed = Date.now() - started;
  write(a.out ?? savePath, serializeState(s));
  if (a.jsonl) write(a.jsonl, jsonl.join(NL) + NL);
  if (a.csv) write(a.csv, csv.join(NL) + NL);
  console.log('RUN DONE months', s.tick, 'status', s.status, 'pop', s.population.total,
    'treasury', s.treasury.toFixed(0), 'decisions', decisions, 'elapsedMs', elapsed, 'hash', stateHash(s));
  if (elapsed > 0) console.log('ticks/s', Math.round(s.tick / (elapsed / 1000)));
}

async function cmdBench(a: Record<string, string>) {
  const outDir = a.out ?? 'results/';
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const report = await runSmokeSuite();
  write(outDir + 'smoke.json', JSON.stringify(report, null, 2));
  write(outDir + 'smoke.md', formatSuiteMarkdown(report));
  write(outDir + 'smoke.csv', formatSuiteCSV(report));
  console.log('SMOKE SUITE episodes', report.episodes.length, 'wallClockMs', report.elapsedMs);
  for (const [k, v] of Object.entries(report.summary)) {
    const mean = v.mean as Record<string, number>;
    console.log(' ', k, 'failures=' + v.failures,
      'pop=' + (mean.finalPopulation ?? 0).toFixed(0),
      'treasury=' + (mean.finalTreasury ?? 0).toFixed(0),
      'composite=' + (mean.composite ?? 0).toFixed(1));
  }
}

function cmdReplay(a: Record<string, string>) {
  const replay = JSON.parse(read(a.replay ?? 'replay.json'));
  const res = verifyReplay(replay);
  console.log('REPLAY', res.ok ? 'PASS' : 'FAIL', 'expected', res.expectedHash, 'actual', res.actualHash,
    'entries', res.entries, res.mismatchTick !== undefined ? 'mismatchAt=' + res.mismatchTick : '');
  if (!res.ok) process.exitCode = 1;
}

async function cmdSelfCheck() {
  const results: { name: string; ok: boolean; detail: string }[] = [];
  const t = (name: string, fn: () => boolean | string) => {
    try {
      const r = fn();
      results.push({ name, ok: r === true || (typeof r === 'string' && r.startsWith('ok')), detail: String(r) });
    } catch (e) {
      results.push({ name, ok: false, detail: 'THREW: ' + (e as Error).message });
    }
  };

  t('fixed-seed determinism', () => {
    let a = makeState(101, 'starter_town'), b = makeState(101, 'starter_town');
    for (let i = 0; i < 30; i++) {
      const c: Command[] = [{ id: 'c' + i, tick: i, actor: 'rule', actions: [{ type: 'noop' }] }];
      a = stepWorld(a, c); b = stepWorld(b, c);
    }
    return stateHash(a) === stateHash(b) ? 'ok hash=' + stateHash(a) : 'FAIL mismatch';
  });
  t('save/load roundtrip', () => {
    let s = makeState(103, 'two_banks');
    for (let i = 0; i < 12; i++) s = stepWorld(s, [{ id: 'c' + i, tick: i, actor: 'rule', actions: [{ type: 'noop' }] }]);
    const h = stateHash(s);
    return stateHash(deserializeState(serializeState(s))) === h ? 'ok hash=' + h : 'FAIL';
  });
  t('corrupt save rejected (checksum)', () => {
    try {
      const j = JSON.parse(serializeState(makeState(1, 'starter_town')));
      j.state.treasury = 999999;
      deserializeState(JSON.stringify(j));
      return 'FAIL accepted corrupt save';
    } catch { return 'ok rejected'; }
  });
  t('illegal action rejected (construction budget)', () => {
    const s = makeState(101, 'starter_town');
    const r = validateCommand(s, { id: 'x', tick: 0, actor: 'llm', actions: [
      { type: 'build', category: 'power_plant' }, { type: 'build', category: 'power_plant' },
      { type: 'build', category: 'power_plant' }, { type: 'build', category: 'power_plant' }] });
    return r.rejected.length > 0 && !r.ok ? 'ok rejected=' + r.rejected.length : 'FAIL';
  });
  t('illegal action rejected (unknown region)', () => {
    const s = makeState(101, 'starter_town');
    const r = validateCommand(s, { id: 'x', tick: 0, actor: 'llm', actions: [{ type: 'set_zone', region: 'atlantis', target: 'res', priority: 0.5, maxBudget: 100 }] });
    return r.rejected.length === 1 ? 'ok' : 'FAIL';
  });
  t('illegal action rejected (out-of-range policy)', () => {
    const s = makeState(101, 'starter_town');
    const r = validateCommand(s, { id: 'x', tick: 0, actor: 'llm', actions: [{ type: 'set_policy', patch: { taxRate: 9 } }] });
    return r.rejected.length === 1 ? 'ok' : 'FAIL';
  });
  t('illegal action rejected (non-whitelisted build)', () => {
    const s = makeState(101, 'starter_town');
    const r = validateCommand(s, { id: 'x', tick: 0, actor: 'llm', actions: [{ type: 'build', category: 'orbital_laser' as unknown as 'park' }] });
    return r.rejected.length === 1 ? 'ok' : 'FAIL';
  });
  t('rule council produces real actions', () => {
    const s = makeState(101, 'starter_town');
    const c = runRuleCouncil(getObservation(s), 0, 5000);
    return c.actions.length > 0 ? 'ok actions=' + c.actions.length + ' (' + c.actions.map(x => x.type).join(',') + ')' : 'FAIL';
  });
  t('multiple distinct maps', () => {
    const hs = [101, 102, 103, 104, 105].map(sd => stateHash(makeState(sd, 'starter_town')));
    return new Set(hs).size === 5 ? 'ok distinct=' + hs.length : 'FAIL';
  });
  t('bankruptcy reachable', () => {
    let s = makeState(104, 'declining_finance');
    for (let i = 0; i < 120 && s.status === 'running'; i++) s = stepWorld(s, [{ id: 'c' + i, tick: i, actor: 'baseline', actions: [{ type: 'noop' }] }]);
    return s.status === 'bankrupt' ? 'ok at tick ' + s.tick : 'FAIL status=' + s.status;
  });
  t('scenario catalogue >= 6', () => Object.keys(SCENARIOS).length >= 6 ? 'ok ' + Object.keys(SCENARIOS).length : 'FAIL');

  for (const behavior of ['valid', 'malformed', 'overspend', 'illegal', 'timeout', 'rate429'] as const) {
    const m = makeMockLLM(behavior);
    const s = makeState(101, 'starter_town');
    try {
      const p = await m.decide({ observation: getObservation(s), role: 'planning', history: [], budgetRemaining: 5000, callsRemaining: 10 });
      results.push({ name: 'mock_llm_' + behavior, ok: true, detail: 'proposal=' + (p ? p.proposal_id : 'null') });
    } catch (e) {
      results.push({ name: 'mock_llm_' + behavior, ok: false, detail: 'THREW ' + (e as Error).message });
    }
  }

  try {
    const cfg: RunConfig = { ...DEFAULT_RUN_CONFIG, scenarioId: 'starter_town', seed: 101, agentId: 'rule_council' };
    const ep = await runEpisode(cfg, makeBaseline('rule_council'));
    const v = verifyReplay(ep.replay);
    results.push({ name: 'replay reproduces final hash', ok: v.ok, detail: 'entries=' + v.entries + ' hash=' + v.actualHash + (v.ok ? '' : ' expected ' + v.expectedHash) });
  } catch (e) {
    results.push({ name: 'replay reproduces final hash', ok: false, detail: 'THREW ' + (e as Error).message });
  }

  const pass = results.filter(r => r.ok).length;
  console.log('=== SELFCHECK ' + pass + '/' + results.length + ' ===');
  for (const r of results) console.log((r.ok ? ' PASS ' : ' FAIL ') + r.name + ' :: ' + r.detail);
  if (pass !== results.length) process.exitCode = 1;
}

function cmdHelp() {
  console.log('Metropolis Council CLI v' + VERSION + ' (schema ' + SCHEMA + ')');
  console.log('');
  console.log('Usage: pnpm cli <command> [options]');
  console.log('');
  console.log('  new       --seed 101 --scenario starter_town --out save.json [--difficulty easy|normal|hard]');
  console.log('  show      --save save.json [--json true]');
  console.log('  hash      --save save.json');
  console.log('  run       --save save.json --months 120 [--agent rule_council|noop|finance_greedy|mock_valid]');
  console.log('            [--jsonl trace.jsonl] [--csv metrics.csv] [--period 3] [--track mayor|council] [--maxcalls 40]');
  console.log('  bench     --out results/            (smoke suite: 3 baselines x 3 scenarios x 5 seeds)');
  console.log('  replay    --replay replay.json');
  console.log('  selfcheck');
  console.log('  serve     --port 4173               (static web build + optional LLM proxy)');
  console.log('');
}

async function main() {
  const cmd = process.argv[2] ?? 'help';
  const a = args();
  switch (cmd) {
    case 'new': cmdNew(a); break;
    case 'show': cmdShow(a); break;
    case 'hash': cmdHash(a); break;
    case 'run': await cmdRun(a); break;
    case 'bench': await cmdBench(a); break;
    case 'replay': cmdReplay(a); break;
    case 'selfcheck': await cmdSelfCheck(); break;
    case 'serve': {
      const { startServer } = await import('@metropolis/server');
      await startServer(Number(a.port ?? 4173));
      break;
    }
    default: cmdHelp(); break;
  }
}
main().catch(e => { console.error('CLI ERROR', e); process.exitCode = 1; });
