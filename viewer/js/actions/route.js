// /route: valhalla and osrm json, compared on a map with maneuver / intersection level detail.
/* global maplibregl */
import {
  $, h, fmtDist, fmtDur, fmtNum, relDiff, pctSpan, cmpValue,
} from '../util.js';

const COLOR_KEY = 'valhalla-qa-basemap-color';

const OSM_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -1, 'raster-contrast': 0.1 } }],
};

// valhalla's DirectionsLeg_Maneuver_Type
const VALHALLA_TYPES = ['None', 'Start', 'Start right', 'Start left', 'Destination', 'Destination right',
  'Destination left', 'Becomes', 'Continue', 'Slight right', 'Right', 'Sharp right', 'U-turn right', 'U-turn left',
  'Sharp left', 'Left', 'Slight left', 'Ramp straight', 'Ramp right', 'Ramp left', 'Exit right', 'Exit left',
  'Stay straight', 'Stay right', 'Stay left', 'Merge', 'Roundabout enter', 'Roundabout exit', 'Ferry enter',
  'Ferry exit', 'Transit', 'Transit transfer', 'Transit remain on', 'Transit connection start',
  'Transit connection transfer', 'Transit connection destination', 'Post transit connection destination',
  'Merge right', 'Merge left', 'Elevator enter', 'Steps enter', 'Escalator enter', 'Building enter', 'Building exit'];

const absRel = (i, k) => Math.abs(i.metrics?.[k] ?? 0);

// ---------------------------------------------------------------------------
// parsing

function decodePolyline(str, precision) {
  const factor = 10 ** precision;
  const coords = [];
  let lat = 0;
  let lon = 0;
  let i = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let result = 0;
      let byte;
      do {
        byte = str.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    coords.push([lon / factor, lat / factor]);
  }
  return coords;
}

/** Decode a shape as polyline6, polyline5 (guessed by proximity to the input locations) or geojson. */
function decodeShape(shape, refs) {
  if (!shape) return [];
  if (typeof shape === 'object') return shape.coordinates || [];
  const c6 = decodePolyline(shape, 6);
  if (!c6.length || !refs.length) return c6;
  const near = (p) => Math.min(...refs.map((r) => Math.hypot(p[0] - r[0], p[1] - r[1])));
  if (near(c6[0]) < 0.5) return c6;
  const c5 = decodePolyline(shape, 5);
  return near(c5[0]) < near(c6[0]) ? c5 : c6;
}

function parseValhalla(resp) {
  if (!resp.trip) {
    return { format: 'valhalla', error: `${resp.error_code ?? ''}: ${resp.error ?? 'no trip in response'}`, routes: [], locations: [] };
  }
  const locations = (resp.trip.locations || []).map((l) => [l.lon, l.lat]);
  const trips = [resp.trip, ...(resp.alternates || []).map((alt) => alt.trip).filter(Boolean)];
  const routes = trips.map((trip) => {
    const unit = trip.units === 'miles' ? 1609.344 : 1000;
    const lines = [];
    const maneuvers = [];
    (trip.legs || []).forEach((leg, li) => {
      const coords = decodeShape(leg.shape, locations);
      lines.push(coords);
      for (const m of leg.maneuvers || []) {
        maneuvers.push({
          leg: li,
          key: String(m.type),
          type: VALHALLA_TYPES[m.type] ?? String(m.type),
          instruction: m.instruction || '',
          distance: m.length != null ? m.length * unit : null,
          duration: m.time,
          cost: m.cost,
          coords: coords.slice(m.begin_shape_index, (m.end_shape_index ?? m.begin_shape_index) + 1),
          location: coords[m.begin_shape_index],
          intersections: null,
          raw: m,
        });
      }
    });
    const s = trip.summary || {};
    return { distance: s.length != null ? s.length * unit : null, duration: s.time, cost: s.cost, lines, maneuvers };
  });
  return { format: 'valhalla', error: null, routes, locations };
}

