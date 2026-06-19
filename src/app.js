// Landing-page controller: builds the vocation picker + stat targets, loads the
// HiGHS WASM solver, runs solveMaxTotal, and renders the result. Authoring source
// lives in src/; `make` bundles it into a single self-contained index.js.

import { loadHighs } from './highs-loader.js';
import { solveMaxTotal } from './solver.js';
import {
  BASIC, ALL, STATS, WEIGHT_CLASSES, WEIGHT_BASE_ST, DEFAULT_WEIGHT,
  WEIGHT_RANGE, WEIGHT_STAREGEN, WEIGHT_ENCUMBRANCE,
  COMBAT, VITALS, MATCH_TILDE_TOL, MATCH_PARTNERS, STAT_MAX, owocUrl, QUOTES,
} from './data.js';

// Display labels (the data uses terse keys).
const VOC_LABEL = {
  fighter: 'Fighter', strider: 'Strider', mage: 'Mage',
  warrior: 'Warrior', ranger: 'Ranger', sorcerer: 'Sorcerer',
  mknight: 'Mystic Knight', assassin: 'Assassin', marcher: 'Magick Archer',
};
const STAT_LABEL = {
  hp: 'HP', st: 'Stamina', attack: 'Attack',
  defense: 'Defense', mattack: 'Magick Atk', mdefense: 'Magick Def',
};
const RANGES = [
  ['to10', '1 → 10', 9],
  ['to100', '10 → 100', 90],
  ['to200', '100 → 200', 100],
];

// Hybrid vocations (Mystic Knight, Assassin, Magick Archer) are Arisen-only —
// pawns cannot take them. Tagged distinctly from the plain advanced vocations.
const HYBRID = new Set(['mknight', 'assassin', 'marcher']);

// Vocation name colors (view-only), mirroring the Python palette. A single color
// applies to the whole name; a [a, b] pair is a split-color name (the hybrids):
// the two halves get the two colors. For a two-word name we split on the space
// (e.g. "Magick" / "Archer"); for a single word, at the midpoint (like Python).
const VOC_COLORS = {
  fighter: 'red', strider: 'yellow', mage: 'blue',
  warrior: 'red', ranger: 'yellow', sorcerer: 'blue',
  mknight: ['red', 'blue'], assassin: ['red', 'yellow'], marcher: ['yellow', 'blue'],
};

// Return HTML for a colored vocation name (full label, not the terse key).
function colorVoc(v) {
  const label = VOC_LABEL[v];
  const style = VOC_COLORS[v] || 'red';
  if (!Array.isArray(style)) return `<span class="vc-${style}">${label}</span>`;
  const sp = label.indexOf(' ');
  const at = sp >= 0 ? sp : Math.floor(label.length / 2);
  const a = label.slice(0, sp >= 0 ? sp : at);
  const b = label.slice(sp >= 0 ? sp + 1 : at); // drop the space between words
  return `<span class="vc-${style[0]}">${a}</span>` +
         (sp >= 0 ? ' ' : '') +
         `<span class="vc-${style[1]}">${b}</span>`;
}

const $ = (id) => document.getElementById(id);
const status = $('status');

// --- build the vocation checkboxes ---
const vocsEl = $('vocs');
for (const v of ALL) {
  const cls = BASIC.includes(v) ? 'basic' : HYBRID.has(v) ? 'hybrid' : 'advanced';
  const label = document.createElement('label');
  label.className = 'voc';
  if (HYBRID.has(v)) label.dataset.hybrid = '1';
  label.innerHTML =
    `<input type="checkbox" value="${v}" checked>` +
    `<span>${colorVoc(v)}</span>` +
    `<span class="tag ${cls}">${cls}</span>`;
  const cb = label.querySelector('input');
  cb.addEventListener('change', () => label.classList.toggle('off', !cb.checked));
  vocsEl.appendChild(label);
}

// Boolean option checkboxes, declared once: { DOM id, solver opt key, URL param }.
// Everything that iterates the toggles — solve, encode, apply, reset — uses this
// table instead of naming each checkbox three times over.
const TOGGLES = [
  { el: $('pawn'), opt: 'pawn', param: 'p' },
  { el: $('min-voc'), opt: 'minimizeVocations', param: 'mv' },
  { el: $('no-pre10'), opt: 'noPre10Switch', param: 'nx' },
];
const pawnEl = $('pawn'); // pawn also drives the hybrid-vocation greying below

