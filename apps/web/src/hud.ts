/**
 * DOM HUD. Pure presentation over a WorldState - it never mutates the state,
 * it only calls back into main.ts through the callbacks it is given.
 */
import type { WorldState, Observation, PendingProposal } from '@metropolis/core';
import { getObservation } from '@metropolis/core';
import type { ViewState, OverlayMode, RenderStats } from '@metropolis/render';

export interface HudCallbacks {
  onAction: (action: unknown) => void;
  onViewChange: (patch: Partial<ViewState>) => void;
  onSpeed: (speed: number) => void;
  onSave: () => void;
  onLoad: () => void;
  onNewGame: (scenarioId: string, seed: number) => void;
  onToggleCouncil: (enabled: boolean) => void;
  onToggleApproval: (enabled: boolean) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onExport: () => void;
  onToggleLLM: (enabled: boolean) => void;
}

const MODES: { id: OverlayMode; label: string }[] = [
  { id: 'standard', label: 'City' },
  { id: 'finance', label: 'Finance' },
  { id: 'traffic', label: 'Traffic' },
  { id: 'pollution', label: 'Pollution' },
  { id: 'services', label: 'Services' },
  { id: 'landvalue', label: 'Land value' },
];

const SCENARIO_OPTIONS = [
  ['starter_town', 'Starter Town'],
  ['water_industry', 'Thirsty Industry'],
  ['two_banks', 'Two Banks'],
  ['declining_finance', 'Declining Finance'],
  ['unequal_growth', 'Unequal Growth'],
  ['compound_crisis', 'Compound Crisis'],
];

