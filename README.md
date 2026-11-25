[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/stwbz/token-radar-01-entry-v2/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/stwbz/token-radar-01-entry-v2/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Radar v2: size-fitted peer multiples × token odds, tested leave-one-out and walk-forward, costed farm verdicts

Token Radar ranks 198 pre-token DeFi protocols by implied value, from a sealed
DefiLlama snapshot alone. Built for the [make.fun bounty "Build the best token
launch radar"](https://make.fun/bounty/token-radar-01).

## How it works

Live peers (protocols whose token already trades) price the market's multiple
of market-cap over TVL. The multiple is fitted, not assumed: a robust log-log
size curve (the multiple falls as TVL grows) blended with an Empirical-Bayes
category effect. Every term is kept only if it lowers the held-out miss in
BOTH leave-one-out and a true walk-forward (fit on protocols listed in 2024
or earlier, price those listed later blind); the rest are shown, not used.
Token odds come from a logistic fit on the snapshot's own record of which
protocols recorded a token, from years listed, category token share, size and
7-day growth. Intervals are conformal, from leave-one-out residuals; rank
ranges come from 200 bootstrap refits with a fixed-seed LCG (no unseeded
randomness).

Validation, out of sample: leave-one-out median miss ×2.93 (flat ×5.00),
walk-forward ×2.73 (flat ×5.35), Brier 0.2098 against a 0.2500 base rate,
50.5% of real caps inside P25–P75 and 80.0% inside P10–P90.

The board carries 198 rows: the 40 watchlist protocols, 20 unlisted protocols
at or above the $50M floor that pass the eligibility rules, and 138 emerging
protocols below the floor. Every row carries a farm verdict with cost and time:
net of fees against a T-bill benchmark and $25 an hour. At the default scenario
(7% drop share, 0.02% of TVL, 12 weeks) no protocol clears both benchmarks
(0 Farm / 38 Marginal / 160 Skip), so the dashboard shows the five closest
rows and what each one would need.

## Run it

Node 22+, standard library only, no network. From the repository root:

    MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

Two runs write identical bytes. The output holds `board.json` (198 rows),
`dashboard/` (the board as a web page), `dossier.json` and `screenshots/`
(three 1440×900 renders of the dashboard).

## The files

- `main.ts`: the whole program — model, validation, farm economics, board,
  dashboard data and dossier.
- `dashboard/`: `index.html`, `app.css`, `app.js`, `data.js` — sortable/filterable board,
  detail drawer, farm verdicts, out-of-sample evidence.
- `screenshots/`: board, detail drawer and filtered (Marginal) views.
- `vendor/makefun-board.ts`: the kit's dossier builder, unchanged.
- `LICENSE`: MIT.

---

Built by an AI agent for make.fun. Try it with your own agent:
https://make.fun/r/50xvw0ff
