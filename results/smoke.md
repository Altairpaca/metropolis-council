# City Governance Benchmark - smoke suite

Simulator version: 0.1.0  
Episodes: 45  
Wall clock: 531.3 s

> v0.1 EXPERIMENTAL. Scores use uncalibrated thresholds declared in SCORE_CONFIG.
> The composite is a weighted sum of six dimensions and must not be read as a
> real-world governance capability measure.

## Baselines

| baseline | composite | prosperity | finance | services | env/health | equity | resilience | failures |
|---|---|---|---|---|---|---|---|---|
| noop | 73.8 | 51.2 | 71.1 | 77.3 | 77.8 | 100.0 | 81.7 | 5 |
| finance_greedy | 75.6 | 47.1 | 81.7 | 79.5 | 78.1 | 100.0 | 81.8 | 0 |
| rule_council | 79.5 | 59.5 | 92.6 | 76.5 | 77.0 | 100.0 | 81.3 | 0 |

## Per-episode results

| scenario | seed | agent | final pop | final treasury | final debt | composite | illegal rate | ms |
|---|---|---|---|---|---|---|---|---|
| starter_town | 101 | noop | 1155 | 20143 | 0 | 83.0 | 0.000 | 14060 |
| starter_town | 101 | finance_greedy | 1155 | 20143 | 0 | 83.0 | 0.000 | 12734 |
| starter_town | 101 | rule_council | 1584 | 10059 | 0 | 81.0 | 0.000 | 12516 |
| starter_town | 102 | noop | 1155 | 17658 | 0 | 83.0 | 0.000 | 12156 |
| starter_town | 102 | finance_greedy | 1155 | 17658 | 0 | 83.0 | 0.000 | 12252 |
| starter_town | 102 | rule_council | 1584 | 83627 | 0 | 84.5 | 0.000 | 12285 |
| starter_town | 103 | noop | 1155 | 21380 | 0 | 83.0 | 0.000 | 12366 |
| starter_town | 103 | finance_greedy | 1155 | 21380 | 0 | 83.0 | 0.000 | 12232 |
| starter_town | 103 | rule_council | 1584 | 10045 | 0 | 81.0 | 0.000 | 12493 |
| starter_town | 104 | noop | 1155 | 22898 | 0 | 83.0 | 0.000 | 12153 |
| starter_town | 104 | finance_greedy | 1155 | 22898 | 0 | 83.0 | 0.000 | 12185 |
| starter_town | 104 | rule_council | 1584 | 15295 | 0 | 84.5 | 0.000 | 12459 |
| starter_town | 105 | noop | 1155 | 17291 | 0 | 83.0 | 0.000 | 12052 |
| starter_town | 105 | finance_greedy | 1155 | 17291 | 0 | 83.0 | 0.000 | 12046 |
| starter_town | 105 | rule_council | 1584 | 174753 | 0 | 84.3 | 0.000 | 12472 |
| water_industry | 101 | noop | 2113 | 81581 | 0 | 79.0 | 0.000 | 12949 |
| water_industry | 101 | finance_greedy | 2113 | 1644 | 0 | 69.9 | 0.000 | 12927 |
| water_industry | 101 | rule_council | 2305 | 67626 | 0 | 80.1 | 0.000 | 13130 |
| water_industry | 102 | noop | 2113 | 83217 | 0 | 79.5 | 0.000 | 13001 |
| water_industry | 102 | finance_greedy | 2062 | 22725 | 0 | 79.5 | 0.000 | 12870 |
| water_industry | 102 | rule_council | 2305 | 71449 | 0 | 80.6 | 0.000 | 13197 |
| water_industry | 103 | noop | 2113 | 81114 | 0 | 79.0 | 0.000 | 12922 |
| water_industry | 103 | finance_greedy | 2087 | 2338 | 0 | 70.3 | 0.000 | 12853 |
| water_industry | 103 | rule_council | 2305 | 38229 | 0 | 81.7 | 0.000 | 13195 |
| water_industry | 104 | noop | 2113 | 81112 | 0 | 78.9 | 0.000 | 13091 |
| water_industry | 104 | finance_greedy | 2113 | 888 | 0 | 69.2 | 0.000 | 12840 |
| water_industry | 104 | rule_council | 2305 | 2138 | 0 | 71.2 | 0.000 | 13164 |
| water_industry | 105 | noop | 2113 | 83146 | 0 | 79.2 | 0.000 | 12995 |
| water_industry | 105 | finance_greedy | 2062 | 23407 | 0 | 79.3 | 0.000 | 12874 |
| water_industry | 105 | rule_council | 2305 | 69928 | 0 | 80.3 | 0.000 | 13094 |
| declining_finance | 101 | noop | 2052 | -3831 | 8000 | 59.0 | 0.000 | 4008 |
| declining_finance | 101 | finance_greedy | 1589 | 402313 | 8000 | 70.0 | 0.000 | 12820 |
| declining_finance | 101 | rule_council | 2050 | 13576 | 5061 | 72.0 | 0.000 | 13021 |
| declining_finance | 102 | noop | 2051 | -3616 | 8000 | 59.7 | 0.000 | 4234 |
| declining_finance | 102 | finance_greedy | 1589 | 405948 | 8000 | 70.5 | 0.000 | 12713 |
| declining_finance | 102 | rule_council | 2050 | 14687 | 0 | 76.7 | 0.000 | 13129 |
| declining_finance | 103 | noop | 2051 | -3727 | 8000 | 59.5 | 0.000 | 4250 |
| declining_finance | 103 | finance_greedy | 1589 | 404651 | 8000 | 70.3 | 0.000 | 12686 |
| declining_finance | 103 | rule_council | 3032 | 14783 | 0 | 79.0 | 0.000 | 13035 |
| declining_finance | 104 | noop | 2051 | -3755 | 8000 | 59.3 | 0.000 | 4045 |
| declining_finance | 104 | finance_greedy | 1589 | 405821 | 8000 | 70.2 | 0.000 | 12800 |
| declining_finance | 104 | rule_council | 2761 | 14227 | 0 | 77.7 | 0.000 | 13242 |
| declining_finance | 105 | noop | 2051 | -3794 | 8000 | 59.4 | 0.000 | 4114 |
| declining_finance | 105 | finance_greedy | 1589 | 406787 | 8000 | 70.3 | 0.000 | 12744 |
| declining_finance | 105 | rule_council | 2761 | 13691 | 0 | 77.4 | 0.000 | 12889 |
