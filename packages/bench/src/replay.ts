/**
 * Replay verification.
 *
 * Determinism guarantee, stated honestly: replaying the RECORDED action
 * sequence against the same simulator version reproduces the same final state
 * hash. It does NOT claim that a remote model would produce the same actions
 * again - only that the recorded trajectory is verifiable.
 */
import { createInitialState, stepWorld, stateHash, getScenario } from '@metropolis/core';
import type { ReplayRecord, WorldState } from '@metropolis/core';
import { SIMULATOR_VERSION } from './runner.js';

export interface ReplayVerification {
  ok: boolean;
  expectedHash: string;
  actualHash: string;
  mismatchTick?: number;
  entries: number;
  versionMatch: boolean;
}

export function replayFromActions(replay: ReplayRecord): WorldState {
  const scenario = getScenario(replay.scenarioId);
  let state = createInitialState(replay.seed, replay.difficulty, { scenario: { ...scenario, seed: replay.seed } });
  const byTick = new Map<number, ReplayRecord['entries']>();
  for (const e of replay.entries) {
    if (!byTick.has(e.tick)) byTick.set(e.tick, []);
    byTick.get(e.tick)!.push(e);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  for (const tick of ticks) {
    const cmds = byTick.get(tick)!.map(e => e.command);
    // Fast-forward to the recorded tick if the action list skips months.
    while (state.tick < tick && state.status === 'running') state = stepWorld(state, []);
    state = stepWorld(state, cmds);
  }
  const lastTick = ticks.length ? ticks[ticks.length - 1]! : 0;
  while (state.tick <= lastTick && state.status === 'running') state = stepWorld(state, []);
  return state;
}

export function verifyReplay(replay: ReplayRecord): ReplayVerification {
  const actual = replayFromActions(replay);
  const actualHash = stateHash(actual);
  const ok = actualHash === replay.finalHash;
  let mismatchTick: number | undefined;
  if (!ok) {
    const scenario = getScenario(replay.scenarioId);
    let state = createInitialState(replay.seed, replay.difficulty, { scenario: { ...scenario, seed: replay.seed } });
    for (const e of replay.entries) {
      while (state.tick < e.tick && state.status === 'running') state = stepWorld(state, []);
      state = stepWorld(state, [e.command]);
      if (e.hashAfter && stateHash(state) !== e.hashAfter) { mismatchTick = e.tick; break; }
    }
  }
  return { ok, expectedHash: replay.finalHash, actualHash, mismatchTick, entries: replay.entries.length, versionMatch: replay.version === SIMULATOR_VERSION };
}
