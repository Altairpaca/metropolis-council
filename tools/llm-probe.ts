#!/usr/bin/env node
/**
 * One-shot probe: call a real OpenAI-compatible endpoint with the PROJECT'S OWN
 * prompt and schema, and report what came back. Used to verify the local model
 * integration before running a full benchmark episode.
 *
 * Usage: npx tsx tools/llm-probe.ts [baseUrl] [model]
 */
import { createInitialState, getScenario, getObservation } from '@metropolis/core';
import { LLMAdapter, DEFAULT_LLM_CONFIG, promptTemplate } from '@metropolis/council';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:11434/v1';
const model = process.argv[3] ?? 'qwen3:8b-nothinking';

const sc = getScenario('starter_town');
const state = createInitialState(101, sc.difficulty, { scenario: { ...sc, seed: 101 } });
const obs = getObservation(state);

const cfg = {
  ...DEFAULT_LLM_CONFIG,
  baseUrl,
  model,
  apiKey: 'local',
  timeoutMs: 120000,
  maxTokens: 900,
  temperature: 0.2,
};

const { system, user } = promptTemplate(obs, 'planning', []);
console.log('prompt chars: system=' + system.length + ' user=' + user.length);

const adapter = new LLMAdapter(cfg);
const t0 = Date.now();
const { proposal, meta } = await adapter.propose({
  observation: obs, role: 'planning', history: [], budgetRemaining: 4000, callsRemaining: 10,
});
console.log('elapsed ms:', Date.now() - t0);
console.log('meta:', JSON.stringify({ ok: meta.ok, retries: meta.retries, inTok: meta.promptTokens, outTok: meta.completionTokens, error: meta.error }));
console.log('used fallback:', proposal ? proposal.proposal_id.includes('fallback') : 'no proposal');
if (proposal) {
  console.log('proposal_id:', proposal.proposal_id);
  console.log('role:', proposal.role, 'cost:', proposal.expected_cost.toFixed(0), 'uncertainty:', proposal.uncertainty);
  console.log('actions:', JSON.stringify(proposal.actions));
  console.log('rationale:', proposal.rationale.slice(0, 400));
}
