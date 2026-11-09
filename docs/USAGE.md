# Usage

## Install and verify

    pnpm install
    pnpm typecheck
    pnpm test

## Play

    pnpm build      # bundles the web app into dist/web
    pnpm start      # serves dist/web plus the optional LLM proxy on :4173

Open <http://127.0.0.1:4173>. Everything runs in the browser; the server only
serves files and, if configured, proxies LLM requests.

Query parameters:

| Param | Values | Default |
|---|---|---|
| scenario | starter_town, water_industry, two_banks, declining_finance, unequal_growth, compound_crisis | starter_town |
| seed | any integer | 101 |

## Headless CLI

All commands work offline and are deterministic except when an LLM endpoint is
explicitly configured.

    pnpm cli new --seed 101 --scenario starter_town --out save.json
    pnpm cli show --save save.json
    pnpm cli hash --save save.json
    pnpm cli run --save save.json --months 120 --out save.json --jsonl trace.jsonl --csv metrics.csv
    pnpm cli bench --out results/
    pnpm cli replay --replay replay.json
    pnpm cli selfcheck
    pnpm cli serve --port 4173

### run options

| Flag | Meaning |
|---|---|
| --agent | rule_council (default), noop, finance_greedy, mock_valid, mock_malformed, mock_overspend, mock_illegal, mock_timeout, mock_rate429 |
| --months | how many ticks to simulate |
| --period | decision period in months (default 3) |
| --maxcalls | decision budget (default 40) |
| --track | council (default) or mayor |
| --jsonl | per-decision trace including validator verdicts |
| --csv | per-month metric series |

The mock_* agents are **protocol test doubles**. They exist to exercise the
failure paths without a network. They are never a model result.

## Enabling a real LLM councillor

    cp .env.example .env.local

Then set:

    MC_LLM_BASE_URL=https://api.deepseek.com/v1
    MC_LLM_API_KEY=sk-...
    MC_LLM_MODEL=deepseek-chat
    MC_LLM_TIMEOUT_MS=20000
    MC_LLM_MAX_CALLS_PER_MIN=20
    MC_LLM_MAX_COST_USD=2.00
    MC_LLM_PRICE_IN_PER_1K=0.00027
    MC_LLM_PRICE_OUT_PER_1K=0.0011

.env.local is gitignored. The key is read only by packages/server, never
returned to the client, never written to a save, never logged.

Verify what the server thinks it has:

    curl -s http://127.0.0.1:4173/api/health
    {"ok":true,"llmConfigured":true,"model":"deepseek-chat","version":"0.1.0"}

## Benchmark

    pnpm bench

Produces:

- results/smoke.json - every episode with full metrics, scores, cost and replay log
- results/smoke.csv  - one row per episode
- results/smoke.md   - the summary table

To benchmark a real model later, implement GovernanceAgent (see
packages/bench/src/baselines.ts) around runLLM and pass it to runEpisode.
The interface is already the one the runner uses; nothing in the runner changes.

## Replay

Every episode carries a ReplayRecord: scenario, seed, difficulty, and every
command with the state hash before and after.

    pnpm cli replay --replay replay.json   # prints PASS/FAIL and the hashes

Replay reproduces the recorded trajectory. It does not, and cannot, claim that a
remote model would choose the same actions again.

## Screenshots

    pnpm start &
    node scripts/screenshot.mjs http://127.0.0.1:4173/ results/screenshot.png 48
    SHOT_MODE=traffic node scripts/screenshot.mjs http://127.0.0.1:4173/ results/overlay-traffic.png 48
    SHOT_TIME=0.93 node scripts/screenshot.mjs http://127.0.0.1:4173/ results/city-night.png 48

Uses headless Chrome with software WebGL; prints renderer statistics and any
console errors so a broken build cannot silently produce a blank image.
