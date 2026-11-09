# Engineering log

Dated, factual record of what was done, what broke, what was fixed and what is
still missing. Written so a reader can audit the claims in the README instead of
trusting them.

## 2026-11-09 - Phase 0: environment and licensing spike

**Machine.** Ubuntu 20.04.6, kernel 5.15, AMD EPYC 7V12, 256 logical CPUs,
1.0 TiB RAM, 4x NVIDIA A40, Node 24.14.0, pnpm 12.18.0, Chrome 144.0.7559.59,
gh 2.62.0 authenticated as the repository owner.

**Task package.** The supplied brief, research report and benchmark proposal were
read in full and archived verbatim in docs/reference/ so the requirements stay
auditable.

### Egregoria spike (time-boxed, concluded NO-GO)

Shallow-cloned https://github.com/Uriopass/Egregoria, pinned commit
ae65c857948a905120474cf93b96dd51cec6d5f6 (2025-06-02).

Findings:

| Question | Answer |
|---|---|
| Root license | GPL-3.0 (full text present, no per-file exceptions found) |
| Size | 300 Rust files, 34 MB repository |
| Architecture doc | yes, explicit fixed tick, pure deterministic step, WorldCommand, render state decoupled |
| Dependency pinning | **not reproducible** - egui from git master, yakui from a git dev branch |
| Assets | Git LFS tracked; a shallow clone without LFS leaves asset directories unresolved |
| Per-asset licensing | not audited; no asset ledger in the repository |

Decision: do **not** fork. Reasons, in order of weight:

1. GPL-3.0 is copyleft; incorporating it would force the whole combined work to
   GPL-3.0 and would forbid the intended Apache-2.0 release.
2. Unpinned git dependencies make a reproducible fixed build a promise this
   environment cannot verify within the time box.
3. The asset pipeline depends on LFS payloads whose licenses were not auditable
   here, which conflicts with the brief's own requirement for a provenance table.
4. The deliverable needs a browser-playable 3D build and a harness where every
   agent action passes through one validator; writing that around a large
   GPL codebase would take longer than an autonomous implementation of the same
   concepts.

No Egregoria source was copied. Only architectural ideas that are public and
generic (fixed tick, command queue, render decoupled from simulation) were
reimplemented independently. Recorded in THIRD_PARTY.md.

## 2026-11-09 - Phase 1: deterministic core

Built packages/core: types, constants, scenarios, xorshift32 RNG with four named
streams, value-noise terrain, command validation, apply, fixed-tick engine,
observation, save/load with checksum and FNV-1a state hash.

Verified determinism in-process: two independently constructed worlds stepped
with identical commands produced identical hashes.

## 2026-11-09 - Phase 2: balance, and the bugs it exposed

This is the part worth reading, because the first three attempts were wrong.

### Bug 1 - population grew regardless of infrastructure

**Symptom.** Starting town of 932 citizens reached 5,836 in 24 months while
water coverage fell to 7%.

**Cause.** state.population.total was recomputed from the representative
household sample, while the sample size was computed from population.total. More
households produced a bigger total, which produced more households. A closed
positive feedback loop that no ceiling could bind.

**Fix.** population.total became authoritative (driven by migration), the sample
became a pure view rescaled from it, and regional allocation now distributes the
authoritative total as weights instead of summing the sample.

### Bug 2 - demand and capacity used different units

**Symptom.** With no action at all, the treasury reached 116,000 credits while
every service was red.

**Cause.** capacity was expressed in arbitrary 'units' while demand was
population x coefficient, and a sub-linear 'popFactor' had been added to paper
over the mismatch. Imports of unmet demand were priced against the mismatched
unit, so the city was simultaneously unserved and profitable.

**Fix.** capacities were redefined as 'citizens served' (one water works serves
1,100), demand became population x per-capita coefficient, and the popFactor hack
was deleted. The published cost formula now matches the enforced one exactly.

### Bug 3 - the council spent itself to death

**Symptom.** The rule council went bankrupt in 22, 13 and 55 months on three
scenarios while the no-op baseline survived.

**Cause.** departments proposed against the legal construction cap, but the
arbiter's budget was the treasury. Packages always exceeded the envelope, so
either everything was rejected or the treasury was drained.

