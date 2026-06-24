// SPDX-License-Identifier: MIT
// Landing-page controller: builds the vocation picker + stat targets, loads the
// HiGHS WASM solver, runs solveMaxTotal, and renders the result. Authoring source
// lives in src/; `make` bundles it into a single self-contained index.html.

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

// --- theme ---------------------------------------------------------------
// The CSS exposes three palettes via :root / html[data-theme]. The picker
// chooses one, persisted in localStorage. "auto" (the default) follows the OS
// light/dark preference and live-updates when the OS flips.
const THEME_KEY = 'ddda-theme';
const osDark = matchMedia('(prefers-color-scheme: dark)');

function applyTheme(choice) {
  // resolve "auto" to a concrete palette; "default" maps to :root (no attr)
  const resolved = choice === 'auto' ? (osDark.matches ? 'dark' : 'light') : choice;
  if (resolved === 'default') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', resolved);
}

function initTheme() {
  let choice = 'auto';
  try { choice = localStorage.getItem(THEME_KEY) || 'auto'; } catch {}
  const sel = $('theme');
  if (sel) sel.value = choice;
  applyTheme(choice);
  if (sel) sel.addEventListener('change', () => {
    applyTheme(sel.value);
    try { localStorage.setItem(THEME_KEY, sel.value); } catch {}
  });
  // when on "auto", track OS theme changes live
  osDark.addEventListener('change', () => {
    if (($('theme')?.value ?? 'auto') === 'auto') applyTheme('auto');
  });
}
initTheme();

// --- build the vocation checkboxes ---
// Two columns for a narrower (mobile-friendly) layout: basics on the left,
// the rest on the right (advanced first, then hybrids — that's ALL order minus
// the basics). Each column is its own container under #vocs.
const vocsEl = $('vocs');
const leftCol = document.createElement('div');
const rightCol = document.createElement('div');
leftCol.className = rightCol.className = 'voc-col';
vocsEl.append(leftCol, rightCol);

// Mark rows that currently carry a requirement (a non-empty, enabled require field)
// so they can be styled. Called from the allow/require row handlers, updatePawnUI,
// and refreshAllCues (URL restore / reset).
function updateRequireUI() {
  for (const input of vocsEl.querySelectorAll('.voc input.require')) {
    const on = input.value !== '' && !input.disabled;
    input.closest('.voc').classList.toggle('required', on);
  }
}

for (const v of ALL) {
  const isBasic = BASIC.includes(v);
  // A row is a <div> holding the allow checkbox (in its own <label> so clicking the
  // name toggles allow) plus a per-vocation "minimum levels in 10→100" number field
  // (blank = no requirement). The vocation id lives in data-voc since the field's
  // value is the level count. Vocation color (via colorVoc) conveys basic/advanced/
  // hybrid; hybrids are also tagged data-hybrid for pawn-mode greying.
  const row = document.createElement('div');
  row.className = 'voc';
  if (HYBRID.has(v)) row.dataset.hybrid = '1';
  row.innerHTML =
    `<label class="voc-allow"><input type="checkbox" value="${v}" checked>` +
    `<span>${colorVoc(v)}</span></label>` +
    `<span class="voc-require">` +
    `<input type="number" class="require" data-voc="${v}" min="1" max="90" step="1" placeholder="–" ` +
    `aria-label="Minimum levels in 10→100">` +
    `<i class="info" title="Require this vocation to take at least this many of the 90 ` +
    `level-10→100 levels. Leave blank for no requirement. Setting it also allows the ` +
    `vocation; the required minimums across all vocations must total ≤ 90.">ⓘ</i></span>`;
  const allow = row.querySelector('input[type="checkbox"]:not(.require)');
  const reqInput = row.querySelector('input.require');
  allow.addEventListener('change', () => {
    row.classList.toggle('off', !allow.checked);
    if (!allow.checked) reqInput.value = ''; // un-allowing clears any requirement
    updateRequireUI();
  });
  reqInput.addEventListener('input', () => {
    if (reqInput.value !== '') { allow.checked = true; row.classList.remove('off'); } // require implies allow
    updateRequireUI();
  });
  (isBasic ? leftCol : rightCol).appendChild(row);
}

