/**
 * Metropolis Council - browser entry point.
 *
 * The ENTIRE simulation runs client-side: @metropolis/core is pure TypeScript
 * with no DOM or Node dependencies. The server is optional and only used to
 * serve files and to proxy LLM calls so an API key never reaches the browser.
 */
import {
  createInitialState, stepWorld, applyCommand, getObservation, serializeState,
  deserializeState, stateHash, getScenario, SCENARIOS,
} from '@metropolis/core';
import type { WorldState, Command, Action } from '@metropolis/core';
import { runRuleCouncil } from '@metropolis/council';
import { CityRenderer, DEFAULT_VIEW } from '@metropolis/render';
import type { ViewState } from '@metropolis/render';
import { HUD } from './hud.js';

const MONTH_MS = 420;

function urlParams(): { seed: number; scenario: string } {
  const p = new URLSearchParams(location.search);
  return {
    seed: Number(p.get('seed') ?? 101) || 101,
    scenario: p.get('scenario') ?? 'starter_town',
  };
}

function boot() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const hudRoot = document.getElementById('hud') as HTMLElement;
  const bootEl = document.getElementById('boot') as HTMLElement;
  const bootMsg = document.getElementById('boot-msg') as HTMLElement;
  const { seed, scenario } = urlParams();

  const view: ViewState = { ...DEFAULT_VIEW };
  let state: WorldState;
  try {
    state = newGame(scenario, seed);
  } catch (e) {
    bootMsg.textContent = 'failed to generate map: ' + (e as Error).message;
    return;
  }

  const renderer = new CityRenderer(canvas, { width: window.innerWidth, height: window.innerHeight });
  let speed = 1;
  let councilOn = true;
  let approvalOn = false;
  let llmOn = false;
  let lastTickAt = performance.now();
  let accumulator = 0;
  let lastLogHash = '';
  const recentStates: WorldState[] = [];

  function newGame(scenarioId: string, s: number): WorldState {
    const sc = getScenario(scenarioId);
    return createInitialState(s, sc.difficulty, { scenario: { ...sc, seed: s } });
  }

  const hud = new HUD(hudRoot, {
    onAction: (action) => {
      const cmd: Command = {
        id: 'player_' + state.tick + '_' + Math.floor(performance.now()),
        tick: state.tick, actor: 'player', actions: [action as Action],
        rationale: 'player action',
      };
      const res = applyCommand(state, cmd);
      state = res.state;
      if (!res.result.ok && res.result.rejected.length) {
        hud.setLLMStatus('rejected: ' + res.result.rejected[0]!.reason.slice(0, 40));
      }
      refresh();
    },
    onViewChange: (patch) => { Object.assign(view, patch); refresh(); },
    onSpeed: (s) => { speed = s; },
    onSave: () => {
      try {
        localStorage.setItem('metropolis-save', serializeState(state));
        hud.setLLMStatus('saved');
      } catch (e) { hud.setLLMStatus('save failed: ' + (e as Error).message); }
    },
    onLoad: () => {
      const raw = localStorage.getItem('metropolis-save');
      if (!raw) { hud.setLLMStatus('no save found'); return; }
      try { state = deserializeState(raw); hud.setLLMStatus('loaded'); refresh(); }
      catch (e) { hud.setLLMStatus('load failed: ' + (e as Error).message); }
    },
    onNewGame: (scenarioId, s) => {
      state = newGame(scenarioId, s);
      recentStates.length = 0;
      hud.hideBanner();
      hud.setLLMStatus('new game ' + scenarioId + ' seed ' + s);
      refresh();
    },
    onToggleCouncil: (on) => { councilOn = on; },
    onToggleApproval: (on) => { approvalOn = on; },
    onToggleLLM: (on) => {
      llmOn = on;
      hud.setLLMStatus(on ? 'llm requested (fallback if unconfigured)' : 'deterministic');
    },
    onApprove: (id) => {
      const res = applyCommand(state, { id: 'appr_' + id, tick: state.tick, actor: 'player', actions: [{ type: 'approve_proposal', proposalId: id }] });
      state = res.state;
      refresh();
    },
    onReject: (id) => {
      const res = applyCommand(state, { id: 'rej_' + id, tick: state.tick, actor: 'player', actions: [{ type: 'reject_proposal', proposalId: id }] });
      state = res.state;
      refresh();
    },
    onExport: () => {
      const blob = new Blob([serializeState(state)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'metropolis-' + state.scenario.id + '-' + state.seed + '-m' + state.tick + '.json';
      a.click();
    },
  }, view);

  function refresh() {
    renderer.update(state, view);
    hud.update(state, view, renderer.getStats());
    (window as unknown as Record<string, unknown>).__MC_STATE__ = state;
    (window as unknown as Record<string, unknown>).__MC_STATS__ = renderer.getStats();
    (window as unknown as Record<string, unknown>).__MC_HASH__ = stateHash(state);
    if (state.status === 'bankrupt') hud.showBanner('BANKRUPT', 'the treasury collapsed in month ' + state.tick);
    else if (state.status === 'victory') hud.showBanner('METROPOLIS', 'population ' + state.population.total + ' - objective complete');
  }

  /** One simulation month. Council decides every third month. */
  function tick() {
    if (state.status !== 'running') return;
    const cmds: Command[] = [];
    if (councilOn && state.tick % 3 === 0) {
      const obs = getObservation(state);
      const budget = obs.treasury + Math.max(0, obs.creditLimit - obs.debt);
      const cmd = runRuleCouncil(obs, state.tick, budget);
      if (approvalOn) {
        const cost = cmd.actions.reduce((a: number, act: Action) => {
          if (act.type === 'build') return a + (obs.costFormula.build[act.category]?.cost ?? 0);
          return a;
        }, 0);
        if (cost > obs.policy.approvalThreshold) {
          state.pending.push({
            id: 'prop_' + state.tick, tick: state.tick, role: cmd.role ?? 'planning',
            actions: cmd.actions, expected_cost: cost,
            rationale: cmd.rationale ?? '', uncertainty: cmd.uncertainty ?? 0.2,
          });
          cmds.push({ id: 'noop_' + state.tick, tick: state.tick, actor: 'system', actions: [{ type: 'noop' }] });
        } else cmds.push(cmd);
      } else cmds.push(cmd);
    }
    recentStates.push(state);
    if (recentStates.length > 8) recentStates.shift();
    state = stepWorld(state, cmds);
    lastLogHash = stateHash(state);
    void lastLogHash;
    refresh();
  }

  // ---- camera interaction ----
  let dragging = false;
  let panning = false;
  let lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    panning = e.button === 2 || e.shiftKey;
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (panning) {
      view.panX -= dx * 0.06 * view.zoom;
      view.panY -= dy * 0.06 * view.zoom;
    } else {
      view.rotation -= dx * 0.006;
      view.timeOfDay = Math.max(0, Math.min(1, view.timeOfDay - dy * 0.0025));
    }
    refresh();
  });
  canvas.addEventListener('pointerup', (e) => { dragging = false; canvas.releasePointerCapture(e.pointerId); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.zoom = Math.max(0.35, Math.min(2.6, view.zoom * (1 + Math.sign(e.deltaY) * 0.08)));
    refresh();
  }, { passive: false });
  window.addEventListener('resize', () => {
    renderer.resize(window.innerWidth, window.innerHeight);
    refresh();
  });

  // ---- test hooks ----
  (window as unknown as Record<string, unknown>).__MC_STEP__ = (n = 1) => {
    for (let i = 0; i < n; i++) tick();
    return { tick: state.tick, population: state.population.total, treasury: state.treasury, status: state.status };
  };
  (window as unknown as Record<string, unknown>).__MC_SET_VIEW__ = (patch: Partial<ViewState>) => { Object.assign(view, patch); refresh(); };

  // ---- main loop ----
  function frame(now: number) {
    const dt = now - lastTickAt;
    lastTickAt = now;
    renderer.tickAnimation(dt / 1000);
    if (speed > 0) {
      accumulator += dt * speed;
      let guard = 0;
      while (accumulator >= MONTH_MS && guard++ < 8) {
        accumulator -= MONTH_MS;
        tick();
      }
    }
    renderer.update(state, view);
    requestAnimationFrame(frame);
  }

  // first paint, then reveal
  refresh();
  bootEl.classList.add('hidden');
  hud.showTutorial();
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
