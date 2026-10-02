// Valhalla QA viewer: front page (differences per action) -> action table -> response detail.
//
// Load with ?url=<artifact zip> or by dropping the zip. Responses are only decompressed when opened,
// so artifacts with thousands of requests stay cheap. How differences are evaluated and shown is up
// to the action modules in ./actions.
import {
  $, h, fmtBytes, nextFrame, jsonView, copyButton,
} from './util.js';
import {
  fetchBytes, openArtifact, getToken, setToken,
} from './load.js';
import { moduleFor } from './actions/index.js';

const ROW_HEIGHT = 36;
// request files as served next to the viewer (github pages, or a server started in the repo root)
const REQUESTS_BASE = '../requests/';

// file name fallback for summaries without a "responses" index
const ACTIONS = ['route', 'optimized_route', 'sources_to_targets', 'trace_route', 'trace_attributes', 'isochrone',
  'locate', 'height', 'expansion', 'centroid', 'status', 'transit_available'];
const COSTINGS = ['auto', 'auto_shorter', 'auto_data_fix', 'bicycle', 'bikeshare', 'bus', 'motor_scooter', 'motorcycle',
  'multimodal', 'pedestrian', 'taxi', 'transit', 'truck', 'none'];

// flags every action can have, modules add their own
const CORE_FLAGS = {
  only_in_a: { sev: 5, label: (s) => `only in ${s.a}`, style: 'hot' },
  only_in_b: { sev: 5, label: (s) => `only in ${s.b}`, style: 'hot' },
  status: { sev: 4, label: 'http status', style: 'hot' },
  transport: { sev: 4, label: 'no response', style: 'hot' },
  identical: { sev: 0, label: 'identical', style: 'dim' },
};

const HEAD_KINDS = [
  { key: 'changed', label: 'All changed', test: (i) => i.status !== 'identical' },
  { key: 'missing', label: 'Missing in one run', test: (i) => i.status === 'only_in_a' || i.status === 'only_in_b' },
  { key: 'status', label: 'HTTP status changed', test: (i) => i.flags.includes('status') || i.flags.includes('transport') },
];
const TAIL_KINDS = [
  { key: 'identical', label: 'Identical', test: (i) => i.status === 'identical' },
  { key: 'all', label: 'Everything', test: () => true },
];

