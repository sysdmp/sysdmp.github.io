// SPDX-License-Identifier: MIT
// Landing-page controller: builds the vocation picker + stat targets, loads the
// HiGHS WASM solver, runs solveMaxTotal, and renders the result. Authoring source
// lives in src/; `make` bundles it into a single self-contained index.html.

import { loadHighs } from './highs-loader.js';
import { solveMaxTotal, sameStatsBuilds } from './solver.js';
import {
  BASIC, ALL, STATS, WEIGHT_CLASSES, WEIGHT_BASE_ST, DEFAULT_WEIGHT,
  WEIGHT_RANGE, WEIGHT_STAREGEN, WEIGHT_ENCUMBRANCE,
  COMBAT, VITALS, MATCH_TILDE_TOL, MATCH_PARTNERS, STAT_MAX, owocUrl, QUOTES, statsOf,
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

// Tier column headers atop each column, aligned over the three per-tier require
// fields (which sit at the right edge of every row). The right column holds only
// advanced/hybrid vocations, which can't level in 1→10, so its first column is blank
// (no "1→10" label) — matching the empty .req-blank cell in those rows.
const tierHeader = (withTo10) => {
  const h = document.createElement('div');
  h.className = 'voc-head';
  h.innerHTML = '<span class="spacer">require ≥ levels:</span>' +
    `<span class="tiers"><span>${withTo10 ? '1→10' : ''}</span><span>10→100</span><span>100→200</span></span>`;
  return h;
};
leftCol.appendChild(tierHeader(true));   // basics: all three ranges
rightCol.appendChild(tierHeader(false)); // advanced/hybrid: no 1→10

// Per-tier sizes/labels for the require fields (1→10 / 10→100 / 100→200). Declared
// before updateRequireUI/clampReqField/encode use them (those run during init).
const TIER_SIZE = { to10: 9, to100: 90, to200: 100 };
const TIER_LABEL = { to10: '1→10', to100: '10→100', to200: '100→200' };
// Short tier codes used in the share URL's `req` param ("voc@10:n", etc.).
const TIER_SHORT = { to10: '10', to100: '100', to200: '200' };
const TIER_FROM_SHORT = { 10: 'to10', 100: 'to100', 200: 'to200' };

// Mark rows that currently carry a requirement (a non-empty, enabled require field)
// so they can be styled. Called from the allow/require row handlers, updatePawnUI,
// and refreshAllCues (URL restore / reset).
function updateRequireUI() {
  for (const row of vocsEl.querySelectorAll('.voc')) {
    const on = [...row.querySelectorAll('input.require')]
      .some((inp) => inp.value !== '' && !inp.disabled);
    row.classList.toggle('required', on);
  }
  // Per tier: when the enabled fields sum to exactly the tier size (no levels left to
  // allocate), highlight all of that tier's fields green via `.tier-full`.
  const tierFull = {};
  for (const tier of ['to10', 'to100', 'to200']) {
    const fields = [...vocsEl.querySelectorAll(`.voc input.require[data-tier="${tier}"]`)];
    const sum = fields.reduce((a, inp) =>
      a + (inp.disabled || inp.value === '' ? 0 : Math.floor(Number(inp.value)) || 0), 0);
    tierFull[tier] = sum === TIER_SIZE[tier];
    for (const inp of fields) inp.classList.toggle('tier-full', tierFull[tier] && inp.value !== '');
  }
  // A fully-allocated 1→10 range pins the whole pre-10 distribution, so the
  // "disable switcheroo" toggle is meaningless — grey it out and uncheck it (so it
  // can't impose a conflicting no-pre10 constraint on the solver). It re-enables and
  // restores its prior checked state when 1→10 is no longer full.
  const noPre10 = $('no-pre10');
  if (tierFull.to10) {
    if (!noPre10.disabled) noPre10.dataset.prevChecked = noPre10.checked ? '1' : '0';
    noPre10.checked = false;
    noPre10.disabled = true;
  } else if (noPre10.disabled) {
    noPre10.disabled = false;
    noPre10.checked = noPre10.dataset.prevChecked === '1';
  }
}

// Live-clamp a require field as the user types: an integer ≥ 1, capped at its tier
// size, and capped so the tier's total across all vocations never exceeds that size
// (1→10 ≤ 9, 10→100 ≤ 90, 100→200 ≤ 100). A value with no headroom left is cleared.
function clampReqField(input) {
  if (input.value === '') return;
  const tier = input.dataset.tier;
  const size = TIER_SIZE[tier];
  let n = Math.floor(Number(input.value));
  if (!Number.isFinite(n) || n < 1) { input.value = ''; return; } // 0 / negative / junk -> clear
  // Sum the OTHER enabled require fields in this tier; this field may use the rest.
  let others = 0;
  for (const o of vocsEl.querySelectorAll(`.voc input.require[data-tier="${tier}"]`)) {
    if (o === input || o.disabled || o.value === '') continue;
    others += Math.floor(Number(o.value)) || 0;
  }
  const headroom = Math.max(0, size - others);
  if (headroom < 1) { input.value = ''; return; } // tier already full elsewhere
  input.value = String(Math.min(n, headroom));
}

// Per-tier "minimum levels" fields per row. Each row carries up to three number
// inputs (class `require`, with data-voc + data-tier): 1→10 (basics only), 10→100,
// and 100→200. Blank = no requirement; setting one implies allowing the vocation.
// Vocation color (via colorVoc) conveys basic/advanced/hybrid; hybrids are tagged
// data-hybrid for pawn-mode greying.
const REQ_TIERS = [
  ['to10', '1→10', 9],
  ['to100', '10→100', 90],
  ['to200', '100→200', 100],
];
const reqField = (v, tier, size) =>
  `<input type="number" class="require" data-voc="${v}" data-tier="${tier}" ` +
  `min="1" max="${size}" step="1" placeholder="–" aria-label="${v} minimum levels in ${tier}">`;

for (const v of ALL) {
  const isBasic = BASIC.includes(v);
  const row = document.createElement('div');
  row.className = 'voc';
  if (HYBRID.has(v)) row.dataset.hybrid = '1';
  // 1→10 is basics-only: advanced/hybrid rows get an empty placeholder cell so the
  // three columns still line up across rows.
  const f10 = isBasic ? reqField(v, 'to10', 9) : '<span class="req-blank"></span>';
  row.innerHTML =
    `<label class="voc-allow"><input type="checkbox" value="${v}" checked>` +
    `<span>${colorVoc(v)}</span></label>` +
    `<span class="voc-require">${f10}${reqField(v, 'to100', 90)}${reqField(v, 'to200', 100)}</span>`;
  const allow = row.querySelector('input[type="checkbox"]:not(.require)');
  const reqInputs = [...row.querySelectorAll('input.require')];
  allow.addEventListener('change', () => {
    row.classList.toggle('off', !allow.checked);
    if (!allow.checked) reqInputs.forEach((inp) => { inp.value = ''; }); // un-allow clears requirements
    updateRequireUI();
  });
  for (const inp of reqInputs) {
    inp.addEventListener('input', () => {
      clampReqField(inp); // keep it an integer within the tier size + remaining headroom
      if (inp.value !== '') { allow.checked = true; row.classList.remove('off'); } // require implies allow
      updateRequireUI();
    });
  }
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

// --- starting-class selector: force one basic vocation as the start, or "Auto" ---
// The solver already picks the best start among allowed basics; choosing one here
// pins it (passed as startPool). "Auto" ("") = let the solver choose (default).
const startClassEl = $('start-class');
{
  const auto = document.createElement('option');
  auto.value = ''; auto.textContent = 'Auto (best)';
  startClassEl.appendChild(auto);
  for (const v of BASIC) {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = VOC_LABEL[v];
    startClassEl.appendChild(opt);
  }
}
$('start-help').title =
  'Which basic vocation the build starts as (the level-1 class). "Auto" lets the ' +
  'solver pick the best-scoring start among the allowed basics. Choosing one pins ' +
  'it — and also allows it (the other two basics can still be used later, just not ' +
  'as the start).';
// Forcing a start implies allowing it; also show a note when pawn + forced start
// combine (pawn forces an extra early level into the start). Re-synced from the
// start-class change, pawn toggle, and refreshAllCues (URL restore / reset).
function updateStartClass() {
  const v = startClassEl.value;
  if (v) { // force implies allow: check + un-"off" the start's allow row
    const cb = [...vocsEl.querySelectorAll('.voc input[type="checkbox"]:not(.require)')]
      .find((c) => c.value === v);
    if (cb) { cb.checked = true; cb.closest('.voc').classList.remove('off'); }
  }
  // Pawn + a forced start: a pawn must take ≥1 of its 1→10 levels in the start
  // vocation, so pre-populate that vocation's 1→10 require field with at least 1.
  // The auto-set "1" is tagged data-pawn-auto so it can be cleared when the condition
  // lifts (pawn off / start changed) without clobbering a value the user typed.
  const target = (v && pawnEl.checked) ? v : null;
  for (const f of vocsEl.querySelectorAll('.voc input.require[data-tier="to10"]')) {
    if (f.dataset.voc === target) {
      if (f.value === '') { f.value = '1'; f.dataset.pawnAuto = '1'; }
    } else if (f.dataset.pawnAuto) {
      if (f.value === '1') f.value = ''; // remove only our untouched auto-fill
      delete f.dataset.pawnAuto;
    }
  }
  const note = $('start-pawn-note');
  if (v && pawnEl.checked) {
    note.hidden = false;
    note.textContent = `⚠ Pawn mode forces at least one of the 1→10 levels into ${VOC_LABEL[v]}, your chosen start.`;
  } else {
    note.hidden = true;
  }
  updateRequireUI(); // the auto-filled 1→10 value may change the tier-full/green state
}
startClassEl.addEventListener('change', updateStartClass);

// Pawn mode disables the hybrid (Arisen-only) vocations in the UI: their allow +
// require fields are greyed out and ignored, and the solver excludes them too.
function updatePawnUI() {
  const on = pawnEl.checked;
  for (const row of vocsEl.querySelectorAll('.voc[data-hybrid]')) {
    const allow = row.querySelector('input[type="checkbox"]:not(.require)');
    allow.disabled = on;
    for (const inp of row.querySelectorAll('input.require')) {
      inp.disabled = on;
      if (on) inp.value = ''; // a pawn can't require a hybrid
    }
    row.classList.toggle('off', on || !allow.checked);
  }
  // updateStartClass() applies the pawn+start 1→10 auto-fill and itself calls
  // updateRequireUI(), so the require cues refresh after that runs.
  updateStartClass(); // pawn toggle changes the combined-effect note + auto-fill
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
    // Cap min/max/divisor at the stat's input ceiling (hp/st 9999, combat 999) —
    // a sanity bound, not the reachable max (the `max` attr drives the spinner +
    // our validation in collectBounds). Targets within it but beyond what a build
    // can reach are allowed and simply come back infeasible from the solver.
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

// Collect per-tier, per-vocation required minimums as { to10, to100, to200 } maps.
// Returns { require, error }: error is set when a value is out of range or a tier's
// minimums sum past its size. Skips pawn-disabled (greyed) require fields.
function collectRequire() {
  const require = { to10: {}, to100: {}, to200: {} };
  const sums = { to10: 0, to100: 0, to200: 0 };
  for (const input of vocsEl.querySelectorAll('.voc input.require')) {
    if (input.disabled || input.value === '') continue;
    const tier = input.dataset.tier;
    const size = TIER_SIZE[tier];
    const n = Number(input.value);
    if (!Number.isInteger(n) || n < 1 || n > size)
      return { error: `Required ${TIER_LABEL[tier]} minimum for ${VOC_LABEL[input.dataset.voc]} ` +
        `must be a whole number from 1 to ${size}.` };
    require[tier][input.dataset.voc] = n;
    sums[tier] += n;
  }
  for (const tier of ['to10', 'to100', 'to200']) {
    if (sums[tier] > TIER_SIZE[tier])
      return { error: `${TIER_LABEL[tier]} required minimums total ${sums[tier]}, but only ` +
        `${TIER_SIZE[tier]} levels are available there. Lower them so they sum to ${TIER_SIZE[tier]} or less.` };
  }
  return { require };
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
    // A generous input ceiling (hp/st 9999, combat 999) — a sanity bound, not the
    // true reachable max. Values within it but beyond what a build can reach are
    // allowed through and simply come back infeasible from the solver.
    if (min != null && min > cap)
      return { error: `${STAT_LABEL[k]} min (${min}) is above the ${cap} input limit.` };
    if (max != null && max > cap)
      return { error: `${STAT_LABEL[k]} max (${max}) is above the ${cap} input limit.` };
    if (divisor != null && divisor > cap)
      return { error: `${STAT_LABEL[k]} divisor (${divisor}) is above the ${cap} input limit.` };
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
//   sc  = forced starting class (a basic vocation; omitted when Auto)
//   p   = 1 when pawn mode is on
//   mv  = 1 when minimize-vocations is on
//   nx  = 1 when "no pre-10 vocation switch" is on
//   <stat>_min   = min bound
//   <stat>_max   = max bound
//   <stat>_div   = divisor
//   <stat>_bias  = bias (-5..5)
//   <stat>_match = "=partner" or "~partner" (emitted for both ends of a pair)
//   max  = the single stat to maximize (ignores all other settings)
//   req  = CSV of "voc@tier:minLevels" pairs — tier is 10/100/200 (the 10->100 tier
//          omits its "@100", so old "voc:n" links still parse), e.g.
//          "warrior:40,fighter@10:9,sorcerer@200:30"
//   b    = the displayed build's exact allocation (start + per-vocation level
//          counts); when present, that exact build is shown on load (see decodeAlloc)
// Stat keys are the canonical short names (hp, st, attack, ...).

// Read the form into URLSearchParams (only non-default values).
function encodeSelections() {
  const params = new URLSearchParams();
  const allowed = selectedVocs();
  if (allowed.length !== ALL.length) params.set('v', allowed.join(','));
  if (weightEl.value !== DEFAULT_WEIGHT) params.set('w', weightEl.value);
  if (startClassEl.value) params.set('sc', startClassEl.value);
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
  // Required vocations: "voc@tier:n" pairs (tier = 10/100/200). The 10→100 tier omits
  // its "@100" suffix so it stays back-compatible with the old "voc:n" links. Read the
  // DOM directly (skip pawn-greyed fields) so encoding never depends on validation.
  const reqPairs = [...vocsEl.querySelectorAll('.voc input.require')]
    .filter((inp) => !inp.disabled && inp.value !== '')
    .map((inp) => {
      const short = TIER_SHORT[inp.dataset.tier];
      const at = inp.dataset.tier === 'to100' ? '' : `@${short}`;
      return `${inp.dataset.voc}${at}:${inp.value}`;
    });
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
  // Forced starting class (a basic vocation, or Auto). refreshAllCues() below runs
  // updateStartClass(), which re-applies force-implies-allow and the pawn note.
  const sc = params.get('sc');
  startClassEl.value = BASIC.includes(sc) ? sc : '';
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
  // Required vocations: parse "voc@tier:n" pairs (tier defaults to 100, i.e. 10→100,
  // for back-compat with old "voc:n" links) into a { 'voc|tier': n } map, then fill
  // each row's field. A set requirement force-checks its row's allow. Unknown vocs,
  // tiers, or out-of-range minimums are ignored.
  const reqMap = {};
  for (const pair of (params.get('req') ?? '').split(',').filter(Boolean)) {
    const [lhs, raw] = pair.split(':');
    if (raw == null) continue;
    const [v, short = '100'] = lhs.split('@');
    const tier = TIER_FROM_SHORT[short];
    const n = Number(raw);
    if (tier && Number.isInteger(n) && n >= 1 && n <= TIER_SIZE[tier]) reqMap[`${v}|${tier}`] = n;
  }
  for (const input of vocsEl.querySelectorAll('.voc input.require')) {
    const n = reqMap[`${input.dataset.voc}|${input.dataset.tier}`];
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

// Encode a build's exact allocation into a compact string for the share URL's `b=`
// param: start letter + 2-hex level count per vocation, per tier (ALL order; to10
// only basics). Mirrors the owoc layout but is our own, decoded by decodeAlloc.
function encodeAlloc(build) {
  const hb = (n) => (n & 0xff).toString(16).padStart(2, '0');
  const { start, counts } = build;
  const s = { fighter: 'f', strider: 's', mage: 'm' }[start];
  const to100 = ALL.map((v) => hb(counts.to100[v] || 0)).join('');
  const to200 = ALL.map((v) => hb(counts.to200[v] || 0)).join('');
  const to10 = BASIC.map((v) => hb(counts.to10[v] || 0)).join('');
  return s + to100 + to200 + to10;
}

// Parse a `b=` allocation string back into { start, counts } (or null if malformed).
function decodeAlloc(str) {
  const START = { f: 'fighter', s: 'strider', m: 'mage' };
  const start = START[str?.[0]];
  const expected = 1 + (ALL.length * 2) * 2 + BASIC.length * 2;
  if (!start || str.length !== expected) return null;
  let i = 1;
  const readTier = (vocs) => {
    const out = {};
    for (const v of vocs) {
      const n = parseInt(str.slice(i, i + 2), 16);
      i += 2;
      if (Number.isNaN(n)) return null;
      if (n > 0) out[v] = n;
    }
    return out;
  };
  const to100 = readTier(ALL), to200 = readTier(ALL), to10 = readTier(BASIC);
  if (!to100 || !to200 || !to10) return null;
  return { start, counts: { to10, to100, to200 } };
}

// Build the absolute share URL for the current selections (+ the displayed build's
// exact allocation as `b=`) and show it. Pass the build being displayed.
function showShareUrl(build) {
  const params = encodeSelections();
  if (build) params.set('b', encodeAlloc(build));
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

// A solve attempt failed (invalid input or infeasible). Show the reason in the
// status line, and if a build is currently displayed, mark it STALE — keep it
// visible but greyed out with a banner, so it's clear it no longer matches the
// current inputs (rather than silently leaving a fresh-looking old build).
function solveFailed(msg) {
  status.textContent = msg;
  status.classList.add('err');
  if ($('results').style.display === 'block') {
    $('results').classList.add('stale');
    const banner = $('stale-banner');
    banner.textContent = `⚠ ${msg} — showing your previous build (no longer matches the inputs above).`;
    banner.hidden = false;
    $('alts').hidden = true; // the stale build's alternatives no longer apply
    if (quoteTimer) { clearInterval(quoteTimer); quoteTimer = null; } // stop rotating on a dead build
  }
}

// --- alternative builds (same exact stats, different vocation allocation) ---
// Lazy: altBuilds grows as the user asks for more. altBuilds[0] is the displayed
// solve; altGen is the live generator producing further same-stats allocations
// (pulled one per "↻ another" click). altCtx carries the per-solve render context
// (weight/kind/goal/bounds) reused on each cycle. altDone = generator exhausted.
let altBuilds = [], altIndex = 0, altGen = null, altDone = false, altCtx = null;

// Drain the generator: find ALL same-stats alternatives (up to ALT_CAP) into
// altBuilds, skipping any allocation equal to one already shown. This is the slow,
// eager search — run once, on the first "↻ another" click. Sets altDone when the
// generator is fully exhausted (vs. stopped at the cap → altCapped).
const ALT_CAP = 50;
let altCapped = false;
function findAllAlts() {
  if (!altGen || altDone) return;
  const seen = new Set(altBuilds.map(allocKey));
  for (;;) {
    if (altBuilds.length >= ALT_CAP) { altCapped = true; break; }
    const { value, done } = altGen.next();
    if (done) { altDone = true; break; }
    const k = allocKey(value);
    if (!seen.has(k)) { altBuilds.push(value); seen.add(k); }
  }
}

// Canonical key for an allocation, to dedup the displayed build vs. the generator.
function allocKey(b) {
  return b.start + '|' + ['to10', 'to100', 'to200']
    .map((t) => Object.entries(b.counts[t] || {}).sort().map(([v, n]) => `${v}:${n}`).join(','))
    .join('|');
}

// Render one build into the results panel: heading, plan, owoc link, share URL, and
// the alternatives counter. Stats/weight-info are rendered once at solve time (they're
// identical across alternatives), so this is the per-cycle update.
function renderBuild(b) {
  const { weight, kind, goal, bounds } = altCtx;
  $('result-head').innerHTML =
    `Best ${kind} build — start as ${colorVoc(b.start)} <span class="wtag">(${weight})</span>${goal}`;
  renderPlan(b.start, b.counts);
  const owoc = owocUrl(b);
  const owocEl = $('owoc-url');
  owocEl.href = owoc;
  owocEl.textContent = owoc;
  $('owoc-warn').hidden = weight === DEFAULT_WEIGHT;
  showShareUrl(b); // pin this exact allocation in the share URL
  updateAltsUI();
}

// Show/update the alternatives control. Before the search has run (just the initial
// build, generator not exhausted) the button invites "find alternatives". After the
// search: if others were found it cycles "build N of M" (M+ if capped); if none, it
// disables and reads "no alternatives".
function updateAltsUI() {
  const alts = $('alts');
  alts.hidden = false;
  const searched = altDone || altBuilds.length > 1; // the full search has been run
  const btn = $('alt-refresh');
  if (!searched) {
    $('alt-count').textContent = '';
    btn.disabled = false;
    btn.textContent = '↻ find alternatives';
  } else if (altBuilds.length > 1) {
    $('alt-count').textContent = `build ${altIndex + 1} of ${altBuilds.length}${altCapped ? '+' : ''}`;
    btn.disabled = false;
    btn.textContent = '↻ another';
  } else {
    $('alt-count').textContent = '';
    btn.disabled = true;
    btn.textContent = 'no alternatives';
  }
}

async function runSolve(pinnedBuild = null) {
  if (!highs) return;
  const allowed = selectedVocs();
  const allowedBasics = allowed.filter((v) => BASIC.includes(v));
  // A forced starting class pins the start to that one basic (it's auto-allowed, so
  // it's normally in `allowed`; fall back to Auto if it somehow isn't). "" = Auto.
  const forced = startClassEl.value;
  const startPool = forced && allowed.includes(forced) ? [forced] : allowedBasics;
  status.classList.remove('err');
  if (startPool.length === 0) {
    solveFailed('Pick at least one basic vocation (Fighter / Strider / Mage) as a start.');
    return;
  }
  const { bounds, error } = collectBounds();
  if (error) {
    solveFailed(error);
    return;
  }
  const { require: requireVocs, error: requireError } = collectRequire();
  if (requireError) {
    solveFailed(requireError);
    return;
  }
  const weight = weightEl.value;
  const bias = collectBias();
  const match = collectMatch();
  const maximize = collectMaximize();
  const toggles = Object.fromEntries(TOGGLES.map((t) => [t.opt, t.el.checked]));
  solveBtn.disabled = true;
  status.textContent = 'Solving…';
  $('spinner').hidden = false;
  // The solve runs synchronously and freezes the main thread, so yield twice to let
  // the browser paint the spinner before we block on it. (Same-stats alternatives are
  // now found lazily, on demand — see the ↻ button — so the initial solve is just one.)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    const t0 = performance.now();
    const solveOpts = { allowed, startPool, bounds, weight, bias, match, maximize,
                        require: requireVocs, ...toggles };
    // A pinnedBuild (from a shared `b=` allocation) is displayed as-is; otherwise solve.
    // Its stats are recomputed from the allocation so enumeration pins the right target.
    const baseSt = WEIGHT_BASE_ST[weight];
    const build = pinnedBuild
      ? { ...pinnedBuild, stats: statsOf(pinnedBuild.start, pinnedBuild.counts, baseSt) }
      : solveMaxTotal(highs, solveOpts);
    build.total = STATS.reduce((a, k) => a + build.stats[k], 0);
    const ms = (performance.now() - t0).toFixed(0);
    // Show this build first; alternatives (same exact stats) are pulled lazily from
    // the generator one at a time when the user clicks "↻ another".
    altBuilds = [build];
    altIndex = 0;
    altDone = false;
    altCapped = false;
    altGen = sameStatsBuilds(highs, solveOpts, build.stats);
    altCtx = {
      weight, bounds,
      kind: toggles.pawn ? 'pawn' : 'Arisen',
      goal: maximize ? ` <span class="wtag">— max ${STAT_LABEL[maximize]}</span>` : '',
    };
    renderStats(build.stats, build.total, bounds); // identical across alternatives
    updateWeightInfo(); // weight-class details now live in the results panel
    renderBuild(build);
    showQuote();
    $('results').style.display = 'block';
    $('results').classList.remove('stale'); // fresh build: clear any stale dimming
    $('stale-banner').hidden = true;
    status.textContent = `Solved in ${ms} ms.`;
  } catch (e) {
    solveFailed('No solution: ' + e.message);
  } finally {
    solveBtn.disabled = false;
    $('spinner').hidden = true;
  }
}

solveBtn.disabled = true;
// Wrap so the click Event isn't passed as runSolve's pinnedBuild argument.
solveBtn.addEventListener('click', () => runSolve());

// "↻ another": the first click eagerly finds ALL same-stats alternatives (the slow
// search — initial solve stays fast by deferring it to here), showing a spinner;
// subsequent clicks just cycle the complete set, wrapping at the end.
$('alt-refresh').addEventListener('click', async () => {
  const btn = $('alt-refresh');
  // Not yet gathered? Run the full search once (it can be slow), with the spinner.
  if (!altDone && altBuilds.length === 1) {
    btn.disabled = true;
    status.textContent = 'Searching for alternatives…';
    $('spinner').hidden = false;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try { findAllAlts(); }
    finally { $('spinner').hidden = true; }
    status.textContent = altBuilds.length > 1
      ? `Found ${altBuilds.length}${altCapped ? '+' : ''} builds with the same stats.`
      : 'No other builds reach these exact stats.';
  }
  // Cycle the found set (wrapping).
  if (altBuilds.length > 1) altIndex = (altIndex + 1) % altBuilds.length;
  renderBuild(altBuilds[altIndex]);
});

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
  startClassEl.value = ''; // Auto
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
  $('results').classList.remove('stale'); // clear stale dimming on reset
  $('stale-banner').hidden = true;
  $('alts').hidden = true; altBuilds = []; altIndex = 0; altGen = null; altDone = false; altCapped = false; // clear the cycler
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
const sharedParams = new URLSearchParams(location.search);
const sharedConfig = applySelections(sharedParams);
// A shared `b=` pins the exact allocation to display (instead of re-solving).
const sharedBuild = sharedConfig ? decodeAlloc(sharedParams.get('b')) : null;

(async () => {
  try {
    highs = await loadHighs();
    solveBtn.disabled = false;
    if (sharedConfig) {
      status.textContent = 'Restored shared configuration — solving…';
      await runSolve(sharedBuild);
    } else {
      status.textContent = 'Ready.';
    }
  } catch (e) {
    status.textContent = 'Failed to load solver: ' + e.message;
    status.classList.add('err');
  }
})();
