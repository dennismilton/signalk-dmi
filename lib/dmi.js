// DMI Open Data API client — key-free host opendataapi.dmi.dk (since 2025-12-02).
// Fair-use limit is 500 req / 5 s → we stay well under and back off on HTTP 429.
// All data is CC BY 4.0 (attribute DMI). See RESEARCH.md for endpoint provenance.
'use strict';

const BASE = 'https://opendataapi.dmi.dk';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// GET JSON with a small retry on 429 ("Server is busy") / transient network error.
async function getJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/geo+json' } });
      if (res.status === 429) {
        await delay(1200 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`DMI ${res.status} ${res.statusText} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await delay(600 * (i + 1));
    }
  }
  throw lastErr || new Error(`DMI request failed: ${url}`);
}

// Forecast EDR position query. Returns rows [{ time, <param>: number, ... }] in
// ascending time order. `coords=POINT(lon lat)` per OGC EDR; f=GeoJSON gives one
// Feature per forecast step with the step time in properties.step.
async function edrPosition(collection, lon, lat, params, range) {
  const q = new URLSearchParams({
    coords: `POINT(${lon} ${lat})`,
    crs: 'crs84',
    'parameter-name': params.join(','),
    f: 'GeoJSON',
  });
  if (range && range.from && range.to) q.set('datetime', `${range.from}/${range.to}`);
  const url = `${BASE}/v1/forecastedr/collections/${collection}/position?${q}`;
  const j = await getJson(url);
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
  const j = await getJson(url);
  return j.features || [];
}

module.exports = { BASE, edrPosition, obsItems, getJson };