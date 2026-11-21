// gta6-trophy-rarity-forecast-01: a data-driven forecaster. For every trophy it reads the earn
// rates' own history and fits what that trophy is actually doing — a weighted logit trend, a
// volatility estimated from the trophy's own recent increments (pooled with its tier neighbours
// when the trophy's own record is thin), and a damped extrapolation to the target — instead of
// assuming one fixed random-walk spread for every trophy as the house baseline does.
//
//   median  = 100 / (1 + exp(-(logit(r_last) + slope_hat * horizon * DAMPING)))
//   q_tau   = 100 / (1 + exp(-(logit_median + z_tau * sigma_hat * sqrt(horizon_days))))
//
// Everything is estimated inside the case: no constants tuned on any future data, no network.
// It runs offline on Node 22 with the standard library only.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** The trend's damping by horizon: short horizons carry most of the fitted slope, long ones bend
 *  harder toward saturation because an earn-rate curve flattens as the player pool's progress
 *  front moves past a chapter. Interpolated in log space between the two anchors. */
function dampingFor(horizonMinutes: number): number {
  const short = 90;
  const long = 1440 * 4.5;
  const x = Math.min(1, Math.max(0, Math.log(Math.max(short, horizonMinutes) / short) / Math.log(long / short)));
  return 0.75 + (0.5 - 0.75) * x;
}

/** The window of recent reads the trend and the volatility are fitted on. */
const TREND_WINDOW = 24;
/** The floor and the ceiling of the pooled volatility, in logit units per square-root day. */
const SIGMA_FLOOR = 0.12;
const SIGMA_CAP = 2.5;
/** How much of the pooled house spread stays in the mix even when the data speaks. */
const PRIOR_SIGMA = 0.5;
const PRIOR_WEIGHT = 0.35;

interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  trophies: Array<{ id: number; tier: string; secret: boolean; description: string | null }>;
  history: Array<{ at: string; rates: Array<number | null> }>;
}

