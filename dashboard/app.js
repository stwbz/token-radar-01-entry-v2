// Token Radar v2 — dashboard app, v1 page structure. No network: all data
// comes from zz-data.js (BOARD, PEERS, model constants).
// BOARD row: [slug, name, tier (0 watchlist / 1 off-list ≥$50M / 2 emerging),
//   tvl, change_7d|null (percent), years listed|null, first chain, category,
//   implied value (rounded $), token odds (4 decimals, same as board.json)]
// No stored verdict or launch value: the verdict is recomputed from the farm
// formula for every row (the live sliders need the recompute anyway), and
// the launch value is recovered as implied / odds (see openDetail).
// PEERS row: [name, tvl, market cap, category, first chain]
// PEERS row: [slug, name, tvl, market cap, category, first chain]
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function usd(x) { if (x >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B'; if (x >= 1e6) return '$' + (x / 1e6).toFixed(1) + 'M'; if (x >= 1e3) return '$' + (x / 1e3).toFixed(0) + 'k'; return '$' + Math.round(x); }
function money(x) { const r = Math.round(x); return '$' + (r === 0 ? 0 : r).toLocaleString('en-US'); } // Math.round(-0.13) is -0, and (-0).toLocaleString() prints "-0": a value that rounds to zero must print "$0", never "$-0".
function fmtMoney(n) { return money(n); }
function fmtUsd(n) { return usd(n); }
function pct(x, d) { return (x * 100).toFixed(d === undefined ? 0 : d) + '%'; }
function ageFmt(y) {
  if (y === null || y === undefined) return '—';
  if (y >= 1) return y.toFixed(1) + ' yr';
  return Math.round(y * 365) + ' d';
}

const TIER_NAMES = ['Watchlist', 'Off-list ≥$50M', 'Emerging'];
const VERDICT_NAMES = ['Farm', 'Marginal', 'Skip'];
const GAS_TOTAL = 78; // sum of the per-step gas costs in the farm plan
const FEE_RATE = 0.0005;
const TBILL = 0.045;
const HOUR_BAR = 25;

const state = { verdict: 'all', tier: '', cat: '', chain: '', q: '', sort: 'rank', dir: 1, mode: 'pre', plan: 2, drop: 7, hor: 12 };

function farmMath(r) {
  const planFrac = state.plan / 10000;
  const deposit = planFrac * r[3];
  const gross = r[8] * (state.drop / 100) * planFrac;
  const fees = FEE_RATE * deposit;
  const net = gross - GAS_TOTAL - fees;
  const tbill = deposit * TBILL * (state.hor / 52);
  const hours = 4.5 + 0.25 * state.hor;
  const nph = net / hours;
  const verdict = net <= 0 ? 2 : (net > tbill && nph > HOUR_BAR ? 0 : 1);
  return { deposit, gross, fees, net, tbill, hours, nph, verdict };
}

// The ten farm steps. Templates are identical to main.ts buildFarmSteps, so
// at the default sliders (7% drop, 0.02% plan, 12 weeks) the steps shown here
// are byte-identical to the farm_steps in board.json.
function buildFarmSteps(r, fm) {
  const dep = fmtMoney(fm.deposit);
  const outcome =
    fm.verdict === 0
      ? `Outcome at the ${state.drop}% drop assumption: expected drop ${fmtMoney(fm.gross)} on a ${fmtMoney(r[8])} implied value at ${Math.round(r[9] * 100)}% launch odds; net of fees ${fmtMoney(fm.net)} over ${fm.hours} hours (${fmtMoney(fm.nph)}/hour). The plan clears both bars.`
      : fm.verdict === 1
        ? `Outcome at the ${state.drop}% drop assumption: expected drop ${fmtMoney(fm.gross)} on a ${fmtMoney(r[8])} implied value at ${Math.round(r[9] * 100)}% launch odds; net of fees ${fmtMoney(fm.net)} over ${fm.hours} hours (${fmtMoney(fm.nph)}/hour). Positive, but it fails one of the two bars, so it is Marginal, not Farm.`
        : `Outcome at the ${state.drop}% drop assumption: expected drop ${fmtMoney(fm.gross)} on a ${fmtMoney(r[8])} implied value at ${Math.round(r[9] * 100)}% launch odds; net of fees ${fmtMoney(fm.net)} over ${fm.hours} hours. The plan loses money at this size — only farm it if you use the protocol anyway.`;
  return [
    `Open ${r[1]} on ${r[6]} with a fresh wallet; keep the seed phrase offline and never share it. Check the official site address twice before connecting.`,
    `Bridge ${dep} to ${r[6]} for the plan, using the chain's canonical bridge. Expect about $6 in gas. Confirm the fee on screen before signing; a wrong bridge can strand funds.`,
    `Deposit ${dep} into ${r[1]}'s ${r[7]} position on ${r[6]}. Expect about $6 in gas. Confirm the position shows in the app and save the transaction hash.`,
    `Use the position once a week for 12 weeks: add or rebalance a small amount so the activity reads as real use, not one deposit. 20 minutes a week, about $4 gas each time.`,
    `Hold the position for the full 12-week horizon. Withdrawing early can void points in most programs, and the plan's math assumes the whole horizon.`,
    `Watch ${r[1]}'s announcements each week for a points or eligibility snapshot; take a dated screenshot of the position while it is active.`,
    `If ${r[1]} opens a points dashboard, connect the same wallet and confirm the position is counted. If it is not, fix it before the snapshot, not after.`,
    `At the end of week 12, withdraw the deposit plus any yield. Expect about $8 in gas to exit; leave a little ${r[6]} gas in the wallet for the exit itself.`,
    `If a token launches, claim only through ${r[1]}'s official site. Expect about $10 in gas to claim. Never use claim links from social media or direct messages; most of them are drains.`,
    outcome,
  ];
}

// ---- board: filters, sorting, verdict recompute
function visibleRows() {
  let list = BOARD.map((r, i) => ({ r, rank: i + 1 }));
  if (state.verdict !== 'all') list = list.filter((x) => VERDICT_NAMES[farmMath(x.r).verdict] === state.verdict);
  if (state.tier !== '') list = list.filter((x) => String(x.r[2]) === state.tier);
  if (state.cat) list = list.filter((x) => (x.r[7] || 'Unknown') === state.cat);
  if (state.chain) list = list.filter((x) => x.r[6] === state.chain);
  if (state.q) {
    const q = state.q.toLowerCase();
    list = list.filter((x) => (x.r[1] + ' ' + x.r[6] + ' ' + (x.r[7] || '')).toLowerCase().includes(q));
  }
  const k = state.sort;
  const val = (x) => {
    const r = x.r;
    if (k === 'rank') return x.rank;
    if (k === 'name') return r[1].toLowerCase();
    if (k === 'tvl') return r[3];
    if (k === 'change_7d') return r[4] === null ? 0 : r[4];
    if (k === 'age') return r[5] === null ? -1 : r[5];
    if (k === 'odds') return r[9];
    if (k === 'launch') return r[8] / r[9];
    if (k === 'implied') return r[8];
    if (k === 'verdict') return farmMath(r).verdict;
    if (k === 'hour') return farmMath(r).nph;
    return x.rank;
  };
  list.sort((a, b) => { const av = val(a), bv = val(b); return (av < bv ? -1 : av > bv ? 1 : 0) * state.dir; });
  return list;
}

// Log-scale bar for the implied-value cell: the bar marks the implied value
// against the board's own spread, the whisker marks P25–P75.
const LOGS = BOARD.map((r) => Math.log10(Math.max(1, r[8])));
const LOG_LO = Math.min.apply(null, LOGS), LOG_HI = Math.max.apply(null, LOGS);
function barHtml(r) {
  const w = (Math.log10(Math.max(1, r[8])) - LOG_LO) / (LOG_HI - LOG_LO) * 100;
  const p25 = Math.round(r[8] / Q50_FACTOR), p75 = Math.round(r[8] * Q50_FACTOR);
  const wl = clamp((Math.log10(Math.max(1, p25)) - LOG_LO) / (LOG_HI - LOG_LO) * 100, 0, 100);
  const wr = clamp((Math.log10(Math.max(1, p75)) - LOG_LO) / (LOG_HI - LOG_LO) * 100, 0, 100);
  return '<div class="bar"><i style="width:' + w.toFixed(1) + '%"></i><span class="wh" style="left:' + wl.toFixed(1) + '%;width:' + Math.max(1, wr - wl).toFixed(1) + '%"></span></div>';
}
function badge(code) {
  return code === 0 ? '<span class="badge watch">Watchlist</span>'
    : code === 1 ? '<span class="badge unlisted">Off-list ≥$50M</span>'
    : '<span class="badge emerging">Emerging</span>';
}
const PRE_HEAD = '<tr><th data-sort="rank">#</th><th data-sort="name">Protocol</th><th data-sort="tvl">TVL</th><th data-sort="change_7d">7D</th><th data-sort="age">No-token age</th><th data-sort="odds">Token odds</th><th data-sort="launch">If it launches</th><th data-sort="implied">Implied value · P25–P75</th><th data-sort="verdict">Verdict · Net of fees</th><th data-sort="hour">Net / hour</th></tr>';
const LIVE_HEAD = '<tr><th>#</th><th>Protocol</th><th>TVL</th><th>Market cap</th><th>Cap / TVL</th></tr>';
const TOTAL_TVL = BOARD.reduce((s, r) => s + r[3], 0);
const TOTAL_IMPLIED = BOARD.reduce((s, r) => s + r[8], 0);

function renderTable() {
  // Live-peers mode: the peers table is rendered unfiltered, so none of the
  // pre-token controls act on it (verdict pills need farmMath, the sliders
  // feed farmMath, search/tier/category/chain only filter visibleRows, and
  // CSV/JSON export visibleRows — the pre-token board, not the peers). Hide
  // them all in live mode so no visible control is dead or misleading; the
  // mode tabs stay, and renderTable re-runs on every state change, so the
  // class always matches state.mode (including Reset, which returns to pre).
  $('#board').classList.toggle('live', state.mode === 'live');
  if (state.mode === 'live') {
    $('#tbl thead').innerHTML = LIVE_HEAD;
    $('#tbl tbody').innerHTML = PEERS.map((p, i) =>
      '<tr><td>' + (i + 1) + '</td><td class="name">' + esc(p[0]) + '<br><span class="sub">' + esc(p[3] || 'Unknown') + ' · ' + esc(p[4]) + '</span></td><td>' + usd(p[1]) + '</td><td>' + usd(p[2]) + '</td><td>' + (p[2] / p[1]).toFixed(2) + '×</td></tr>').join('');
    $('#row-count').textContent = PEERS.length + ' live peers with a recorded market cap and a listing date. They fit the model; they are never ranked.';
    return;
  }
  $('#tbl thead').innerHTML = PRE_HEAD;
  const list = visibleRows();
  $('#tbl tbody').innerHTML = list.map((x) => {
    const r = x.r;
    const fm = farmMath(r);
    const chg = r[4] === null ? '—' : (r[4] > 0 ? '+' : '') + r[4].toFixed(1) + '%';
    const chgCls = r[4] === null ? '' : r[4] >= 0 ? 'pos' : 'neg';
    const p25 = Math.round(r[8] / Q50_FACTOR), p75 = Math.round(r[8] * Q50_FACTOR);
    const launch = r[8] / r[9];
    const totalFees = GAS_TOTAL + fm.fees;
    // The sign comes from the ROUNDED net: a net of -$0.13 rounds to $0 and
    // must print "0", not "−0" (and not "+0" either).
    const netR = Math.round(fm.net), nphR = Math.round(fm.nph);
    const netSign = netR < 0 ? '−' : netR > 0 ? '+' : '';
    const netCls = netR < 0 ? 'neg' : netR > 0 ? 'pos' : '';
    const nphSign = nphR < 0 ? '−' : nphR > 0 ? '+' : '';
    const nphCls = nphR < 0 ? 'neg' : nphR > 0 ? 'pos' : '';
    return '<tr data-slug="' + r[0] + '">' +
      '<td>' + x.rank + '</td>' +
      '<td class="name"><a href="#detail=' + r[0] + '" class="rowlink">' + esc(r[1]) + '</a>' + badge(r[2]) + '<br><span class="sub">' + esc(r[7] || 'Unknown') + ' · ' + esc(r[6]) + '</span></td>' +
      '<td>' + usd(r[3]) + '</td>' +
      '<td class="' + chgCls + '">' + chg + '</td>' +
      '<td>' + ageFmt(r[5]) + '</td>' +
      '<td>' + pct(r[9], 0) + '<div class="oddsbar"><i style="width:' + (r[9] * 100).toFixed(0) + '%"></i></div></td>' +
      '<td>' + usd(launch) + '</td>' +
      '<td><span class="imp">' + usd(r[8]) + '</span> <span class="rng">' + usd(p25) + '–' + usd(p75) + '</span>' + barHtml(r) + '</td>' +
      '<td><span class="vchip ' + VERDICT_NAMES[fm.verdict] + '">' + VERDICT_NAMES[fm.verdict] + '</span> <span class="' + netCls + '">' + netSign + money(Math.abs(netR)).slice(1) + '</span><br><span class="rng">' + usd(fm.gross) + ' drop − ' + money(totalFees) + ' fees</span></td>' +
      '<td class="' + nphCls + '">' + nphSign + money(Math.abs(nphR)).slice(1) + '</td></tr>';
  }).join('');
  $('#row-count').textContent = list.length + ' of ' + BOARD.length + ' rows · ' + usd(TOTAL_TVL) + ' TVL · ' + usd(TOTAL_IMPLIED) + ' implied';
  $('#c-all').textContent = BOARD.length;
  $('#c-farm').textContent = BOARD.filter((r) => farmMath(r).verdict === 0).length;
  $('#c-marg').textContent = BOARD.filter((r) => farmMath(r).verdict === 1).length;
  $('#c-skip').textContent = BOARD.filter((r) => farmMath(r).verdict === 2).length;
}

// ---- scatter: log TVL (x) vs log implied value (y), dots coloured by tier.
function renderChart() {
  const W = 640, H = 170, PL = 44, PR = 8, PT = 10, PB = 22;
  const xs = BOARD.map((r) => Math.log10(r[3])), ys = BOARD.map((r) => Math.log10(Math.max(1, r[8])));
  const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  const X = (x) => PL + (x - x0) / (x1 - x0) * (W - PL - PR);
  const Y = (y) => PT + (1 - (y - y0) / (y1 - y0)) * (H - PT - PB);
  const col = { 0: '#34D399', 1: '#22D3EE', 2: '#6B7280' };
  let dots = '';
  for (let i = 0; i < BOARD.length; i++) dots += '<circle cx="' + X(xs[i]).toFixed(1) + '" cy="' + Y(ys[i]).toFixed(1) + '" r="' + (BOARD[i][2] === 0 ? 3.4 : 2.4) + '" fill="' + col[BOARD[i][2]] + '" fill-opacity="0.85"/>';
  // Log-scale ticks: labelled powers of ten inside the data range (2–3 per
  // axis). The x labels sit under the axis; the "TVL, log scale" title moves
  // to the bottom-right end so it cannot collide with the $1B tick.
  function tickLabel(v) { return v >= 1e9 ? '$' + (v / 1e9) + 'B' : v >= 1e6 ? '$' + (v / 1e6) + 'M' : '$' + (v / 1e3) + 'K'; }
  let ticks = '';
  for (let e = 5; e <= 10; e++) {
    if (e > x0 + 0.15 && e < x1 - 0.15) {
      const x = X(e);
      ticks += '<line x1="' + x.toFixed(1) + '" y1="' + (H - PB) + '" x2="' + x.toFixed(1) + '" y2="' + (H - PB + 4) + '" stroke="#1F2937"/>' +
        '<text x="' + x.toFixed(1) + '" y="' + (H - 6) + '" fill="#9CA3AF" font-size="9" text-anchor="middle">' + tickLabel(Math.pow(10, e)) + '</text>';
    }
  }
  for (let e = 4; e <= 8; e++) {
    if (e > y0 + 0.15 && e < y1 - 0.15) {
      const y = Y(e);
      ticks += '<line x1="' + (PL - 4) + '" y1="' + y.toFixed(1) + '" x2="' + PL + '" y2="' + y.toFixed(1) + '" stroke="#1F2937"/>' +
        '<text x="' + (PL - 6) + '" y="' + (y + 3).toFixed(1) + '" fill="#9CA3AF" font-size="9" text-anchor="end">' + tickLabel(Math.pow(10, e)) + '</text>';
    }
  }
  $('#chart').innerHTML =
    '<line x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - PR) + '" y2="' + (H - PB) + '" stroke="#1F2937"/>' +
    '<line x1="' + PL + '" y1="' + PT + '" x2="' + PL + '" y2="' + (H - PB) + '" stroke="#1F2937"/>' + ticks +
    '<text x="' + (W - PR) + '" y="' + (H - 6) + '" fill="#9CA3AF" font-size="10" text-anchor="end">TVL, log scale</text>' +
    '<text x="6" y="' + (PT + 8) + '" fill="#9CA3AF" font-size="10">implied, log</text>' + dots;
}

// ---- detail drawer
function nearestPeers(r) {
  const lt = Math.log(r[3]);
  return PEERS.map((p) => ({ p, d: Math.abs(Math.log(p[1]) - lt) }))
    .sort((a, b) => a.d - b.d || (a.p[0] < b.p[0] ? -1 : 1))
    .slice(0, 3)
    .map((x) => x.p);
}

function openDetail(slug) {
  const idx = BOARD.findIndex((r) => r[0] === slug);
  if (idx < 0) return;
  const r = BOARD[idx];
  const fm = farmMath(r);
  const lnTvl = Math.log(r[3]);
  const catEff = CAT_EFFECTS[r[7]] || 0;
  // Launch value = implied / odds: the implied value already carries the
  // launch odds, so dividing them out recovers it (the 4-decimal odds
  // rounding moves it by 0.00005/odds — under 0.01% except the smallest
  // odds, 0.61% worst case). Recomputing from the rounded VALUE_SLOPE /
  // CAT_EFFECTS drifts up to ~0.6%, so the drawer would disagree with the
  // board's "If it launches" column.
  const launch = r[8] / r[9];
  const share = CAT_SHARES[r[7]] !== undefined ? CAT_SHARES[r[7]] : ODDS_GLOBAL_SHARE;
  const yrs = r[5] === null ? Math.log(Math.max(MEDIAN_YEARS, 0.05)) : Math.log(Math.max(r[5], 0.05));
  // change_7d in the data is in percent (-1.08 means -1.08%); the model uses
  // the fraction, winsorized to [-0.5, 1.0], and 0 when the snapshot has none.
  const growth = r[4] === null ? 0 : Math.max(-0.5, Math.min(1, r[4] / 100));
  const z = ODDS_RAW.c + ODDS_RAW.years * yrs + ODDS_RAW.share * share + ODDS_RAW.tvl * lnTvl + ODDS_RAW.growth * growth;
  const peers = nearestPeers(r);
  const steps = buildFarmSteps(r, fm);
  const p10 = Math.round(r[8] / Q80_FACTOR);
  const p90 = Math.round(r[8] * Q80_FACTOR);
  const p25 = Math.round(r[8] / Q50_FACTOR);
  const p75 = Math.round(r[8] * Q50_FACTOR);
  // Dollar figures in the drawer are rounded for display, and every
  // difference the reader sees is computed FROM those rounded figures, so
  // the arithmetic on screen is exact: the net shown is the displayed drop
  // minus the displayed fees, and the T-bill gap is the displayed T-bill
  // minus the displayed net. The verdict itself still comes from the
  // unrounded economics, so a $1 boundary case could in principle disagree
  // with the rounded gap — none of the 198 rows is within $1 of a test line.
  const dGross = Math.round(fm.gross), dFees = Math.round(GAS_TOTAL + fm.fees);
  const dNet = dGross - dFees, dTbill = Math.round(fm.tbill);
  const dGap = dNet - dTbill, dHour = Math.round(dNet / fm.hours);
  // Size multiple and category effect split the stored launch value, so the
  // factor table multiplies back to it exactly (before display rounding):
  // TVL × sizeMult × catMult = launch, and launch × odds = implied.
  // The factors are printed with 5 significant figures (odds is stored at 4
  // decimals, so it is exact): multiplying the PRINTED factors reproduces
  // the implied value within ~0.01% on every row — the old 3/2/2-decimal
  // display drifted by 0.92% on Steakhouse.
  const catMult = Math.exp(catEff);
  const sizeMult = launch / (r[3] * catMult);
  const sizeTxt = sizeMult.toPrecision(5);
  const catTxt = catMult.toPrecision(5);
  const oddsTxt = r[9].toFixed(4);
  const chgTxt = r[4] === null ? 'no 7d change' : r[4].toFixed(1) + '% 7d';
  const ageTxt = r[5] === null ? 'listing date unknown' : ageFmt(r[5]) + ' with no token';
  $('#detail').innerHTML =
    '<p class="muted">#' + (idx + 1) + ' of ' + BOARD.length + ' by implied value</p>' +
    '<h2>' + esc(r[1]) + '</h2>' +
    '<p class="muted">' + esc(r[7] || 'Unknown') + ' · ' + esc(r[6]) + ' · ' + usd(r[3]) + ' TVL · ' + chgTxt + ' · ' + ageTxt + '</p>' +
    '<div class="big">' + money(r[8]) + '</div>' +
    '<p class="muted">implied value × model estimate · ' + money(launch) + ' if it launches · token odds ' + pct(r[9], 0) + ' · range ' + money(p25) + '–' + money(p75) + '</p>' +
    '<h3>How the figure is made</h3>' +
    '<div class="kv">' +
    '<span>TVL</span><b>' + money(r[3]) + '</b>' +
    '<span>Size multiple, fitted</span><b>×' + sizeTxt + '</b>' +
    '<span>Category effect</span><b>×' + catTxt + '</b>' +
    '<span>Growth factor</span><b>×1.000</b>' +
    '<span>Age factor</span><b>×1.00</b>' +
    '<span>Token odds</span><b>×' + oddsTxt + '</b>' +
    '<span>Implied value</span><b>' + money(r[8]) + '</b></div>' +
    '<p class="muted">' + money(r[3]) + ' × ' + sizeTxt + ' × ' + catTxt + ' × 1.000 × 1.00 × ' + oddsTxt + ' = ' + money(r[8]) + '. The size multiple falls with TVL (fitted multiple slope ' + (VALUE_SLOPE - 1).toFixed(2) + '); the category effect is shrunk toward zero when a category has few peers. Growth and age are not in the value model: their factors are 1.000 and 1.00 by construction.</p>' +
    '<p class="muted">Token odds: logit = ' + ODDS_RAW.c + ' + ' + ODDS_RAW.years + ' × ln(years) + ' + ODDS_RAW.share + ' × category share + ' + ODDS_RAW.tvl + ' × ln(TVL) ' + (ODDS_RAW.growth < 0 ? '− ' + Math.abs(ODDS_RAW.growth) : '+ ' + ODDS_RAW.growth) + ' × growth = ' + z.toFixed(2) + ' → ' + (r[9] * 100).toFixed(0) + '%. Years listed ' + (r[5] === null ? 'unknown (median ' + MEDIAN_YEARS + 'y used)' : r[5]) + ', category share ' + share.toFixed(2) + ', 7-day growth ' + (r[4] === null ? 'n/a' : r[4].toFixed(1) + '%') + '.</p>' +
    '<h3>Nearest priced peers — their token trades</h3>' +
    '<table class="peer"><thead><tr><th>Token</th><th>Category</th><th>TVL</th><th>Market cap</th><th>Cap / TVL</th></tr></thead><tbody>' +
    peers.map((p) => '<tr><td>' + esc(p[0]) + '</td><td>' + esc(p[3] || 'Unknown') + '</td><td>' + usd(p[1]) + '</td><td>' + usd(p[2]) + '</td><td>' + (p[2] / p[1]).toFixed(2) + '×</td></tr>').join('') +
    '</tbody></table>' +
    '<h3>Farm verdict: ' + VERDICT_NAMES[fm.verdict] + '</h3>' +
    '<p>Deposit ' + money(fm.deposit) + ' (' + (state.plan / 100).toFixed(2) + '% of TVL). Expected drop ' + money(dGross) + '. Costs: gas ' + money(GAS_TOTAL) + ' + fees ' + money(Math.round(fm.fees)) + '. Net ' + money(dNet) + ' over ' + fm.hours + ' hours (' + money(dHour) + '/hour). T-bill bar ' + money(dTbill) + '; $25/hour bar.</p>' +
    '<p>A farm is worth it only if it beats both benchmarks: the same deposit in a T-bill at 4.5% a year earns ' + money(dTbill) + ' over ' + state.hor + ' weeks, and the work must pay more than $25 an hour. This one ' + (dGap > 0 ? 'beats the T-bill by ' + money(dGap) : dGap < 0 ? 'loses to the T-bill by ' + money(-dGap) : 'matches the T-bill to the dollar') + ' and pays ' + money(dHour) + ' an hour, so the verdict is ' + VERDICT_NAMES[fm.verdict] + ' — ' + (fm.verdict === 0 ? 'it clears both tests.' : fm.verdict === 1 ? 'it nets more than $0 but fails ' + ((fm.net <= fm.tbill && fm.nph <= HOUR_BAR) ? 'both tests.' : (fm.net <= fm.tbill ? 'the T-bill test.' : 'the $25-an-hour test.')) : 'it nets $0 or less.') + ' The deposit also earns the vault&rsquo;s own yield while it sits there, not counted here, so the T-bill line is the opportunity cost of the cash, not the whole return.</p>' +
    '<h3>Farm plan — 10 steps</h3><ol>' + steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
    '<p class="muted">Farm on ' + esc(r[6]) + ', the protocol&rsquo;s first chain from the snapshot. Every step above is written for this protocol and this chain.</p>';
  $('#drawer').hidden = false;
  document.body.classList.add('has-drawer');
  if (location.hash !== '#detail=' + slug) history.replaceState(null, '', '#detail=' + slug);
}
function closeDetail() {
  $('#drawer').hidden = true;
  document.body.classList.remove('has-drawer');
  history.replaceState(null, '', location.pathname + location.search);
}

// ---- wiring
function init() {
  renderChart();
  const cats = [...new Set(BOARD.map((r) => r[7] || 'Unknown'))].sort();
  $('#f-category').innerHTML = '<option value="">All categories</option>' + cats.map((c) => '<option>' + esc(c) + '</option>').join('');
  const chains = [...new Set(BOARD.map((r) => r[6]))].sort();
  $('#f-chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => '<option>' + esc(c) + '</option>').join('');
  renderTable();
  document.querySelectorAll('#verdict-tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#verdict-tabs button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); state.verdict = b.dataset.verdict; renderTable();
  }));
  $('#f-tier').addEventListener('change', (e) => { state.tier = e.target.value; renderTable(); });
  $('#f-category').addEventListener('change', (e) => { state.cat = e.target.value; renderTable(); });
  $('#f-chain').addEventListener('change', (e) => { state.chain = e.target.value; renderTable(); });
  $('#search').addEventListener('input', (e) => { state.q = e.target.value; renderTable(); });
  $('#plan-size').addEventListener('input', (e) => {
    state.plan = +e.target.value;
    $('#plan-val').textContent = (state.plan / 100).toFixed(2) + '% of TVL';
    renderTable();
  });
  $('#drop-share').addEventListener('input', (e) => {
    state.drop = +e.target.value;
    $('#drop-val').textContent = state.drop.toFixed(1) + '%';
    renderTable();
  });
  $('#horizon').addEventListener('input', (e) => {
    state.hor = +e.target.value;
    $('#hor-val').textContent = state.hor + ' wk';
    renderTable();
  });
  $('#btn-reset').addEventListener('click', () => {
    state.verdict = 'all'; state.tier = ''; state.cat = ''; state.chain = ''; state.q = ''; state.sort = 'rank'; state.dir = 1; state.mode = 'pre';
    state.plan = 2; state.drop = 7; state.hor = 12;
    $('#f-tier').value = ''; $('#f-category').value = ''; $('#f-chain').value = ''; $('#search').value = '';
    $('#plan-size').value = '2'; $('#drop-share').value = '7'; $('#horizon').value = '12';
    $('#plan-val').textContent = '0.02% of TVL'; $('#drop-val').textContent = '7.0%'; $('#hor-val').textContent = '12 wk';
    document.querySelectorAll('#verdict-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.verdict === 'all'));
    document.querySelectorAll('#mode-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.mode === 'pre'));
    renderTable();
  });
  $('#tbl').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = 1; }
      renderTable();
      return;
    }
    const a = e.target.closest('a.rowlink');
    if (a) { e.preventDefault(); openDetail(a.getAttribute('href').slice(8)); return; }
    const tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.dataset.slug);
  });
  document.querySelectorAll('#mode-tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#mode-tabs button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); state.mode = b.dataset.mode; renderTable();
  }));
  $('#close').addEventListener('click', closeDetail);
  $('#btn-csv').addEventListener('click', () => {
    const head = 'rank,slug,name,tier,category,chain,tvl_usd,change_7d,age_days,token_odds,if_launches_usd,implied_value_usd,p25_usd,p75_usd,verdict,net_fees_usd,net_per_hour_usd';
    const lines = visibleRows().map((x) => {
      const r = x.r, fm = farmMath(r);
      const p25 = Math.round(r[8] / Q50_FACTOR), p75 = Math.round(r[8] * Q50_FACTOR);
      return [x.rank, r[0], '"' + r[1].replace(/"/g, '""') + '"', TIER_NAMES[r[2]], '"' + (r[7] || '') + '"', r[6], r[3], r[4] === null ? '' : r[4], r[5] === null ? '' : Math.round(r[5] * 365), r[9], Math.round(r[8] / r[9]), r[8], p25, p75, VERDICT_NAMES[fm.verdict], Math.round(fm.net), fm.nph.toFixed(2)].join(',');
    });
    const blob = new Blob([[head].concat(lines).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'token-radar.csv'; a.click();
  });
  $('#btn-json').addEventListener('click', () => {
    const rows = visibleRows().map((x) => {
      const r = x.r, fm = farmMath(r);
      return { rank: x.rank, slug: r[0], name: r[1], tier: TIER_NAMES[r[2]], category: r[7], chain: r[6], tvl_usd: r[3], change_7d: r[4], years_listed: r[5], token_odds: r[9], if_launches_usd: Math.round(r[8] / r[9]), implied_value_usd: r[8], p25_usd: Math.round(r[8] / Q50_FACTOR), p75_usd: Math.round(r[8] * Q50_FACTOR), verdict: VERDICT_NAMES[fm.verdict], net_fees_usd: Math.round(fm.net), net_per_hour_usd: +fm.nph.toFixed(2) };
    });
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'token-radar.json'; a.click();
  });
  // Deep links: #detail=<slug> opens the drawer; #tier=watchlist|offlist|
  // emerging selects the tier; #verdict=farm|marginal|skip selects the
  // verdict tab. Applied on load and on every hash change, because a
  // same-document navigation does not reload the page.
  applyHash();
  window.addEventListener('hashchange', applyHash);
  // Screenshot helper: #scroll=board brings the board to the top of the view.
  // Native fragment scrolling (#boardsec) is unreliable in headless captures,
  // so do it explicitly after render.
  const h0 = location.hash || '';
  if (h0.includes('scroll=board')) {
    const sec = document.querySelector('.boardsec');
    if (sec) window.scrollTo(0, sec.getBoundingClientRect().top + window.scrollY - 8);
  }
  // Verification hook: #selftest writes every row's farm steps as JSON for the
  // build check script. It only runs on that hash.
  if (h0.includes('selftest')) {
    const all = BOARD.map((r) => buildFarmSteps(r, farmMath(r)));
    const pre = document.createElement('pre');
    pre.id = 'selftest';
    pre.textContent = JSON.stringify(all);
    document.body.appendChild(pre);
  }
}
function applyHash() {
  const hash = location.hash || '';
  const mD = hash.match(/#detail=([a-z0-9-]+)/);
  if (mD) openDetail(mD[1]);
  else if (!$('#drawer').hidden) closeDetail();
  const mT = hash.match(/tier=(watchlist|offlist|emerging)/);
  if (mT) {
    const code = mT[1] === 'watchlist' ? '0' : mT[1] === 'offlist' ? '1' : '2';
    state.tier = code;
    $('#f-tier').value = code;
    renderTable();
  }
  const vm = hash.match(/#verdict=(farm|marginal|skip)/i);
  if (vm) {
    const want = vm[1].charAt(0).toUpperCase() + vm[1].slice(1);
    const b = document.querySelector('#verdict-tabs button[data-verdict="' + want + '"]');
    if (b) { b.click(); document.getElementById('board').scrollIntoView(); }
  }
}

if (typeof document !== 'undefined' && document.querySelector) init();