// Pawn mode disables the hybrid (Arisen-only) vocations in the UI: their
// checkboxes are greyed out and ignored, and the solver excludes them too.
function updatePawnUI() {
  const on = pawnEl.checked;
  for (const label of vocsEl.querySelectorAll('.voc[data-hybrid]')) {
    const cb = label.querySelector('input');
    cb.disabled = on;
    label.classList.toggle('off', on || !cb.checked);
  }
}
pawnEl.addEventListener('change', updatePawnUI);
updatePawnUI();

const selectedVocs = () =>
  [...vocsEl.querySelectorAll('input:checked')].map((cb) => cb.value);

// --- populate the weight-class selector (sets level-1 stamina) ---
// Only base stamina affects the solve; the body-weight range, stamina-recovery
// rate, and max encumbrance are shown as read-only info for the chosen class.
const weightEl = $('weight');
const weightInfoEl = $('weight-info');
for (const w of WEIGHT_CLASSES) {
  const opt = document.createElement('option');
  opt.value = w;
  opt.textContent = `${w} (${WEIGHT_RANGE[w]}) — base st ${WEIGHT_BASE_ST[w]}`;
  if (w === DEFAULT_WEIGHT) opt.selected = true;
  weightEl.appendChild(opt);
}

function updateWeightInfo() {
  const w = weightEl.value;
  const sg = WEIGHT_STAREGEN[w];
  weightInfoEl.innerHTML =
    `<span>body weight <b>${WEIGHT_RANGE[w]}</b></span>` +
    `<span>base stamina <b>${WEIGHT_BASE_ST[w]}</b></span>` +
    `<span>stamina regen <b>${sg.rate}/s</b> (${sg.pct})</span>` +
    `<span>max encumbrance <b>${WEIGHT_ENCUMBRANCE[w]}kg</b></span>`;
}
weightEl.addEventListener('change', updateWeightInfo);
updateWeightInfo();

// --- build the stat range inputs (min / max per stat) ---
// Default minimum floors pre-populated for convenience (user can clear/change).
const DEFAULT_MIN = { hp: 3500, defense: 300, mdefense: 300 };
const rangesEl = $('ranges');
for (const k of STATS) {
  const name = document.createElement('span');
  name.className = 'rname';
  name.textContent = STAT_LABEL[k];
  const mk = (kind) => {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = kind === 'divisor' ? '1' : '0';
    // Cap min/max/divisor at the stat's maximum reachable value so the solver is
    // never handed an impossible target (the `max` attr drives the spinner + our
    // validation in collectBounds). A divisor above the max has no reachable
    // nonzero multiple, so it's capped the same way.
    inp.max = String(STAT_MAX[k]);
    inp.placeholder = kind === 'min' ? 'min' : kind === 'max' ? 'max' : '÷';
    inp.dataset.stat = k;
    inp.dataset.kind = kind;
    if (kind === 'min' && DEFAULT_MIN[k] != null) inp.value = DEFAULT_MIN[k];
    inp.addEventListener('input', updateExactCues);
    return inp;
  };
  // bias selector: integers -5..+5, default 0 (neutral)
  const bias = document.createElement('select');
  bias.dataset.stat = k;
  bias.dataset.kind = 'bias';
  for (let b = 5; b >= -5; b--) {
    const opt = document.createElement('option');
    opt.value = String(b);
    opt.textContent = b > 0 ? `+${b}` : String(b);
    if (b === 0) opt.selected = true;
    bias.appendChild(opt);
  }
  bias.addEventListener('change', updateBiasCue);

  // match selector: "none", then "=partner" / "~partner" for each allowed partner.
  const matchSel = document.createElement('select');
  matchSel.dataset.stat = k;
  matchSel.dataset.kind = 'match';
  const none = document.createElement('option');
  none.value = ''; none.textContent = '—'; none.selected = true;
  matchSel.appendChild(none);
  for (const partner of MATCH_PARTNERS[k]) {
    for (const op of ['=', '~']) {
      const opt = document.createElement('option');
      opt.value = `${op}${partner}`;
      opt.textContent = `${op} ${STAT_LABEL[partner]}`;
      matchSel.appendChild(opt);
    }
  }
  matchSel.addEventListener('change', updateMatchCue);

  // maximize radio: exclusive across all stats (shared name); clicking the
  // already-checked one clears it (so "maximize nothing" is reachable).
  const maxRadio = document.createElement('input');
  maxRadio.type = 'radio';
  maxRadio.name = 'maximize';
  maxRadio.value = k;
  maxRadio.dataset.stat = k;
  maxRadio.dataset.kind = 'maximize';
  maxRadio.title = `Maximize ${STAT_LABEL[k]} (ignores all other settings)`;
  maxRadio.addEventListener('click', onMaximizeClick);

  rangesEl.append(name, mk('min'), mk('max'), mk('divisor'), bias, matchSel, maxRadio);
}