const byName = (x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
const SEVERITY_SORT = { key: 'severity', label: 'Severity, then largest change', cmp: (x, y) => y.severity - x.severity || y.magnitude - x.magnitude };
const NAME_SORT = { key: 'name', label: 'Name', cmp: () => 0 };

const state = {
  summary: null,
  runs: null,
  items: [],
  byName: new Map(),
  actions: [], // [{action, module, items}]
  filters: new Map(), // action -> {q, kind, costing, sort}
  view: [], // filtered + sorted items of the current action table
  viewAction: null,
  detail: null, // {item, module}
};

const kindsFor = (mod) => [...HEAD_KINDS, ...mod.kinds, ...TAIL_KINDS];
const sortsFor = (mod) => [SEVERITY_SORT, ...mod.sorts, NAME_SORT];
const actionHref = (action) => `#/a/${encodeURIComponent(action)}`;
const itemHref = (item) => `${actionHref(item.action)}/${encodeURIComponent(item.name)}`;

function setStatus(text) {
  $('#status').textContent = text || '';
  $('#loading-text').textContent = text || '';
}

function flagDef(item, flag) {
  return CORE_FLAGS[flag] || moduleFor(item.action).flags[flag];
}

function badge(item, flag) {
  const def = flagDef(item, flag);
  const label = typeof def.label === 'function' ? def.label(state.summary) : def.label;
  return h('span', { class: `badge ${def.style}` }, label);
}

// ---------------------------------------------------------------------------
// items

function parseName(name) {
  const stem = name.replace(/\.json$/, '');
  const action = ACTIONS.filter((a) => stem.startsWith(`${a}_`)).sort((x, y) => y.length - x.length)[0];
  if (!action) return { action: 'unknown', costing: '' };
  const rest = stem.slice(action.length + 1);
  const costing = COSTINGS.filter((c) => rest.startsWith(`${c}_`)).sort((x, y) => y.length - x.length)[0];
  return { action, costing: costing || '' };
}

function responseIndex() {
  const { summary, runs } = state;
  if (summary.responses) return summary.responses;
  const index = {};
  for (const name of new Set([...runs.a.names, ...runs.b.names])) {
    const entry = summary.different?.[name];
    const status = !runs.b.has(name) ? 'only_in_a' : !runs.a.has(name) ? 'only_in_b' : entry ? 'different' : 'identical';
    const parsed = parseName(name);
    index[name] = { action: entry?.action || parsed.action, costing: entry?.costing || parsed.costing, status };
  }
  return index;
}

function classify(item) {
  const flags = [];
  if (item.status === 'only_in_a' || item.status === 'only_in_b') flags.push(item.status);
  if (item.entry?.status_code) flags.push('status');
  if (item.entry?.transport_error) flags.push('transport');
  item.flags = flags;
  const res = moduleFor(item.action).classify(item);
  item.flags = [...flags, ...res.flags];
  if (item.status === 'identical') item.flags.push('identical');
  item.magnitude = res.magnitude || 0;
  item.metrics = res.metrics || {};
  item.severity = Math.max(0, ...item.flags.map((f) => flagDef(item, f).sev));
}

function buildItems() {
  const different = state.summary.different || {};
  state.items = Object.entries(responseIndex())
    .map(([name, m]) => ({
      name, action: m.action || 'unknown', costing: m.costing || '', status: m.status, entry: different[name],
    }))
    .sort(byName);
  state.items.forEach(classify);
  state.byName = new Map(state.items.map((i) => [i.name, i]));

  const groups = new Map();
  for (const item of state.items) {
    if (!groups.has(item.action)) groups.set(item.action, []);
    groups.get(item.action).push(item);
  }
  state.actions = [...groups].map(([action, items]) => ({
    action,
    module: moduleFor(action),
    items,
    changed: items.filter((i) => i.status !== 'identical').length,
  })).sort((x, y) => y.changed / y.items.length - x.changed / x.items.length || (x.action < y.action ? -1 : 1));
}

// ---------------------------------------------------------------------------
// loading

async function load(getBytes, label) {
  showSection('loading');
  setStatus(`Loading ${label}`);
  try {
    const bytes = await getBytes();
    setStatus('Unpacking');
    await nextFrame();
    Object.assign(state, openArtifact(bytes));
    buildItems();
    renderTopbar();
    setStatus(`${label} · ${fmtBytes(bytes.length)}`);
    route();
  } catch (e) {
    showLanding(e.message);
  }
}

const loadUrl = (url) => load(() => fetchBytes(url, setStatus), url.split('/').pop() || url);
const loadFile = (file) => load(async () => new Uint8Array(await file.arrayBuffer()), file.name);

// ---------------------------------------------------------------------------
// chrome

function showSection(id) {
  for (const s of ['loading', 'landing', 'front', 'table', 'detail']) $(`#${s}`).hidden = s !== id;
}

function showLanding(error) {
  showSection('landing');
  setStatus('');
  $('#landing-error').hidden = !error;
  $('#landing-error').textContent = error || '';
}

function renderTopbar() {
  const { a, b } = state.summary;
  $('#runs').replaceChildren(
    h('span', { class: 'tag a' }, 'A'), h('b', null, a),
    h('span', { class: 'vs' }, 'vs'),
    h('span', { class: 'tag b' }, 'B'), h('b', null, b),
  );
  document.title = `QA ${a} vs ${b}`;
}

function setCrumbs(...crumbs) {
  $('#crumbs').replaceChildren(...crumbs.flatMap((c) => [h('span', { class: 'sep' }, '/'), c]));
}

// ---------------------------------------------------------------------------
// front page: differences per action

function bar(share) {
  return h('span', { class: 'bar' }, h('span', { style: { width: `${Math.max(share > 0 ? 1 : 0, share * 100)}%` } }));
}

function renderFront() {
  showSection('front');
  setCrumbs();
  const total = state.items.length;
  const changed = state.items.filter((i) => i.status !== 'identical').length;

  const rows = state.actions.map(({ action, module, items, changed: n }) => {
    const share = n / items.length;
    const chips = kindsFor(module)
      .filter((k) => k.key !== 'changed' && k.key !== 'all' && k.key !== 'identical')
      .map((k) => [k, items.filter(k.test).length])
      .filter(([, c]) => c > 0)
      .map(([k, c]) => h('a', { class: 'chip', href: `${actionHref(action)}?kind=${k.key}` }, h('b', null, c), ` ${k.label.toLowerCase()}`));
    return h('a', { class: 'arow', href: actionHref(action) },
      h('span', { class: 'a-name' }, action, h('span', { class: `mod ${module.detailed ? 'on' : ''}` }, module.detailed ? 'detailed' : 'json diff')),
      h('span', { class: 'num' }, items.length),
      h('span', { class: 'num strong' }, n),
      h('span', { class: 'num strong' }, `${(share * 100).toFixed(1)}%`),
      bar(share),
      h('span', { class: 'chips' }, chips));
  });

  $('#front').replaceChildren(h('div', { class: 'front' },
    h('div', { class: 'hero' },
      h('div', { class: 'stat' }, h('div', { class: 'v' }, total), h('div', { class: 'l' }, 'requests')),
      h('div', { class: 'stat hot' }, h('div', { class: 'v' }, changed), h('div', { class: 'l' }, 'changed')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, `${total ? ((changed / total) * 100).toFixed(1) : 0}%`), h('div', { class: 'l' }, 'changed share')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, state.actions.length), h('div', { class: 'l' }, 'actions'))),
    h('div', { class: 'arow head' },
      h('span', null, 'Action'), h('span', { class: 'num' }, 'Requests'), h('span', { class: 'num' }, 'Changed'),
      h('span', { class: 'num' }, 'Share'), h('span'), h('span', null, 'Breakdown')),
    rows));
}