function parseOsrm(resp) {
  const locations = (resp.waypoints || []).map((w) => w.location);
  const error = resp.code === 'Ok' ? null : `${resp.code}: ${resp.message ?? ''}`;
  const routes = (resp.routes || []).map((r) => {
    const maneuvers = [];
    (r.legs || []).forEach((leg, li) => {
      for (const s of leg.steps || []) {
        const m = s.maneuver || {};
        maneuvers.push({
          leg: li,
          key: `${m.type}:${m.modifier ?? ''}`,
          type: [m.type, m.modifier].filter(Boolean).join(' '),
          instruction: m.instruction || s.name || '',
          distance: s.distance,
          duration: s.duration,
          cost: s.weight,
          coords: decodeShape(s.geometry, locations),
          location: m.location,
          intersections: (s.intersections || []).map((x) => ({
            location: x.location,
            duration: x.duration,
            turnDuration: x.turn_duration,
            weight: x.weight,
            turnWeight: x.turn_weight,
          })),
          raw: s,
        });
      }
    });
    return { distance: r.distance, duration: r.duration, cost: r.weight, lines: [decodeShape(r.geometry, locations)], maneuvers };
  });
  return { format: 'osrm', error, routes, locations };
}

function normalize(file) {
  if (!file) return null;
  if (file.error) return { format: '', error: `no response: ${file.error}`, routes: [], locations: [] };
  const resp = file.response;
  if (resp && typeof resp === 'object') {
    if ('trip' in resp || 'error_code' in resp) return parseValhalla(resp);
    if ('code' in resp) return parseOsrm(resp);
  }
  return { format: 'unknown', error: 'unrecognized response format', routes: [], locations: [] };
}

// ---------------------------------------------------------------------------
// map

const EMPTY = { type: 'FeatureCollection', features: [] };

const view = {
  map: null,
  ready: null,
  layers: { a: true, b: true, alt: true, points: true },
  norm: null, // {a, b}
  routeIndex: 0,
  runTab: 'a',
  onlyChanged: false,
  selected: null, // {idx, run}
  ctx: null,
};

function basemapColor() {
  try { return localStorage.getItem(COLOR_KEY) === 'true'; } catch { return false; }
}

function setBasemapColor(color) {
  try { localStorage.setItem(COLOR_KEY, String(color)); } catch { /* storage unavailable */ }
  applyBasemapColor();
}

function applyBasemapColor() {
  const color = basemapColor();
  for (const b of document.querySelectorAll('#basemap-toggle button')) b.classList.toggle('on', b.dataset.color === String(color));
  if (view.map?.getLayer('osm')) {
    view.map.setPaintProperty('osm', 'raster-saturation', color ? 0 : -1);
    view.map.setPaintProperty('osm', 'raster-contrast', color ? 0 : 0.1);
  }
}