// Visual cues: a stat's min/max go green when equal and set (exact-value
// request); a set divisor field is highlighted gold. A divisor ignores the max,
// so the exact cue is suppressed when a divisor is present.
function updateExactCues() {
  for (const k of STATS) {
    const [mn, mx, dv] = statInputs(k);
    const hasDiv = dv.value !== '';
    const exact = !hasDiv && mn.value !== '' && mn.value === mx.value;
    mn.classList.toggle('exact', exact);
    mx.classList.toggle('exact', exact);
    dv.classList.toggle('div-on', hasDiv);
  }
}

// Color a bias select by sign (green favor, red deprioritize, neutral at 0).
function updateBiasCue(e) {
  const sel = e.target;
  const v = Number(sel.value);
  sel.classList.toggle('bias-pos', v > 0);
  sel.classList.toggle('bias-neg', v < 0);
}

// A radio can't normally be unchecked by clicking it; track the last-checked one
// so a second click on the same radio clears the whole group (maximize nothing).
let lastMaximize = null;
function onMaximizeClick(e) {
  const r = e.target;
  if (lastMaximize === r.value) {
    r.checked = false;
    lastMaximize = null;
  } else {
    lastMaximize = r.value;
  }
}

// Re-sync every visual cue + dependent control to the current field values.
// Used after bulk changes (URL restore, reset).
function refreshAllCues() {
  updateExactCues();
  for (const k of STATS) {
    biasSelect(k).dispatchEvent(new Event('change'));
    matchSelect(k).dispatchEvent(new Event('change'));
  }
  updatePawnUI();
  updateWeightInfo();
}

// Color a match select green once a partner is chosen.
function updateMatchCue(e) {
  e.target.classList.toggle('match-on', e.target.value !== '');
}

const statInputs = (k) => [
  rangesEl.querySelector(`input[data-stat="${k}"][data-kind="min"]`),
  rangesEl.querySelector(`input[data-stat="${k}"][data-kind="max"]`),
  rangesEl.querySelector(`input[data-stat="${k}"][data-kind="divisor"]`),
];

const biasSelect = (k) =>
  rangesEl.querySelector(`select[data-stat="${k}"][data-kind="bias"]`);

const matchSelect = (k) =>
  rangesEl.querySelector(`select[data-stat="${k}"][data-kind="match"]`);

// The stat currently selected to maximize, or null. (Radios share a name, so at
// most one is checked.)
function collectMaximize() {
  const r = rangesEl.querySelector('input[data-kind="maximize"]:checked');
  return r ? r.value : null;
}

// Collect the per-stat bias map (omitting neutral 0).
function collectBias() {
  const bias = {};
  for (const k of STATS) {
    const v = Number(biasSelect(k).value);
    if (v !== 0) bias[k] = v;
  }
  return bias;
}

// Collect match pairs as {a, b, tol}. A match is symmetric, so each pair is
// emitted once (deduped by an unordered key). The '~' tolerance depends on the
// pair kind: 100 for the hp/st vitals pair, 10 for combat pairs.
function collectMatch() {
  const pairs = [];
  const seen = new Set();
  for (const k of STATS) {
    const v = matchSelect(k).value; // '' | '=partner' | '~partner'
    if (!v) continue;
    const op = v[0];
    const partner = v.slice(1);
    const key = [k, partner].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = VITALS.includes(k) ? 'vitals' : 'combat';
    const tol = op === '=' ? 0 : MATCH_TILDE_TOL[kind];
    pairs.push({ a: k, b: partner, tol });
  }
  return pairs;
}

