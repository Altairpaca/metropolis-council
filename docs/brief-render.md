3D RENDERER + WEB FRONTEND TASK

Repo: /home/lzz/playground/metropolis-council. This is the most visually important part - make it genuinely beautiful.

FIRST: Read CONTRACT.md FULLY (especially Render contract + Frontend architecture), packages/core/src/types.ts (WorldState, Tile, WorldMap, RoadNetwork), map.ts (idx), constants.ts. Read docs/reference/02_DSH_开发提示词.md sections 游戏体验与内容 / 交互式 3D 可视化 / 美术约束 and 01_调查报告.md section 7.

WRITE SCOPE (STRICT):
- packages/render/src/*.ts ONLY
- apps/web/** ONLY (index.html, src/main.ts, src/hud.ts, src/style.css, vite.config.ts, src/*.ts)
- scripts/screenshot.mjs (Playwright screenshot helper; global playwright 1.59.1 at /usr/lib/node_modules/playwright; Chrome 144 at /usr/bin/google-chrome)
You may READ anything else. Do NOT edit core, council, bench, sim, server, docs, root configs, CONTRACT.md.
NOTE: council is implemented IN PARALLEL. Import runRuleCouncil, runNoop, runGreedy, LLMAdapter, DEFAULT_LLM_CONFIG, makeMockLLM from '@metropolis/council' per CONTRACT.md. They WILL exist.

IMPLEMENT:
A) packages/render/src/index.ts - export CityRenderer class + ViewState type:
   constructor(canvas:HTMLCanvasElement, opts?:{width,height}); update(state:WorldState, view?:ViewState): void; dispose(): void; getStats(): {drawCalls,triangles,instanced}; setHighlight(mode).
   ViewState = { mode:'standard'|'finance'|'traffic'|'pollution'|'services'|'landvalue'; zoom, rotation, panX, panY, timeOfDay(0..1), showLabels }.
   Build a genuinely nice ORIGINAL procedural 3D scene with three.js (0.172.0 at root):
   - Terrain heightmap mesh from map.tiles[].height with vertex colors (green lowlands, rocky highs, sandy coast), animated water/sea plane, river cells.
   - Roads: ribbons/tubes from state.roads.nodes+edges with lane-marking feel.
   - Buildings: InstancedMesh boxes with per-instance color + heights from tile.density / landUse (res/com/ind/civic/park) / landValue; emissive windows at night; rooftop details; varied footprints. SKYLINE: taller towers near center, lower suburbs outward; a few ORIGINAL procedural landmark towers (NOT copies of real buildings).
   - Parks/trees: instanced low-poly trees (cone+sphere), green space.
   - Day/night: directional sun + ambient + hemisphere light; sky background lerps by timeOfDay; emissive windows glow at night; subtle fog.
   - Camera: PerspectiveCamera with orbit rotation/zoom/pan driven by ViewState; pointer drag rotate, wheel zoom, right-drag pan on canvas.
   - Overlay modes: recolor tiles/roads by data (finance, traffic, pollution, services, landvalue) via vertex/instance colors + legend callback.
   - People/vehicles: lightweight instanced moving dots along road edges (animate by time, deterministic from tile index, NO Math.random for positions).
   - Perf: InstancedMesh, reused geometry/materials, proper dispose, getStats() from renderer.info.
   - OPTIONAL renderToDataURL(state,view) helper.
   - Absolutely NO external models/textures/audio - all generated in code. Header comment stating this.
B) apps/web/vite.config.ts - Vite config root=apps/web, build.outDir=../../dist/web, alias @metropolis/* -> ../../packages/*/src/index.ts. Must work with 'vite build --config apps/web/vite.config.ts' from repo root.
C) apps/web/index.html - polished dark 'city ops' shell with canvas + HUD containers.
D) apps/web/src/style.css - professional modern UI: glass panels, monospace numerics, restrained accent, responsive, readable. Real game UI, not a debug page.
E) apps/web/src/hud.ts - export class HUD with constructor(root:HTMLElement), update(state:WorldState, view:ViewState, rendererStats): void, callback hooks (onAction, onViewChange, onSpeed, onSave, onLoad, onNewGame, onToggleCouncil, onApprove, onReject, onExport). Render: top bar (city name, year/month, population, treasury, debt, happiness with bars), left panel (policy sliders: taxRate, serviceLevel, constructionBudget, maintenanceBudget, priorities; borrow/repay buttons), right panel (service coverage gauges, demands, traffic, pollution, warnings), bottom council log (events + proposals with approve/reject buttons in approval mode), overlay mode selector, speed controls (pause/1x/2x/4x), milestone/bankruptcy/victory banners, first-run TUTORIAL overlay with 3-4 steps. ALL numbers from real state - no fake data. setCouncilProposals(pending), setLLMStatus(text).
F) apps/web/src/main.ts - wire it: createInitialState from URL (?seed=101&scenario=starter_town), fixed-tick loop (~500ms/month at 1x scaled by speed), default council = runRuleCouncil every 3 months, player actions through applyCommand (SAME command queue), OPTIONAL LLM toggle via LLMAdapter/propose through /api/llm with deterministic fallback (offline by default, NO key needed). Save/load via localStorage with serializeState/deserializeState. Pause/accelerate/rollback (ring of recent states for 'rollback uncommitted proposal'). Buttons: new game, save, load, export JSONL, scenario picker, seed input. Approval mode toggle: proposals go to state.pending, require approve/reject. Show real stateHash. Expose window.__MC_STATE__, window.__MC_STATS__, window.__MC_STEP__(n) for tests. All browser-side; no server needed to play.
G) scripts/screenshot.mjs - Playwright script: launch Chrome headless with WebGL (--use-gl=angle --use-angle=swiftshader --enable-webgl --ignore-gpu-blocklist or headless=new), navigate to URL from argv (default http://127.0.0.1:4173), wait for canvas, full-page screenshot to results/screenshot.png, capture console errors, print renderer stats if window.__MC_STATS__ exposed.

QUALITY BAR: must look like a real, polished 3D city builder. Effort on lighting, color, composition, skyline silhouette, HUD typography. VERIFY: cd /home/lzz/playground/metropolis-council && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'packages/render|apps/web|error' | head -40 -> ZERO errors in your scope, and 'npx vite build --config apps/web/vite.config.ts 2>&1 | tail -20' succeeds (retry once if council not landed yet). Report files, scene contents, build result, gaps. Do NOT claim screenshots you didn't take.