// Tuck the option checkboxes and the weight-class selector into the left column,
// below the basic vocations (so they sit to the left of the hybrid vocations in
// the right column). They're authored in the template after #vocs; move the DOM
// nodes, keeping their ids/listeners intact.
leftCol.appendChild($('weight').closest('.wsel'));
for (const id of ['pawn', 'min-voc', 'no-pre10']) leftCol.appendChild($(id).closest('.pawn'));
// (the weight-class info display lives in the results panel, updated on solve)

// Boolean option checkboxes, declared once: { DOM id, solver opt key, URL param }.
// Everything that iterates the toggles — solve, encode, apply, reset — uses this
// table instead of naming each checkbox three times over.
const TOGGLES = [
  { el: $('pawn'), opt: 'pawn', param: 'p' },
  { el: $('min-voc'), opt: 'minimizeVocations', param: 'mv' },
  { el: $('no-pre10'), opt: 'noPre10Switch', param: 'nx' },
];
const pawnEl = $('pawn'); // pawn also drives the hybrid-vocation greying below

// Pawn mode disables the hybrid (Arisen-only) vocations in the UI: their allow +
// require fields are greyed out and ignored, and the solver excludes them too.
function updatePawnUI() {
  const on = pawnEl.checked;
  for (const row of vocsEl.querySelectorAll('.voc[data-hybrid]')) {
    const allow = row.querySelector('input[type="checkbox"]:not(.require)');
    const reqInput = row.querySelector('input.require');
    allow.disabled = on;
    reqInput.disabled = on;
    if (on) reqInput.value = ''; // a pawn can't require a hybrid
    row.classList.toggle('off', on || !allow.checked);
  }
  updateRequireUI();
}
pawnEl.addEventListener('change', updatePawnUI);
updatePawnUI();

const selectedVocs = () =>
  // Scope to .voc and exclude .require: the option toggles (pawn/min-voc/no-pre10)
  // also live in #vocs (value "on"), and each row now also has a require field —
  // neither must leak into the allowed-vocation list.
  [...vocsEl.querySelectorAll('.voc input[type="checkbox"]:not(.require):checked')].map((cb) => cb.value);

// --- populate the weight-class selector (sets level-1 stamina) ---
// Only base stamina affects the solve; the body-weight range, stamina-recovery
// rate, and max encumbrance are shown as read-only info for the chosen class.
const weightEl = $('weight');
const weightInfoEl = $('weight-info');
for (const w of WEIGHT_CLASSES) {
  const opt = document.createElement('option');
  opt.value = w;
  opt.textContent = `${w} (${WEIGHT_RANGE[w]})`;
  if (w === DEFAULT_WEIGHT) opt.selected = true;
  weightEl.appendChild(opt);
}

// Weight-class help icon: the same facts the build summary shows, but for every
// class at once (one line per class). Only base stamina affects the solve; the
// rest are informational.
$('weight-help').title =
  'Weight class affects base stamina (the only stat the solver uses) plus a few ' +
  'informational facts. By body weight:\n' +
  WEIGHT_CLASSES.map((w) => {
    const sg = WEIGHT_STAREGEN[w];
    return `${w} (${WEIGHT_RANGE[w]}): base stamina ${WEIGHT_BASE_ST[w]}, ` +
           `regen ${sg.rate}/s (${sg.pct}), max encumbrance ${WEIGHT_ENCUMBRANCE[w]}kg`;
  }).join('\n');

function updateWeightInfo() {
  const w = weightEl.value;
  const sg = WEIGHT_STAREGEN[w];
  weightInfoEl.innerHTML =
    `<span>weight <b>${WEIGHT_RANGE[w]}</b></span>` +
    `<span>base stamina <b>${WEIGHT_BASE_ST[w]}</b></span>` +
    `<span>stamina regen <b>${sg.rate}/s</b> (${sg.pct})</span>` +
    `<span>max encumbrance <b>${WEIGHT_ENCUMBRANCE[w]}kg</b></span>`;
}
weightEl.addEventListener('change', updateWeightInfo);
updateWeightInfo();

// --- build the stat range inputs (min / max per stat) ---
const rangesEl = $('ranges');
for (const k of STATS) {
  const name = document.createElement('span');
  name.className = 'rname';
  name.dataset.stat = k;
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

  rangesEl.append(name, mk('min'), mk('max'), mk('divisor'), bias, matchSel);
}