// ---------------------------------------------------------------------------
// action table

function filtersFor(action) {
  if (!state.filters.has(action)) state.filters.set(action, { q: '', kind: 'changed', costing: '', sort: 'severity', scroll: 0 });
  return state.filters.get(action);
}

function columnsFor(mod) {
  return [
    { label: 'Changes', width: '240px', render: (i) => h('span', { class: 'badges' }, i.flags.map((f) => badge(i, f))) },
    { label: 'Request', width: 'minmax(0, 1fr)', cls: 'mono', render: (i) => i.name.replace(/\.json$/, '') },
    { label: 'Costing', width: '120px', render: (i) => i.costing },
    ...mod.columns,
  ];
}

function renderTable(action, kindFromUrl) {
  const group = state.actions.find((g) => g.action === action);
  if (!group) {
    location.hash = '#/';
    return;
  }
  showSection('table');
  setCrumbs(h('a', { href: actionHref(action) }, action));
  const f = filtersFor(action);
  if (kindFromUrl) f.kind = kindFromUrl;
  const mod = group.module;

  const kinds = kindsFor(mod);
  $('#table-head').replaceChildren(
    h('div', { class: 'page-head' },
      h('h1', null, action),
      h('span', { class: 'dim' }, `${group.changed} of ${group.items.length} changed`),
      h('span', { class: `mod ${mod.detailed ? 'on' : ''}` }, mod.detailed ? 'detailed comparison' : 'generic json diff')),
    h('div', { class: 'kinds' }, kinds.map((k) => {
      const n = group.items.filter(k.test).length;
      return h('button', {
        class: `kind${k.key === f.kind ? ' on' : ''}`,
        disabled: !n && k.key !== f.kind,
        onclick: () => {
          f.kind = k.key;
          f.scroll = 0;
          renderTable(action);
        },
      }, h('b', null, n), h('span', null, k.label));
    })),
  );

  const costings = [...new Set(group.items.map((i) => i.costing).filter(Boolean))].sort();
  $('#f-costing').replaceChildren(h('option', { value: '' }, 'All costings'), costings.map((c) => h('option', { value: c }, c)));
  $('#f-sort').replaceChildren(...sortsFor(mod).map((s) => h('option', { value: s.key }, `Sort: ${s.label}`)));
  $('#f-search').value = f.q;
  $('#f-costing').value = f.costing;
  $('#f-sort').value = f.sort;

  const cols = columnsFor(mod);
  const template = cols.map((c) => c.width).join(' ');
  $('#list').style.setProperty('--cols', template);
  $('#list-head').style.setProperty('--cols', template);
  $('#list-head').replaceChildren(...cols.map((c) => h('span', { class: c.cls === 'num' ? 'num' : '' }, c.label)));

  const kind = kinds.find((k) => k.key === f.kind) || kinds[0];
  const sort = sortsFor(mod).find((s) => s.key === f.sort) || SEVERITY_SORT;
  const q = f.q.trim().toLowerCase();
  state.viewAction = action;
  state.view = group.items
    .filter((i) => kind.test(i) && (!f.costing || i.costing === f.costing) && (!q || i.name.toLowerCase().includes(q)))
    .sort((x, y) => sort.cmp(x, y) || byName(x, y));
  state.viewCols = cols;
  $('#f-count').textContent = `${state.view.length} shown`;
  $('#list-spacer').style.height = `${state.view.length * ROW_HEIGHT}px`;
  $('#list').scrollTop = f.scroll;
  renderRows();
}

