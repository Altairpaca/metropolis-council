#!/usr/bin/env node
/**
 * Real LLM episode runner.
 *
 * Plays the council track with a REAL OpenAI-compatible model, then runs the
 * deterministic baselines on the identical scenario and seed so the comparison
 * is honest. Writes results/llm-episode.json.
 *
 * Usage:
 *   npx tsx tools/llm-episode.ts [baseUrl] [model] [scenario] [seed] [months] [period]
 */
import { writeFileSync } from 'node:fs';
import type { GovernanceAgent, Observation, Command, AgentMeta, RunConfig } from '@metropolis/core';
import { LLMAdapter, DEFAULT_LLM_CONFIG } from '@metropolis/council';
import { runEpisode, makeBaseline } from '@metropolis/bench';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:11434/v1';
const model = process.argv[3] ?? 'qwen3:8b-nothinking';
const scenarioId = process.argv[4] ?? 'starter_town';
const seed = Number(process.argv[5] ?? 101);
const months = Number(process.argv[6] ?? 36);
const period = Number(process.argv[7] ?? 6);

const cfg = {
  ...DEFAULT_LLM_CONFIG,
  baseUrl, model, apiKey: 'local',
  timeoutMs: 180000, maxTokens: 900, temperature: 0.2,
  maxCallsPerMinute: 60, maxCostUSD: 100,
  pricePer1kIn: 0, pricePer1kOut: 0,
};

const adapter = new LLMAdapter(cfg);
const meta: AgentMeta = {
  callCount: 0, tokensIn: 0, tokensOut: 0, costUSD: 0,
  latencyMs: 0, errors: [], fallbackUsed: false,
};

const llmAgent: GovernanceAgent = {
  id: 'llm_' + model,
  async decide(obs: Observation, ctx) {
    const t0 = Date.now();
    const { proposal, meta: m } = await adapter.propose({
      observation: obs, role: 'planning', history: [],
      budgetRemaining: obs.treasury + Math.max(0, obs.creditLimit - obs.debt),
      callsRemaining: ctx.callsLeft,
    });
    meta.callCount += 1;
    meta.tokensIn += m.promptTokens;
    meta.tokensOut += m.completionTokens;
    meta.costUSD += m.costUSD;
    meta.latencyMs += Date.now() - t0;
    if (m.error) meta.errors.push(m.error);
    if (proposal && proposal.proposal_id.includes('fallback')) meta.fallbackUsed = true;
    const command: Command = proposal
      ? { id: 'llm_' + ctx.tick, tick: ctx.tick, actor: 'llm', role: proposal.role, actions: proposal.actions, rationale: proposal.rationale, uncertainty: proposal.uncertainty }
      : { id: 'llm_noop_' + ctx.tick, tick: ctx.tick, actor: 'llm', actions: [{ type: 'noop' }], rationale: 'no proposal' };
    console.log('  decision t' + ctx.tick + ' ' + (m.ok ? 'model' : 'FALLBACK ' + m.error)
      + ' actions=' + command.actions.length + ' ' + (Date.now() - t0) + 'ms');
    return { command, meta: { ...meta } };
  },
};

const base: RunConfig = {
  scenarioId, seed, track: 'council', agentId: 'x',
  maxDecisionCalls: Math.ceil(months / period) + 1,
  maxTokens: 20000,
  months, decisionPeriod: period,
};

console.log('scenario=' + scenarioId + ' seed=' + seed + ' months=' + months + ' period=' + period);
console.log('model=' + model + ' endpoint=' + baseUrl);
console.log('--- rule council ---');
const rule = await runEpisode({ ...base, agentId: 'rule_council' }, makeBaseline('rule_council'));
console.log('--- noop ---');
const noop = await runEpisode({ ...base, agentId: 'noop' }, makeBaseline('noop'));
console.log('--- real LLM ---');
const llm = await runEpisode({ ...base, agentId: llmAgent.id }, llmAgent);

function row(name: string, e: typeof rule) {
  return {
    agent: name,
    finalPopulation: e.metrics.finalPopulation,
    finalTreasury: Math.round(e.metrics.finalTreasury),
    finalDebt: Math.round(e.metrics.finalDebt),
    survivalTicks: e.metrics.survivalTicks,
    illegalActionRate: Number(e.metrics.illegalActionRate.toFixed(3)),
    composite: e.scores ? e.scores.composite : null,
    prosperity: e.scores ? e.scores.prosperity : null,
    finance: e.scores ? e.scores.finance : null,
    services: e.scores ? e.scores.services : null,
    status: e.failure ? e.failure.kind : 'running',
    elapsedMs: e.elapsedMs,
  };
}

const report = {
  generatedAt: new Date(0).toISOString(),
  note: 'Real local model run; baselines on the identical scenario and seed. Single episode, not a ranking.',
  endpoint: baseUrl, model, scenarioId, seed, months, decisionPeriod: period,
  llmMeta: meta,
  results: [row('rule_council', rule), row('noop', noop), row(llmAgent.id, llm)],
};
writeFileSync('results/llm-episode.json', JSON.stringify(report, null, 2));

console.log('');
console.log('=== RESULTS (' + scenarioId + ' seed ' + seed + ', ' + months + ' months) ===');
for (const r of report.results) {
  console.log(r.agent.padEnd(28) + ' pop=' + String(r.finalPopulation).padStart(5)
    + ' treasury=' + String(r.finalTreasury).padStart(7)
    + ' composite=' + (r.composite === null ? 'n/a' : r.composite.toFixed(1))
    + ' status=' + r.status);
}
console.log('');
console.log('llm calls=' + meta.callCount + ' tokens=' + meta.tokensIn + '+' + meta.tokensOut
  + ' latency=' + Math.round(meta.latencyMs / 1000) + 's fallbackUsed=' + meta.fallbackUsed);
console.log('written results/llm-episode.json');
