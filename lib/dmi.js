// DMI Open Data API client — key-free host opendataapi.dmi.dk (since 2025-12-02).
// Fair-use limit is 500 req / 5 s → we stay well under and back off on HTTP 429.
// All data is CC BY 4.0 (attribute DMI). See RESEARCH.md for endpoint provenance.
'use strict';

const BASE = 'https://opendataapi.dmi.dk';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// GET JSON with retry + exponential backoff on 429 ("Server is busy"), 5xx, and
// transient network errors. DMI's fair-use limit is 500 req/5s; the plugin fires
// only a handful of calls per poll and spaces them, so backing off here (0.7s,
// 1.4s, 2.8s between tries) rides out a busy moment without breaching the limit.
async function getJson(url, opts = {}) {
  const tries = opts.tries || 4;
  const timeoutMs = opts.timeoutMs || 15000;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    // Per-request timeout via AbortController — a slow/hung DMI never blocks the
    // caller (critical for the on-demand Weather API path).
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/geo+json' }, signal: ac.signal });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`DMI ${res.status} ${res.statusText} for ${url}`);
        if (i < tries - 1) { await delay(700 * 2 ** i); continue; }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`DMI ${res.status} ${res.statusText} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`DMI timeout (${timeoutMs}ms) for ${url}`) : e;
      if (i < tries - 1) await delay(700 * 2 ** i);
    } finally {
      clearTimeout(to);
    }
  }
  throw lastErr || new Error(`DMI request failed: ${url}`);
}

// Forecast EDR position query. Returns rows [{ time, <param>: number, ... }] in
// ascending time order. `coords=POINT(lon lat)` per OGC EDR; f=GeoJSON gives one
// Feature per forecast step with the step time in properties.step.
async function edrPosition(collection, lon, lat, params, range, reqOpts) {
  const q = new URLSearchParams({
    coords: `POINT(${lon} ${lat})`,
    crs: 'crs84',
    'parameter-name': params.join(','),
    f: 'GeoJSON',
  });
  if (range && range.from && range.to) q.set('datetime', `${range.from}/${range.to}`);
  const url = `${BASE}/v1/forecastedr/collections/${collection}/position?${q}`;
  const j = await getJson(url, reqOpts);
  const rows = (j.features || []).map((f) => {
    const p = f.properties || {};
    const row = { time: p.step };
    for (const k of params) if (typeof p[k] === 'number') row[k] = p[k];
    return row;
  });
  rows.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return rows;
}

// OGC-Features observation items (service = 'metObs' | 'oceanObs'). Returns raw
// GeoJSON features: { geometry.coordinates:[lon,lat], properties:{parameterId,value,observed,stationId} }.
async function obsItems(service, opts = {}) {
  const q = new URLSearchParams({ limit: String(opts.limit || 1000) });
  if (opts.bbox) q.set('bbox', opts.bbox.join(','));
  if (opts.stationId) q.set('stationId', opts.stationId);
  if (opts.parameterId) q.set('parameterId', opts.parameterId);
  if (opts.datetime) q.set('datetime', opts.datetime);
  const url = `${BASE}/v2/${service}/collections/observation/items?${q}`;
  const j = await getJson(url, opts.req);
  return j.features || [];
}

module.exports = { BASE, edrPosition, obsItems, getJson };