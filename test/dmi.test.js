'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const dmi = require('../lib/dmi');

// --- fetch stub -------------------------------------------------------------
// edrPositionNearby drives real HTTP via global.fetch; stub it so we can control
// which POINT queries return rows and count how many were probed. Each stub
// returns DMI-shaped GeoJSON (one Feature per forecast step, step time in props).
function geojson(features) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ features }) };
}
function feature(step, props) { return { properties: { step, ...props } }; }
// A MASKED DMI cell returns a full-length time series whose parameter values are all
// NULL (not an empty response) — the real cause of blank waves/swell. Build one.
function maskedSeries(param, n = 6) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const step = `2026-07-09T${String(12 + i).padStart(2, '0')}:00:00Z`;
    out.push(feature(step, { [param]: null }));
  }
  return out;
}
function pointOf(url) {
  const coords = new URL(url).searchParams.get('coords'); // 'POINT(lon lat)'
  const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(coords);
  return { lon: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

// Install a stub for the duration of `fn`, always restoring the real fetch.
async function withFetch(stub, fn) {
  const real = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = real; }
}

const BOAT = { lon: 10, lat: 56 };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('edrPositionNearby: exact point has data → used as-is, no offset', async () => {
  const calls = [];
  await withFetch(async (url) => {
    const p = pointOf(url); calls.push(p);
    return geojson([feature('2026-07-09T12:00:00Z', { 'significant-wave-height': 1.1 })]);
  }, async () => {
    const r = await dmi.edrPositionNearby('wam_dw', BOAT.lon, BOAT.lat,
      ['significant-wave-height'], null, { tries: 1 }, { gapMs: 0 });
    assert.strictEqual(r.offset, null);            // exact point → no nearby tag
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0]['significant-wave-height'], 1.1);
    assert.strictEqual(calls.length, 1);           // only the exact query fired
  });
});

test('edrPositionNearby: empty at point → samples surrounding area, nearest non-empty used', async () => {
  const calls = [];
  await withFetch(async (url) => {
    const p = pointOf(url); calls.push(p);
    const isExact = near(p.lon, BOAT.lon) && near(p.lat, BOAT.lat);
    // Exact point is a grid gap (empty); any offset point has a real grid value.
    const features = isExact ? [] : [feature('2026-07-09T12:00:00Z', { 'significant-wave-height': 1.4 })];
    return geojson(features);
  }, async () => {
    const r = await dmi.edrPositionNearby('wam_dw', BOAT.lon, BOAT.lat,
      ['significant-wave-height'], null, { tries: 1 }, { gapMs: 0 });
    // The first ring/first bearing (0.05° due North) is the nearest probe → used.
    assert.ok(r.offset, 'expected a nearby offset marker');
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0]['significant-wave-height'], 1.4);   // real grid value, not fabricated
    // 0.05° ≈ 5566 m ≈ 3.0 nm; bearing 0 rad = due North.
    assert.ok(near(r.offset.distanceM, 0.05 * 111320, 1), `distance ~5566 m, got ${r.offset.distanceM}`);
    assert.ok(near(r.offset.bearingRad, 0, 1e-6), `bearing ~0, got ${r.offset.bearingRad}`);
    assert.ok(r.offset.distanceM <= 0.25 * 111320 + 1, 'within the ~15 nm cap');
    assert.strictEqual(calls.length, 2);           // exact (empty) + first probe (hit)
  });
});

test('edrPositionNearby: nearest hit is the second probe when the first offset is also empty', async () => {
  await withFetch(async (url) => {
    const p = pointOf(url);
    // Empty at the exact point AND at the 0.05°-North probe (candidate 1); the
    // 0.05°-East probe (candidate 2, cardinal ring) is the first with data.
    const isNorth = near(p.lon, BOAT.lon) && p.lat > BOAT.lat + 0.049 && p.lat < BOAT.lat + 0.051;
    const isExact = near(p.lon, BOAT.lon) && near(p.lat, BOAT.lat);
    const features = (isExact || isNorth) ? [] : [feature('2026-07-09T12:00:00Z', { 'water-temperature': 15 })];
    return geojson(features);
  }, async () => {
    const r = await dmi.edrPositionNearby('dkss_nsbs', BOAT.lon, BOAT.lat,
      ['water-temperature'], null, { tries: 1 }, { gapMs: 0 });
    assert.ok(r.offset);
    assert.strictEqual(r.rows[0]['water-temperature'], 15);
    // Candidate 2 = 0.05° due East → bearing π/2, still ~0.05° (~3 nm) out.
    assert.ok(near(r.offset.bearingRad, Math.PI / 2, 1e-6), `bearing ~π/2, got ${r.offset.bearingRad}`);
    assert.ok(near(r.offset.distanceM, 0.05 * 111320, 1));
  });
});