// Collect the bounds map for the solver, omitting empty fields. Returns
// { bounds, error }: error is set on invalid input (e.g. min > max).
function collectBounds() {
  const bounds = {};
  for (const k of STATS) {
    const [mn, mx, dv] = statInputs(k);
    const min = mn.value === '' ? null : Number(mn.value);
    const max = mx.value === '' ? null : Number(mx.value);
    const divisor = dv.value === '' ? null : Number(dv.value);
    const cap = STAT_MAX[k];
    if (min != null && (!Number.isInteger(min) || min < 0))
      return { error: `${STAT_LABEL[k]} min must be a non-negative whole number.` };
    if (max != null && (!Number.isInteger(max) || max < 0))
      return { error: `${STAT_LABEL[k]} max must be a non-negative whole number.` };
    if (divisor != null && (!Number.isInteger(divisor) || divisor < 1))
      return { error: `${STAT_LABEL[k]} divisor must be a whole number of at least 1.` };
    // Cap every field at the stat's maximum reachable value: a target above it
    // can never be met, so reject up front rather than hand the solver an
    // infeasible (and potentially slow) problem.
    if (min != null && min > cap)
      return { error: `${STAT_LABEL[k]} min (${min}) exceeds the maximum reachable ${cap}.` };
    if (max != null && max > cap)
      return { error: `${STAT_LABEL[k]} max (${max}) exceeds the maximum reachable ${cap}.` };
    if (divisor != null && divisor > cap)
      return { error: `${STAT_LABEL[k]} divisor (${divisor}) exceeds the maximum reachable ${cap}; no multiple is reachable.` };
    // A divisor drops the max (mirrors the prototype), so don't enforce min<=max
    // against a max that won't apply.
    if (divisor == null && min != null && max != null && min > max)
      return { error: `${STAT_LABEL[k]} min (${min}) is greater than its max (${max}).` };
    if (min != null || max != null || divisor != null) bounds[k] = { min, max, divisor };
  }
  return { bounds };
}

// --- shareable URL: encode/restore every selection in the query string ---
//
// Params (all optional, omitted when at their default):
//   v   = CSV of allowed vocations (omitted when all are on)
//   w   = weight class (omitted when M)
//   p   = 1 when pawn mode is on
//   mv  = 1 when minimize-vocations is on
//   nx  = 1 when "no pre-10 vocation switch" is on
//   <stat>_min   = min bound
//   <stat>_max   = max bound
//   <stat>_div   = divisor
//   <stat>_bias  = bias (-5..5)
//   <stat>_match = "=partner" or "~partner" (emitted for both ends of a pair)
//   max  = the single stat to maximize (ignores all other settings)
// Stat keys are the canonical short names (hp, st, attack, ...).

// Read the form into URLSearchParams (only non-default values).
function encodeSelections() {
  const params = new URLSearchParams();
  const allowed = selectedVocs();
  if (allowed.length !== ALL.length) params.set('v', allowed.join(','));
  if (weightEl.value !== DEFAULT_WEIGHT) params.set('w', weightEl.value);
  for (const t of TOGGLES) if (t.el.checked) params.set(t.param, '1');
  for (const k of STATS) {
    const [mn, mx, dv] = statInputs(k);
    if (mn.value !== '') params.set(`${k}_min`, mn.value);
    if (mx.value !== '') params.set(`${k}_max`, mx.value);
    if (dv.value !== '') params.set(`${k}_div`, dv.value);
    const b = biasSelect(k).value;
    if (b !== '0') params.set(`${k}_bias`, b);
    const m = matchSelect(k).value;
    if (m !== '') params.set(`${k}_match`, m);
  }
  const maximize = collectMaximize();
  if (maximize) params.set('max', maximize);
  return params;
}

// Apply query params back onto the form. Returns true if any were present.
function applySelections(params) {
  if ([...params.keys()].length === 0) return false;

  // Vocations: only those listed stay checked (default = all on).
  if (params.has('v')) {
    const want = new Set(params.get('v').split(',').filter(Boolean));
    for (const cb of vocsEl.querySelectorAll('input[type="checkbox"]')) {
      cb.checked = want.has(cb.value);
      cb.closest('.voc').classList.toggle('off', !cb.checked);
    }
  }
  if (params.has('w') && WEIGHT_BASE_ST[params.get('w')] != null) weightEl.value = params.get('w');
  for (const t of TOGGLES) t.el.checked = params.get(t.param) === '1';

  for (const k of STATS) {
    const [mn, mx, dv] = statInputs(k);
    mn.value = params.get(`${k}_min`) ?? '';
    mx.value = params.get(`${k}_max`) ?? '';
    dv.value = params.get(`${k}_div`) ?? '';
    const sel = biasSelect(k);
    const b = params.get(`${k}_bias`);
    sel.value = b != null && [...sel.options].some((o) => o.value === b) ? b : '0';
    const msel = matchSelect(k);
    const m = params.get(`${k}_match`);
    msel.value = m != null && [...msel.options].some((o) => o.value === m) ? m : '';
  }
  // Maximize radio (exclusive). Set the matching radio and sync the click tracker.
  const maxStat = params.get('max');
  lastMaximize = STATS.includes(maxStat) ? maxStat : null;
  for (const k of STATS) {
    const r = rangesEl.querySelector(`input[data-kind="maximize"][value="${k}"]`);
    r.checked = k === lastMaximize;
  }
  refreshAllCues();
  return true;
}