function ensureMap(main, summary) {
  if (view.ready) return view.ready;
  const customStyle = new URLSearchParams(location.search).get('style');
  main.append(
    h('div', { id: 'map' }),
    h('div', { id: 'layer-ctl', class: 'overlay' }),
    customStyle ? null : h('div', { id: 'basemap-toggle', class: 'overlay seg' },
      h('button', { type: 'button', 'data-color': 'false', onclick: () => setBasemapColor(false) }, 'Grayscale'),
      h('button', { type: 'button', 'data-color': 'true', onclick: () => setBasemapColor(true) }, 'Color')),
  );
  renderLayerControl(summary);
  applyBasemapColor();
  const map = new maplibregl.Map({
    container: 'map', style: customStyle || OSM_STYLE, center: [8.2, 46.8], zoom: 7, attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl(), 'bottom-right');
  view.map = map;
  view.ready = new Promise((resolve) => {
    map.on('load', () => {
      applyBasemapColor();
      addLayers(map);
      resolve(map);
    });
  });
  return view.ready;
}

function addLayers(map) {
  const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#0047ff';
  for (const id of ['routes-a', 'routes-b', 'points-a', 'points-b', 'locations', 'hl-line', 'hl-point']) {
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }
  const line = { 'line-cap': 'round', 'line-join': 'round' };
  const sel = ['==', ['get', 'selected'], true];
  const unsel = ['!=', ['get', 'selected'], true];
  map.addLayer({ id: 'hl-line', type: 'line', source: 'hl-line', layout: line, paint: { 'line-color': '#000', 'line-width': 20, 'line-opacity': 0.22 } });
  map.addLayer({ id: 'routes-a-other', type: 'line', source: 'routes-a', filter: unsel, layout: line, paint: { 'line-color': '#000', 'line-width': 5, 'line-opacity': 0.5, 'line-dasharray': [1, 1.5] } });
  map.addLayer({ id: 'routes-b-other', type: 'line', source: 'routes-b', filter: unsel, layout: line, paint: { 'line-color': primary, 'line-width': 3, 'line-opacity': 0.6, 'line-dasharray': [1, 1.5] } });
  map.addLayer({ id: 'routes-a', type: 'line', source: 'routes-a', filter: sel, layout: line, paint: { 'line-color': '#000', 'line-width': 8 } });
  map.addLayer({ id: 'routes-b', type: 'line', source: 'routes-b', filter: sel, layout: line, paint: { 'line-color': primary, 'line-width': 3.5 } });
  map.addLayer({ id: 'points-a', type: 'circle', source: 'points-a', paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#000', 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'points-b', type: 'circle', source: 'points-b', paint: { 'circle-radius': 2.5, 'circle-color': primary } });
  map.addLayer({ id: 'locations', type: 'circle', source: 'locations', paint: { 'circle-radius': 8, 'circle-color': '#000', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
  map.addLayer({ id: 'hl-point', type: 'circle', source: 'hl-point', paint: { 'circle-radius': 11, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': primary, 'circle-stroke-width': 3 } });

  for (const run of ['a', 'b']) {
    map.on('click', `points-${run}`, (e) => {
      const idx = e.features[0]?.properties.idx;
      if (idx != null) selectManeuver(idx, run, false, true);
    });
    map.on('mouseenter', `points-${run}`, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', `points-${run}`, () => { map.getCanvas().style.cursor = ''; });
  }
  applyLayerVisibility();
}

function applyLayerVisibility() {
  const map = view.map;
  if (!map?.getLayer('routes-a')) return;
  const L = view.layers;
  const vis = {
    'routes-a': L.a,
    'routes-b': L.b,
    'routes-a-other': L.a && L.alt,
    'routes-b-other': L.b && L.alt,
    'points-a': L.a && L.points,
    'points-b': L.b && L.points,
  };
  for (const [id, on] of Object.entries(vis)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

function toggleLayer(key, value) {
  view.layers[key] = value ?? !view.layers[key];
  applyLayerVisibility();
  for (const input of document.querySelectorAll('#layer-ctl input')) input.checked = view.layers[input.dataset.key];
}

function renderLayerControl(summary) {
  const box = (key, ...label) => h('label', null,
    h('input', { type: 'checkbox', 'data-key': key, checked: view.layers[key], onchange: (e) => toggleLayer(key, e.target.checked) }),
    ...label);
  $('#layer-ctl').replaceChildren(
    box('a', h('span', { class: 'swatch a' }), h('span', { class: 'tag a' }, 'A'), summary.a),
    box('b', h('span', { class: 'swatch b' }), h('span', { class: 'tag b' }, 'B'), summary.b),
    box('alt', 'Alternates'),
    box('points', 'Maneuver points'),
    h('div', { class: 'hint' }, '1 / 2 toggle A / B'),
  );
}

function routeFeatures(norm) {
  return {
    type: 'FeatureCollection',
    features: (norm?.routes || []).map((r, i) => ({
      type: 'Feature',
      properties: { selected: i === view.routeIndex },
      geometry: { type: 'MultiLineString', coordinates: r.lines },
    })),
  };
}

function pointFeatures(norm) {
  const route = norm?.routes[view.routeIndex];
  return {
    type: 'FeatureCollection',
    features: (route?.maneuvers || []).map((m, idx) => (m.location ? {
      type: 'Feature', properties: { idx }, geometry: { type: 'Point', coordinates: m.location },
    } : null)).filter(Boolean),
  };
}

function extend(bounds, coords) {
  for (const c of coords) bounds.extend(c);
}

async function updateMap(fit) {
  const map = await view.ready;
  const { a, b } = view.norm;
  map.getSource('routes-a').setData(routeFeatures(a));
  map.getSource('routes-b').setData(routeFeatures(b));
  map.getSource('points-a').setData(pointFeatures(a));
  map.getSource('points-b').setData(pointFeatures(b));
  const locs = a?.locations?.length ? a.locations : b?.locations || [];
  map.getSource('locations').setData({
    type: 'FeatureCollection',
    features: locs.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })),
  });
  highlight([], null, false);
  if (!fit) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const n of [a, b]) for (const r of n?.routes || []) for (const l of r.lines) extend(bounds, l);
  extend(bounds, locs);
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 70, duration: 0, maxZoom: 17 });
}

function highlight(lines, point, fit) {
  const map = view.map;
  if (!map?.getSource('hl-line')) return;
  lines = lines.filter((l) => l.length > 0);
  map.getSource('hl-line').setData(lines.length ? {
    type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines },
  } : EMPTY);
  map.getSource('hl-point').setData(point ? {
    type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: point },
  } : EMPTY);
  if (!fit) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const l of lines) extend(bounds, l);
  if (point) bounds.extend(point);
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 90, maxZoom: 17, duration: 400 });
}

function flyTo(point) {
  if (point && view.map) view.map.easeTo({ center: point, zoom: Math.max(view.map.getZoom(), 17), duration: 400 });
}

// ---------------------------------------------------------------------------
// sidebar

function currentRoutes() {
  const { a, b } = view.norm;
  return { ra: a?.routes[view.routeIndex] || null, rb: b?.routes[view.routeIndex] || null };
}

function isAligned(ra, rb) {
  return ra && rb && ra.maneuvers.length === rb.maneuvers.length
    && ra.maneuvers.every((m, i) => m.key === rb.maneuvers[i].key);
}

function flatFields(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (k === 'intersections' || k === 'geometry' || k.startsWith('verbal_')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = typeof v2 === 'object' ? JSON.stringify(v2) : v2;
    } else {
      out[k] = Array.isArray(v) ? JSON.stringify(v) : v;
    }
  }
  return out;
}

