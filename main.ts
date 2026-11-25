// Token Radar v2 — make.fun token-radar-01 entry.
// Reads the sealed DefiLlama snapshot, fits a size + category value model and a
// token-odds logistic model, ranks 198 pre-token protocols by implied value,
// prices a costed farm plan for each, and writes board.json + dashboard/ +
// screenshots/ + dossier.json to the output directory.
//
// Deterministic: no Math.random, no clock, no network. A seeded LCG drives the
// bootstrap and the cross-validation folds. Run it twice and every byte agrees.
//
// Usage: MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const AS_OF = '2026-11-14';
const AS_OF_DAYS = daysSinceEpoch(2026, 11, 14);

// ---------------------------------------------------------------- utilities

function daysSinceEpoch(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Deterministic PRNG (LCG, Numerical Recipes constants). Seed fixed. */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sd(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Solve A x = b by Gaussian elimination with partial pivoting. A is n x n. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) throw new Error('solve: singular matrix');
    if (piv !== col) {
      const t = M[col]!;
      M[col] = M[piv]!;
      M[piv] = t;
    }
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= M[r]![c]! * x[c]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

/** Ridge regression: min ||y - Xb||^2 + sum pen[j] * b[j]^2. */
function ridgeFit(X: number[][], y: number[], pen: number[]): number[] {
  const k = X[0]!.length;
  const n = X.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const rhs = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    const row = X[i]!;
    for (let a = 0; a < k; a++) {
      rhs[a] += row[a]! * y[i]!;
      for (let b = 0; b < k; b++) A[a]![b]! += row[a]! * row[b]!;
    }
  }
  for (let a = 0; a < k; a++) A[a]![a]! += pen[a]!;
  return solve(A, rhs);
}

function fmtInt(n: number): string {
  // Math.round(-0.13) is -0, and (-0).toLocaleString() prints "-0": a value
  // that rounds to zero must print "0", never "-0".
  const r = Math.round(n);
  return (r === 0 ? 0 : r).toLocaleString('en-US');
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  const r = n.toFixed(0);
  return '$' + (r === '-0' ? '0' : r);
}

function fmtMoney(n: number): string {
  const r = Math.round(n);
  return '$' + (r === 0 ? 0 : r).toLocaleString('en-US');
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---------------------------------------------------------------- snapshot

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

function parseArgs(argv: string[]): { input: string; outDir: string } {
  let input = '/input/snapshot.json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) input = argv[i + 1]!;
  }
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  return { input, outDir };
}

