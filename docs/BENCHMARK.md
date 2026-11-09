# City Governance Benchmark - protocol v0.1

Status: **experimental**. Thresholds are published, not calibrated. Baseline
numbers below are real measurements from this repository and are labelled as
smoke results, not as a ranking of model capability.

## What is measured

An episode is:

    (simulator version, scenario, world seed, agent, call budget, decision period, horizon)

The unit of study is a model's ability to make long-horizon decisions from
limited information inside a simulation - not its planning credentials, and not
real-world governance capability.

## Tracks

| Track | Tested agent is | Other seat is |
|---|---|---|
| council | the council | a FIXED scripted mayor that holds a stable policy envelope |
| mayor | the mayor | a FIXED rule council that executes within the envelope |

Exactly one seat is tested per episode. Results from different tracks are never
averaged together, and a multi-agent track (not implemented) would not be
comparable to a single-agent track on token cost alone.

## Information discipline

Every agent receives the same object: the result of getObservation(state).

It contains: tick, treasury, debt, credit limit, policy, population aggregates,
economy aggregates, service coverage, utility capacity and demand, congestion,
per-region summaries, warnings, the last six monthly reports, a bounded candidate
action menu, the legal ranges, and the exact cost formula.

It does **not** contain: the RNG states, the future shock schedule, internal tile
arrays, the household sample, the pending queue internals, or any other agent's
history. The cost formula in the observation is the same object the validator
enforces, so an agent cannot be misled about prices.

## Budget discipline

All agents are called on the same decision period and share the same maximum
number of decisions. A token budget and a cost cap are recorded per episode.
Exceeding the budget stops further calls; the agent then behaves as no-op and
the failure is reported rather than hidden.

## Metrics

Raw series are recorded every month: population, treasury, debt, GDP, happiness,
health, unemployment, commute time, six service coverage rates, pollution, net
migration, build and maintenance spend, illegal-action rate, survival ticks.

Six dimensions, each normalised linearly into 0..100 and clamped:

| Dimension | Weight | Built from |
|---|---|---|
| prosperity | 20% | sustainable population, employment, happiness |
| finance | 20% | terminal treasury, debt ratio |
| services | 20% | mean service coverage, water reliability, power reliability |
| environment and health | 15% | pollution, health index |
| equity | 10% | 1 - regional service spread |
| resilience | 15% | worst-month service coverage, commute time |

Hard floors are reported separately and never folded into the composite:
bankruptcy, chronic water shortage (mean coverage below 0.60), service collapse
(mean coverage below 0.35).

Thresholds live in SCORE_CONFIG in packages/bench/src/scoring.ts. They are
**uncalibrated v0.1 constants**. Changing them changes every historical score,
which is why they are versioned with the simulator version.

### Bankruptcy is not rewarded

A failed episode is scored over the FULL configured horizon using its terminal
values, not truncated at the failure tick. Averaging survival time across
episodes would reward a model that loses quickly.

## Statistics

Reports include per-metric means and a seed-paired percentile bootstrap 95%
confidence interval (1000 resamples, deterministic RNG, so the interval is
reproducible). binary outcomes report failure counts, not invented p-values.

Pairing matters: every agent sees the same seeds and the same shock schedule, so
a difference between agents is not confounded by which map they happened to get.

## Seeds

Public development seeds are 101-110. The smoke suite uses 101-105.

holdoutSeeds(n) derives additional seeds from a version salt. This is a
**documented generation rule, not a secret**: anyone with the source can compute
it. It is useful for avoiding accidental overfitting during development, not for
claiming a hidden test set.

## Replay semantics, stated precisely

A replay record stores every applied command with the state hash before and after.
Replaying those commands on the same simulator version reproduces the same final
hash; this is verified in the acceptance self-check.

This is a claim about the SIMULATOR, not about the model. A remote LLM sampled
again will produce different actions, and the benchmark never claims otherwise.
Any reproducibility claim must therefore travel with the recorded action log.

## Baselines

| Baseline | What it may use | What it represents |
|---|---|---|
| no-op | nothing; it observes only | the cost of doing nothing |
| finance-greedy | cash and debt figures only | competent but shallow austerity |
| rule council | the full public observation, the same one an LLM gets | a strong deterministic reference |

The greedy baseline is intentionally narrow but not a strawman: within its narrow
view it behaves sensibly, raising tax when cash is short and repaying debt when
it is abundant.

## Measured smoke results (v0.1)

Command: pnpm bench. 3 baselines x 3 scenarios x 5 seeds = 45 episodes, 120
months each, decision period 3, call budget 40, track council.

Wall clock: 531 seconds on the machine that built this repository.

| baseline | mean composite | mean final population | mean final treasury | failures |
|---|---|---|---|---|
| no-op | 73.8 | 1,773 | 32,721 | 5 / 15 |
| finance-greedy | 75.6 | 1,610 | 145,059 | 0 / 15 |
| rule council | 79.5 | 2,140 | 40,941 | 0 / 15 |

Interpretation, with its limits stated:

- The ordering rule council > greedy > no-op is the expected shape and shows the
  benchmark separates strategies at all.
- Greedy hoards 145k while ending with a smaller population than the rule
  council: the composite rewards solvency but not solvency alone, which is the
  intended tension rather than a bug.
- Doing nothing fails 5 of 15 runs, so the hard floor is live.
- Three scenarios x five seeds is a smoke test. It is not a statistically
  powered comparison and no model ranking should be inferred from it.

## What is not implemented

- No real LLM episode has been run in this repository. The mock behaviours exist
  so the protocol can be tested offline and are clearly labelled as mocks.
- The multi-agent track is designed but not implemented.
- No private test set exists; holdout seeds are transparent.
- Equity uses a regional service-spread proxy, not income-level microdata.
- The resilience proxy is worst-month coverage, not a formal recovery-time metric.