function renderSide() {
  const { side } = view.ctx;
  const parts = [];
  const { norm } = view;
  const nRoutes = Math.max(norm.a?.routes.length || 0, norm.b?.routes.length || 0);
  if (!nRoutes) {
    side.replaceChildren();
    return;
  }

  if (nRoutes > 1) {
    parts.push(h('div', { class: 'seg route-tabs' }, Array.from({ length: nRoutes }, (_, i) => h('button', {
      class: i === view.routeIndex ? 'on' : '',
      onclick: () => {
        view.routeIndex = i;
        view.selected = null;
        renderSide();
        updateMap(false);
      },
    }, i === 0 ? 'Primary' : `Alt ${i}`, ` · ${[norm.a?.routes[i] && 'A', norm.b?.routes[i] && 'B'].filter(Boolean).join('+')}`))));
  }

  const { ra, rb } = currentRoutes();
  const row = (label, key, fmt) => {
    const a = ra?.[key];
    const b = rb?.[key];
    const both = typeof a === 'number' && typeof b === 'number';
    const changed = both && a !== b;
    return h('tr', { class: changed ? 'changed' : '' }, h('td', null, label), h('td', null, fmt(a)), h('td', null, fmt(b)),
      h('td', null, changed ? fmt(b - a) : ''), h('td', null, both ? pctSpan(relDiff(a, b)) : ''));
  };
  parts.push(h('table', { class: 'grid metrics' },
    h('thead', null, h('tr', null, h('th'), h('th', null, h('span', { class: 'tag a' }, 'A')),
      h('th', null, h('span', { class: 'tag b' }, 'B')), h('th', null, 'Δ'), h('th', null, 'Δ%'))),
    h('tbody', null,
      row('Distance', 'distance', fmtDist),
      row('Duration', 'duration', fmtDur),
      row('Cost', 'cost', fmtNum),
      h('tr', { class: ra && rb && ra.maneuvers.length !== rb.maneuvers.length ? 'changed' : '' },
        h('td', null, 'Maneuvers'), h('td', null, ra?.maneuvers.length ?? '–'), h('td', null, rb?.maneuvers.length ?? '–'), h('td'), h('td')))));

  const aligned = isAligned(ra, rb);
  const head = h('div', { class: 'section-head' }, h('h3', null, 'Maneuvers'));
  if (aligned) {
    head.append(h('label', { class: 'check' }, h('input', {
      type: 'checkbox',
      checked: view.onlyChanged,
      onchange: (e) => {
        view.onlyChanged = e.target.checked;
        renderSide();
      },
    }), 'Only changed'));
  }
  parts.push(head);

  if (aligned) {
    let shown = 0;
    ra.maneuvers.forEach((ma, i) => {
      const mb = rb.maneuvers[i];
      const changed = JSON.stringify(ma.raw) !== JSON.stringify(mb.raw);
      if (view.onlyChanged && !changed) return;
      shown++;
      parts.push(maneuverEl(i, ma, mb, null, changed));
    });
    if (!shown) parts.push(h('div', { class: 'empty' }, 'No maneuver differs.'));
  } else {
    const runs = ['a', 'b'].filter((r) => (r === 'a' ? ra : rb));
    if (!runs.includes(view.runTab)) view.runTab = runs[0];
    if (ra && rb) {
      parts.push(h('div', { class: 'callout' },
        `Maneuver sequences differ (A ${ra.maneuvers.length}, B ${rb.maneuvers.length}). Showing each run separately.`));
    }
    parts.push(h('div', { class: 'seg run-tabs' }, runs.map((r) => h('button', {
      class: r === view.runTab ? 'on' : '',
      onclick: () => {
        view.runTab = r;
        view.selected = null;
        renderSide();
      },
    }, h('span', { class: `tag ${r}` }, r.toUpperCase()), ` ${view.ctx.summary[r]}`))));
    const route = view.runTab === 'a' ? ra : rb;
    route.maneuvers.forEach((m, i) => parts.push(maneuverEl(i, m, null, view.runTab, false)));
  }
  side.replaceChildren(...parts);
}

