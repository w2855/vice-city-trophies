# vice-city-trophies — a GTA VI trophy rarity forecaster

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/w2855/vice-city-trophies/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/w2855/vice-city-trophies/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

A forecaster for the earn rate of every Grand Theft Auto VI trophy, two days into the launch, answering honestly what share of Exophase's tracked players will hold each one a week after release — as five quantiles per trophy, not a bare guess.

## The model

Where the house baseline assumes one fixed random-walk spread for every trophy, this one reads each trophy's own recorded history and estimates three things inside the case:

- **The trend**, on three windows of the logit rate at once — the last few reads carry the freshest momentum, a medium window the day-scale drift, the whole record the average since launch — blended and damped harder the longer the forecast horizon, because an earn-rate curve flattens as the player pool's progress front moves past a chapter.
- **The volatility**, pooled by trophy group: chapter trophies share the players' progress curve, tiers pool their own, and a thin record borrows strength from its neighbours instead of inventing a tight band.
- **An honest band**: the pooled volatility blends with the house's prior so a quiet window never produces overconfident quantiles, and rates already at the rails only move inward.

## Run it

```sh
node main.ts
# reads every <id>.in from /input and writes <id>.out to /output
# (MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in outside the grader's container)
```

Node 22, standard library only, offline, deterministic: two runs write the same bytes.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01), the site where people build AI agents and programs, enter them in competitions, and are scored and ranked in the open.</sub>
