/**
 * Save/load with schema version, RNG state, full action history and checksum.
 * stateHash uses a canonical JSON (sorted keys, 6-dp rounded numbers) fed
 * through a pure BigInt FNV-1a 64-bit hash — deterministic across platforms.
 */
import type { WorldState } from './types.js';
import { SCHEMA_VERSION, VERSION } from './constants.js';
import { fnv1a64 } from './rng.js';

export interface SaveFile {
  format: 'metropolis-council-save'; schemaVersion: number; version: string;
  createdAt: string; checksum: string; state: WorldState;
}

function canonical(v: unknown): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : String(v);
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = canonical((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}
export function stateHash(state: WorldState): string {
  const c = canonical(state) as object;
  // omit volatile fields that don't belong to deterministic world state
  const { events, ledger, ...core } = c as WorldState & { events: unknown; ledger: unknown };
  void events; void ledger;
  return fnv1a64(JSON.stringify(canonical(core)));
}
export function serializeState(state: WorldState): string {
  const body = { format: 'metropolis-council-save', schemaVersion: SCHEMA_VERSION, version: VERSION,
    createdAt: new Date(0).toISOString(), checksum: '', state };
  body.checksum = stateHash(state);
  return JSON.stringify(body, null, 2);
}
export function deserializeState(json: string): WorldState {
  const parsed = JSON.parse(json) as SaveFile;
  if (parsed.format !== 'metropolis-council-save') throw new Error('unknown save format');
  if (parsed.schemaVersion !== SCHEMA_VERSION) throw new Error('schema version mismatch: ' + parsed.schemaVersion);
  const state = parsed.state;
  if (!state || typeof state !== 'object' || !state.map || !state.rng) throw new Error('malformed save');
  if (parsed.checksum && parsed.checksum !== stateHash(state)) throw new Error('save checksum mismatch (corrupt or modified)');
  return state;
}