function maneuverEl(i, ma, mb, run, changed) {
  const single = !mb;
  const el = h('div', {
    class: `man${changed ? ' changed' : ''}`,
    id: single ? `m-${run}-${i}` : `m-${i}`,
    onmouseenter: () => highlightManeuver(i, run, false),
    onclick: (e) => {
      if (e.target.closest('.man-detail, .man-toggle')) return;
      selectManeuver(i, run, true, false);
    },
  });
  if (view.selected?.idx === i && (!single || view.selected.run === run)) el.classList.add('selected');

  const toggle = h('button', { class: 'btn small man-toggle', title: 'all fields and intersections' }, '+');
  toggle.addEventListener('click', () => {
    let detail = el.querySelector('.man-detail');
    if (!detail) {
      detail = maneuverDetail(ma, mb);
      detail.hidden = true;
      el.append(detail);
    }
    detail.hidden = !detail.hidden;
    toggle.textContent = detail.hidden ? '+' : '−';
  });

  el.append(h('div', { class: 'man-head' },
    h('span', { class: 'man-idx' }, i),
    h('span', { class: 'man-type' }, ma.type),
    h('span', { class: 'man-instr' }, ma.instruction),
    toggle));
  if (mb && mb.instruction !== ma.instruction) {
    el.append(h('div', { class: 'man-instr-b' }, h('span', { class: 'tag b' }, 'B'), ' ', mb.instruction));
  }
  const metric = (k, key, fmt) => h('span', null, h('span', { class: 'k' }, k), cmpValue(ma[key], mb?.[key], fmt, single));
  el.append(h('div', { class: 'man-metrics' },
    metric('dist', 'distance', fmtDist),
    metric('time', 'duration', fmtDur),
    metric('cost', 'cost', fmtNum),
    ma.intersections ? h('span', { class: 'dim' }, `${ma.intersections.length} int.`) : null));
  return el;
}