// Visual cues: a stat's min/max go green when equal and set (exact-value request);
// a set divisor field is highlighted gold. An exact value pins the stat outright, so
// the divisor and bias controls can't apply — disable (grey) them while exact. (The
// divisor previously overrode an exact min=max; now exact wins and suppresses it.)
// Skip the maximized stat: updateMaximizeCue already disables its whole row, and we
// must not re-enable those fields here.
function updateExactCues() {
  const maxStat = maximizeEl.value;
  for (const k of STATS) {
    const [mn, mx, dv] = statInputs(k);
    const exact = mn.value !== '' && mn.value === mx.value;
    mn.classList.toggle('exact', exact);
    mx.classList.toggle('exact', exact);
    const bias = biasSelect(k);
    if (k !== maxStat) { // maximized row stays disabled via updateMaximizeCue
      dv.disabled = exact;
      bias.disabled = exact;
    }
    const hasDiv = !dv.disabled && dv.value !== '';
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

// Maximize dropdown: one stat to maximize as the top priority, or "— none —".
// Populated with every stat; the template provides the leading none option.
const maximizeEl = $('maximize');
for (const k of STATS) {
  const opt = document.createElement('option');
  opt.value = k;
  opt.textContent = STAT_LABEL[k];
  maximizeEl.appendChild(opt);
}
function updateMaximizeCue() {
  const max = maximizeEl.value;
  maximizeEl.classList.toggle('on', max !== '');
  // The maximized stat is driven to its global peak, so its own min/max/divisor/
  // bias/match inputs can't apply — disable them and dim the row's label. (The
  // collectors skip disabled controls, so any value the user typed there is ignored.)
  for (const k of STATS) {
    const off = k === max;
    for (const el of [...statInputs(k), biasSelect(k), matchSelect(k)]) el.disabled = off;
    rangesEl.querySelector(`.rname[data-stat="${k}"]`)?.classList.toggle('maxed', off);
  }
  // Re-apply the exact-value disable: a row we just un-maximized may itself be exact,
  // in which case its divisor/bias must stay disabled rather than be re-enabled above.
  updateExactCues();
}
maximizeEl.addEventListener('change', updateMaximizeCue);

// Re-sync every visual cue + dependent control to the current field values.
// Used after bulk changes (URL restore, reset). updateExactCues runs LAST (it owns
// the divisor/bias disabled-state for exact stats, and must win over the blanket
// enable/disable in updateMaximizeCue).
function refreshAllCues() {
  for (const k of STATS) {
    biasSelect(k).dispatchEvent(new Event('change'));
    matchSelect(k).dispatchEvent(new Event('change'));
  }
  updatePawnUI();
  updateWeightInfo();
  updateMaximizeCue(); // calls updateExactCues() at its end
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

// The stat currently selected to maximize, or null ("— none —").
function collectMaximize() {
  return maximizeEl.value || null;
}

// Collect per-vocation required minimums as { voc: minLevels }. Returns
// { require, error }: error is set when any value is out of range or the minimums sum
// past the 90 level-10→100 levels. Skips pawn-disabled (greyed) require fields.
function collectRequire() {
  const req = {};
  let sum = 0;
  for (const input of vocsEl.querySelectorAll('.voc input.require')) {
    if (input.disabled || input.value === '') continue;
    const n = Number(input.value);
    if (!Number.isInteger(n) || n < 1 || n > 90)
      return { error: `Required minimum for ${VOC_LABEL[input.dataset.voc]} must be a ` +
        'whole number from 1 to 90.' };
    req[input.dataset.voc] = n;
    sum += n;
  }
  if (sum > 90)
    return { error: `Required minimums total ${sum}, but only 90 levels are available ` +
      '(10→100). Lower them so they sum to 90 or less.' };
  return { require: req };
}

// Collect the per-stat bias map (omitting neutral 0). Skips the maximized stat,
// whose controls are disabled (its bias can't apply).
function collectBias() {
  const bias = {};
  for (const k of STATS) {
    const sel = biasSelect(k);
    if (sel.disabled) continue;
    const v = Number(sel.value);
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
    const sel = matchSelect(k);
    if (sel.disabled) continue; // maximized stat: match can't apply
    const v = sel.value; // '' | '=partner' | '~partner'
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
    if (mn.disabled) continue; // maximized stat: its own bounds/divisor can't apply
    const min = mn.value === '' ? null : Number(mn.value);
    const max = mx.value === '' ? null : Number(mx.value);
    // An exact (min=max) request disables the divisor field; ignore any stale value
    // left in it so the pinned exact value wins instead of the divisor overriding.
    const divisor = (dv.disabled || dv.value === '') ? null : Number(dv.value);
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
//   req  = CSV of "voc:minLevels" pairs (each voc takes >= minLevels of the 90
//          level-10->100 levels), e.g. "warrior:40,sorcerer:10"
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
  // Required vocations: "voc:minLevels" pairs. Read the DOM directly (skip pawn-greyed
  // fields) so encoding never depends on collectRequire's validation passing.
  const reqPairs = [...vocsEl.querySelectorAll('.voc input.require')]
    .filter((inp) => !inp.disabled && inp.value !== '')
    .map((inp) => `${inp.dataset.voc}:${inp.value}`);
  if (reqPairs.length) params.set('req', reqPairs.join(','));
  return params;
}

// Apply query params back onto the form. Returns true if any were present.
function applySelections(params) {
  if ([...params.keys()].length === 0) return false;

  // Vocations: only those listed stay checked (default = all on). Scope to the allow
  // checkbox (.voc input :not(.require)) — the option toggles also live in #vocs with
  // no .voc ancestor (closest() would throw), and the per-row require field must not be
  // driven by the allow list (it's restored from `req` below).
  if (params.has('v')) {
    const want = new Set(params.get('v').split(',').filter(Boolean));
    for (const cb of vocsEl.querySelectorAll('.voc input[type="checkbox"]:not(.require)')) {
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
  // Maximize dropdown.
  const maxStat = params.get('max');
  maximizeEl.value = STATS.includes(maxStat) ? maxStat : '';
  // Required vocations: parse "voc:minLevels" pairs into a map, then fill each row's
  // require field. A set requirement also force-checks its row's allow (require implies
  // allow). Unknown vocs / out-of-range minimums are ignored.
  const reqMap = {};
  for (const pair of (params.get('req') ?? '').split(',').filter(Boolean)) {
    const [v, raw] = pair.split(':');
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 90) reqMap[v] = n;
  }
  for (const input of vocsEl.querySelectorAll('.voc input.require')) {
    const n = reqMap[input.dataset.voc];
    input.value = n != null ? n : '';
    if (n != null) {
      const row = input.closest('.voc');
      row.querySelector('input[type="checkbox"]:not(.require)').checked = true;
      row.classList.remove('off');
    }
  }
  refreshAllCues();
  return true;
}

// Build the absolute share URL for the current selections and show it.
function showShareUrl() {
  const params = encodeSelections();
  const qs = params.toString();
  const url = location.origin + location.pathname + (qs ? '?' + qs : '');
  $('cfg-url').value = url;
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
  // Combat summary: the four combat stats only (attack/defense/mattack/mdefense),
  // excluding hp and st. The formula rides on an ⓘ tooltip next to the label.
  const combat = COMBAT.reduce((a, k) => a + stats[k], 0);
  body.insertAdjacentHTML('beforeend',
    `<tr class="sum"><td>Combat<i class="info" title="attack + defense + mattack + mdefense (excludes HP and stamina)">ⓘ</i></td>` +
    `<td class="num">${combat}</td><td></td></tr>`);
  body.insertAdjacentHTML('beforeend',
    `<tr class="sum"><td>Total<i class="info" title="every stat added together: HP + stamina + the four combat stats">ⓘ</i></td>` +
    `<td class="num">${total}</td><td></td></tr>`);
}

// Flavor quotes: show one after each solve, then rotate to a fresh one every
// 30s. textContent keeps it safe against any punctuation in the quote strings.
const QUOTE_ROTATE_MS = 30000;
let lastQuote = -1;
let quoteTimer = null;

function renderQuote() {
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
  // restart the left-to-right reveal: drop the class, force reflow, re-add it
  el.classList.remove('reveal');
  void el.offsetWidth;
  el.classList.add('reveal');
}

// Show a quote now and (re)start the rotation. Called on each solve, so the
// 15s clock restarts from the freshly-shown quote.
function showQuote() {
  renderQuote();
  if (quoteTimer) clearInterval(quoteTimer);
  quoteTimer = setInterval(renderQuote, QUOTE_ROTATE_MS);
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
  const { require: requireVocs, error: requireError } = collectRequire();
  if (requireError) {
    status.textContent = requireError;
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
    const build = solveMaxTotal(highs, { allowed, startPool, bounds, weight, bias, match, maximize,
                                         require: requireVocs, ...toggles });
    const ms = (performance.now() - t0).toFixed(0);
    const kind = toggles.pawn ? 'pawn' : 'Arisen';
    const goal = maximize ? ` <span class="wtag">— max ${STAT_LABEL[maximize]}</span>` : '';
    $('result-head').innerHTML =
      `Best ${kind} build — start as ${colorVoc(build.start)} <span class="wtag">(${weight})</span>${goal}`;
    renderPlan(build.start, build.counts);
    renderStats(build.stats, build.total, bounds);
    updateWeightInfo(); // weight-class details now live in the results panel
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
$('cfg-copy').addEventListener('click', async () => {
  const btn = $('cfg-copy');
  const input = $('cfg-url');
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
// all stat fields blank, biases neutral, no requirements.
function resetSelections() {
  // Allow checkboxes back on (the option toggles + require fields also live in vocsEl
  // but are reset separately — scope to the allow box only).
  for (const cb of vocsEl.querySelectorAll('.voc input[type="checkbox"]:not(.require)')) {
    cb.checked = true;
    cb.closest('.voc').classList.remove('off');
  }
  for (const input of vocsEl.querySelectorAll('.voc input.require')) input.value = '';
  for (const t of TOGGLES) t.el.checked = false;
  weightEl.value = DEFAULT_WEIGHT;
  for (const k of STATS) {
    const [mn, mx, dv] = statInputs(k);
    mn.value = '';
    mx.value = '';
    dv.value = '';
    biasSelect(k).value = '0';
    matchSelect(k).value = '';
  }
  maximizeEl.value = '';
  // refresh dependent UI and clear the shared-state bits
  refreshAllCues();
  $('results').style.display = 'none';
  if (quoteTimer) { clearInterval(quoteTimer); quoteTimer = null; } // results hidden; stop rotating
  history.replaceState(null, '', location.origin + location.pathname);
  status.classList.remove('err');
  // Restore the Solve button: enabled once the solver is loaded. (A solve may
  // still be in flight and left it disabled; reset shouldn't strand it greyed.)
  solveBtn.disabled = !highs;
  status.textContent = highs ? 'Reset to defaults.' : status.textContent;
}
$('reset').addEventListener('click', resetSelections);

// --- ⓘ help icons: tap-to-show popover (mobile, where hover/title don't fire) ---
// Delegated so it covers both the static checkbox icons and the ⓘ icons that
// renderStats() injects into the summary rows. The desktop `title` tooltip still
// works on hover; this adds an explicit tap affordance on top of it.
function closeInfoPop() {
  const open = document.querySelector('.info.open');
  if (open) {
    open.classList.remove('open');
    open.querySelector('.info-pop')?.remove();
  }
}
document.addEventListener('click', (e) => {
  if (e.target.closest('.info-pop')) return; // tap inside the open popover: ignore
  const icon = e.target.closest('.info');
  if (!icon) { closeInfoPop(); return; }
  // Don't let the tap toggle the checkbox/label the icon sits inside.
  e.preventDefault();
  e.stopPropagation();
  const wasOpen = icon.classList.contains('open');
  closeInfoPop();
  if (wasOpen) return; // second tap on the same icon closes it
  const pop = document.createElement('span');
  pop.className = 'info-pop';
  pop.textContent = icon.getAttribute('title') || '';
  // Right-aligned icons (e.g. the summary rows) flip the popover to the right
  // edge so it doesn't run off-screen.
  if (icon.getBoundingClientRect().left > window.innerWidth / 2) pop.classList.add('flip-right');
  icon.appendChild(pop);
  icon.classList.add('open');
});
// Close on Escape for keyboard users.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInfoPop(); });

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
