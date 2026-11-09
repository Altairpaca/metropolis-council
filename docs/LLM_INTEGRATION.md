# Local LLM integration

This document records a **real** run of the LLM councillor against a local model,
not a mock. It exists because the difference between "the adapter compiles" and
"a model actually played the city" is the difference between a claim and a fact.

## Environment

| Item | Value |
|---|---|
| Runtime | Ollama, already running on this machine |
| Endpoint | http://127.0.0.1:11434/v1 (OpenAI-compatible) |
| Model | qwen3:8b-nothinking (8.2B, Q4_K_M) |
| Cost | 0 USD (local inference) |
| Harness | tools/llm-episode.ts, using the project's own LLMAdapter |

## Protocol

    npx tsx tools/llm-episode.ts http://127.0.0.1:11434/v1 qwen3:8b-nothinking starter_town 101 36 6

- Track: council. The mayor seat is the same fixed script used in the benchmark.
- Scenario starter_town, seed 101, 36 months, decision period 6 months.
- The model receives exactly the same observation an LLM would get in production:
  the full public observation, the legal ranges, the real cost formula and the
  candidate action menu.
- Its reply is parsed, schema-validated, checked against the action whitelist,
  and then validated again by the core validator before execution.

## Result

| agent | final population | final treasury | composite | status |
|---|---|---|---|---|
| rule council | 1,583 | 23,533 | 84.9 | running |
| no-op | 1,155 | 10,252 | 79.7 | running |
| **qwen3:8b** | **1,265** | **3,412** | **71.0** | running |

Calls: 6. Tokens: 18,562 in / 2,973 out. Wall clock: 255 s (~42 s per decision,
local GPU inference). **Fallback used: no.** Every one of the six proposals was
accepted by the schema and by the validator on the first attempt.

Raw artifact: results/llm-episode.json.

## What this actually shows

1. **The integration works end to end.** A real local model, prompted with this
   repository's prompt, produced schema-valid bounded JSON actions that the
   simulation executed. No key, no cloud, no handholding.
2. **The model governed worse than doing nothing.** It spent 6,840 more credits
   than the no-op baseline and ended with 110 more people: it bought things
   without addressing the constraint that was actually binding. Its proposals
   were plausible-sounding (zone five regions residential, build a transit hub)
   and consistently mis-prioritised.
3. **The rubric is not softening the result.** The composite ranks it last of the
   three agents in this episode. A benchmark that only produces flattering output
   for LLMs would be worthless.

## Honest limits of this result

- **One episode.** One scenario, one seed, six decisions. This is a smoke run
  demonstrating the plumbing and one anecdote about capability. It is not a
  ranking, and no confidence interval is meaningful at n=1.
- The model played a single department seat (planning) and the arbiter executed
  its proposal alongside... nothing else, because in the council track the tested
  agent is the whole council. So this measures "one planning-minded call every
  six months", which is a deliberately weak council.
- 42 seconds per call at 8B parameters is far too slow for a fair comparison
  against a rule council that thinks in microseconds. A real study must fix a
  decision-frequency and token budget per arm, which is exactly what the
  benchmark protocol specifies and what this smoke run did not attempt.
- Temperature 0.2, max 900 output tokens, no chain-of-thought steering.

## Reproducing

    # any OpenAI-compatible endpoint works: Ollama, vLLM, LM Studio, a hosted API
    npx tsx tools/llm-episode.ts <baseUrl> <model> <scenario> <seed> <months> <period>

For the browser, put the same coordinates in .env.local and start the server; the
key stays server-side and the client only talks to /api/llm.

## Next step for a real study

Wrap the same adapter in a GovernanceAgent (as tools/llm-episode.ts does), run
the full scenario x seed matrix through runEpisode, and report paired seed
differences with the bootstrap CI the bench package already provides. Publish the
per-decision logs, token counts and latencies alongside the scores.
