// DOM and formatting helpers shared by the app shell and the action modules.

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const nextFrame = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// numbers

const trim = (v, digits) => String(Number(v.toFixed(digits)));

export function fmtBytes(n) {
  return n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`;
}

export function fmtDist(m) {
  if (m == null || Number.isNaN(m)) return '–';
  return Math.abs(m) < 1000 ? `${trim(m, 1)} m` : `${trim(m / 1000, 3)} km`;
}

export function fmtDur(s) {
  if (s == null || Number.isNaN(s)) return '–';
  const sign = s < 0 ? '−' : '';
  s = Math.abs(s);
  if (s < 60) return `${sign}${trim(s, 2)} s`;
  if (s < 3600) return `${sign}${Math.floor(s / 60)} min ${trim(s % 60, 1)} s`;
  return `${sign}${Math.floor(s / 3600)} h ${trim((s % 3600) / 60, 1)} min`;
}

export function fmtNum(v) {
  if (v == null || Number.isNaN(v)) return '–';
  return typeof v === 'number' ? trim(v, 3) : String(v);
}

export function fmtPct(rel) {
  if (rel == null || Number.isNaN(rel)) return '';
  if (!Number.isFinite(rel)) return 'new';
  const p = rel * 100;
  const s = Math.abs(p) < 0.1 && p !== 0 ? Math.abs(p).toPrecision(1) : Math.abs(p).toFixed(1);
  return `${p < 0 ? '−' : '+'}${s}%`;
}

export function relDiff(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  if (a === 0) return b === 0 ? 0 : Infinity;
  return (b - a) / a;
}

export function pctSpan(rel) {
  if (rel == null) return h('span');
  if (rel === 0) return h('span', { class: 'dim' }, '0');
  return h('span', { class: 'delta' }, fmtPct(rel));
}

/** "a" when equal or single-run, "a → b ±x%" when different. */
export function cmpValue(a, b, fmt, single) {
  if (single || a === b) return h('span', null, fmt(a));
  const rel = relDiff(a, b);
  return h('span', { class: 'chg' }, fmt(a), ' → ', fmt(b), rel != null && rel !== 0 ? ` ${fmtPct(rel)}` : null);
}

// ---------------------------------------------------------------------------
// clipboard

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // the clipboard api needs a secure context, fall back to the legacy way
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function copyButton(getText, label = 'Copy') {
  const btn = h('button', { class: 'btn small', type: 'button', title: 'copy json to clipboard' }, label);
  btn.addEventListener('click', async (e) => {
    e.preventDefault(); // don't toggle an enclosing <details>
    e.stopPropagation();
    await copyText(getText());
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = label; }, 1200);
  });
  return btn;
}

// ---------------------------------------------------------------------------
// json rendering with differences to the other run marked

const NONE = Symbol('none');

function jsonLines(v, other, out, indent, key, last) {
  const pad = '  '.repeat(indent);
  const prefix = key == null ? '' : `${JSON.stringify(key)}: `;
  const comma = last ? '' : ',';
  if (v !== null && typeof v === 'object') {
    const isArr = Array.isArray(v);
    const same = other !== NONE && other !== null && typeof other === 'object' && Array.isArray(other) === isArr;
    const entries = isArr ? v.map((x, i) => [i, x]) : Object.entries(v);
    if (!entries.length) {
      const otherEmpty = same && (isArr ? other.length === 0 : Object.keys(other).length === 0);
      out.push([`${pad}${prefix}${isArr ? '[]' : '{}'}${comma}`, !otherEmpty]);
      return;
    }
    out.push([`${pad}${prefix}${isArr ? '[' : '{'}`, !same]);
    entries.forEach(([k, x], i) => {
      let o = NONE;
      if (same) o = isArr ? (k < other.length ? other[k] : NONE) : (Object.hasOwn(other, k) ? other[k] : NONE);
      jsonLines(x, o, out, indent + 1, isArr ? null : k, i === entries.length - 1);
    });
    out.push([`${pad}${isArr ? ']' : '}'}${comma}`, !same]);
  } else {
    out.push([`${pad}${prefix}${JSON.stringify(v)}${comma}`, other === NONE || other !== v]);
  }
}

/**
 * Pretty-printed json as a <pre>, lines that differ from `other` (same path) are marked.
 * Pass other = undefined to mark nothing.
 */
export function jsonView(value, other, compare = true) {
  const lines = [];
  jsonLines(value, compare ? (other === undefined ? NONE : other) : NONE, lines, 0, null, true);
  const pre = h('pre', { class: 'json' });
  const frag = document.createDocumentFragment();
  for (const [text, diff] of lines) {
    const line = document.createElement('span');
    if (diff && compare) line.className = 'd';
    line.textContent = `${text}\n`;
    frag.append(line);
  }
  pre.append(frag);
  return pre;
}

/** Scroll a jsonView's container to the next marked line below the current position. */
export function scrollToNextDiff(scroller, pre) {
  const top = scroller.scrollTop;
  const lines = pre.querySelectorAll('.d');
  const base = pre.offsetTop;
  for (const l of lines) {
    if (base + l.offsetTop > top + 8) {
      scroller.scrollTop = base + l.offsetTop - 40;
      return;
    }
  }
  if (lines.length) scroller.scrollTop = base + lines[0].offsetTop - 40;
}
