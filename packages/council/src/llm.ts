/**
 * OpenAI-compatible LLM adapter.
 *
 * Safety and robustness contract:
 *  - The API key lives ONLY in the server proxy. The default baseUrl is the
 *    relative '/api/llm', so a browser build never embeds a secret.
 *  - Every failure mode (network, timeout, 429, malformed JSON, schema error,
 *    illegal action, budget breach) degrades to a DETERMINISTIC rule proposal.
 *    The adapter never throws, so the game stays playable with no network.
 *  - Local rate limiting and a USD cost cap are enforced before each call.
 *  - Date.now() is used for latency measurement only, never for decisions.
 */
import type { AgentContext, CallMeta, LLMConfig, Proposal } from '@metropolis/core';
import { promptTemplate } from './prompt.js';
import { ProposalSchema, extractJson, toProposal, BUILD_CATEGORY_SET } from './schema.js';
import { ruleProposalFor } from './agents.js';

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  baseUrl: '/api/llm',
  model: 'deepseek-chat',
  timeoutMs: 20000,
  maxTokens: 900,
  maxCallsPerMinute: 20,
  maxCostUSD: 2.0,
  pricePer1kIn: 0.00027,
  pricePer1kOut: 0.0011,
  temperature: 0.2,
};

export interface LLMResult {
  proposal: Proposal | null;
  meta: CallMeta;
}

function emptyMeta(): CallMeta {
  return { ok: false, latencyMs: 0, promptTokens: 0, completionTokens: 0, costUSD: 0, retries: 0 };
}

function redact(s: string, key?: string): string {
  if (!key || key.length < 6) return s;
  return s.split(key).join('[REDACTED]');
}

/** Reject actions that the core validator would reject anyway, before spending a turn. */
function actionAllowed(a: { type: string; category?: string }): boolean {
  if (a.type === 'build') return typeof a.category === 'string' && BUILD_CATEGORY_SET.has(a.category);
  return true;
}

export class LLMAdapter {
  private callsThisWindow = 0;
  private windowStart = 0;
  private spentUSD = 0;
  private readonly cfg: LLMConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: Partial<LLMConfig> = {}, fetchImpl?: typeof fetch) {
    this.cfg = { ...DEFAULT_LLM_CONFIG, ...cfg };
    this.fetchImpl = fetchImpl ?? ((globalThis as unknown as { fetch: typeof fetch }).fetch);
  }

  get config(): LLMConfig { return { ...this.cfg }; }
  get costSoFarUSD(): number { return this.spentUSD; }

  /** Tokenise approximately: 1 token ~= 4 chars. Good enough for a local cap. */
  private estimateTokens(s: string): number { return Math.ceil(s.length / 4); }

  private budgetAvailable(): { ok: boolean; why: string } {
    const now = Date.now();
    if (now - this.windowStart > 60_000) { this.windowStart = now; this.callsThisWindow = 0; }
    if (this.callsThisWindow >= this.cfg.maxCallsPerMinute) return { ok: false, why: 'local rate limit reached' };
    if (this.spentUSD >= this.cfg.maxCostUSD) return { ok: false, why: 'cost cap reached (' + this.spentUSD.toFixed(4) + ' USD)' };
    return { ok: true, why: '' };
  }

  async propose(ctx: AgentContext): Promise<LLMResult> {
    const meta = emptyMeta();
    const gate = this.budgetAvailable();
    if (!gate.ok) {
      meta.error = gate.why;
      return { proposal: this.fallback(ctx, gate.why), meta };
    }
    const role = ctx.role === 'mayor' ? 'planning' : ctx.role;
    const { system, user } = promptTemplate(ctx.observation, role, ctx.history);
    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: this.cfg.temperature,
      max_tokens: this.cfg.maxTokens,
      stream: false,
    };

    let lastError = '';
    for (let attempt = 0; attempt <= 2; attempt++) {
      const started = Date.now();
      this.callsThisWindow++;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
        const res = await this.fetchImpl(this.cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        meta.latencyMs += Date.now() - started;
        if (res.status === 429) { lastError = 'upstream 429'; meta.retries = attempt + 1; continue; }
        if (!res.ok) { lastError = 'upstream ' + res.status; meta.retries = attempt + 1; continue; }
        const json = await res.json() as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = json.choices?.[0]?.message?.content ?? '';
        const inTok = json.usage?.prompt_tokens ?? this.estimateTokens(system + user);
        const outTok = json.usage?.completion_tokens ?? this.estimateTokens(text);
        meta.promptTokens += inTok;
        meta.completionTokens += outTok;
        meta.costUSD += (inTok / 1000) * this.cfg.pricePer1kIn + (outTok / 1000) * this.cfg.pricePer1kOut;
        this.spentUSD += (inTok / 1000) * this.cfg.pricePer1kIn + (outTok / 1000) * this.cfg.pricePer1kOut;
        const raw = extractJson(text);
        if (!raw) { lastError = 'no JSON object in reply'; meta.retries = attempt + 1; continue; }
        const parsed = ProposalSchema.safeParse(raw);
        if (!parsed.success) { lastError = 'schema: ' + parsed.error.issues.map(i => i.path.join('.') + ' ' + i.message).slice(0, 3).join('; '); meta.retries = attempt + 1; continue; }
        if (!parsed.data.actions.every(actionAllowed)) { lastError = 'non-whitelisted action'; meta.retries = attempt + 1; continue; }
        const proposal = toProposal(parsed.data);
        // Force the tick and role to the requested ones (models routinely drift).
        proposal.tick = ctx.observation.tick;
        proposal.role = role as Proposal['role'];
        meta.ok = true;
        return { proposal, meta };
      } catch (e) {
        meta.latencyMs += Date.now() - started;
        lastError = redact((e as Error)?.message ?? String(e), this.cfg.apiKey);
        meta.retries = attempt + 1;
        // exponential-ish backoff, bounded
        await new Promise(r => setTimeout(r, Math.min(400, 50 * Math.pow(2, attempt))));
      }
    }
    meta.ok = false;
    meta.error = lastError || 'unknown failure';
    return { proposal: this.fallback(ctx, meta.error), meta };
  }

  private fallback(ctx: AgentContext, why: string): Proposal {
    const role = ctx.role === 'mayor' ? 'planning' : ctx.role;
    const p = ruleProposalFor(role, ctx.observation);
    return {
      ...p,
      proposal_id: p.proposal_id + '_fallback',
      rationale: '[deterministic fallback: ' + why + '] ' + p.rationale,
    };
  }
}

export interface RunLLMResult {
  command: { id: string; tick: number; actor: 'llm'; role: string; actions: Proposal['actions']; rationale: string; uncertainty: number };
  meta: CallMeta;
  proposal: Proposal | null;
}

/** Wrap the adapter into a command, always producing something executable. */
export async function runLLM(ctx: AgentContext, cfg: Partial<LLMConfig> = {}, adapter?: LLMAdapter): Promise<RunLLMResult> {
  const a = adapter ?? new LLMAdapter(cfg);
  const { proposal, meta } = await a.propose(ctx);
  const fallback = proposal ?? ruleProposalFor(ctx.role === 'mayor' ? 'planning' : ctx.role, ctx.observation);
  return {
    command: {
      id: 'llm_' + fallback.proposal_id + '_' + ctx.observation.tick,
      tick: ctx.observation.tick,
      actor: 'llm',
      role: fallback.role,
      actions: fallback.actions,
      rationale: fallback.rationale,
      uncertainty: fallback.uncertainty,
    },
    meta,
    proposal,
  };
}
