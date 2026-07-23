// Open-Meteo Marine API client — RELIABLE, key-free, unlimited marine fallback.
// DMI's WAM/DKSS marine models frequently have NO data at the boat (coastal grid
// gap) or 429-rate-limit hard, so waves/swell/current vanish for hours/days. When
// that happens this fills the SAME environment.water.* paths from Open-Meteo Marine
// (models GWAM/EWAM/MFWAM) so marine data never simply disappears. DMI stays primary
// where it has data; Open-Meteo only fills the gaps, tagged with an honest source.
//
// Endpoint (verified against https://open-meteo.com/en/docs/marine-weather-api):
//   https://marine-api.open-meteo.com/v1/marine
//   ?latitude=&longitude=&current=<vars>&cell_selection=sea&timezone=GMT
// No API key for non-commercial use. Units: heights m, periods s, directions deg,
// SST °C, ocean_current_velocity km/h. Data: Open-Meteo.com, CC BY 4.0.
'use strict';

const t = require('./transform');

const BASE = 'https://marine-api.open-meteo.com/v1/marine';

// The "current" (now-slice) variables we request — waves + swell (height/period/
// direction), ocean current (velocity/direction) and sea-surface temperature.
const CURRENT_VARS = [
  'wave_height', 'wave_direction', 'wave_period',
  'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
  'ocean_current_velocity', 'ocean_current_direction',
  'sea_surface_temperature',
];

const kmhToMs = (k) => k / 3.6;                 // ocean_current_velocity is km/h
const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);

// The SK value paths Open-Meteo can supply, grouped so a toggle can gate each group.
const WAVE_PATHS = [
  'environment.water.waves.significantHeight', 'environment.water.waves.period',
  'environment.water.waves.direction', 'environment.water.swell.height',
  'environment.water.swell.period', 'environment.water.swell.direction',
];

// Parse an Open-Meteo Marine "current" block into the SAME `water` shape that
// lib/transform.waterFromMarine produces from DMI, so the caller fills identical
// SI paths. Directions → rad (waves FROM, current TOWARD, matching DMI). Velocity
// km/h → m/s. SST °C → K. Only numeric fields are set; a missing/land cell yields {}.
function parseCurrent(json) {
  const c = json && json.current;
  if (!c) return {};
  const water = {};
  if (isNum(c.wave_height)) water.waveSignificantHeight = c.wave_height;
  if (isNum(c.wave_period)) water.wavePeriod = c.wave_period;
  if (isNum(c.wave_direction)) water.waveDirection = t.degToRad(c.wave_direction);
  if (isNum(c.swell_wave_height)) water.swellHeight = c.swell_wave_height;
  if (isNum(c.swell_wave_period)) water.swellPeriod = c.swell_wave_period;
  if (isNum(c.swell_wave_direction)) water.swellDirection = t.degToRad(c.swell_wave_direction);
  if (isNum(c.ocean_current_velocity)) water.surfaceCurrentSpeed = kmhToMs(c.ocean_current_velocity);
  if (isNum(c.ocean_current_direction)) water.surfaceCurrentDirection = t.degToRad(c.ocean_current_direction);
  if (isNum(c.sea_surface_temperature)) water.temperature = t.cToK(c.sea_surface_temperature);
  return water;
}

// Fetch the Open-Meteo Marine now-slice for a position. Robust: AbortController
// timeout, throws (caller catches) — never crashes the plugin. Returns a `water`
// block (parseCurrent) or throws on HTTP/network/timeout error.
async function fetchMarineCurrent(lat, lon, opts = {}) {
  const timeoutMs = opts.timeoutMs || 8000;
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: CURRENT_VARS.join(','),
    cell_selection: 'sea',   // snap to the nearest SEA cell (this is a marine query)
    timezone: 'GMT',
  });
  const url = `${BASE}?${q}`;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ac.signal });
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status} ${res.statusText} for Open-Meteo Marine`);
      e.status = res.status;
      throw e;
    }
    return parseCurrent(await res.json());
  } catch (e) {
    throw e.name === 'AbortError' ? new Error(`timeout (${timeoutMs}ms) for Open-Meteo Marine`) : e;
  } finally {
    clearTimeout(to);
  }
}

// Fill ONLY the missing marine paths in the DMI-produced `marine` map from an
// Open-Meteo `water` block, and report honest provenance. Pure + data-driven so it
// is unit-testable without the SignalK app. `om` may be null (no fetch / fetch
// failed) — then it just reports the DMI sources. opts.waves / opts.ocean gate the
// wave and current/temp groups to respect the plugin toggles.
//   returns { marine: <new map>, sources: { waves?, current?, temp? } }
// sources value is 'DMI-WAM'|'DMI-DKSS'|'DMI' when DMI supplied it, 'Open-Meteo'
// when Open-Meteo filled it, or 'DMI-WAM + Open-Meteo' for a mixed wave block.
function fillGaps(marine, om, opts = {}) {
  const out = Object.assign({}, marine);
  const sources = {};
  const has = (p) => p in out;

  const dmiWaves = has('environment.water.waves.significantHeight') || has('environment.water.swell.height');
  if (dmiWaves) sources.waves = 'DMI-WAM';
  if (has('environment.current.drift')) sources.current = 'DMI-DKSS';
  if (has('environment.water.temperature')) sources.temp = 'DMI';

  if (!om) return { marine: out, sources };

  // Waves/swell: fill each sub-group anchored on its HEIGHT (never an orphan
  // period/direction without a height), so a DMI wave block missing only its period
  // stays DMI. Tag the group Open-Meteo, or mixed when DMI supplied part of it.
  if (opts.waves) {
    let filled = false;
    if (!has('environment.water.waves.significantHeight') && isNum(om.waveSignificantHeight)) {
      out['environment.water.waves.significantHeight'] = om.waveSignificantHeight;
      if (isNum(om.wavePeriod)) out['environment.water.waves.period'] = om.wavePeriod;
      if (isNum(om.waveDirection)) out['environment.water.waves.direction'] = om.waveDirection;
      filled = true;
    }
    if (!has('environment.water.swell.height') && isNum(om.swellHeight)) {
      out['environment.water.swell.height'] = om.swellHeight;
      if (isNum(om.swellPeriod)) out['environment.water.swell.period'] = om.swellPeriod;
      if (isNum(om.swellDirection)) out['environment.water.swell.direction'] = om.swellDirection;
      filled = true;
    }
    if (filled) sources.waves = dmiWaves ? 'DMI-WAM + Open-Meteo' : 'Open-Meteo';
  }

  // Current: only if DMI produced none (its focused ring already tried).
  if (opts.ocean && !has('environment.current.drift') && isNum(om.surfaceCurrentSpeed)) {
    out['environment.current.drift'] = om.surfaceCurrentSpeed;
    if (isNum(om.surfaceCurrentDirection)) out['environment.current.setTrue'] = om.surfaceCurrentDirection;
    sources.current = 'Open-Meteo';
  }

  // Sea-surface temperature: only if DMI (DKSS/oceanObs) produced none.
  if (opts.ocean && !has('environment.water.temperature') && isNum(om.temperature)) {
    out['environment.water.temperature'] = om.temperature;
    sources.temp = 'Open-Meteo';
  }

  return { marine: out, sources };
}

module.exports = { BASE, CURRENT_VARS, WAVE_PATHS, parseCurrent, fetchMarineCurrent, fillGaps, kmhToMs };