function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function pct(n: number): string { return Math.round(Math.max(0, Math.min(1, n)) * 100) + '%'; }
function esc(s: string): string {
  return String(s).replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

export class HUD {
  private root: HTMLElement;
  private cb: HudCallbacks;
  private speed = 1;
  private councilOn = true;
  private approvalOn = false;
  private llmOn = false;
  private mode: OverlayMode = 'standard';
  private view: ViewState;
  private tutorialStep = 0;
  private proposalSignature = '';

  constructor(root: HTMLElement, callbacks: HudCallbacks, view: ViewState) {
    this.root = root;
    this.cb = callbacks;
    this.view = view;
    this.build();
  }

  private build() {
    this.root.innerHTML = [
      "<div id='topbar' class='panel'>",
      "  <div class='brand'>METROPOLIS COUNCIL<small>governance sandbox</small></div>",
      "  <div class='stat'><span class='k'>Year</span><span class='v' id='s-year'>-</span></div>",
      "  <div class='stat'><span class='k'>Population</span><span class='v' id='s-pop'>-</span></div>",
      "  <div class='stat'><span class='k'>Treasury</span><span class='v' id='s-treas'>-</span></div>",
      "  <div class='stat'><span class='k'>Debt</span><span class='v' id='s-debt'>-</span></div>",
      "  <div class='stat'><span class='k'>Happiness</span><span class='v' id='s-happy'>-</span></div>",
      "  <div class='stat'><span class='k'>Net / mo</span><span class='v' id='s-net'>-</span></div>",
      "  <div class='spacer'></div>",
      "  <div class='speed-group' id='speed'>",
      "    <button class='btn' data-speed='0'>II</button>",
      "    <button class='btn active' data-speed='1'>1x</button>",
      "    <button class='btn' data-speed='2'>2x</button>",
      "    <button class='btn' data-speed='4'>4x</button>",
      "  </div>",
      "  <button class='btn' id='btn-council'>Council ON</button>",
      "  <button class='btn' id='btn-approve'>Approve mode</button>",
      "  <button class='btn' id='btn-llm'>LLM OFF</button>",
      "  <button class='btn' id='btn-save'>Save</button>",
      "  <button class='btn' id='btn-load'>Load</button>",
      "  <button class='btn' id='btn-new'>New game</button>",
      "</div>",
      "<div id='leftcol'>",
      "  <div class='panel' id='policy'>",
      "    <div class='panel-title'>Policy levers</div>",
      "    <div id='sliders'></div>",
      "    <div style='display:flex;gap:6px;padding:8px 12px 12px'>",
      "      <button class='btn' id='btn-borrow' style='flex:1'>Borrow 2,000</button>",
      "      <button class='btn' id='btn-repay' style='flex:1'>Repay 2,000</button>",
      "    </div>",
      "  </div>",
      "  <div class='panel'>",
      "    <div class='panel-title'>Overlay</div>",
      "    <div class='modes' id='modes'></div>",
      "  </div>",
      "  <div class='panel'>",
      "    <div class='panel-title'>Scenario</div>",
      "    <div style='padding:0 12px 12px;display:flex;flex-direction:column;gap:6px'>",
      "      <select id='scenario-sel' style='width:100%;padding:6px;border-radius:6px;background:#121a25;color:#dfe8f2;border:1px solid rgba(120,170,220,0.34);font-size:11px'></select>",
      "      <div style='display:flex;gap:6px'>",
      "        <input id='seed-in' type='number' value='101' style='flex:1;padding:6px;border-radius:6px;background:#121a25;color:#dfe8f2;border:1px solid rgba(120,170,220,0.34);font-size:11px' />",
      "        <button class='btn' id='btn-restart'>Restart</button>",
      "      </div>",
      "    </div>",
      "  </div>",
      "</div>",
      "<div id='rightcol'>",
      "  <div class='panel'>",
      "    <div class='panel-title'>Services</div>",
      "    <div id='gauges'></div>",
      "  </div>",
      "  <div class='panel'>",
      "    <div class='panel-title'>City vitals</div>",
      "    <div id='vitals'></div>",
      "  </div>",
      "  <div class='panel'>",
      "    <div class='panel-title'>Warnings</div>",
      "    <div id='warnings' style='padding:0 12px 12px;font-size:11px;line-height:1.6;color:#8ea1b5'>none</div>",
      "  </div>",
      "  <div class='panel'>",
      "    <div class='panel-title'>Performance</div>",
      "    <div id='perf' style='padding:0 12px 12px;font-size:10px;font-family:var(--mono);color:#8ea1b5;line-height:1.7'></div>",
      "  </div>",
      "</div>",
      "<div id='logpanel' class='panel'>",
      "  <div class='panel-title'>Council log <span class='tag' id='llm-status'>deterministic</span></div>",
      "  <div id='loglist'></div>",
      "</div>",
      "<div id='banner'><div class='bt'></div><div class='bs'></div></div>",
      "<div id='tutorial' class='hidden'><div class='tut-card'>",
      "  <h2></h2><div class='tut-body'></div>",
      "  <div class='tut-actions'><button class='btn' id='tut-skip'>Skip</button><button class='btn' id='tut-next'>Continue</button></div>",
      "</div></div>",
    ].join('');

    this.bind();
    this.renderModes();
    this.renderSliders();
    this.renderScenarioOptions();
  }

  private bind() {
    const q = (s: string) => this.root.querySelector(s) as HTMLElement | null;
    for (const b of Array.from(this.root.querySelectorAll('#speed .btn'))) {
      b.addEventListener('click', () => {
        this.speed = Number((b as HTMLElement).dataset.speed ?? 1);
        for (const x of Array.from(this.root.querySelectorAll('#speed .btn'))) x.classList.remove('active');
        b.classList.add('active');
        this.cb.onSpeed(this.speed);
      });
    }
    q('#btn-council')?.addEventListener('click', () => {
      this.councilOn = !this.councilOn;
      const b = q('#btn-council')!;
      b.textContent = this.councilOn ? 'Council ON' : 'Council OFF';
      b.classList.toggle('active', this.councilOn);
      this.cb.onToggleCouncil(this.councilOn);
    });
    q('#btn-approve')?.addEventListener('click', () => {
      this.approvalOn = !this.approvalOn;
      const b = q('#btn-approve')!;
      b.textContent = this.approvalOn ? 'Approve: ON' : 'Approve mode';
      b.classList.toggle('active', this.approvalOn);
      this.cb.onToggleApproval(this.approvalOn);
    });
    q('#btn-llm')?.addEventListener('click', () => {
      this.llmOn = !this.llmOn;
      const b = q('#btn-llm')!;
      b.textContent = this.llmOn ? 'LLM ON' : 'LLM OFF';
      b.classList.toggle('active', this.llmOn);
      this.cb.onToggleLLM(this.llmOn);
    });
    q('#btn-save')?.addEventListener('click', () => this.cb.onSave());
    q('#btn-load')?.addEventListener('click', () => this.cb.onLoad());
    q('#btn-new')?.addEventListener('click', () => this.cb.onNewGame(this.scenarioId(), this.seed()));
    q('#btn-restart')?.addEventListener('click', () => this.cb.onNewGame(this.scenarioId(), this.seed()));
    q('#btn-borrow')?.addEventListener('click', () => this.cb.onAction({ type: 'borrow', amount: 2000 }));
    q('#btn-repay')?.addEventListener('click', () => this.cb.onAction({ type: 'repay', amount: 2000 }));
    q('#tut-skip')?.addEventListener('click', () => this.hideTutorial());
    q('#tut-next')?.addEventListener('click', () => this.nextTutorial());
    q('#btn-council')?.classList.add('active');
    this.root.querySelector('#scenario-sel')?.addEventListener('change', () => this.cb.onNewGame(this.scenarioId(), this.seed()));
  }

  private scenarioId(): string {
    const sel = this.root.querySelector('#scenario-sel') as HTMLSelectElement | null;
    return sel?.value ?? 'starter_town';
  }
  private seed(): number {
    const inp = this.root.querySelector('#seed-in') as HTMLInputElement | null;
    return Number(inp?.value ?? 101);
  }

  private renderScenarioOptions() {
    const sel = this.root.querySelector('#scenario-sel') as HTMLSelectElement | null;
    if (!sel) return;
    sel.innerHTML = SCENARIO_OPTIONS.map(([id, label]) => "<option value='" + id + "'>" + label + '</option>').join('');
  }

  private renderModes() {
    const box = this.root.querySelector('#modes');
    if (!box) return;
    box.innerHTML = MODES.map(m => "<button class='btn" + (m.id === this.mode ? ' active' : '') + "' data-mode='" + m.id + "'>" + m.label + '</button>').join('');
    for (const b of Array.from(box.querySelectorAll('.btn'))) {
      b.addEventListener('click', () => {
        this.mode = ((b as HTMLElement).dataset.mode ?? 'standard') as OverlayMode;
        this.renderModes();
        this.cb.onViewChange({ mode: this.mode });
      });
    }
  }

  private renderSliders() {
    const box = this.root.querySelector('#sliders');
    if (!box) return;
    const defs: [string, string, number, number, number, number][] = [
      ['taxRate', 'Tax rate', 0, 0.25, 0.005, 0.09],
      ['serviceLevel', 'Service level', 0, 1.5, 0.05, 1.0],
      ['constructionBudget', 'Construction budget', 0, 6000, 100, 3500],
      ['maintenanceBudget', 'Maintenance budget', 0, 6000, 100, 1800],
    ];
    box.innerHTML = defs.map(([id, label, min, max, step, val]) => [
      "<div class='slider-row'>",
      "  <label>" + label + " <b id='lb-" + id + "'>" + val + '</b></label>',
      "  <input type='range' id='sl-" + id + "' min='" + min + "' max='" + max + "' step='" + step + "' value='" + val + "' />",
      '</div>',
    ].join('')).join('');
    for (const [id] of defs) {
      const el = this.root.querySelector('#sl-' + id) as HTMLInputElement | null;
      el?.addEventListener('input', () => {
        const v = Number(el.value);
        const lb = this.root.querySelector('#lb-' + id);
        if (lb) lb.textContent = id === 'taxRate' ? v.toFixed(3) : String(Math.round(v));
        el.style.setProperty('--fill', ((v - Number(el.min)) / (Number(el.max) - Number(el.min)) * 100) + '%');
        this.cb.onAction({ type: 'set_policy', patch: { [id]: v } });
      });
    }
  }

  private syncSliders(obs: Observation) {
    const set = (id: string, v: number) => {
      const el = this.root.querySelector('#sl-' + id) as HTMLInputElement | null;
      const lb = this.root.querySelector('#lb-' + id);
      if (el && document.activeElement !== el) {
        el.value = String(v);
        el.style.setProperty('--fill', ((v - Number(el.min)) / (Number(el.max) - Number(el.min)) * 100) + '%');
      }
      if (lb) lb.textContent = id === 'taxRate' ? v.toFixed(3) : String(Math.round(v));
    };
    set('taxRate', obs.policy.taxRate);
    set('serviceLevel', obs.policy.serviceLevel);
    set('constructionBudget', obs.policy.constructionBudget);
    set('maintenanceBudget', obs.policy.maintenanceBudget);
  }

  update(state: WorldState, view: ViewState, stats: RenderStats) {
    this.view = view;
    const obs = getObservation(state);
    const q = (id: string) => this.root.querySelector(id);
    const setText = (id: string, v: string, cls?: string) => {
      const el = q(id);
      if (!el) return;
      el.textContent = v;
      if (cls !== undefined) el.className = 'v ' + cls;
    };
    setText('#s-year', 'Y' + obs.year + ' M' + String(obs.month).padStart(2, '0'));
    setText('#s-pop', fmt(state.population.total));
    setText('#s-treas', fmt(state.treasury), state.treasury < 0 ? 'neg' : 'pos');
    setText('#s-debt', fmt(state.debt));
    setText('#s-happy', pct(state.population.happiness));
    const net = state.lastReport ? state.lastReport.net : 0;
    setText('#s-net', (net >= 0 ? '+' : '') + fmt(net), net >= 0 ? 'pos' : 'neg');
    this.syncSliders(obs);

    const gauges = q('#gauges');
    if (gauges) {
      const order: [string, string][] = [
        ['waterReliability', 'water'], ['powerReliability', 'power'], ['healthCoverage', 'health'],
        ['educationCoverage', 'education'], ['fireCoverage', 'fire'], ['transitCoverage', 'transit'],
      ];
      gauges.innerHTML = order.map(([key, label]) => {
        const v = (obs.services as Record<string, number>)[key] ?? 0;
        const color = v > 0.8 ? 'var(--ok)' : v > 0.55 ? 'var(--warn)' : 'var(--danger)';
        return "<div class='gauge'><span class='label'>" + label + "</span><span class='bar'><span class='fill' style='width:" + (v * 100).toFixed(0) + '%;background:' + color + "'></span></span><span class='val'>" + Math.round(v * 100) + '%</span></div>';
      }).join('');
    }

    const vitals = q('#vitals');
    if (vitals) {
      const rows: [string, string][] = [
        ['GDP / mo', fmt(obs.economy.gdp)],
        ['Jobs', fmt(obs.economy.jobs)],
        ['Employment', pct(obs.economy.employment)],
        ['Housing cap', fmt(state.economy.housingCapacity)],
        ['Demand r/c/i', [obs.economy.demands.res, obs.economy.demands.com, obs.economy.demands.ind].map(x => x.toFixed(2)).join(' / ')],
        ['Commute', obs.population.commuteTime.toFixed(1) + ' min'],
        ['Congestion', pct(obs.congestion)],
        ['Pollution', pct(obs.services.pollution ?? 0)],
        ['Land value', pct(obs.economy.landValue)],
        ['Net migration', (obs.population.netMigration >= 0 ? '+' : '') + obs.population.netMigration],
      ];
      vitals.innerHTML = rows.map(([k, v]) => "<div class='row'><span class='k'>" + k + "</span><span class='v'>" + v + '</span></div>').join('');
    }

    const warn = q('#warnings');
    if (warn) {
      warn.innerHTML = obs.warnings.length
        ? obs.warnings.map(w => "<div style='padding:2px 0;color:#ffb454'>- " + esc(w) + '</div>').join('')
        : "<span style='color:#6ee7a8'>all systems nominal</span>";
    }

    const perf = q('#perf');
    if (perf) {
      perf.innerHTML = [
        'draw calls ' + stats.drawCalls,
        'triangles ' + fmt(stats.triangles),
        'instances ' + fmt(stats.instanced),
        'buildings ' + fmt(stats.buildings) + ' / trees ' + fmt(stats.trees),
        'tick ' + state.tick + ' / hash ' + state.seed,
      ].join('<br/>');
    }

    this.renderLog(state);
  }

  private renderLog(state: WorldState) {
    const list = this.root.querySelector('#loglist');
    if (!list) return;
    const sig = state.tick + ':' + state.events.length + ':' + state.pending.length;
    if (sig === this.proposalSignature) return;
    this.proposalSignature = sig;
    const rows: string[] = [];
    for (const p of state.pending.slice(-4)) {
      const cost = Math.round(p.expected_cost);
      rows.push("<div class='proposal'><div class='pbody'><div class='prole'>" + esc(p.role) + ' - ' + cost + ' cr'
        + "</div><div style='color:#8ea1b5'>" + esc(p.rationale.slice(0, 200)) + '</div></div>'
        + "<button class='btn' data-approve='" + esc(p.id) + "'>Approve</button>"
        + "<button class='btn danger' data-reject='" + esc(p.id) + "'>Reject</button></div>");
    }
    for (const e of state.events.slice(-14).reverse()) {
      rows.push("<div class='logline " + e.severity + "'><span class='t'>M" + String(e.tick).padStart(3, '0')
        + "</span><span class='m'>" + esc(e.title) + ': ' + esc(e.text) + '</span></div>');
    }
    list.innerHTML = rows.join('');
    list.scrollTop = 0;
    for (const b of Array.from(list.querySelectorAll('[data-approve]'))) {
      b.addEventListener('click', () => this.cb.onApprove((b as HTMLElement).dataset.approve ?? ''));
    }
    for (const b of Array.from(list.querySelectorAll('[data-reject]'))) {
      b.addEventListener('click', () => this.cb.onReject((b as HTMLElement).dataset.reject ?? ''));
    }
  }

  setPending(pending: PendingProposal[]) {
    if (pending.length === 0) return;
    this.proposalSignature = '';
  }

  setLLMStatus(text: string) {
    const el = this.root.querySelector('#llm-status');
    if (el) el.textContent = text;
  }

  showBanner(title: string, sub: string) {
    const b = this.root.querySelector('#banner') as HTMLElement | null;
    if (!b) return;
    (b.querySelector('.bt') as HTMLElement).textContent = title;
    (b.querySelector('.bs') as HTMLElement).textContent = sub;
    b.classList.add('show');
  }
  hideBanner() { (this.root.querySelector('#banner') as HTMLElement | null)?.classList.remove('show'); }

  private tutorialSlides = [
    {
      title: 'You are the mayor',
      body: '<p>The city runs on a <b>fixed monthly tick</b>. You set policy and budget; the municipal council turns that into actual construction.</p><ul><li>Population grows only when <b>housing, jobs, water and power</b> all allow it.</li><li>Every credit in and out is recorded in the ledger.</li><li>The simulation is deterministic: the same seed and actions always give the same city.</li></ul>',
    },
    {
      title: 'The levers that matter',
      body: '<p><b>Tax rate</b> funds everything but suppresses demand. <b>Construction budget</b> caps how fast the city can build. <b>Maintenance budget</b> keeps infrastructure quality up.</p><p>Watch the right-hand gauges: a service below about 60% starts costing you migration and imports.</p>',
    },
    {
      title: 'Read the council log',
      body: '<p>The council explains itself in the bottom log: which department proposed what, why it was chosen, and which actions the validator rejected.</p><p>Turn on <b>Approve mode</b> to review every proposal yourself instead of delegating.</p>',
    },
    {
      title: 'Failure and success',
      body: '<p>You go bankrupt when the treasury falls below the floor. You reach metropolis status by surviving the full term with a large, happy, solvent city.</p><p>Try all six scenarios: each breaks a different part of the system.</p>',
    },
  ];

  showTutorial() {
    this.tutorialStep = 0;
    this.renderTutorial();
    (this.root.querySelector('#tutorial') as HTMLElement | null)?.classList.remove('hidden');
  }
  private renderTutorial() {
    const card = this.root.querySelector('.tut-card');
    if (!card) return;
    const s = this.tutorialSlides[this.tutorialStep]!;
    (card.querySelector('h2') as HTMLElement).textContent = s.title;
    (card.querySelector('.tut-body') as HTMLElement).innerHTML = s.body;
    const next = card.querySelector('#tut-next') as HTMLElement | null;
    if (next) next.textContent = this.tutorialStep === this.tutorialSlides.length - 1 ? 'Start governing' : 'Continue';
  }
  private nextTutorial() {
    this.tutorialStep++;
    if (this.tutorialStep >= this.tutorialSlides.length) this.hideTutorial();
    else this.renderTutorial();
  }
  hideTutorial() { (this.root.querySelector('#tutorial') as HTMLElement | null)?.classList.add('hidden'); }

  getSpeed(): number { return this.speed; }
  getCouncilOn(): boolean { return this.councilOn; }
  getApprovalOn(): boolean { return this.approvalOn; }
  getLLMOn(): boolean { return this.llmOn; }
  getView(): ViewState { return this.view; }
}