const clamp = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clamp(pct) / (100 - clamp(pct)));
const expit = (x: number): number => 100 / (1 + Math.exp(-x));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** The minutes between two ISO stamps, floored at zero. */
function minutesBetween(a: string, b: string): number {
  const d = (Date.parse(b) - Date.parse(a)) / 60_000;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** One trophy's read series: timestamps in minutes since the first read, with its logit rate. */
interface Series {
  t: number[];
  y: number[];
}

function seriesOf(c: Case, index: number): Series {
  const t: number[] = [];
  const y: number[] = [];
  for (const read of c.history) {
    const rate = read.rates[index];
    if (rate === null || rate === undefined) continue;
    t.push(minutesBetween(c.history[0]!.at, read.at));
    y.push(logit(rate));
  }
  return { t, y };
}

/** Weighted least squares on the last WINDOW points: slope in logit units per minute and the
 *  residual standard deviation around that line. Weights decay with a half-life of half the span. */
function fitTrend(s: Series, window: number): { slope: number; resid: number; used: number } {
  const n = s.t.length;
  if (n < 3) return { slope: 0, resid: -1, used: n };
  const start = Math.max(0, n - window);
  const t0 = s.t[start]!;
  const t = s.t.slice(start).map((v) => v - t0);
  const y = s.y.slice(start);
  const span = Math.max(1, t[t.length - 1]!);
  const halfLife = Math.max(1, span / 2);
  let wsum = 0, wt = 0, wy = 0, wtt = 0, wty = 0;
  for (let i = 0; i < t.length; i++) {
    const w = Math.pow(0.5, (span - t[i]!) / halfLife);
    wsum += w; wt += w * t[i]!; wy += w * y[i]!; wtt += w * t[i]! * t[i]!; wty += w * t[i]! * y[i]!;
  }
  const denom = wsum * wtt - wt * wt;
  const slope = Math.abs(denom) < 1e-9 ? 0 : (wsum * wty - wt * wy) / denom;
  let sse = 0;
  for (let i = 0; i < t.length; i++) {
    const pred = slope * t[i]!;
    sse += Math.pow(y[i]! - pred, 2);
  }
  const resid = Math.sqrt(sse / Math.max(1, t.length - 2));
  return { slope, resid, used: t.length };
}

/** The pooled volatility, in logit units per square-root day, over a group of trophies. */
function pooledSigma(series: Series[], horizonMinutes: number): number {
  const vars: number[] = [];
  for (const s of series) {
    const fit = fitTrend(s, TREND_WINDOW);
    if (fit.resid < 0 || fit.used < 4) continue;
    const span = Math.max(1, s.t[s.t.length - 1]! - s.t[Math.max(0, s.t.length - TREND_WINDOW)]!);
    const perSqrtDay = fit.resid / Math.sqrt(Math.max(1 / 1440, span / 1440));
    if (Number.isFinite(perSqrtDay) && perSqrtDay > 0) vars.push(perSqrtDay * perSqrtDay);
  }
  if (vars.length === 0) return PRIOR_SIGMA;
  vars.sort((a, b) => a - b);
  const median = vars[Math.floor(vars.length / 2)]!;
  const sigma = Math.sqrt(median);
  return Math.min(SIGMA_CAP, Math.max(SIGMA_FLOOR, sigma));
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  const last = c.history[c.history.length - 1];
  if (last === undefined) throw new Error(`${file} has no history`);
  const horizonDays = c.horizon_minutes / 1440;

  // The pooled volatilities: line chapters together (they share the players' progress curve),
  // then tiers, so a trophy with a thin record borrows strength from its neighbours.
  const chapters = c.trophies.map((t, i) => ({ t, i }))
    .filter(({ t }) => t.tier === 'platinum' || (t.secret && /Complete (Chapter|Side Story|Collection)/i.test(t.description ?? '')));
  const chapterSigma = pooledSigma(chapters.map(({ i }) => seriesOf(c, i)), c.horizon_minutes);
  const byTier = new Map<string, number[]>();
  c.trophies.forEach((t, i) => {
    const list = byTier.get(t.tier) ?? [];
    list.push(i);
    byTier.set(t.tier, list);
  });
  const tierSigma = new Map<string, number>();
  for (const [tier, list] of byTier) tierSigma.set(tier, pooledSigma(list.map((i) => seriesOf(c, i)), c.horizon_minutes));

  const trophies = c.trophies.map((t, i) => {
    const s = seriesOf(c, i);
    // Three windows on the same series: the last few reads carry the freshest momentum, the medium
    // one the day-scale drift, the whole record the average since launch. Their blend is the slope.
    const short = fitTrend(s, Math.min(s.t.length, 6));
    const medium = fitTrend(s, Math.min(s.t.length, TREND_WINDOW));
    const whole = fitTrend(s, s.t.length);
    let slope = short.slope * 0.5 + medium.slope * 0.3 + whole.slope * 0.2;
    if (!Number.isFinite(slope)) slope = 0;
    const isChapter = chapters.some(({ i: ci }) => ci === i);
    const logitLast = logit(last.rates[i] ?? 0);
    const medianLogit = logitLast + slope * c.horizon_minutes * dampingFor(c.horizon_minutes);
    // The spread: the trophy's own pooled group volatility, blended with the house's prior so a
    // quiet window never produces an overconfident band.
    const sigmaData = isChapter ? chapterSigma : tierSigma.get(t.tier) ?? PRIOR_SIGMA;
    const sigma = Math.sqrt((1 - PRIOR_WEIGHT) * sigmaData * sigmaData + PRIOR_WEIGHT * PRIOR_SIGMA * PRIOR_SIGMA) * Math.sqrt(horizonDays);
    const q = LEVELS.map((_, j) => {
      let v = expit(medianLogit + Z[j]! * sigma);
      // A rate already at the rails can only move inward: keep the band honest on that side.
      if (clamp(last.rates[i] ?? 0) >= 99.99 && v > 99.99) v = 99.99;
      if (clamp(last.rates[i] ?? 0) <= 0.01 && v < 0.01) v = 0.01;
      return round4(v);
    });
    for (let j = 1; j < q.length; j++) if (q[j]! < q[j - 1]!) q[j] = q[j - 1]!;
    return { id: t.id, q };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
