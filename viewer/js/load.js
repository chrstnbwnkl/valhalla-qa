// Fetching and unpacking QA artifacts: summary.json next to <a>.zip and <b>.zip (or unpacked <a>/, <b>/).
/* global fflate */
import { fmtBytes } from './util.js';

const TOKEN_KEY = 'valhalla-qa-gh-token';
const CACHE_SIZE = 40;

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable */ }
}

/** github.com/<o>/<r>/actions/runs/<id>/artifacts/<id> -> the API download url */
function ghApiUrl(url) {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/artifacts\/(\d+)/);
  return m ? `https://api.github.com/repos/${m[1]}/${m[2]}/actions/artifacts/${m[3]}/zip` : url;
}

export async function fetchBytes(url, onProgress) {
  const target = ghApiUrl(url);
  const headers = {};
  if (target.startsWith('https://api.github.com/')) {
    const token = getToken();
    if (!token) throw new Error('GitHub artifact downloads need a token, set one below and load again.');
    headers.Authorization = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(target, { headers });
  } catch {
    throw new Error(`Could not fetch ${target} (network error or blocked by CORS). `
      + 'Download the zip and drop it here instead.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${target}`);

  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(`Downloading ${fmtBytes(received)}${total ? ` / ${fmtBytes(total)}` : ''}`);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** A run backed by a zip: only the central directory is read up front, entries are inflated on demand. */
function zipRun(bytes) {
  const paths = new Map();
  fflate.unzipSync(bytes, {
    filter(f) {
      const i = f.name.lastIndexOf('responses/');
      if (i >= 0 && f.name.endsWith('.json')) paths.set(f.name.slice(i + 'responses/'.length), f.name);
      return false;
    },
  });
  return {
    names: new Set(paths.keys()),
    load(name) {
      const path = paths.get(name);
      const out = fflate.unzipSync(bytes, { filter: (f) => f.name === path });
      return JSON.parse(fflate.strFromU8(out[path]));
    },
  };
}

function dirRun(files, dir) {
  const paths = Object.keys(files).filter((n) => n.startsWith(dir) && n.endsWith('.json'));
  if (!paths.length) return null;
  return {
    names: new Set(paths.map((n) => n.slice(dir.length))),
    load: (n) => JSON.parse(fflate.strFromU8(files[dir + n])),
  };
}

function withCache(run) {
  const cache = new Map();
  return {
    names: run.names,
    has: (name) => run.names.has(name),
    load(name) {
      if (!run.names.has(name)) return null;
      if (cache.has(name)) {
        const v = cache.get(name);
        cache.delete(name);
        cache.set(name, v);
        return v;
      }
      const v = run.load(name);
      cache.set(name, v);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
      return v;
    },
  };
}

/** Returns {summary, runs: {a, b}} where each run has names, has(name) and load(name). */
export function openArtifact(bytes) {
  const files = fflate.unzipSync(bytes);
  const summaryPath = Object.keys(files)
    .filter((n) => n === 'summary.json' || n.endsWith('/summary.json'))
    .sort((x, y) => x.length - y.length)[0];
  if (!summaryPath) throw new Error('No summary.json found in the zip.');
  const prefix = summaryPath.slice(0, -'summary.json'.length);
  const summary = JSON.parse(fflate.strFromU8(files[summaryPath]));

  const open = (name) => {
    const zip = files[`${prefix}${name}.zip`];
    const run = zip ? zipRun(zip) : dirRun(files, `${prefix}${name}/responses/`);
    if (!run) throw new Error(`Neither ${name}.zip nor ${name}/responses/ found next to summary.json`);
    return withCache(run);
  };
  return { summary, runs: { a: open(summary.a), b: open(summary.b) } };
}