// Build the absolute share URL for the current selections and show it.
function showShareUrl() {
  const params = encodeSelections();
  const qs = params.toString();
  const url = location.origin + location.pathname + (qs ? '?' + qs : '');
  $('share-url').value = url;
  // keep the address bar in sync so a plain reload preserves the config too
  history.replaceState(null, '', url);
}

// --- render helpers ---
function renderPlan(start, counts) {
  const body = $('plan').querySelector('tbody');
  body.innerHTML = '';
  // start row
  body.insertAdjacentHTML('beforeend',
    `<tr><td class="range">start</td><td class="num">—</td>` +
    `<td class="levels">${colorVoc(start)}</td></tr>`);
  for (const [tier, label, size] of RANGES) {
    const parts = Object.entries(counts[tier] || {})
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => `${colorVoc(v)} <span class="n">×${n}</span>`)
      .join('&nbsp;&nbsp;') || '—';
    body.insertAdjacentHTML('beforeend',
      `<tr><td class="range">${label}</td><td class="num">${size}</td>` +
      `<td class="levels">${parts}</td></tr>`);
  }
  // Pre-level-10 vocation-change warning: you normally can't switch vocation
  // before level 10, so any 1→10 level in a vocation other than the start
  // requires the Hard Mode restart trick (mirrors the Python prototype).
  const warn = $('pre10-warn');
  const switchesPre10 = Object.entries(counts.to10 || {})
    .some(([v, n]) => v !== start && n > 0);
  if (switchesPre10) {
    warn.innerHTML =
      '⚠ This build changes vocation before level 10. ' +
      'To do it, restart the game in Hard Mode — that resets save progress, but the ' +
      'character keeps its levels and items.';
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

// Describe a stat's requested bound for the Target column.
function targetText(b) {
  if (!b) return { text: '—', exact: false };
  const { min, max, divisor } = b;
  if (divisor != null) {
    // divisor drops the max; only a min floor (if any) still applies
    const floor = min != null ? `, ≥ ${min}` : '';
    return { text: `÷ ${divisor}${floor}`, exact: false };
  }
  if (min != null && max != null) {
    if (min === max) return { text: `= ${min}`, exact: true };
    return { text: `${min}–${max}`, exact: false };
  }
  if (min != null) return { text: `≥ ${min}`, exact: false };
  return { text: `≤ ${max}`, exact: false };
}

function renderStats(stats, total, bounds) {
  const body = $('stats').querySelector('tbody');
  body.innerHTML = '';
  for (const k of STATS) {
    const t = targetText(bounds?.[k]);
    body.insertAdjacentHTML('beforeend',
      `<tr><td class="stat-name">${STAT_LABEL[k]}</td>` +
      `<td class="num stat-val">${stats[k]}</td>` +
      `<td class="target${t.exact ? ' exact' : ''}">${t.text}</td></tr>`);
  }
  body.insertAdjacentHTML('beforeend',
    `<tr class="sum"><td>Total</td><td class="num">${total}</td><td></td></tr>`);
}

// Show a random flavor quote, avoiding an immediate repeat. textContent keeps it
// safe against any punctuation in the quote strings.
let lastQuote = -1;
function showQuote() {
  let i = Math.floor(Math.random() * QUOTES.length);
  if (QUOTES.length > 1 && i === lastQuote) i = (i + 1) % QUOTES.length;
  lastQuote = i;
  const { text, who } = QUOTES[i];
  const el = $('quote');
  el.textContent = text;
  const cite = document.createElement('span');
  cite.className = 'who';
  cite.textContent = who;
  el.appendChild(cite);
  el.hidden = false;
}

// --- solve ---
const solveBtn = $('solve');
let highs = null; // HiGHS solver instance, set once the wasm loads

async function runSolve() {
  if (!highs) return;
  const allowed = selectedVocs();
  const startPool = allowed.filter((v) => BASIC.includes(v));
  status.classList.remove('err');
  if (startPool.length === 0) {
    status.textContent = 'Pick at least one basic vocation (Fighter / Strider / Mage) as a start.';
    status.classList.add('err');
    return;
  }
  const { bounds, error } = collectBounds();
  if (error) {
    status.textContent = error;
    status.classList.add('err');
    return;
  }
  const weight = weightEl.value;
  const bias = collectBias();
  const match = collectMatch();
  const maximize = collectMaximize();
  const toggles = Object.fromEntries(TOGGLES.map((t) => [t.opt, t.el.checked]));
  solveBtn.disabled = true;
  status.textContent = 'Solving…';
  try {
    const t0 = performance.now();
    const build = solveMaxTotal(highs, { allowed, startPool, bounds, weight, bias, match, maximize, ...toggles });
    const ms = (performance.now() - t0).toFixed(0);
    const kind = toggles.pawn ? 'pawn' : 'Arisen';
    const goal = maximize ? ` <span class="wtag">— max ${STAT_LABEL[maximize]}</span>` : '';
    $('result-head').innerHTML =
      `Best ${kind} build — start as ${colorVoc(build.start)} <span class="wtag">(${weight})</span>${goal}`;
    renderPlan(build.start, build.counts);
    renderStats(build.stats, build.total, bounds);
    showShareUrl();
    const owoc = owocUrl(build);
    const owocEl = $('owoc-url');
    owocEl.href = owoc;
    owocEl.textContent = owoc;
    // owoc assumes the M weight class; warn when this build uses another, since
    // its stamina (base st) won't match there.
    $('owoc-warn').hidden = weight === DEFAULT_WEIGHT;
    showQuote();
    $('results').style.display = 'block';
    status.textContent = `Solved in ${ms} ms.`;
  } catch (e) {
    status.textContent = 'No solution: ' + e.message;
    status.classList.add('err');
  } finally {
    solveBtn.disabled = false;
  }
}

solveBtn.disabled = true;
solveBtn.addEventListener('click', runSolve);

// --- copy-to-clipboard for the share link ---
$('share-copy').addEventListener('click', async () => {
  const btn = $('share-copy');
  const input = $('share-url');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy'); // fallback for non-secure contexts
  }
  btn.textContent = 'Copied';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
});