test('edrPositionNearby: probe set is CAPPED — whole area empty rings at most 8 points (not ~40)', async () => {
  const calls = [];
  await withFetch(async (url) => {
    calls.push(pointOf(url));
    return geojson([]);   // nothing anywhere in the domain
  }, async () => {
    const r = await dmi.edrPositionNearby('wam_dw', BOAT.lon, BOAT.lat,
      ['significant-wave-height'], null, { tries: 1 }, { gapMs: 0 });
    assert.strictEqual(r.rows.length, 0);
    assert.strictEqual(r.offset, null);
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.probed, true);
    assert.strictEqual(r.rateLimited, false);
    // exact + 8 capped ring candidates = 9 DMI calls total (was 1 + 40).
    assert.strictEqual(calls.length, 1 + 8);
    assert.ok(calls.length <= 9, `capped, got ${calls.length}`);
  });
});

test('edrPositionNearby: an out-of-domain 4xx on a probe is treated as empty (keeps probing)', async () => {
  await withFetch(async (url) => {
    const p = pointOf(url);
    const isExact = near(p.lon, BOAT.lon) && near(p.lat, BOAT.lat);
    if (isExact) return geojson([]);                       // gap at point
    // First probe throws (out of domain); a later probe succeeds.
    const isNorth = near(p.lon, BOAT.lon) && p.lat > BOAT.lat + 0.049 && p.lat < BOAT.lat + 0.051;
    if (isNorth) return { ok: false, status: 400, statusText: 'Bad Request', json: async () => ({}) };
    return geojson([feature('2026-07-09T12:00:00Z', { 'significant-wave-height': 2.0 })]);
  }, async () => {
    const r = await dmi.edrPositionNearby('wam_dw', BOAT.lon, BOAT.lat,
      ['significant-wave-height'], null, { tries: 1 }, { gapMs: 0 });
    assert.ok(r.offset);
    assert.strictEqual(r.rows[0]['significant-wave-height'], 2.0);
  });
});

test('edrPositionNearby: null-masked exact cell (full-length all-null series) counts as EMPTY → rings to nearby', async () => {
  const calls = [];
  await withFetch(async (url) => {
    const p = pointOf(url); calls.push(p);
    const isExact = near(p.lon, BOAT.lon) && near(p.lat, BOAT.lat);
    // Exact point is MASKED: a full-length series, every value null (the real bug).
    // Any offset point is a real wet WAM cell with numeric values.
    return geojson(isExact
      ? maskedSeries('significant-wave-height', 6)
      : [feature('2026-07-09T12:00:00Z', { 'significant-wave-height': 1.4 })]);
  }, async () => {
    const r = await dmi.edrPositionNearby('wam_dw', BOAT.lon, BOAT.lat,
      ['significant-wave-height'], null, { tries: 1 }, { gapMs: 0 });
    // The masked exact cell must NOT be mistaken for data; the ring must fire and
    // the first nearby wet cell (0.05° N, ~3 nm) must be used with its offset reported.
    assert.ok(r.offset, 'null-masked exact point must trigger the nearby ring probe');
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0]['significant-wave-height'], 1.4);
    assert.ok(near(r.offset.distanceM, 0.05 * 111320, 1), `distance ~5566 m, got ${r.offset.distanceM}`);
    assert.ok(near(r.offset.bearingRad, 0, 1e-6));
    assert.strictEqual(calls.length, 2);   // exact (masked) + first probe (hit)
  });
});

test('edrPositionNearby: null-masked everywhere → no rows, no offset (honest empty, probed)', async () => {
  await withFetch(async (url) => geojson(maskedSeries('significant-wave-height', 6)),
    async () => {
      const r = await dmi.edrPositionNearby('wam_dw', BOAT.lon, BOAT.lat,
        ['significant-wave-height'], null, { tries: 1 }, { gapMs: 0 });
      assert.strictEqual(r.rows.length, 0);
      assert.strictEqual(r.offset, null);
      assert.strictEqual(r.found, false);
      assert.strictEqual(r.probed, true);
    });
});

test('edrPositionNearby: early-exit on first numeric hit — no further probes fire', async () => {
  const calls = [];
  await withFetch(async (url) => {
    const p = pointOf(url); calls.push(p);
    const isExact = near(p.lon, BOAT.lon) && near(p.lat, BOAT.lat);
    // Masked exact; EVERY offset has data — so the first probe must win and stop.
    return geojson(isExact ? maskedSeries('significant-wave-height', 6)
      : [feature('2026-07-09T12:00:00Z', { 'significant-wave-height': 0.7 })]);
  }, async () => {
    const r = await dmi.edrPositionNearby('wam_dw', BOAT.lon, BOAT.lat,
      ['significant-wave-height'], null, { tries: 1 }, { gapMs: 0 });
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.probed, true);
    assert.strictEqual(r.rows[0]['significant-wave-height'], 0.7);
    assert.strictEqual(calls.length, 2);   // exact + exactly ONE probe, then early exit
  });
});

