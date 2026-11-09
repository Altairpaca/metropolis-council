/**
 * Zod schemas for the ONLY shapes an LLM is allowed to produce.
 * Validation happens before anything touches the command queue, and the core
 * validator runs again afterwards - defence in depth.
 */
import { z } from 'zod';
import type { Proposal, Role } from '@metropolis/core';

const FINITE = z.number().refine(n => Number.isFinite(n), 'must be finite');
const POSITIVE = z.number().refine(n => Number.isFinite(n) && n > 0, 'must be a finite positive number');

export const ActionSchema = z.union([
  z.object({
    type: z.literal('set_policy'),
    patch: z.object({
      taxRate: FINITE.optional(), serviceLevel: FINITE.optional(),
      constructionBudget: FINITE.optional(), maintenanceBudget: FINITE.optional(),
      envPriority: FINITE.optional(), equityPriority: FINITE.optional(),
      growthPriority: FINITE.optional(), borrowingAllowed: z.boolean().optional(),
      approvalThreshold: FINITE.optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('set_zone'),
    region: z.string().min(1).max(64),
    target: z.enum(['res', 'com', 'ind', 'park', 'civic', 'none']),
    priority: FINITE, maxBudget: FINITE,
  }).strict(),
  z.object({
    type: z.literal('build'),
    category: z.string().min(1).max(40),
    region: z.string().min(1).max(64).optional(),
    tile: z.number().int().nonnegative().optional(),
    level: z.number().int().min(1).max(5).optional(),
  }).strict(),
  z.object({ type: z.literal('borrow'), amount: POSITIVE }).strict(),
  z.object({ type: z.literal('repay'), amount: POSITIVE }).strict(),
  z.object({ type: z.literal('set_service_level'), level: FINITE }).strict(),
  z.object({ type: z.literal('approve_proposal'), proposalId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('reject_proposal'), proposalId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('noop') }).strict(),
]);

export const ProposalSchema = z.object({
  proposal_id: z.string().min(1).max(120),
  role: z.enum(['planning', 'finance', 'transport', 'welfare', 'industry_env']),
  tick: z.number().int().nonnegative(),
  observations: z.array(z.string().max(300)).max(8).default([]),
  actions: z.array(ActionSchema).min(1).max(8),
  expected_cost: FINITE,
  rationale: z.string().min(1).max(1200),
  uncertainty: FINITE,
  conflicts: z.array(z.string().max(300)).max(5).default([]),
}).strict();

export type ValidatedProposal = z.infer<typeof ProposalSchema>;

/** Cast a validated proposal into the core Proposal type. */
export function toProposal(p: ValidatedProposal): Proposal {
  return {
    proposal_id: p.proposal_id,
    role: p.role as Role,
    tick: p.tick,
    observations: p.observations,
    actions: p.actions as Proposal['actions'],
    expected_cost: p.expected_cost,
    rationale: p.rationale,
    uncertainty: Math.max(0, Math.min(1, p.uncertainty)),
    conflicts: p.conflicts,
  };
}

const FENCE = String.fromCharCode(96).repeat(3);

/** Extract the first balanced JSON object from a possibly-noisy model reply. */
export function extractJson(text: string): unknown | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  let s = text.trim();
  const f1 = s.indexOf(FENCE);
  if (f1 >= 0) {
    const f2 = s.indexOf(FENCE, f1 + FENCE.length);
    if (f2 > f1) {
      let inner = s.slice(f1 + FENCE.length, f2).trim();
      if (inner.toLowerCase().startsWith('json')) inner = inner.slice(4).trim();
      s = inner;
    }
  }
  try { return JSON.parse(s); } catch { /* fall through */ }
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === String.fromCharCode(92)) esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export const BUILD_CATEGORY_SET: ReadonlySet<string> = new Set([
  'power_plant', 'water_works', 'sewage_plant', 'garbage_facility',
  'clinic', 'school', 'fire_station', 'transit_hub', 'park',
  'road_segment', 'bridge', 'res_zone', 'com_zone', 'ind_zone', 'civic_zone',
]);
export const ZONE_TARGET_SET: ReadonlySet<string> = new Set(['res', 'com', 'ind', 'park', 'civic', 'none']);