**Fix.** runRuleCouncil computes an affordable capital envelope from recent
reported cash flow and passes it into the departments before they propose, so
proposals are born inside the envelope. The finance department also reacts to a
three-month average deficit, not only to a negative balance.

### Bug 4 - planning solved the wrong problem

**Symptom.** Population pinned at exactly 2,113 in four scenarios - the initial
water capacity - while the council bought housing.

**Cause.** the planning department expanded housing whenever housing demand was
high, even when the binding constraint was water. More residents, no more water,
so the ceiling never moved.

**Fix.** planning is now capacity-first: when a utility is above 92% coverage it
saves for the plant instead of adding demand, and when it cannot afford the plant
it correctly does nothing that month.

### Bug 5 - zoning was decorative

**Symptom.** No way for a player to affect where the city densified.

**Fix.** zone intents now drive organic densification each tick: land designated
for a use intensifies toward it while demand exists. This is simultaneously a
game mechanic and the reason the skyline grows over decades in the renderer.

### Bug 6 - replay did not reproduce the hash

**Symptom.** verifyReplay failed. Recorded 3 commands, replayed 54 expected.

**Cause.** the council track applies a scripted mayor command AND the agent
command in the same tick, but only the agent command was recorded.

**Fix.** the runner records every command applied in a step; replay groups by
tick and applies them together. Verified: 160 recorded commands reproduce the
final hash exactly.

### Calibration after the fixes

Final shape, 120 months, three strategies per scenario:

| scenario | no-op | finance-greedy | rule council |
|---|---|---|---|
| starter_town | 1,218 pop | 1,218 | **1,584** |
| water_industry | 2,113 | 2,066 | **2,305** |
| two_banks | 2,113 | 2,113 | **2,305** |
| declining_finance | **bankrupt @ month 17** | 1,589 | **2,783** |
| unequal_growth | 2,113 | 2,113 | **2,305** |
| compound_crisis | **bankrupt @ month 33** | 1,998 | **2,290** |

The rule council wins population in all six and survives all six; doing nothing
dies twice; austerity survives but shrinks while hoarding cash. That is a real
trade-off space rather than a dominant strategy.

## 2026-11-09 - Phase 3: council, LLM adapter, benchmark

- Five deterministic departments, deterministic arbiter with recorded rejection
  reasons, prompt builder with a versioned prompt, zod schema that also validates
  whitelisted actions, robust adapter with bounded retries and deterministic
  fallback, and six offline mock behaviours.
- Benchmark runner with two tracks, baselines, six-dimension scoring with hard
  floors, seeded bootstrap CIs, replay verification and a 45-episode smoke suite.
- Measured: no-op 73.8 (5 failures), greedy 75.6, rule council 79.5. Wall clock
  531 s for 45 x 120 months.

## 2026-11-09 - Phase 4: renderer and web app

Procedural three.js renderer: terrain from the heightfield, water, road ribbons
that follow terrain slope, instanced buildings coloured by land use, instanced
trees, landmark towers, day/night lighting with night-only window emissive, and
five data overlays. HUD with policy sliders, service gauges, vitals, warnings,
council log with approve/reject, overlay selector, speed control and a tutorial.

Fixed during visual review:

- emissive window glow was applied in daylight per frame, washing every facade
  to a uniform tan; now it fades in only after dark,
- the river rendered nearly black because of high metalness and a grazing angle;
  water roughness and metalness were retuned and given a faint emissive,
- roads were buried under sloped terrain; they now follow node elevation with
  pitch along the segment,
- the right HUD column was placed in the wrong grid cell,
- landmark towers were too tall and unlit; made smaller, wider, matte and
  faintly self-lit,
- the camera framed the whole map, leaving a young town tiny in frame; it now
  frames the built-up extent and pulls back as the city grows.

Measured renderer cost on the screenshot run (1600x900, software WebGL):
98 draw calls, 12.6k triangles, 582 instances, 82 buildings, 273 trees, 227
vehicles, zero console errors.

## 2026-11-09 - Phase 5: verification

pnpm test -> SELFCHECK 18/18. Includes cross-process determinism, save/load
round-trip, checksum rejection of a tampered save, four illegal-action classes,
five distinct maps, reachable bankruptcy, six offline LLM failure modes, and a
full episode replay matching its final hash.

pnpm bench -> 45 episodes, exit 0, artifacts written to results/.

