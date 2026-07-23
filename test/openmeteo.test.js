'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const om = require('../lib/openmeteo');
const t = require('../lib/transform');

// A representative Open-Meteo Marine "current" response block (SI-ish raw units:
// heights m, periods s, directions deg, current km/h, SST °C). Data-driven — every
// expectation is COMPUTED from these inputs via the same conversions, never hardcoded.
const CUR = {
  wave_height: 1.42, wave_direction: 210, wave_period: 6.3,
  swell_wave_height: 0.88, swell_wave_direction: 225, swell_wave_period: 8.1,
  ocean_current_velocity: 3.6, ocean_current_direction: 90,
  sea_surface_temperature: 17.4,
};

test('parseCurrent maps Open-Meteo → SI water block (deg→rad, km/h→m/s, °C→K)', () => {
  const w = om.parseCurrent({ current: CUR });
  assert.strictEqual(w.waveSignificantHeight, CUR.wave_height);         // m passthrough
  assert.strictEqual(w.wavePeriod, CUR.wave_period);                     // s passthrough
  assert.ok(Math.abs(w.waveDirection - t.degToRad(CUR.wave_direction)) < 1e-9);
  assert.strictEqual(w.swellHeight, CUR.swell_wave_height);
  assert.strictEqual(w.swellPeriod, CUR.swell_wave_period);
  assert.ok(Math.abs(w.swellDirection - t.degToRad(CUR.swell_wave_direction)) < 1e-9);
  assert.ok(Math.abs(w.surfaceCurrentSpeed - om.kmhToMs(CUR.ocean_current_velocity)) < 1e-9);
  assert.strictEqual(w.surfaceCurrentSpeed, CUR.ocean_current_velocity / 3.6);
  assert.ok(Math.abs(w.surfaceCurrentDirection - t.degToRad(CUR.ocean_current_direction)) < 1e-9);
  assert.ok(Math.abs(w.temperature - t.cToK(CUR.sea_surface_temperature)) < 1e-9);
});

test('parseCurrent tolerates missing block / null fields', () => {
  assert.deepStrictEqual(om.parseCurrent({}), {});
  assert.deepStrictEqual(om.parseCurrent({ current: {} }), {});
  const w = om.parseCurrent({ current: { wave_height: 2.0, swell_wave_height: null } });
  assert.strictEqual(w.waveSignificantHeight, 2.0);
  assert.ok(!('swellHeight' in w));
});

test('fillGaps: DMI empty → Open-Meteo fills waves/swell/current, tagged Open-Meteo', () => {
  const marine = {};                        // DMI produced NOTHING (grid gap)
  const omWater = om.parseCurrent({ current: CUR });
  const { marine: out, sources } = om.fillGaps(marine, omWater, { waves: true, ocean: true });
  // every wave/swell path now present, sourced from Open-Meteo
  for (const p of om.WAVE_PATHS) assert.ok(p in out, `${p} filled`);
  assert.strictEqual(out['environment.water.waves.significantHeight'], CUR.wave_height);
  assert.strictEqual(out['environment.current.drift'], CUR.ocean_current_velocity / 3.6);
  assert.strictEqual(sources.waves, 'Open-Meteo');
  assert.strictEqual(sources.current, 'Open-Meteo');
  assert.strictEqual(sources.temp, 'Open-Meteo');
});

test('fillGaps: DMI present → keeps DMI values, tags DMI, does NOT overwrite', () => {
  const marine = {
    'environment.water.waves.significantHeight': 0.5,
    'environment.water.swell.height': 0.3,
    'environment.current.drift': 0.2,
    'environment.water.temperature': 285,
  };
  const omWater = om.parseCurrent({ current: CUR });
  const { marine: out, sources } = om.fillGaps(marine, omWater, { waves: true, ocean: true });
  assert.strictEqual(out['environment.water.waves.significantHeight'], 0.5);   // untouched
  assert.strictEqual(out['environment.current.drift'], 0.2);
  assert.strictEqual(sources.waves, 'DMI-WAM');
  assert.strictEqual(sources.current, 'DMI-DKSS');
  assert.strictEqual(sources.temp, 'DMI');
});

test('fillGaps: mixed — DMI swell only, Open-Meteo fills significantHeight → mixed tag', () => {
  const marine = { 'environment.water.swell.height': 0.3 };  // DMI had swell, no sig height
  const omWater = om.parseCurrent({ current: CUR });
  const { marine: out, sources } = om.fillGaps(marine, omWater, { waves: true, ocean: true });
  assert.strictEqual(out['environment.water.swell.height'], 0.3);               // DMI kept
  assert.strictEqual(out['environment.water.waves.significantHeight'], CUR.wave_height); // OM
  assert.strictEqual(sources.waves, 'DMI-WAM + Open-Meteo');
});

test('fillGaps: om=null just reports DMI provenance (no fetch happened)', () => {
  const marine = { 'environment.water.waves.significantHeight': 1.1 };
  const { marine: out, sources } = om.fillGaps(marine, null, { waves: true, ocean: true });
  assert.deepStrictEqual(out, marine);
  assert.strictEqual(sources.waves, 'DMI-WAM');
  assert.ok(!('current' in sources));
});

test('fillGaps: ocean toggle OFF → does not fill current/temp from Open-Meteo', () => {
  const omWater = om.parseCurrent({ current: CUR });
  const { marine: out, sources } = om.fillGaps({}, omWater, { waves: true, ocean: false });
  assert.ok('environment.water.waves.significantHeight' in out);
  assert.ok(!('environment.current.drift' in out));
  assert.ok(!('environment.water.temperature' in out));
  assert.strictEqual(sources.current, undefined);
});

test('fetchMarineCurrent: builds sea-cell URL, parses mocked response, no key', async () => {
  const realFetch = global.fetch;
  let seenUrl = '';
  global.fetch = async (url) => {
    seenUrl = url;
    return { ok: true, status: 200, json: async () => ({ current: CUR }) };
  };
  try {
    const w = await om.fetchMarineCurrent(55.0, 12.5, { timeoutMs: 2000 });
    assert.match(seenUrl, /^https:\/\/marine-api\.open-meteo\.com\/v1\/marine\?/);
    assert.match(seenUrl, /latitude=55/);
    assert.match(seenUrl, /longitude=12\.5/);
    assert.match(seenUrl, /cell_selection=sea/);
    assert.doesNotMatch(seenUrl, /apikey/);         // key-free
    assert.strictEqual(w.waveSignificantHeight, CUR.wave_height);
  } finally {
    global.fetch = realFetch;
  }
});

test('fetchMarineCurrent: HTTP error throws (caller catches, plugin never crashes)', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({}) });
  try {
    await assert.rejects(() => om.fetchMarineCurrent(55, 12, { timeoutMs: 2000 }), /429/);
  } finally {
    global.fetch = realFetch;
  }
});
