# Architecture

## The one rule that shapes everything

`@metropolis/core` is **pure TypeScript**: it has no DOM access, no Node API, no
network, no clock and no `Math.random`. It imports exactly one runtime dependency
(zod, and only for schemas in the council package it does not depend on).

That single constraint is why the same simulation can run in a browser tab, in a
headless CLI, and in a benchmark harness, byte-for-byte identically. It is also
what makes the determinism claims testable rather than aspirational.

## Data flow

```
                        +-------------------+
   player input  ---->  |  Command (actor)  |  <---- council proposal
   (GUI buttons)        +---------+---------+  <---- LLM proposal
                                  |            <---- baseline agent
                                  v
                       +---------------------+
                       |  validateCommand()  |   pure, never mutates
                       +---------+-----------+
                                  v
                       +---------------------+
                       |  applyCommand()     |   the ONLY mutation path
                       +---------+-----------+
                                  v
                       +---------------------+
                       |  stepWorld()        |   fixed monthly tick
                       |  services -> economy|
                       |  -> traffic         |
                       |  -> population      |
                       |  -> finance         |
                       +---------+-----------+
                                  v
                    WorldState (plain JSON, hashable)
                       |                    |
                       v                    v
              getObservation()        CityRenderer.update()
              (the ONLY agent view)   (three.js, read-only)
```

## Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `@metropolis/core` | world model, map generation, RNG, validation, tick engine, observation, persistence | nothing |
| `@metropolis/council` | five rule departments, deterministic arbiter, prompt building, zod schema, LLM adapter, offline mocks | core |
| `@metropolis/bench` | episode runner, baselines, scoring, replay, smoke suite, statistics | core, council |
| `@metropolis/render` | procedural three.js city | core (types only) |
| `@metropolis/sim` | headless CLI | core, council, bench, server |
| `@metropolis/server` | static file host + LLM proxy | node:http |
| `apps/web` | game loop, HUD, camera, Vite build | core, council, render |

## Determinism

Three mechanisms, each independently tested:

1. **Split RNG streams.** `terrain`, `events`, `population`, `economy` are seeded
   from the world seed with distinct salts and carried in `state.rng` as four
   uint32 values. An agent that makes more or fewer calls cannot shift when a
   drought arrives, because shocks are pre-scheduled by absolute tick and the
   stream is consumed by the engine, not by the agent.
2. **Single mutation path.** Nothing writes to `WorldState` except `applyCommand`.
   The renderer, the HUD, the benchmarks and the LLM all go through it.
3. **Canonical hashing.** `stateHash()` sorts keys, rounds numbers to six
   decimals, drops volatile bookkeeping (event and ledger tails) and hashes the
   rest with a pure BigInt FNV-1a 64. Same state, same hash, on any platform.

Save files carry `schemaVersion`, the four RNG states, a checksum and the full
state. Loading a file whose checksum does not match is refused, which is what
makes "corrupt save rejected" an actual test rather than a comment.

## The tick, in order

| # | Stage | What it may read | What it writes |
|---|---|---|---|
| 1 | commands | state, command | via applyCommand only |
| 2 | shocks | events RNG, scenario schedule | activeShocks, events |
| 3 | services | population, infra units, quality, policy | infra capacity/demand/coverage, services |
| 4 | economy | land use census, population, services | housing, jobs, demand, land value, pollution |
| 5 | traffic | road graph, population | congestion, connectivity, commute |
| 6 | population | services, economy, housing/jobs/utility ceilings | total, sample, byRegion |
| 7 | finance | revenue and cost terms | treasury, ledger, monthly report |
| 8 | end conditions | treasury, population, happiness | status, milestones |

The order is not arbitrary: population must be computed before finance (tax base
depends on it), and services before population (capacity gates migration).

## Why the council is not allowed to be clever with money

The arbiter only sees what an agent sees. It computes an affordable capital
envelope from *recent reported cash flow* - not from internal state - and passes
it to the departments before they propose. A department that proposes outside the
envelope gets its package rejected with a reason, which is logged. This is what
stops the council from spending the treasury to zero in the first two years; an
earlier version did exactly that and went bankrupt in three scenarios.

## Where the LLM is allowed to stand

The model is one more proposal source behind the same arbiter, plus a schema
validator, plus the core validator. It cannot execute code, cannot mutate state,
cannot see future shocks, and cannot see another agent's internals. Its output
is bounded JSON, its actions are whitelisted, and every failure mode degrades to
the deterministic council.

## Renderer

`CityRenderer` builds the terrain once per map, rebuilds roads when the road
network changes, and rebuilds the city when `landVersion` or the tick changes.
Buildings, trees and vehicles are `InstancedMesh` batches, so a city of a few
hundred buildings costs single-digit draw calls per batch rather than one per
building. It reads `WorldState` and never writes to it. Measured on the included
screenshot run: 98 draw calls, 12.6k triangles, 582 instances.