Screenshots captured headlessly from the built app (day, night, traffic overlay).

## Known defects and gaps

| Area | State |
|---|---|
| Real LLM episodes | not run. Adapter and proxy are implemented and protocol-tested offline only |
| Multi-agent benchmark track | designed, not implemented |
| Traffic | aggregate link loading; no per-vehicle pathfinding or turning cost |
| Economy | internally coherent, not calibrated against real municipal data |
| Equity metric | regional service-spread proxy, not income microdata |
| Resilience metric | worst-month coverage proxy, not measured recovery time |
| Score thresholds | uncalibrated v0.1 constants, clearly labelled |
| Renderer | stylised procedural geometry; no PBR asset pipeline, no LOD manager |
| Audio | none |
| Modding | none |
| Mobile / touch | HUD is responsive but not touch-optimised |
| Performance | full 120-month x 45-episode suite takes ~9 minutes; state cloning per tick is the hotspot |
| Tests | acceptance self-check is broad but there is no unit-test framework beyond it |

## Honest performance numbers

| Measurement | Value | Context |
|---|---|---|
| Benchmark suite | 531 s for 45 episodes x 120 months | Node 24, single process |
| In-browser tick | ~4-6 s for 60 months via the test hook | headless Chrome, software WebGL |
| Render | 98 draw calls / 12.6k triangles at 82 buildings | same run |
| Build | Vite production build ~2 s, 607 kB JS (159 kB gzip) | includes the whole simulator |

No claim is made about frame rate on real GPU hardware, because that was not
measured on one.

## Cost

LLM spend during development: **0 USD**. No paid endpoint was called. The LLM
integration was validated against local mocks and against the documented
OpenAI-compatible wire format.

## Next steps, in priority order

1. Run a real model through the council track and publish the episode logs with
   token and cost accounting, clearly separated from the mock protocol tests.
2. Implement the mayor track end to end and the multi-agent ablation.
3. Calibrate SCORE_CONFIG against a wider seed set and freeze it as v1.0.
4. Replace aggregate traffic with a routed graph and per-vehicle agents.
5. Add unit tests around the engine's invariants (conservation of credits,
   monotonic land version, bounded household sample).
6. Add a LOD manager and a PBR material pass for the renderer.
## 2026-11-09 - Phase 6: real local model, and two more visual bugs

### Real LLM episode

Found an Ollama instance already running on the machine with an 8B model loaded.
Rather than stop at mocks, ran a real episode through the project's own adapter:

    npx tsx tools/llm-episode.ts http://127.0.0.1:11434/v1 qwen3:8b-nothinking starter_town 101 36 6

All six proposals were schema-valid on the first attempt, no fallback, 18,562 in /
2,973 out tokens, 255 s total. Result: the model scored 71.0 against the rule
council at 84.9 and no-op at 79.7 on the identical seed. It spent 6,840 more
credits than doing nothing and gained 110 people.

That is a genuinely useful outcome: the plumbing works end to end AND the harness
reports an unflattering result instead of a flattering one. Recorded in full in
docs/LLM_INTEGRATION.md, including the reasons one episode is not a ranking.

### Bug 7 - the sun never reached noon

**Symptom.** A screenshot requested at timeOfDay 0.74 came back looking like
night.

**Cause.** the sun elevation used sin(t*2pi - pi/2), which peaks at t=0.25 and is
back to zero by 0.5. The clock and the lighting disagreed about when noon is.

**Fix.** sun elevation is now sin((t - 0.25) * 2pi), so 0.25 is sunrise, 0.50 is
noon and 0.75 is sunset, which is what the HUD implies.

### Bug 8 - night facades turned into one glowing mass

**Symptom.** At night the whole city became a single cream-coloured blob.

**Cause.** emissive intensity was applied per frame at night*0.85 on a shared
material, saturating every facade.
**Fix.** reduced to night^2 * 0.16 and added a cool moonlight fill light so the
city stays readable without glowing. Also fixed the inverse bug from earlier in
the day: daytime facades had been washed warm because emissive was being applied
at noon.

### Overlay readability

The traffic overlay originally recoloured every building, which produced a
uniform slab of colour that communicated nothing. Roads now carry the congestion
signal and buildings go neutral, so the overlay reads as a road network condition
map, which is what a mayor would actually look at.
