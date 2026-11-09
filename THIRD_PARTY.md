# Third-party code, assets and provenance

Inventory date: 2026-11-09. This file is part of the licensing record and must be
updated whenever a dependency or asset is added.

## Project license

All original code in this repository is **Apache-2.0** (see `LICENSE`).

## Runtime and build dependencies

| Package | Version | License | Used for |
|---|---|---|---|
| three | 0.172.0 | MIT | 3D rendering |
| zod | 3.25.76 | MIT | LLM proposal schema validation |
| typescript | 5.9.3 | Apache-2.0 | compiler |
| tsx | 4.23.15 | MIT | running the CLI and tests |
| vite | 6.4.5 | MIT | web bundler |
| @types/node | 22.20.5 | MIT | type definitions |
| @types/three | 0.172.0 | MIT | type definitions |

Exact resolved versions and integrity hashes are pinned in `pnpm-lock.yaml`.

## Assets

**There are no third-party art assets in this repository.**

Every visual element is generated at runtime by `packages/render/src/index.ts`:

- terrain mesh from the simulation heightfield with computed vertex colours,
- procedural building volumes from InstancedMesh boxes,
- procedural trees (cone geometry), road ribbons, water plane, sky and lighting.

No model files, no texture images, no HDRIs, no audio, no fonts beyond system
UI fonts, and nothing from any commercial game.

`results/*.png` are screenshots captured from this repository's own build.

## Inspected but NOT incorporated

### Egregoria

- URL: https://github.com/Uriopass/Egregoria
- Commit inspected: `ae65c857948a905120474cf93b96dd51cec6d5f6` (2025-06-02)
- License at root: **GPL-3.0**
- What was done: shallow clone, read `LICENSE`, `ARCHITECTURE.md`, `README.md`,
  `Cargo.toml`, and the asset directory layout. **No source file was copied,
  translated, or linked into this project.**
- Why not forked: GPL-3.0 would make the whole combined work GPL-3.0 (it cannot
  be relicensed to Apache-2.0); the workspace depends on unpinned git branches
  (`egui` from master, `yakui` from `dev`), so a reproducible fixed build is not
  guaranteed; and the art pipeline depends on Git LFS assets that were not
  fetched and whose per-file licenses were not audited.
- Result: **no-go** for a fork; architecture ideas (fixed tick, command/event
  separation, render state decoupled from simulation state) were reimplemented
  independently from public documentation of those concepts.

### Others read for mechanism understanding only

| Project | License | What was taken |
|---|---|---|
| Citybound | AGPL-3.0 | nothing beyond the general idea that planning is cooperative |
| KotCity | Apache-2.0 | nothing |
| 3d.city | mixed / GPLv3 claims | nothing |
| Cytopia | GPL-3.0 | nothing |

None of these contributed code or assets. No file from them is present here.

### Commercial titles

Cities: Skylines and its sequels were **not** decompiled, copied from, or used as
a data source. Only publicly published feature descriptions informed the broad
design goals (zoning, utilities, service coverage, budget pressure), which are
generic city-builder concepts. No trademark, model, texture, sound, UI layout or
game-data file from any commercial title is included.

## Papers

No paper text, dataset, figure or table is reproduced in this repository. Research
framing was read at the level of abstracts and public repository documentation;
see `docs/reference/` for the supplied brief and `docs/BENCHMARK.md` for how the
protocol responds to that literature.

## Generated content

All commit content in this repository was produced by a human-directed AI coding
agent (DeepSeek Harness) working with the project owner. No third-party generative
model output (image, mesh, audio) is embedded in the repository. Contributors
should independently verify the license terms of any tool they use to add assets
in the future.