function maneuverDetail(ma, mb) {
  const wrap = h('div', { class: 'man-detail' });
  const fa = flatFields(ma.raw);
  const fb = mb ? flatFields(mb.raw) : null;
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb || {})])];
  wrap.append(h('h4', null, 'Fields'), h('table', { class: 'grid fields' }, h('tbody', null, keys.map((k) => {
    const diff = fb && fa[k] !== fb[k];
    return h('tr', { class: diff ? 'changed' : '' }, h('td', null, k), h('td', null, fmtNum(fa[k])),
      fb ? h('td', null, diff ? fmtNum(fb[k]) : '') : null);
  }))));

  const ia = ma.intersections;
  const ib = mb?.intersections;
  if (ia && ib && ia.length === ib.length) {
    wrap.append(h('h4', null, 'Intersections'), intersectionsTable(ia, ib));
  } else {
    if (ia) wrap.append(h('h4', null, mb ? 'Intersections A' : 'Intersections'), intersectionsTable(ia, null));
    if (ib) wrap.append(h('h4', null, 'Intersections B'), intersectionsTable(ib, null));
  }
  return wrap;
}

function intersectionsTable(ia, ib) {
  const cols = [['duration', 'dur'], ['turnDuration', 'turn dur'], ['weight', 'weight'], ['turnWeight', 'turn wt']];
  return h('table', { class: 'grid inters' },
    h('thead', null, h('tr', null, h('th', null, '#'), cols.map(([, l]) => h('th', null, l)))),
    h('tbody', null, ia.map((xa, j) => {
      const xb = ib?.[j];
      const onclick = () => {
        highlight([], xa.location, false);
        flyTo(xa.location);
      };
      return h('tr', { onclick }, h('td', null, j), cols.map(([k]) => h('td', null, cmpValue(xa[k], xb?.[k], fmtNum, !ib))));
    })));
}

function maneuversFor(idx, run) {
  const { ra, rb } = currentRoutes();
  if (run === 'a') return [ra?.maneuvers[idx]];
  if (run === 'b') return [rb?.maneuvers[idx]];
  return [ra?.maneuvers[idx], rb?.maneuvers[idx]];
}

function highlightManeuver(idx, run, fit) {
  const ms = maneuversFor(idx, run).filter(Boolean);
  if (ms.length) highlight(ms.map((m) => m.coords), ms[0].location, fit);
}