// --- reset all inputs to their initial defaults ---
// Mirrors the fresh, no-params page state: all vocations on, weight M, pawn off,
// default min floors pre-filled, everything else cleared, biases neutral.
function resetSelections() {
  for (const cb of vocsEl.querySelectorAll('input[type="checkbox"]')) {
    cb.checked = true;
    cb.closest('.voc').classList.remove('off');
  }
  for (const t of TOGGLES) t.el.checked = false;
  weightEl.value = DEFAULT_WEIGHT;
  for (const k of STATS) {
    const [mn, mx, dv] = statInputs(k);
    mn.value = DEFAULT_MIN[k] != null ? DEFAULT_MIN[k] : '';
    mx.value = '';
    dv.value = '';
    biasSelect(k).value = '0';
    matchSelect(k).value = '';
  }
  for (const r of rangesEl.querySelectorAll('input[data-kind="maximize"]')) r.checked = false;
  lastMaximize = null;
  // refresh dependent UI and clear the shared-state bits
  refreshAllCues();
  $('results').style.display = 'none';
  history.replaceState(null, '', location.origin + location.pathname);
  status.classList.remove('err');
  // Restore the Solve button: enabled once the solver is loaded. (A solve may
  // still be in flight and left it disabled; reset shouldn't strand it greyed.)
  solveBtn.disabled = !highs;
  status.textContent = highs ? 'Reset to defaults.' : status.textContent;
}
$('reset').addEventListener('click', resetSelections);

// --- restore selections from the URL, then load the solver (auto-solve if shared) ---
const sharedConfig = applySelections(new URLSearchParams(location.search));

(async () => {
  try {
    highs = await loadHighs();
    solveBtn.disabled = false;
    if (sharedConfig) {
      status.textContent = 'Restored shared configuration — solving…';
      await runSolve();
    } else {
      status.textContent = 'Ready.';
    }
  } catch (e) {
    status.textContent = 'Failed to load solver: ' + e.message;
    status.classList.add('err');
  }
})();
