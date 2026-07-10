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
async function getWith(url, parse, accept, opts = {}) {
  const tries = opts.tries || 4;
  const timeoutMs = opts.timeoutMs || 15000;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    // Per-request timeout via AbortController — a slow/hung source never blocks
    // the caller (critical for the on-demand Weather API path).
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { Accept: accept }, signal: ac.signal });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        lastErr.status = res.status;   // let callers distinguish 429 (back off) from data
        if (i < tries - 1) { await delay(700 * 2 ** i); continue; }
        throw lastErr;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        err.status = res.status;
        throw err;
      }
      return await parse(res);
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`timeout (${timeoutMs}ms) for ${url}`) : e;
      if (i < tries - 1) await delay(700 * 2 ** i);
    } finally {
      clearTimeout(to);
    }
  }
  throw lastErr || new Error(`request failed: ${url}`);
}

// GET JSON with retry + exponential backoff on 429/5xx and transient errors.
const getJson = (url, opts) => getWith(url, (r) => r.json(), 'application/geo+json', opts);

// GET plain text (used for the MeteoAlarm CAP/Atom warnings feed) — same
// retry/backoff/timeout policy as getJson.
const getText = (url, opts) => getWith(url, (r) => r.text(), 'application/atom+xml, application/xml;q=0.9, */*;q=0.8', opts);

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

// Metres per degree of latitude (WGS84 mean); longitude scales by cos(lat).
const M_PER_DEG = 111320;

// A DMI grid cell that is MASKED (land, out of the model's wet domain, or otherwise
// no-data) does NOT return an empty response — it returns a full-length time series
// whose parameter VALUES are all null. edrPosition strips non-numeric values, so such
// a cell yields rows of just `{ time }`. "Has usable data" therefore means at least
// one row carries a numeric value for one of the requested parameters — NOT merely
// that the rows array is non-empty (which is true even for a null-masked cell).
function hasNumericValues(rows, params) {
  for (const r of rows) for (const k of params) if (typeof r[k] === 'number') return true;
  return false;
}

const is429 = (e) => !!e && e.status === 429;

// CAPPED nearest-first probe set (2 rings, 8 points total). Ring 1 at ~0.05°
// (~3 nm) on the cardinals, ring 2 at ~0.10° (~6 nm) on the diagonals — the
// smallest set that still reaches a wet cell a few nm out in any direction while
// staying well inside the ~15 nm cap. Deliberately NOT the old 5-ring × 8-bearing
// (40-point) sweep: DMI 429-rate-limits the marine EDR, and 40 calls per masked
// poll amplifies the very rate-limit we're fighting.
const RING_CANDIDATES = [
  { r: 0.05, bearingDeg: 0 }, { r: 0.05, bearingDeg: 90 }, { r: 0.05, bearingDeg: 180 }, { r: 0.05, bearingDeg: 270 },
  { r: 0.10, bearingDeg: 45 }, { r: 0.10, bearingDeg: 135 }, { r: 0.10, bearingDeg: 225 }, { r: 0.10, bearingDeg: 315 },
];