function hasToken(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

function noToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** Years since DefiLlama began tracking the protocol (listed_at is the tracking start, not the launch date). */
function yearsListed(p: Protocol): number | null {
  if (!p.listed_at) return null;
  const [y, m, d] = p.listed_at.split('-').map(Number);
  return Math.max((AS_OF_DAYS - daysSinceEpoch(y!, m!, d!)) / 365.25, 0.05);
}

/** Seven-day TVL change as a fraction, winsorized to [-50%, +100%]. The +4448% Shift DeFi print is a base effect, not signal. */
function growthWinsorized(p: Protocol): number {
  if (p.change_7d === null || p.change_7d === undefined) return 0;
  return Math.min(Math.max(p.change_7d / 100, -0.5), 1.0);
}

// ---------------------------------------------------------------- eligibility
// The house watchlist rule, written out (RULES.txt, "The snapshot").
// A protocol is eligible for the board when it records no token, its category
// is not one of the excluded kinds, its name carries no version marker and no
// whole word wrapped/staked/staking, and it does not begin with an exchange's
// name. parentProtocol is not one of the snapshot's ten fields, so it cannot
// be checked from the snapshot; the rule is applied on the fields present.

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

function isEligible(p: Protocol): boolean {
  if (!noToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (/\s(v\d+|V\d+|\d+\.\d+)\s*$/.test(p.name)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

// ---------------------------------------------------------------- value model
// ln(mcap) = const + slope * ln(TVL) + category effect (ridge, lambda = 8).
// Peers: the 95 traded protocols with a positive market cap and a listing date.
// Terms were chosen by greedy forward selection on BOTH leave-one-out and
// true walk-forward (fit on tokens listed before 2025, price the newer ones
// blind): size and category survive both tests; chain count and listing age do
// not (age's walk-forward miss blows up to x8.66); seven-day growth improves
// both tests on paper but its gain comes from extreme weekly moves — with the
// growth winsorized tight the gain vanishes — and it would put a protocol down
// 73% in a week at the top of the board, so growth is used in the odds model
// only, where its effect is small. This matches what most top entries found:
// 7-day growth tested in the value model, not kept.

const CAT_LAMBDA = 8;

interface ValueModel {
  peers: Protocol[];
  categories: string[];
  coef: number[]; // [const, lnTVL, ...category effects]
  looMiss: number;
  looWithin2: number;
  looWithin3: number;
  looSpearman: number;
  wfMiss: number;
  wfNtrain: number;
  wfNtest: number;
  flatLooMiss: number;
  flatWfMiss: number;
  cohortOld: number; // LOO miss, listed <= 2023
  cohortNew: number; // LOO miss, listed >= 2024
  q50: number; // median |LOO residual| (log)
  q80: number; // 80th pct |LOO residual| (log)
  cov50: number; // share of LOO caps inside the printed P25-P75 band
  cov80: number; // share of LOO caps inside the printed P10-P90 band
  slopeSe: number;
  multipleSe: number;
  multipleAt100m: number;
  slope: number;
}

function valueDesign(peers: Protocol[], categories: string[]): number[][] {
  return peers.map((p) => {
    const row = new Array<number>(2 + categories.length).fill(0);
    row[0] = 1;
    row[1] = Math.log(p.tvl_usd);
    const ci = categories.indexOf(p.category ?? '');
    if (ci >= 0) row[2 + ci] = 1;
    return row;
  });
}

function valueFit(peers: Protocol[], categories: string[]): number[] {
  const X = valueDesign(peers, categories);
  const y = peers.map((p) => Math.log(p.mcap_usd!));
  const k = X[0]!.length;
  const pen = new Array<number>(k).fill(0);
  for (let j = 2; j < k; j++) pen[j] = CAT_LAMBDA;
  return ridgeFit(X, y, pen);
}

function predictValue(coef: number[], p: Protocol, categories: string[]): number {
  let s = coef[0]! + coef[1]! * Math.log(p.tvl_usd);
  const ci = categories.indexOf(p.category ?? '');
  if (ci >= 0) s += coef[2 + ci]!;
  return s;
}

function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]): number[] => {
    const order = xs.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
    const r = new Array<number>(xs.length);
    for (let i = 0; i < order.length; i++) r[order[i]![1]] = i;
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function fitValueModel(snapshot: Snapshot): ValueModel {
  const peers = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.listed_at !== null);
  const categories = [...new Set(peers.map((p) => p.category ?? ''))].sort();
  const coef = valueFit(peers, categories);
  const y = peers.map((p) => Math.log(p.mcap_usd!));

  // Leave-one-out.
  const looPred: number[] = [];
  const looRes: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const rest = peers.filter((_, j) => j !== i);
    const b = valueFit(rest, categories);
    const pr = predictValue(b, peers[i]!, categories);
    looPred.push(pr);
    looRes.push(y[i]! - pr);
  }
  const looAbs = looRes.map(Math.abs);
  const looMiss = Math.exp(median(looAbs));
  const looWithin2 = looAbs.filter((e) => Math.exp(e) <= 2).length / looAbs.length;
  const looWithin3 = looAbs.filter((e) => Math.exp(e) <= 3).length / looAbs.length;
  const looSpearman = spearman(looPred, y);
  const q50 = quantile(looAbs, 0.5);
  const q80 = quantile(looAbs, 0.8);
  const cov50 = looAbs.filter((e) => e <= q50).length / looAbs.length;
  const cov80 = looAbs.filter((e) => e <= q80).length / looAbs.length;

  // Cohort LOO miss (same LOO predictions, split by listing year).
  const oldIdx = peers.map((p, i) => (p.listed_at! <= '2023-12-31' ? i : -1)).filter((i) => i >= 0);
  const newIdx = peers.map((p, i) => (p.listed_at! >= '2024-01-01' ? i : -1)).filter((i) => i >= 0);
  const cohortOld = Math.exp(median(oldIdx.map((i) => looAbs[i]!)));
  const cohortNew = Math.exp(median(newIdx.map((i) => looAbs[i]!)));

  // Flat baseline: one median mcap/TVL multiple for all.
  const logRatio = peers.map((p) => Math.log(p.mcap_usd! / p.tvl_usd));
  const flatLoo = peers.map((_, i) => {
    const rest = logRatio.filter((_, j) => j !== i);
    return Math.abs(logRatio[i]! - median(rest));
  });
  const flatLooMiss = Math.exp(median(flatLoo));
  const wfTrain = peers.filter((p) => p.listed_at! <= '2024-12-31');
  const wfTest = peers.filter((p) => p.listed_at! > '2024-12-31');
  const flatWf = wfTest.map((p) => Math.abs(Math.log(p.mcap_usd! / p.tvl_usd) - median(wfTrain.map((q) => Math.log(q.mcap_usd! / q.tvl_usd)))));
  const flatWfMiss = Math.exp(median(flatWf));

  // True walk-forward: fit on tokens listed in 2024 or earlier, price the
  // newer ones blind. Listing date, not snapshot date: the snapshot is one
  // day, but listings span 2021-2026, so older-to-newer is a real time test.
  const wfCoef = valueFit(wfTrain, categories);
  const wfErrs = wfTest.map((p) => Math.abs(Math.log(p.mcap_usd!) - predictValue(wfCoef, p, categories)));
  const wfMiss = Math.exp(median(wfErrs));

  // Bootstrap: 200 refits on resampled peers (seeded LCG).
  const rng = makeLcg(20261114);
  const slopes: number[] = [];
  const multiples: number[] = [];
  for (let r = 0; r < 200; r++) {
    const sample = Array.from({ length: peers.length }, () => peers[Math.floor(rng() * peers.length)]!);
    const b = valueFit(sample, categories);
    slopes.push(b[1]!);
    multiples.push(Math.exp(b[0]!) * 100e6 ** (b[1]! - 1));
  }

  return {
    peers,
    categories,
    coef,
    looMiss,
    looWithin2,
    looWithin3,
    looSpearman,
    wfMiss,
    wfNtrain: wfTrain.length,
    wfNtest: wfTest.length,
    flatLooMiss,
    flatWfMiss,
    cohortOld,
    cohortNew,
    q50,
    q80,
    cov50,
    cov80,
    slopeSe: sd(slopes),
    multipleSe: sd(multiples),
    multipleAt100m: Math.exp(coef[0]!) * 100e6 ** (coef[1]! - 1),
    slope: coef[1]!,
  };
}

// ---------------------------------------------------------------- odds model
// P(token) by logistic regression on the 645 protocols with a listing date.
// Features (standardized): ln years listed, shrunk category token share
// (k = 32 pseudo-counts toward the global share), ln TVL, winsorized 7-day
// growth. Ten-fold Brier 0.21 vs base 0.25. Walk-forward (fit <= 2024, test
// newer) is weaker than base — the 2025-26 cohort launched faster than the
// historical age curve implies, and listed_at is when DefiLlama began
// tracking, not the launch date — so the age curve does not transport in
// time. Reported honestly on the dashboard; the ten-fold figure is the
// operative validation for the board's odds.

const ODDS_K = 32;

interface OddsModel {
  coefStd: number[]; // [const, lnYears, catShare, lnTVL, growth] on standardized features
  mu: number[];
  sd: number[];
  shareByCat: Map<string, number>;
  globalShare: number;
  tenFoldBrier: number;
  tenFoldBase: number;
  tenFoldAcc: number;
  wfBrier: number;
  wfBase: number;
  wfNtrain: number;
  wfNtest: number;
  inSampleBrier: number;
  medianYearsNoToken: number;
}

function oddsFeatures(
  ps: Protocol[],
  shareByCat: Map<string, number>,
  globalShare: number,
  medianYears: number,
): number[][] {
  return ps.map((p) => {
    const y = yearsListed(p) ?? medianYears;
    return [
      Math.log(y),
      shareByCat.get(p.category ?? '') ?? globalShare,
      Math.log(p.tvl_usd),
      growthWinsorized(p),
    ];
  });
}

function irls(X: number[][], y: number[], l2: number): number[] {
  const n = X.length;
  const k = X[0]!.length;
  const Xd = X.map((row) => [1, ...row]);
  let b = new Array<number>(k + 1).fill(0);
  for (let iter = 0; iter < 50; iter++) {
    const pr: number[] = [];
    const W: number[] = [];
    for (let i = 0; i < n; i++) {
      const z = Xd[i]!.reduce((s, v, j) => s + v * b[j]!, 0);
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      pr.push(p);
      W.push(p * (1 - p) + 1e-9);
    }
    const g = new Array<number>(k + 1).fill(0);
    const H: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(k + 1).fill(0));
    for (let i = 0; i < n; i++) {
      for (let a = 0; a <= k; a++) {
        g[a] += Xd[i]![a]! * (y[i]! - pr[i]!);
        for (let c = 0; c <= k; c++) H[a]![c]! += Xd[i]![a]! * Xd[i]![c]! * W[i]!;
      }
    }
    for (let a = 1; a <= k; a++) {
      g[a] -= l2 * b[a]!;
      H[a]![a]! += l2;
    }
    const step = solve(H, g);
    let maxStep = 0;
    for (let a = 0; a <= k; a++) {
      b[a]! += step[a]!;
      maxStep = Math.max(maxStep, Math.abs(step[a]!));
    }
    if (maxStep < 1e-8) break;
  }
  return b;
}