function renderRows() {
  const list = $('#list');
  const spacer = $('#list-spacer');
  if (!state.view.length) {
    spacer.replaceChildren(h('div', { class: 'empty' }, 'Nothing matches the current filters.'));
    return;
  }
  const first = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - 10);
  const last = Math.min(state.view.length, Math.ceil((list.scrollTop + list.clientHeight) / ROW_HEIGHT) + 10);
  const rows = [];
  for (let i = first; i < last; i++) {
    const item = state.view[i];
    rows.push(h('a', { class: 'row', href: itemHref(item), style: { top: `${i * ROW_HEIGHT}px` } },
      state.viewCols.map((c) => h('span', { class: c.cls || '', title: c.label === 'Request' ? item.name : null }, c.render(item)))));
  }
  spacer.replaceChildren(...rows);
}

// ---------------------------------------------------------------------------
// detail

function navList(item) {
  if (state.viewAction === item.action && state.view.includes(item)) return state.view;
  return state.actions.find((g) => g.action === item.action).items.slice().sort((x, y) => SEVERITY_SORT.cmp(x, y) || byName(x, y));
}

function step(delta) {
  if (!state.detail) return;
  const list = navList(state.detail.item);
  const next = list[list.indexOf(state.detail.item) + delta];
  if (next) location.hash = itemHref(next);
}

function mainFor(mod) {
  const main = $('#main');
  let pane = [...main.children].find((c) => c.module === mod);
  if (!pane) {
    pane = h('div', { class: 'main-pane' });
    pane.module = mod;
    main.append(pane);
  }
  for (const c of main.children) c.hidden = c !== pane;
  return pane;
}

function renderDetail(action, name) {
  const item = state.byName.get(name);
  if (!item || item.action !== action) {
    location.hash = actionHref(action);
    return;
  }
  showSection('detail');
  setCrumbs(h('a', { href: actionHref(action) }, action), h('span', { class: 'mono' }, name));
  const mod = moduleFor(action);
  state.detail = { item, module: mod };

  const loadRun = (run) => {
    try {
      return state.runs[run].load(name);
    } catch (e) {
      return { error: `could not read response: ${e.message}` };
    }
  };
  const files = { a: loadRun('a'), b: loadRun('b') };
  const s = state.summary;

  const list = navList(item);
  const pos = list.indexOf(item);
  const errors = h('div', { class: 'errors' });
  const addError = (run, text) => errors.append(h('div', { class: 'callout' }, run ? h('span', { class: `tag ${run}` }, run.toUpperCase()) : null, ` ${text}`));
  if (files.a?.status_code !== files.b?.status_code && files.a && files.b) {
    addError(null, `HTTP status ${files.a.status_code ?? '–'} → ${files.b.status_code ?? '–'}`);
  }
  for (const run of ['a', 'b']) {
    if (!files[run]) addError(run, `no response in ${s[run]}`);
    else if (files[run].error) addError(run, files[run].error);
  }

  $('#side-head').replaceChildren(
    h('div', { class: 'side-nav' },
      h('a', { class: 'btn', href: actionHref(action) }, `← ${action}`),
      h('button', { class: 'btn', onclick: () => step(-1), disabled: pos <= 0, title: 'previous (k)' }, '↑'),
      h('button', { class: 'btn', onclick: () => step(1), disabled: pos >= list.length - 1, title: 'next (j)' }, '↓'),
      h('span', { class: 'pos' }, `${pos + 1} / ${list.length}`)),
    h('div', { class: 'side-title' }, name),
    h('div', { class: 'badges' }, item.flags.map((f) => badge(item, f)), item.costing ? h('span', { class: 'dim' }, item.costing) : null),
    errors,
  );

  const sideModule = $('#side-module');
  sideModule.replaceChildren();
  mod.renderDetail({
    item, files, summary: s, side: sideModule, main: mainFor(mod), addError,
  });

  const tail = [];
  const paths = item.entry?.differing_paths;
  if (paths?.length) {
    tail.push(h('h3', null, 'Differing JSON paths'), h('ul', { class: 'paths' }, paths.map((p) => h('li', null, p))),
      item.entry.differing_paths_truncated ? h('div', { class: 'dim' }, 'truncated') : null);
  }
  if (!mod.rawInMain) {
    tail.push(h('h3', null, 'Raw responses'));
    for (const run of ['a', 'b']) {
      const file = files[run];
      if (!file) continue;
      const other = files[run === 'a' ? 'b' : 'a'];
      const body = (f) => (f?.error ? f : f?.response);
      const det = h('details', { class: 'raw' }, h('summary', null,
        h('span', { class: `tag ${run}` }, run.toUpperCase()), h('b', null, s[run]),
        copyButton(() => JSON.stringify(body(file), null, 2))));
      det.addEventListener('toggle', () => {
        if (det.open && !det.querySelector('pre')) det.append(jsonView(body(file), body(other), Boolean(other)));
      });
      tail.push(det);
    }
  }
  tail.push(requestButton(item));
  $('#side-tail').replaceChildren(...tail.filter(Boolean));
  $('#side').scrollTop = 0;
}