// Surrounding-area fallback for marine EDR (fetch-layer only). DMI's marine
// models — WAM (waves/swell) and DKSS (ocean/current) — frequently have NO usable
// data at the boat's EXACT point: the cell is a coastal/land cell, an interior grid
// gap, outside the model domain, or MASKED — and a masked cell returns a full-length
// time series of all-null values, not an empty response. So "has data" is judged by
// the presence of NUMERIC values (hasNumericValues), never by the row count, or a
// null-masked cell would be mistaken for a valid reading and the ring never probes.
// Strategy (429-aware, capped, spaced, early-exit):
//   1. try the exact point first; if it has numeric data, use it (offset = null);
//   2. else (only when opts.probe !== false) probe the CAPPED nearest-first ring
//      (RING_CANDIDATES, ≤8 points), spacing calls by `gapMs`, and use the FIRST
//      grid point with numeric data AS-IS — early-exit on that hit;
//   3. a 429 on any call is BACKOFF, not data: abort probing immediately (rateLimited)
//      and rely on the next poll — never treat a 429 as an empty cell that fuels more
//      probing;
//   4. if the whole (capped) area has no numeric data, return empty (probed=true) so
//      the caller can start a cooldown and not re-run the ring every poll.
// No interpolation, no fabrication. Returns
//   { rows, offset, found, rateLimited, probed }
// where offset = { distanceM, bearingRad } for the point actually used (so the display
// can show a "nearby ~X nm" marker) or null; found = numeric data was obtained (exact
// or nearby); rateLimited = a 429 aborted the work; probed = the ring was run.
async function edrPositionNearby(collection, lon, lat, params, range, reqOpts, opts = {}) {
  const probe = opts.probe !== false;                       // false while in cooldown → exact-only
  const gapMs = opts.gapMs != null ? opts.gapMs : 400;      // space DMI calls so a poll doesn't burst
  const probeReq = opts.probeReq || { tries: 1, timeoutMs: 6000 };
  const candidates = opts.candidates || RING_CANDIDATES;
  const n = Math.min(opts.maxProbes || candidates.length, candidates.length);

  // 1. exact point (single call, primary budget). A failure here is a fetch/429 — not
  //    a masked cell — so back off rather than probe.
  let exact;
  try {
    exact = await edrPosition(collection, lon, lat, params, range, reqOpts);
  } catch (e) {
    return { rows: [], offset: null, found: false, rateLimited: is429(e), probed: false };
  }
  if (hasNumericValues(exact, params)) {
    return { rows: exact, offset: null, found: true, rateLimited: false, probed: false };
  }
  if (!probe) return { rows: [], offset: null, found: false, rateLimited: false, probed: false };

  // 2. capped, spaced, nearest-first ring probe with early exit + 429 abort.
  const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i < n; i++) {
    const { r, bearingDeg } = candidates[i];
    const br = (bearingDeg * Math.PI) / 180;
    const dLat = r * Math.cos(br);              // north component (deg lat)
    const dLon = (r * Math.sin(br)) / cosLat;   // east widened so the ring is ~circular on the ground
    let rows;
    try {
      // eslint-disable-next-line no-await-in-loop
      rows = await edrPosition(collection, lon + dLon, lat + dLat, params, range, probeReq);
    } catch (e) {
      // 429 → stop hammering DMI this poll; anything else (out-of-domain 4xx, timeout)
      // → this point has no data, keep probing the remaining nearest points.
      if (is429(e)) return { rows: [], offset: null, found: false, rateLimited: true, probed: true };
      rows = [];
    }
    if (hasNumericValues(rows, params)) {
      const y = dLat * M_PER_DEG;               // north metres
      const x = dLon * cosLat * M_PER_DEG;      // east metres
      const distanceM = Math.hypot(x, y);       // = r * M_PER_DEG
      const bearingRad = (Math.atan2(x, y) + 2 * Math.PI) % (2 * Math.PI);
      return { rows, offset: { distanceM, bearingRad }, found: true, rateLimited: false, probed: true };
    }
    // eslint-disable-next-line no-await-in-loop
    if (gapMs && i < n - 1) await delay(gapMs);
  }
  return { rows: [], offset: null, found: false, rateLimited: false, probed: true };
}

// Empty/rate-limited cooldown for the ring probe (state lives in the caller's map).
// After a full ring comes back with nothing — genuinely empty OR aborted by 429 —
// remember it per collection for a window so the plugin does not re-run the whole ring
// every poll and re-trigger the 429. A `found` result clears the cooldown immediately.
function marineCooldownActive(map, collection, now) {
  return !!map[collection] && now < map[collection];
}
function noteMarineProbeResult(map, collection, now, result, cooldownMs) {
  if (result.found) { delete map[collection]; return false; }
  if (result.rateLimited || result.probed) { map[collection] = now + cooldownMs; return true; }
  return false;
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

module.exports = {
  BASE, edrPosition, edrPositionNearby, hasNumericValues,
  marineCooldownActive, noteMarineProbeResult, obsItems, getJson, getText,
};