/** Select a maneuver from the sidebar or from a map point (fromMap). */
function selectManeuver(idx, run, fit, fromMap) {
  const { ra, rb } = currentRoutes();
  const aligned = isAligned(ra, rb);
  const rowRun = aligned ? null : run;
  view.selected = { idx, run: rowRun };
  if (!aligned && run && run !== view.runTab) {
    view.runTab = run;
    renderSide();
  }
  if (aligned && view.onlyChanged && !document.getElementById(`m-${idx}`)) {
    view.onlyChanged = false;
    renderSide();
  }
  for (const el of document.querySelectorAll('.man.selected')) el.classList.remove('selected');
  const el = document.getElementById(aligned ? `m-${idx}` : `m-${run}-${idx}`);
  if (el) {
    el.classList.add('selected');
    if (fromMap) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  highlightManeuver(idx, rowRun, fit);
}

// ---------------------------------------------------------------------------
// module

export default {
  detailed: true,
  rawInMain: false,

  flags: {
    error: { sev: 4, label: 'error', style: 'hot' },
    routes: { sev: 3, label: 'route count', style: 'solid' },
    geometry: { sev: 2, label: 'geometry', style: 'solid' },
    maneuvers: { sev: 2, label: 'maneuvers', style: 'solid' },
    values: { sev: 1, label: 'values', style: 'line' },
    json: { sev: 1, label: 'json', style: 'line' },
  },

  classify(item) {
    const r = item.entry?.route;
    if (!r) return { flags: item.status === 'different' && !item.flags.length ? ['json'] : [], magnitude: 0, metrics: {} };
    const flags = [];
    const metrics = {};
    let magnitude = 0;
    const routes = r.routes || [];
    if (r.error) flags.push('error');
    if (r.route_count) flags.push('routes');
    if (routes.some((x) => x.geometry_changed)) flags.push('geometry');
    if (routes.some((x) => x.maneuver_types_changed || x.maneuvers || x.legs)) flags.push('maneuvers');
    let values = false;
    for (const x of routes) {
      for (const k of ['distance', 'duration', 'cost']) {
        if (!x[k]) continue;
        values = true;
        const d = x[k].rel_diff ?? (x[k].a === 0 ? Infinity : null);
        if (d == null) continue;
        magnitude = Math.max(magnitude, Math.abs(d));
        if (x.index === 0) metrics[k] = d;
      }
    }
    if (values) flags.push('values');
    if (!flags.length && !item.flags.length) flags.push('json');
    const fmt = r.format;
    metrics.format = fmt == null ? '' : typeof fmt === 'string' ? fmt : `${fmt.a}/${fmt.b}`;
    return { flags, magnitude, metrics };
  },

  kinds: [
    { key: 'error', label: 'Error changed', test: (i) => i.flags.includes('error') },
    { key: 'routes', label: 'Route count changed', test: (i) => i.flags.includes('routes') },
    { key: 'geometry', label: 'Geometry changed', test: (i) => i.flags.includes('geometry') },
    { key: 'maneuvers', label: 'Maneuvers changed', test: (i) => i.flags.includes('maneuvers') },
    { key: 'values', label: 'Values only', test: (i) => i.status === 'different' && i.severity === 1 },
  ],

  columns: [
    { label: 'Format', width: '90px', render: (i) => i.metrics?.format || '' },
    { label: 'Δ dist', width: '84px', cls: 'num', render: (i) => pctSpan(i.metrics?.distance) },
    { label: 'Δ time', width: '84px', cls: 'num', render: (i) => pctSpan(i.metrics?.duration) },
    { label: 'Δ cost', width: '84px', cls: 'num', render: (i) => pctSpan(i.metrics?.cost) },
  ],

  sorts: [
    { key: 'magnitude', label: 'Largest relative change', cmp: (x, y) => y.magnitude - x.magnitude },
    { key: 'distance', label: '|Δ distance|', cmp: (x, y) => absRel(y, 'distance') - absRel(x, 'distance') },
    { key: 'duration', label: '|Δ duration|', cmp: (x, y) => absRel(y, 'duration') - absRel(x, 'duration') },
    { key: 'cost', label: '|Δ cost|', cmp: (x, y) => absRel(y, 'cost') - absRel(x, 'cost') },
  ],

  renderDetail(ctx) {
    view.ctx = ctx;
    view.norm = { a: normalize(ctx.files.a), b: normalize(ctx.files.b) };
    view.routeIndex = 0;
    view.selected = null;
    view.runTab = ctx.files.a ? 'a' : 'b';
    for (const run of ['a', 'b']) {
      if (ctx.files[run] && view.norm[run]?.error && !ctx.files[run].error) ctx.addError(run, view.norm[run].error);
    }
    renderSide();
    ensureMap(ctx.main, ctx.summary).then((map) => {
      map.resize();
      updateMap(true);
    });
  },

  onKey(e) {
    if (e.key === '1') toggleLayer('a');
    else if (e.key === '2') toggleLayer('b');
    else return false;
    return true;
  },
};