function requestButton(item) {
  const stem = item.name.slice(`${item.action}_${item.costing}_`.length).replace(/\.json$/, '');
  const url = `${REQUESTS_BASE}${item.action}/${item.costing}/${stem}.json`;
  let text = '';
  const btn = copyButton(() => text, 'Copy request');
  btn.classList.remove('small');
  btn.title = 'copy request json to clipboard';
  btn.disabled = true;
  const note = h('span', { class: 'dim' });
  // fetched up front: a clipboard write after an await can lose the click's user activation
  fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((json) => {
      text = JSON.stringify(json.request, null, 2);
      btn.disabled = false;
    })
    .catch(() => {
      if (state.detail?.item === item) note.textContent = `not found: requests/${item.action}/${item.costing}/${stem}.json`;
    });
  return h('div', { class: 'request-copy' }, btn, note);
}

// ---------------------------------------------------------------------------
// routing

function route() {
  if (!state.summary) return;
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'a' && parts[1] && parts[2]) {
    renderDetail(parts[1], parts[2]);
    return;
  }
  state.detail = null;
  if (parts[0] === 'a' && parts[1]) {
    renderTable(parts[1], new URLSearchParams(query).get('kind'));
    if (query) history.replaceState(null, '', actionHref(parts[1]));
  } else {
    renderFront();
  }
}

function wire() {
  $('#url-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#url-input').value.trim();
    const params = new URLSearchParams(location.search);
    params.set('url', url);
    history.pushState(null, '', `?${params}${location.hash}`);
    loadUrl(url);
  });
  $('#file-input').addEventListener('change', (e) => e.target.files[0] && loadFile(e.target.files[0]));
  const token = $('#token-input');
  token.value = getToken();
  token.addEventListener('change', () => setToken(token.value.trim()));

  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    $('#drop-hint').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      $('#drop-hint').hidden = true;
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    $('#drop-hint').hidden = true;
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  const filter = (id, key, ev = 'change') => $(id).addEventListener(ev, (e) => {
    const f = filtersFor(state.viewAction);
    f[key] = e.target.value;
    f.scroll = 0;
    renderTable(state.viewAction);
  });
  filter('#f-search', 'q', 'input');
  filter('#f-costing', 'costing');
  filter('#f-sort', 'sort');

  let raf = 0;
  $('#list').addEventListener('scroll', () => {
    if (state.viewAction && !$('#table').hidden) filtersFor(state.viewAction).scroll = $('#list').scrollTop;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(renderRows);
  });
  window.addEventListener('resize', () => !$('#table').hidden && renderRows());
  window.addEventListener('hashchange', route);

  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (state.detail) location.hash = actionHref(state.detail.item.action);
      else if (!$('#table').hidden) location.hash = '#/';
      return;
    }
    if (!state.detail) return;
    if (e.key === 'j') step(1);
    else if (e.key === 'k') step(-1);
    else state.detail.module.onKey?.(e);
  });
}

wire();
const url = new URLSearchParams(location.search).get('url');
if (url) {
  $('#url-input').value = url;
  loadUrl(url);
} else {
  showLanding();
}