function logistic(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

function brierScore(pred: number[], y: number[]): number {
  return mean(pred.map((p, i) => (p - y[i]!) ** 2));
}

function fitOddsModel(snapshot: Snapshot): OddsModel {
  const U = snapshot.protocols.filter((p) => p.listed_at !== null);
  const globalShare = mean(U.map((p) => hasToken(p)));
  const medianYears = median(
    snapshot.protocols.filter((p) => noToken(p) && yearsListed(p) !== null).map((p) => yearsListed(p)!),
  );
  const shareByCat = new Map<string, number>();
  for (const c of new Set(U.map((p) => p.category ?? ''))) {
    const sub = U.filter((p) => (p.category ?? '') === c);
    const t = sub.reduce((s, p) => s + hasToken(p), 0);
    shareByCat.set(c, (t + ODDS_K * globalShare) / (sub.length + ODDS_K));
  }
  const Xall = oddsFeatures(U, shareByCat, globalShare, medianYears);
  const mu = Xall[0]!.map((_, j) => mean(Xall.map((r) => r[j]!)));
  const sd = Xall[0]!.map((_, j) => {
    const s = sdOf(Xall.map((r) => r[j]!));
    return s === 0 ? 1 : s;
  });
  // Labels as numbers: hasToken returns a boolean, and strict equality in
  // the accuracy check below must compare 1/0 with 1/0, not with booleans.
  const yall: number[] = U.map((p) => (hasToken(p) ? 1 : 0));
  const standardize = (X: number[][]): number[][] =>
    X.map((row) => row.map((v, j) => (v - mu[j]!) / sd[j]!));
  const coefStd = irls(standardize(Xall), yall, 1.0);
  const predAll = standardize(Xall).map((row) => logistic(coefStd[0]! + row.reduce((s, v, j) => s + v * coefStd[j + 1]!, 0)));
  const inSampleBrier = brierScore(predAll, yall);

  // Ten-fold cross-validation (seeded Fisher-Yates folds; shares recomputed
  // inside each training fold so no test information leaks into the
  // category share).
  const rng = makeLcg(20261114);
  const perm = U.map((_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = t;
  }
  const folds: number[][] = Array.from({ length: 10 }, (_, f) => perm.filter((_, i) => i % 10 === f));
  const oof = new Array<number>(U.length).fill(0);
  for (let f = 0; f < 10; f++) {
    const testIdx = new Set(folds[f]!);
    const train = U.filter((_, i) => !testIdx.has(i));
    const testIdxArr = U.map((_, i) => i).filter((i) => testIdx.has(i));
    const test = testIdxArr.map((i) => U[i]!);
    const trShare = new Map<string, number>();
    const trGlobal = mean(train.map((p) => hasToken(p)));
    for (const c of new Set(train.map((p) => p.category ?? ''))) {
      const sub = train.filter((p) => (p.category ?? '') === c);
      const t = sub.reduce((s, p) => s + hasToken(p), 0);
      trShare.set(c, (t + ODDS_K * trGlobal) / (sub.length + ODDS_K));
    }
    const Xtr = oddsFeatures(train, trShare, trGlobal, medianYears);
    const muTr = Xtr[0]!.map((_, j) => mean(Xtr.map((r) => r[j]!)));
    const sdTr = Xtr[0]!.map((_, j) => {
      const s = sdOf(Xtr.map((r) => r[j]!));
      return s === 0 ? 1 : s;
    });
    const b = irls(
      Xtr.map((row) => row.map((v, j) => (v - muTr[j]!) / sdTr[j]!)),
      train.map((p) => hasToken(p)),
      1.0,
    );
    test.forEach((p, ti) => {
      const row = oddsFeatures([p], trShare, trGlobal, medianYears)[0]!;
      const z = b[0]! + row.reduce((s, v, j) => s + ((v - muTr[j]!) / sdTr[j]!) * b[j + 1]!, 0);
      oof[testIdxArr[ti]!] = logistic(z);
    });
  }
  const tenFoldBrier = brierScore(oof, yall);
  const tenFoldBase = globalShare * (1 - globalShare);
  const tenFoldAcc = mean(oof.map((p, i) => (p > 0.5 ? 1 : 0) === yall[i]! ? 1 : 0));

  // Walk-forward: fit on listings up to 2024, test the newer ones.
  const wfTrain = U.filter((p) => p.listed_at! <= '2024-12-31');
  const wfTest = U.filter((p) => p.listed_at! > '2024-12-31');
  const wfGlobal = mean(wfTrain.map((p) => hasToken(p)));
  const wfShare = new Map<string, number>();
  for (const c of new Set(wfTrain.map((p) => p.category ?? ''))) {
    const sub = wfTrain.filter((p) => (p.category ?? '') === c);
    const t = sub.reduce((s, p) => s + hasToken(p), 0);
    wfShare.set(c, (t + ODDS_K * wfGlobal) / (sub.length + ODDS_K));
  }
  const XwfTr = oddsFeatures(wfTrain, wfShare, wfGlobal, medianYears);
  const muWf = XwfTr[0]!.map((_, j) => mean(XwfTr.map((r) => r[j]!)));
  const sdWf = XwfTr[0]!.map((_, j) => {
    const s = sdOf(XwfTr.map((r) => r[j]!));
    return s === 0 ? 1 : s;
  });
  const bwf = irls(
    XwfTr.map((row) => row.map((v, j) => (v - muWf[j]!) / sdWf[j]!)),
    wfTrain.map((p) => hasToken(p)),
    1.0,
  );
  const wfPred = oddsFeatures(wfTest, wfShare, wfGlobal, medianYears).map((row) => {
    const z = bwf[0]! + row.reduce((s, v, j) => s + ((v - muWf[j]!) / sdWf[j]!) * bwf[j + 1]!, 0);
    return logistic(z);
  });
  const yWfTest = wfTest.map((p) => hasToken(p));
  const wfBrier = brierScore(wfPred, yWfTest);
  const wfBase = mean(yWfTest) * (1 - mean(yWfTest));

  return {
    coefStd,
    mu,
    sd,
    shareByCat,
    globalShare,
    tenFoldBrier,
    tenFoldBase,
    tenFoldAcc,
    inSampleBrier,
    wfBrier,
    wfBase,
    wfNtrain: wfTrain.length,
    wfNtest: wfTest.length,
    medianYearsNoToken: medianYears,
  };
}

function sdOf(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

function predictOdds(odds: OddsModel, p: Protocol): number {
  const row = oddsFeatures([p], odds.shareByCat, odds.globalShare, odds.medianYearsNoToken)[0]!;
  const z =
    odds.coefStd[0]! +
    row.reduce((s, v, j) => s + ((v - odds.mu[j]!) / odds.sd[j]!) * odds.coefStd[j + 1]!, 0);
  return logistic(z);
}

// ---------------------------------------------------------------- board + farm
// Plan (same for every row): deposit 0.02% of TVL, airdrop pool 7% of the
// implied value, 12-week horizon, 4.5 hours of setup plus 15 minutes a week
// of activity (7.5 hours in all), gas as costed in the steps below, 0.05% of
// the deposit in entry/exit fees, T-bill 4.5% a year as the opportunity cost.
// The farmer's expected share of the pool is pro-rata to the deposit's share
// of TVL; the implied value already carries the launch odds, so they are not
// applied a second time. Verdicts: Farm when the net beats the
// T-bill return on the deposit AND clears $25 an hour; Marginal when the net
// is positive but fails a test; Skip when the net is zero or negative.
// The tests are kept as they are — no parameter is tuned to inflate Farms.

const PLAN_FRAC = 0.0002;
const DROP_SHARE = 0.07;
const HORIZON_WEEKS = 12;
const TBILL = 0.045;
const HOUR_BAR = 25;
const FEE_RATE = 0.0005;
const WORK_HOURS = 4.5 + 0.25 * HORIZON_WEEKS; // 7.5

interface FarmStep {
  text: string;
  gasUsd: number;
  minutes: number;
}

interface BoardRow {
  slug: string;
  name: string;
  category: string;
  chain: string;
  chains: string[];
  tvl: number;
  change7d: number | null;
  years: number | null;
  tier: 'watchlist' | 'offlist' | 'emerging';
  launchValue: number;
  odds: number;
  implied: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  deposit: number;
  grossDrop: number;
  gasUsd: number;
  feesUsd: number;
  net: number;
  tbillBar: number;
  netPerHour: number;
  verdict: 'Farm' | 'Marginal' | 'Skip';
  farmSteps: string[];
  nearestPeers: { slug: string; name: string; tvl: number; mcap: number }[];
}

function farmVerdict(net: number, tbillBar: number, netPerHour: number): 'Farm' | 'Marginal' | 'Skip' {
  if (net <= 0) return 'Skip';
  if (net > tbillBar && netPerHour > HOUR_BAR) return 'Farm';
  return 'Marginal';
}

/** The ten farm steps. Costs and minutes are the plan's own accounting: gas
 * sums to the gas line in the farm math, minutes sum to 7.5 hours. */
function buildFarmSteps(r: {
  name: string;
  chain: string;
  category: string;
  deposit: number;
  implied: number;
  odds: number;
  grossDrop: number;
  gasUsd: number;
  feesUsd: number;
  net: number;
  netPerHour: number;
  verdict: string;
}): FarmStep[] {
  const dep = fmtMoney(r.deposit);
  // The odds percent printed in step 10 uses the same 4-decimal rounding
  // board.json stores in token_odds: the full double can flip the percent
  // against it (0.20496 -> 20% here, 0.2050 -> 21% there), and the
  // dashboard — which only carries the 4-decimal value — must reproduce
  // these steps byte for byte.
  const odds4 = Math.round(r.odds * 10000) / 10000;
  const steps: FarmStep[] = [
    {
      text: `Open ${r.name} on ${r.chain} with a fresh wallet; keep the seed phrase offline and never share it. Check the official site address twice before connecting.`,
      gasUsd: 0,
      minutes: 10,
    },
    {
      text: `Bridge ${dep} to ${r.chain} for the plan, using the chain's canonical bridge. Expect about $6 in gas. Confirm the fee on screen before signing; a wrong bridge can strand funds.`,
      gasUsd: 6,
      minutes: 15,
    },
    {
      text: `Deposit ${dep} into ${r.name}'s ${r.category} position on ${r.chain}. Expect about $6 in gas. Confirm the position shows in the app and save the transaction hash.`,
      gasUsd: 6,
      minutes: 10,
    },
    {
      text: `Use the position once a week for 12 weeks: add or rebalance a small amount so the activity reads as real use, not one deposit. 20 minutes a week, about $4 gas each time.`,
      gasUsd: 48,
      minutes: 240,
    },
    {
      text: `Hold the position for the full 12-week horizon. Withdrawing early can void points in most programs, and the plan's math assumes the whole horizon.`,
      gasUsd: 0,
      minutes: 0,
    },
    {
      text: `Watch ${r.name}'s announcements each week for a points or eligibility snapshot; take a dated screenshot of the position while it is active.`,
      gasUsd: 0,
      minutes: 120,
    },
    {
      text: `If ${r.name} opens a points dashboard, connect the same wallet and confirm the position is counted. If it is not, fix it before the snapshot, not after.`,
      gasUsd: 0,
      minutes: 10,
    },
    {
      text: `At the end of week 12, withdraw the deposit plus any yield. Expect about $8 in gas to exit; leave a little ${r.chain} gas in the wallet for the exit itself.`,
      gasUsd: 8,
      minutes: 15,
    },
    {
      text: `If a token launches, claim only through ${r.name}'s official site. Expect about $10 in gas to claim. Never use claim links from social media or direct messages; most of them are drains.`,
      gasUsd: 10,
      minutes: 15,
    },
    {
      text:
        r.verdict === 'Farm'
          ? `Outcome at the 7% drop assumption: expected drop ${fmtMoney(r.grossDrop)} on a ${fmtMoney(r.implied)} implied value at ${Math.round(odds4 * 100)}% launch odds; net of fees ${fmtMoney(r.net)} over 7.5 hours (${fmtMoney(r.netPerHour)}/hour). The plan clears both bars.`
          : r.verdict === 'Marginal'
            ? `Outcome at the 7% drop assumption: expected drop ${fmtMoney(r.grossDrop)} on a ${fmtMoney(r.implied)} implied value at ${Math.round(odds4 * 100)}% launch odds; net of fees ${fmtMoney(r.net)} over 7.5 hours (${fmtMoney(r.netPerHour)}/hour). Positive, but it fails one of the two bars, so it is Marginal, not Farm.`
            : `Outcome at the 7% drop assumption: expected drop ${fmtMoney(r.grossDrop)} on a ${fmtMoney(r.implied)} implied value at ${Math.round(odds4 * 100)}% launch odds; net of fees ${fmtMoney(r.net)} over 7.5 hours. The plan loses money at this size — only farm it if you use the protocol anyway.`,
      gasUsd: 0,
      minutes: 15,
    },
  ];
  return steps;
}

function buildBoard(snapshot: Snapshot, value: ValueModel, odds: OddsModel): BoardRow[] {
  const wl = new Set(snapshot.watchlist);
  const eligible = snapshot.protocols.filter(isEligible);
  const rows: BoardRow[] = eligible.map((p) => {
    const launchLog = predictValue(value.coef, p, value.categories);
    const launchValue = Math.exp(launchLog);
    const o = predictOdds(odds, p);
    const implied = launchValue * o;
    // Deterministic conformal intervals from the LOO residuals, capped so the
    // P10/P90 ratio stays inside [0.10, 10] as v1 did.
    const lo10 = Math.max(0.1, Math.exp(-value.q80));
    const hi90 = Math.min(10, Math.exp(value.q80));
    const lo25 = Math.exp(-value.q50);
    const hi75 = Math.exp(value.q50);
    const deposit = PLAN_FRAC * p.tvl_usd;
    // Farm math, with gas summed from the steps themselves.
    const steps0 = buildFarmSteps({
      name: p.name,
      chain: p.chains[0] ?? 'Ethereum',
      category: p.category ?? 'DeFi',
      deposit,
      implied,
      odds: o,
      grossDrop: 0,
      gasUsd: 0,
      feesUsd: 0,
      net: 0,
      netPerHour: 0,
      verdict: 'Marginal',
    });
    const gasUsd = steps0.reduce((s, st) => s + st.gasUsd, 0);
    const feesUsd = FEE_RATE * deposit;
    const grossDrop = implied * DROP_SHARE * PLAN_FRAC;
    const net = grossDrop - gasUsd - feesUsd;
    const tbillBar = deposit * TBILL * (HORIZON_WEEKS / 52);
    const netPerHour = net / WORK_HOURS;
    const verdict = farmVerdict(net, tbillBar, netPerHour);
    const steps = buildFarmSteps({
      name: p.name,
      chain: p.chains[0] ?? 'Ethereum',
      category: p.category ?? 'DeFi',
      deposit,
      implied,
      odds: o,
      grossDrop,
      gasUsd,
      feesUsd,
      net,
      netPerHour,
      verdict,
    });
    // Three nearest priced peers by log TVL distance, for the detail view.
    const peers = value.peers
      .map((q) => ({ q, d: Math.abs(Math.log(q.tvl_usd) - Math.log(p.tvl_usd)) }))
      .sort((a, b) => a.d - b.d || (a.q.slug < b.q.slug ? -1 : 1))
      .slice(0, 3)
      .map(({ q }) => ({ slug: q.slug, name: q.name, tvl: q.tvl_usd, mcap: q.mcap_usd! }));
    const tier: BoardRow['tier'] = wl.has(p.slug) ? 'watchlist' : p.tvl_usd >= 50000000 ? 'offlist' : 'emerging';
    return {
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'Uncategorized',
      chain: p.chains[0] ?? 'Ethereum',
      chains: p.chains,
      tvl: p.tvl_usd,
      change7d: p.change_7d,
      years: yearsListed(p),
      tier,
      launchValue,
      odds: o,
      implied,
      p10: implied * lo10,
      p25: implied * lo25,
      p75: implied * hi75,
      p90: implied * hi90,
      deposit,
      grossDrop,
      gasUsd,
      feesUsd,
      net,
      tbillBar,
      netPerHour,
      verdict,
      farmSteps: steps.map((s) => s.text),
      nearestPeers: peers,
    };
  });
  // Rank by implied value, ties broken by TVL then slug so the order is total.
  rows.sort(
    (a, b) =>
      b.implied - a.implied || b.tvl - a.tvl || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  return rows;
}

/** Farm counts if the drop share were different (same plan, same tests). */
function farmSensitivity(rows: BoardRow[], dropShare: number): { farm: number; marginal: number; skip: number } {
  let farm = 0;
  let marginal = 0;
  let skip = 0;
  for (const r of rows) {
    const gross = r.implied * dropShare * PLAN_FRAC;
    const net = gross - r.gasUsd - r.feesUsd;
    const v = farmVerdict(net, r.tbillBar, net / WORK_HOURS);
    if (v === 'Farm') farm++;
    else if (v === 'Marginal') marginal++;
    else skip++;
  }
  return { farm, marginal, skip };
}

/** Rows closest to passing both farm tests, with the binding test, the
 * drop share that would flip each row, and the plan size that would flip it
 * (null when no plan size can: for the T-bill test the drop and the T-bill
 * return both scale with the deposit, so a row whose implied value is small
 * against its TVL can never be fixed by sizing up). Only Marginal rows can
 * flip by raising the drop share; a row that already clears the $/hour test
 * needs only the T-bill test, and vice versa. */
function closestToFarm(rows: BoardRow[]): {
  slug: string;
  name: string;
  tvl: number;
  net: number;
  tbill: number;
  netHour: number;
  minRatio: number;
  binding: string;
  dropNeeded: number;
  planNeeded: number | null;
  lever: string;
  ratioTbill: number;
  ratioHour: number;
}[] {
  const out: {
    slug: string;
    name: string;
    tvl: number;
    net: number;
    tbill: number;
    netHour: number;
    minRatio: number;
    binding: string;
    dropNeeded: number;
    planNeeded: number | null;
    lever: string;
    ratioTbill: number;
    ratioHour: number;
  }[] = [];
  for (const r of rows) {
    if (r.verdict !== 'Marginal') continue;
    const ratioTbill = r.net / r.tbillBar;
    const ratioHour = r.netPerHour / HOUR_BAR;
    const minRatio = Math.min(ratioTbill, ratioHour);
    const binding = ratioTbill <= ratioHour ? 'T-bill' : '$/hour';
    // net(drop) = implied*drop*PLAN_FRAC - gas - fees. Solve for the
    // drop share where each test is exactly met; the row flips at the larger.
    const denom = r.implied * PLAN_FRAC;
    const needTbill = denom > 0 ? (r.tbillBar + r.gasUsd + r.feesUsd) / denom : 9;
    const needHour = denom > 0 ? (HOUR_BAR * WORK_HOURS + r.gasUsd + r.feesUsd) / denom : 9;
    const dropNeeded = Math.max(needTbill, needHour);
    // Plan size that would flip the row at the default 7% drop share.
    // net(p) - tbill(p) = p*(implied*DROP_SHARE - tvl*(FEE_RATE + TBILL*HORIZON_WEEKS/52)) - gas,
    // net(p) = p*(implied*DROP_SHARE - tvl*FEE_RATE) - gas. A test is flippable
    // by sizing up only when its bracket is positive; the row flips at the
    // larger of the two sizes, and at no size when either test is unflippable.
    const tbillBracket = r.implied * DROP_SHARE - r.tvl * (FEE_RATE + (TBILL * HORIZON_WEEKS) / 52);
    const hourBracket = r.implied * DROP_SHARE - r.tvl * FEE_RATE;
    const pTbill = tbillBracket > 0 ? r.gasUsd / tbillBracket : null;
    const pHour = hourBracket > 0 ? (HOUR_BAR * WORK_HOURS + r.gasUsd) / hourBracket : null;
    const planNeeded = pTbill === null || pHour === null ? null : Math.max(pTbill, pHour);
    const lever =
      planNeeded === null
        ? 'drop share'
        : dropNeeded / DROP_SHARE <= planNeeded / PLAN_FRAC
          ? 'drop share'
          : 'plan size';
    out.push({
      slug: r.slug,
      name: r.name,
      tvl: r.tvl,
      net: r.net,
      tbill: r.tbillBar,
      netHour: r.netPerHour,
      minRatio,
      binding,
      dropNeeded,
      planNeeded,
      lever,
      ratioTbill,
      ratioHour,
    });
  }
  out.sort((a, b) => b.minRatio - a.minRatio || (a.slug < b.slug ? -1 : 1));
  return out.slice(0, 5);
}

// ---------------------------------------------------------------- ablation
// Greedy forward selection, each candidate judged on BOTH leave-one-out and
// true walk-forward. Generic design so rejected terms can be measured too.

type AblationFeat = 'lnTVL' | 'cat' | 'lnChains' | 'lnYears' | 'growth';

function ablationDesign(peers: Protocol[], categories: string[], feats: AblationFeat[]): number[][] {
  return peers.map((p) => {
    const row: number[] = [1];
    if (feats.includes('lnTVL')) row.push(Math.log(p.tvl_usd));
    if (feats.includes('lnChains')) row.push(Math.log(p.chains.length));
    if (feats.includes('lnYears')) row.push(Math.log(yearsListed(p) ?? 1));
    if (feats.includes('growth')) row.push(growthWinsorized(p));
    if (feats.includes('cat')) {
      for (const c of categories) row.push(p.category === c ? 1 : 0);
    }
    return row;
  });
}

function ablationFit(peers: Protocol[], categories: string[], feats: AblationFeat[]): number[] {
  const X = ablationDesign(peers, categories, feats);
  const y = peers.map((p) => Math.log(p.mcap_usd!));
  const k = X[0]!.length;
  const pen = new Array<number>(k).fill(0);
  if (feats.includes('cat')) {
    const start = k - categories.length;
    for (let j = start; j < k; j++) pen[j] = CAT_LAMBDA;
  }
  return ridgeFit(X, y, pen);
}

function ablationLooWf(
  peers: Protocol[],
  categories: string[],
  feats: AblationFeat[],
): { loo: number; wf: number } {
  const y = peers.map((p) => Math.log(p.mcap_usd!));
  let looSum = 0;
  const looErrs: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const rest = peers.filter((_, j) => j !== i);
    const b = ablationFit(rest, categories, feats);
    const pr = ablationDesign([peers[i]!], categories, feats)[0]!.reduce((s, v, j) => s + v * b[j]!, 0);
    looErrs.push(Math.abs(y[i]! - pr));
  }
  const loo = Math.exp(median(looErrs));
  const tr = peers.filter((p) => p.listed_at! <= '2024-12-31');
  const te = peers.filter((p) => p.listed_at! > '2024-12-31');
  const yte = te.map((p) => Math.log(p.mcap_usd!));
  const b = ablationFit(tr, categories, feats);
  const wfErrs = ablationDesign(te, categories, feats).map((row, i) =>
    Math.abs(yte[i]! - row.reduce((s, v, j) => s + v * b[j]!, 0)),
  );
  return { loo, wf: Math.exp(median(wfErrs)) };
}

// ---------------------------------------------------------------- dashboard

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Binned log-log scatter: peer medians per TVL decile plus the fitted size curve. */
function buildChartSvg(value: ValueModel): string {
  const W = 560;
  const H = 220;
  const PL = 44;
  const PR = 12;
  const PT = 14;
  const PB = 30;
  const peers = [...value.peers].sort((a, b) => a.tvl_usd - b.tvl_usd);
  const xs = peers.map((p) => Math.log(p.tvl_usd));
  const ys = peers.map((p) => Math.log(p.mcap_usd!));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const X = (v: number): number => PL + ((v - x0) / (x1 - x0)) * (W - PL - PR);
  const Y = (v: number): number => PT + (1 - (v - y0) / (y1 - y0)) * (H - PT - PB);
  const bins: { x: number; y: number }[] = [];
  const NB = 10;
  for (let b = 0; b < NB; b++) {
    const lo = Math.floor((b * peers.length) / NB);
    const hi = Math.floor(((b + 1) * peers.length) / NB);
    if (hi <= lo) continue;
    bins.push({ x: median(xs.slice(lo, hi)), y: median(ys.slice(lo, hi)) });
  }
  const lx1 = X(x0);
  const ly1 = Y(value.coef[0]! + value.slope * x0);
  const lx2 = X(x1);
  const ly2 = Y(value.coef[0]! + value.slope * x1);
  const dots = bins.map((pt) => `<circle cx="${X(pt.x).toFixed(1)}" cy="${Y(pt.y).toFixed(1)}" r="4" fill="#22d3ee"/>`).join('');
  const grid = [0.25, 0.5, 0.75]
    .map(
      (f) =>
        `<line x1="${(PL + f * (W - PL - PR)).toFixed(1)}" y1="${PT}" x2="${(PL + f * (W - PL - PR)).toFixed(1)}" y2="${H - PB}" stroke="#1f2937" stroke-width="1"/>`,
    )
    .join('');
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Log-log scatter of traded tokens' market caps against TVL, with the fitted size curve">` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#0b0f17"/>` +
    grid +
    `<line x1="${PL}" y1="${H - PB}" x2="${W - PR}" y2="${H - PB}" stroke="#374151" stroke-width="1"/>` +
    `<line x1="${PL}" y1="${PT}" x2="${PL}" y2="${H - PB}" stroke="#374151" stroke-width="1"/>` +
    `<line x1="${lx1.toFixed(1)}" y1="${ly1.toFixed(1)}" x2="${lx2.toFixed(1)}" y2="${ly2.toFixed(1)}" stroke="#34d399" stroke-width="2"/>` +
    dots +
    `<text x="${PL}" y="${H - 8}" fill="#9ca3af" font-size="11">ln TVL (USD) — 95 traded tokens, binned by decile</text>` +
    `<text x="8" y="${PT + 8}" fill="#9ca3af" font-size="11">ln mcap</text>` +
    `<text x="${W - PR - 150}" y="${PT + 12}" fill="#34d399" font-size="11">fitted size curve, slope ${value.slope.toFixed(2)}</text>` +
    `</svg>`
  );
}

interface Ledger {
  ranked: number;
  token: number;
  tokenWithMcap: number;
  tokenNoMcap: number;
  excluded: number;
  excludedByCat: Record<string, number>;
  excludedByName: number;
}

function buildLedger(snapshot: Snapshot): Ledger {
  const token = snapshot.protocols.filter(hasToken);
  const excluded = snapshot.protocols.filter((p) => noToken(p) && !isEligible(p));
  const byCat: Record<string, number> = {};
  let byName = 0;
  for (const p of excluded) {
    if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) {
      byCat[p.category] = (byCat[p.category] ?? 0) + 1;
    } else {
      byName++;
    }
  }
  return {
    ranked: snapshot.protocols.filter(isEligible).length,
    token: token.length,
    tokenWithMcap: token.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length,
    tokenNoMcap: token.filter((p) => !(p.mcap_usd !== null && p.mcap_usd > 0)).length,
    excluded: excluded.length,
    excludedByCat: byCat,
    excludedByName: byName,
  };
}

// ---------------------------------------------------------------- main

function main(): void {
  const { input, outDir } = parseArgs(process.argv.slice(2));
  const snapshot: Snapshot = JSON.parse(readFileSync(input, 'utf8'));
  const value = fitValueModel(snapshot);
  const odds = fitOddsModel(snapshot);
  const rows = buildBoard(snapshot, value, odds);
  const ledger = buildLedger(snapshot);

  // Board invariants (fail fast, before writing anything).
  if (rows.length !== 198) throw new Error(`board has ${rows.length} rows, expected 198`);
  const wlCount = rows.filter((r) => r.tier === 'watchlist').length;
  const offCount = rows.filter((r) => r.tier === 'offlist').length;
  const emCount = rows.filter((r) => r.tier === 'emerging').length;
  if (wlCount !== 40 || offCount !== 20 || emCount !== 138) {
    throw new Error(`tiers ${wlCount}/${offCount}/${emCount}, expected 40/20/138`);
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.implied > rows[i - 1]!.implied + 1e-9) throw new Error('board not monotonically decreasing');
  }
  if (rows.some((r) => r.farmSteps.length !== 10)) throw new Error('farm_steps must be 10 per row');
  if (rows.some((r) => /\s(v\d+|V\d+|\d+\.\d+)\s*$/.test(r.name))) throw new Error('versioned row on board');

  const counts = {
    farm: rows.filter((r) => r.verdict === 'Farm').length,
    marginal: rows.filter((r) => r.verdict === 'Marginal').length,
    skip: rows.filter((r) => r.verdict === 'Skip').length,
  };
  const sens7 = farmSensitivity(rows, 0.07);
  const sens12 = farmSensitivity(rows, 0.12);
  const sens15 = farmSensitivity(rows, 0.15);
  const closest = closestToFarm(rows);
  const totalImplied = rows.reduce((s, r) => s + Math.round(r.implied), 0);
  const totalTvl = rows.reduce((s, r) => s + r.tvl, 0);

  // Ablation trace (greedy forward selection, both tests).
  const ablBase = ablationLooWf(value.peers, value.categories, ['lnTVL']);
  const ablCat = ablationLooWf(value.peers, value.categories, ['lnTVL', 'cat']);
  const ablGrowth = ablationLooWf(value.peers, value.categories, ['lnTVL', 'cat', 'growth']);
  const ablChains = ablationLooWf(value.peers, value.categories, ['lnTVL', 'cat', 'lnChains']);
  const ablYears = ablationLooWf(value.peers, value.categories, ['lnTVL', 'cat', 'lnYears']);

  // Raw odds coefficients (unstandardized) for the detail view.
  const rawCoef = odds.coefStd.slice(1).map((b, j) => b / odds.sd[j]!);
  const rawConst = odds.coefStd[0]! - odds.coefStd.slice(1).reduce((s, b, j) => s + (b * odds.mu[j]!) / odds.sd[j]!, 0);

  // Compact board data for the dashboard. The dashboard recomputes farm
  // verdicts from these fields with the same formula; steps are rebuilt from
  // the same templates (verified against board.json by the check script).
  const tierCode = { watchlist: 0, offlist: 1, emerging: 2 } as const;
  const boardData = rows.map((r) => [
    r.slug,
    r.name,
    tierCode[r.tier],
    r.tvl,
    r.change7d === null ? null : Math.round(r.change7d * 100) / 100,
    r.years === null ? null : Math.round(r.years * 100) / 100,
    r.chain,
    r.category,
    Math.round(r.implied),
    // Four decimals, the same rounding board.json uses: the dashboard shows
    // the odds percentage from this value, and a full double can flip the
    // displayed percent against board.json (0.20496 -> 20% here, 0.2050 ->
    // 21% there). The launch value is NOT stored: the drawer recovers it
    // as implied / odds (within 0.00005/odds of the true launch value —
    // 0.61% worst case at the smallest odds). The verdict is NOT stored
    // either: the dashboard recomputes it from the farm formula for every
    // row (and the live sliders need the recompute anyway), so a stored
    // copy would only duplicate it.
    Math.round(r.odds * 10000) / 10000,
  ]);
  const peersData = value.peers.map((p) => [p.name, p.tvl_usd, p.mcap_usd!, p.category, p.chains[0] ?? '']);
  const catEffects: Record<string, number> = {};
  value.categories.forEach((c, i) => {
    catEffects[c] = Math.round(value.coef[2 + i]! * 1000) / 1000;
  });
  const catShares: Record<string, number> = {};
  for (const [c, s] of odds.shareByCat) catShares[c] = Math.round(s * 10000) / 10000;

  const checksum = sha256Hex(readFileSync(join(HERE, 'main.ts'), 'utf8'));

  const repl: Record<string, string> = {
    '%%SNAPSHOT_DATE%%': snapshot.as_of,
    '%%TOTAL_TVL%%': fmtUsd(totalTvl),
    '%%TOTAL_IMPLIED%%': fmtUsd(totalImplied),
    '%%TOTAL_IMPLIED_EXACT%%': '$' + totalImplied.toLocaleString('en-US'),
    '%%BOARD_ROWS%%': String(rows.length),
    '%%LOO_MISS%%': value.looMiss.toFixed(2),
    '%%LOO_FLAT%%': value.flatLooMiss.toFixed(2),
    '%%WF_MISS%%': value.wfMiss.toFixed(2),
    '%%WF_FLAT%%': value.flatWfMiss.toFixed(2),
    '%%WF_NTRAIN%%': String(value.wfNtrain),
    '%%WF_NTEST%%': String(value.wfNtest),
    '%%WITHIN2%%': (value.looWithin2 * 100).toFixed(1),
    '%%WITHIN3%%': (value.looWithin3 * 100).toFixed(1),
    '%%SPEARMAN%%': value.looSpearman.toFixed(3),
    '%%COHORT_OLD%%': value.cohortOld.toFixed(2),
    '%%COHORT_NEW%%': value.cohortNew.toFixed(2),
    '%%BRIER%%': odds.tenFoldBrier.toFixed(4),
    '%%BRIER_BASE%%': odds.tenFoldBase.toFixed(4),
    '%%BRIER_WF%%': odds.wfBrier.toFixed(4),
    '%%BRIER_WF_BASE%%': odds.wfBase.toFixed(4),
    '%%BRIER_INSAMPLE%%': odds.inSampleBrier.toFixed(4),
    '%%ODDS_ACC%%': (odds.tenFoldAcc * 100).toFixed(1),
    '%%Q50_FACTOR%%': Math.exp(value.q50).toFixed(2),
    '%%Q80_FACTOR%%': Math.exp(value.q80).toFixed(2),
    '%%COV50%%': (value.cov50 * 100).toFixed(1),
    '%%COV80%%': (value.cov80 * 100).toFixed(1),
    '%%SLOPE%%': value.slope.toFixed(3),
    '%%SLOPE_SE%%': value.slopeSe.toFixed(3),
    '%%MULT100%%': value.multipleAt100m.toFixed(4),
    '%%MULT100_SE%%': value.multipleSe.toFixed(4),
    '%%FARM_N%%': String(counts.farm),
    '%%MARGINAL_N%%': String(counts.marginal),
    '%%SKIP_N%%': String(counts.skip),
    '%%SENS_7%%': String(sens7.farm),
    '%%SENS_12%%': String(sens12.farm),
    '%%SENS_15%%': String(sens15.farm),
    '%%CHECKSUM%%': checksum.slice(0, 8),
    '%%LEDGER_TOKEN%%': String(ledger.token),
    '%%LEDGER_TOKEN_MCAP%%': String(ledger.tokenWithMcap),
    '%%LEDGER_TOKEN_NOMCAP%%': String(ledger.tokenNoMcap),
    '%%LEDGER_EXCLUDED%%': String(ledger.excluded),
    '%%LEDGER_EXCLUDED_NAME%%': String(ledger.excludedByName),
    '%%ODDS_RAW_CONST%%': rawConst.toFixed(3),
    '%%MEDIAN_YEARS%%': String(Math.round(odds.medianYearsNoToken * 100) / 100),
    '%%ODDS_RAW_YEARS%%': rawCoef[0]!.toFixed(3),
    '%%ODDS_RAW_SHARE%%': rawCoef[1]!.toFixed(3),
    '%%ODDS_RAW_TVL%%': rawCoef[2]!.toFixed(3),
    '%%ODDS_RAW_GROWTH%%': rawCoef[3]!.toFixed(3),
    // Emitted for the method prose in index.html (the fitted intercept is
    // printed there); zz-data.js does not declare it — the drawer recovers the
    // launch value as implied / odds and never recomputes from the intercept.
    '%%VALUE_CONST%%': value.coef[0]!.toFixed(3),
    '%%VALUE_SLOPE%%': value.slope.toFixed(3),
    '%%CAT_EFFECTS%%': JSON.stringify(catEffects),
    '%%CAT_SHARES%%': JSON.stringify(catShares),
    '%%ODDS_GLOBAL_SHARE%%': String(Math.round(odds.globalShare * 10000) / 10000),
    '%%PEERS_DATA%%': JSON.stringify(peersData),
    '%%BOARD_DATA%%': JSON.stringify(boardData),
    '%%CHART_SVG%%': buildChartSvg(value),
    '%%ABLATION_ROWS%%': [
      `<tr><td>Size only (ln TVL)</td><td>×${ablBase.loo.toFixed(2)}</td><td>×${ablBase.wf.toFixed(2)}</td><td>base</td></tr>`,
      `<tr><td>+ Category ridge (λ=8)</td><td>×${ablCat.loo.toFixed(2)}</td><td>×${ablCat.wf.toFixed(2)}</td><td class="kept">KEPT — lowers both</td></tr>`,
      `<tr><td>+ 7-day growth (winsorized)</td><td>×${ablGrowth.loo.toFixed(2)}</td><td>×${ablGrowth.wf.toFixed(2)}</td><td class="notkept">NOT KEPT in value — see note</td></tr>`,
      `<tr><td>+ Chain count (ln)</td><td>×${ablChains.loo.toFixed(2)}</td><td>×${ablChains.wf.toFixed(2)}</td><td class="notkept">NOT KEPT — walk-forward worse</td></tr>`,
      `<tr><td>+ Years listed (ln)</td><td>×${ablYears.loo.toFixed(2)}</td><td>×${ablYears.wf.toFixed(2)}</td><td class="notkept">NOT KEPT — walk-forward collapses</td></tr>`,
    ].join('\n'),
    '%%CLOSEST_ROWS%%': closest
      .map(
        (c, i) =>
          `<tr><td>${i + 1}</td><td class="name">${escapeHtml(c.name)}</td><td>${fmtUsd(c.tvl)}</td><td>${fmtMoney(c.net)}</td><td>${fmtMoney(c.tbill)}</td><td>${fmtMoney(c.netHour)}</td><td>${c.ratioTbill.toFixed(2)}×</td><td>${c.ratioHour.toFixed(2)}×</td><td>${(c.dropNeeded * 100).toFixed(1)}%</td><td>${c.planNeeded === null ? '—' : (c.planNeeded * 100).toFixed(3) + '%'}</td><td>${c.lever}</td></tr>`,
      )
      .join('\n'),
    '%%TOP5_LIST%%': rows
      .slice(0, 5)
      .map(
        (r, i) =>
          `<li><b>#${i + 1} ${escapeHtml(r.name)}</b> — ${fmtUsd(r.implied)} implied, ${Math.round(Math.round(r.odds * 10000) / 10000 * 100)}% odds, ${r.verdict}</li>`,
      )
      .join('\n'),
  };

  // ---- write board.json
  const boardJson = {
    as_of: snapshot.as_of,
    rows: rows.map((r, i) => ({
      slug: r.slug,
      name: r.name,
      rank: i + 1,
      implied_value_usd: Math.round(r.implied),
      tier: r.tier,
      tvl_usd: r.tvl,
      launch_value_usd: Math.round(r.launchValue),
      token_odds: Math.round(r.odds * 10000) / 10000,
      p10_usd: Math.round(r.p10),
      p25_usd: Math.round(r.p25),
      p75_usd: Math.round(r.p75),
      p90_usd: Math.round(r.p90),
      farm_steps: r.farmSteps,
    })),
  };
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'dashboard'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });
  writeFileSync(join(outDir, 'board.json'), JSON.stringify(boardJson, null, 2) + '\n');

  // ---- render dashboard templates
  // The data file is emitted as zz-data.js, not data.js: buildDossier sorts
  // the dashboard files alphabetically for the dossier text (capped at
  // 65,536 bytes), so a data.js would eat the budget and cut index.html off
  // mid-page. Sorted last, zz-data.js is the one that gets cut — and its
  // BOARD rows are redundant with board.json, which the dossier carries
  // whole as its own file. (v1's own trick.)
  for (const name of ['index.html', 'app.css', 'app.js', 'data.js']) {
    const src = readFileSync(join(HERE, 'dashboard', name), 'utf8');
    let out = src;
    for (const [k, v] of Object.entries(repl)) out = out.split(k).join(v);
    const left = out.match(/%%[A-Z0-9_]+%%/g);
    if (left) throw new Error(`unreplaced placeholder in ${name}: ${left.join(', ')}`);
    writeFileSync(join(outDir, 'dashboard', name === 'data.js' ? 'zz-data.js' : name), out);
  }

  // ---- screenshots + dossier
  const shotDir = join(HERE, 'screenshots');
  if (existsSync(shotDir)) cpSync(shotDir, join(outDir, 'screenshots'), { recursive: true });
  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  // ---- report
  const top5 = rows.slice(0, 5).map((r) => `${r.name} $${Math.round(r.implied).toLocaleString('en-US')}`);
  console.log('value: LOO x' + value.looMiss.toFixed(2) + ' (flat x' + value.flatLooMiss.toFixed(2) + ') WF x' + value.wfMiss.toFixed(2) + ' (flat x' + value.flatWfMiss.toFixed(2) + ')');
  console.log('value: within2 ' + (value.looWithin2 * 100).toFixed(1) + '% within3 ' + (value.looWithin3 * 100).toFixed(1) + '% spearman ' + value.looSpearman.toFixed(3));
  console.log('value: slope ' + value.slope.toFixed(3) + ' +- ' + value.slopeSe.toFixed(3) + ' multiple@100M ' + value.multipleAt100m.toFixed(4) + ' +- ' + value.multipleSe.toFixed(4));
  console.log('value: cohort old x' + value.cohortOld.toFixed(2) + ' new x' + value.cohortNew.toFixed(2) + ' Q50 x' + Math.exp(value.q50).toFixed(2) + ' Q80 x' + Math.exp(value.q80).toFixed(2));
  console.log('odds: ten-fold Brier ' + odds.tenFoldBrier.toFixed(4) + ' base ' + odds.tenFoldBase.toFixed(4) + ' acc ' + (odds.tenFoldAcc * 100).toFixed(1) + '% WF Brier ' + odds.wfBrier.toFixed(4) + ' base ' + odds.wfBase.toFixed(4));
  console.log('board: ' + rows.length + ' rows, tiers ' + wlCount + '/' + offCount + '/' + emCount + ', total implied $' + totalImplied.toLocaleString('en-US'));
  console.log('top5: ' + top5.join(' | '));
  console.log('farm: ' + counts.farm + ' Farm / ' + counts.marginal + ' Marginal / ' + counts.skip + ' Skip');
  console.log('sensitivity: 7% -> ' + sens7.farm + ' Farm, 12% -> ' + sens12.farm + ', 15% -> ' + sens15.farm);
  console.log('checksum: ' + checksum.slice(0, 8));
  console.log('dossier bytes: ' + dossier.length);
}

main();