test('edrPositionNearby: a 429 on a probe is BACKOFF, not data — aborts probing immediately', async () => {
  const calls = [];
  await withFetch(async (url) => {
    const p = pointOf(url); calls.push(p);
    const isExact = near(p.lon, BOAT.lon) && near(p.lat, BOAT.lat);
    if (isExact) return geojson(maskedSeries('significant-wave-height', 6));   // masked → would ring
    return { ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({}) };
  }, async () => {
    const r = await dmi.edrPositionNearby('wam_dw', BOAT.lon, BOAT.lat,
      ['significant-wave-height'], null, { tries: 1 }, { gapMs: 0 });
    assert.strictEqual(r.rateLimited, true);
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.probed, true);
    assert.strictEqual(r.offset, null);
    // exact + ONE probe (429) → abort; the other 7 candidates must NOT fire.
    assert.strictEqual(calls.length, 2);
  });
});

test('edrPositionNearby: a 429 on the exact point backs off without probing', async () => {
  const calls = [];
  await withFetch(async (url) => {
    calls.push(pointOf(url));
    return { ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({}) };
  }, async () => {
    const r = await dmi.edrPositionNearby('wam_dw', BOAT.lon, BOAT.lat,
      ['significant-wave-height'], null, { tries: 1 }, { gapMs: 0 });
    assert.strictEqual(r.rateLimited, true);
    assert.strictEqual(r.probed, false);   // never entered the ring
    assert.strictEqual(calls.length, 1);   // just the exact call
  });
});

test('edrPositionNearby: probe:false (cooldown) does exact-only, never rings', async () => {
  const calls = [];
  await withFetch(async (url) => {
    calls.push(pointOf(url));
    return geojson(maskedSeries('significant-wave-height', 6));   // masked → would normally ring
  }, async () => {
    const r = await dmi.edrPositionNearby('wam_dw', BOAT.lon, BOAT.lat,
      ['significant-wave-height'], null, { tries: 1 }, { gapMs: 0, probe: false });
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.probed, false);
    assert.strictEqual(r.offset, null);
    assert.strictEqual(calls.length, 1);   // exact only — ring suppressed
  });
});

test('marine cooldown: empty/429 probe sets a window that suppresses re-probing until it expires', () => {
  const map = {};
  const t0 = 1000000;
  const WINDOW = 60 * 60000;   // ~2 poll cycles at 30 min

  // A probed-empty result opens the cooldown.
  const set = dmi.noteMarineProbeResult(map, 'wam_dw', t0, { found: false, rateLimited: false, probed: true }, WINDOW);
  assert.strictEqual(set, true);
  assert.strictEqual(dmi.marineCooldownActive(map, 'wam_dw', t0), true);
  assert.strictEqual(dmi.marineCooldownActive(map, 'wam_dw', t0 + 30 * 60000), true);   // within window → still cooling
  assert.strictEqual(dmi.marineCooldownActive(map, 'wam_dw', t0 + WINDOW + 1), false);  // expired → probe again

  // A 429 result also opens the cooldown.
  const map2 = {};
  dmi.noteMarineProbeResult(map2, 'dkss_nsbs', t0, { found: false, rateLimited: true, probed: true }, WINDOW);
  assert.strictEqual(dmi.marineCooldownActive(map2, 'dkss_nsbs', t0 + 5000), true);

  // A numeric hit clears any existing cooldown immediately.
  dmi.noteMarineProbeResult(map, 'wam_dw', t0 + 10, { found: true, rateLimited: false, probed: true }, WINDOW);
  assert.strictEqual(dmi.marineCooldownActive(map, 'wam_dw', t0 + 20), false);

  // An exact-only, non-probed empty (during cooldown) neither sets nor extends it.
  const map3 = {};
  const set3 = dmi.noteMarineProbeResult(map3, 'wam_dw', t0, { found: false, rateLimited: false, probed: false }, WINDOW);
  assert.strictEqual(set3, false);
  assert.strictEqual(dmi.marineCooldownActive(map3, 'wam_dw', t0), false);
});

test('edrPositionNearby: DKSS mixed cell (real temp, null current) still counts as PRESENT (no regression)', async () => {
  const calls = [];
  await withFetch(async (url) => {
    calls.push(pointOf(url));
    // DKSS exact cell: water-temperature is a real number, current-u/v are null.
    // Must be treated as present (exact-preferred) — do NOT ring away working ocean data.
    return geojson([feature('2026-07-09T12:00:00Z',
      { 'water-temperature': 15.2, 'current-u': null, 'current-v': null })]);
  }, async () => {
    const r = await dmi.edrPositionNearby('dkss_nsbs', BOAT.lon, BOAT.lat,
      ['water-temperature', 'current-u', 'current-v'], null, { tries: 1 }, { gapMs: 0 });
    assert.strictEqual(r.offset, null);          // exact used, no nearby tag
    assert.strictEqual(r.rows[0]['water-temperature'], 15.2);
    assert.strictEqual(calls.length, 1);         // no ring probe fired
  });
});
