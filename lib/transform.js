// DMI → Signal K unit conversions and shape builders.
// Signal K is SI: temperature K, pressure Pa, speed m/s, angle rad, ratio 0..1.
// DMI unit provenance (all live-verified, see RESEARCH.md):
//   HARMONIE: temp K, wind m/s, pressure Pa, humidity %, dir deg          (mostly SI already)
//   WAM     : wave height m, period s, direction deg
//   DKSS    : water-temp °C, current-u/v m/s, sea-mean-deviation m
//   metObs  : temp °C, wind m/s, dir deg, humidity %, pressure hPa
//   oceanObs: sealev cm, water-temp (tw) °C
'use strict';

const cToK = (c) => c + 273.15;
const hPaToPa = (h) => h * 100;
const pctToRatio = (p) => p / 100;
const degToRad = (d) => (d * Math.PI) / 180;
const cmToM = (c) => c / 100;
// metObs precip_past10min is mm accumulated over 10 min → SI rate m/s.
const mm10ToMps = (mm) => mm / 1000 / 600;
const TWO_PI = Math.PI * 2;
const norm = (r) => ((r % TWO_PI) + TWO_PI) % TWO_PI;

// Ocean current from eastward (u) / northward (v) components (m/s).
// drift = magnitude; setTrue = direction the current flows TOWARD (true), in rad.
function uvToCurrent(u, v) {
  if (typeof u !== 'number' || typeof v !== 'number') return null;
  return { drift: Math.hypot(u, v), setTrue: norm(Math.atan2(u, v)) };
}

// DMI EDR parameter names we request (exact ids from the collections' parameter_names).
const HARMONIE_PARAMS = [
  'temperature-2m', 'dew-point-temperature-2m', 'relative-humidity-2m',
  'pressure-sealevel', 'wind-speed-10m', 'wind-dir-10m', 'gust-wind-speed-10m',
  'fraction-of-cloud-cover', 'visibility', 'total-precipitation',
];
const WAM_PARAMS = [
  'significant-wave-height', 'mean-wave-dir', 'mean-wave-period',
  'significant-totalswell-height', 'mean-totalswell-dir', 'mean-totalswell-period',
];
const DKSS_PARAMS = ['water-temperature', 'current-u', 'current-v', 'sea-mean-deviation'];

// Build the `outside` + `wind` blocks of a WeatherData object from a HARMONIE row.
function outsideFromHarmonie(row) {
  const outside = {};
  const wind = {};
  if (typeof row['temperature-2m'] === 'number') outside.temperature = row['temperature-2m'];
  if (typeof row['dew-point-temperature-2m'] === 'number') outside.dewPointTemperature = row['dew-point-temperature-2m'];
  if (typeof row['relative-humidity-2m'] === 'number') outside.relativeHumidity = pctToRatio(row['relative-humidity-2m']);
  if (typeof row['pressure-sealevel'] === 'number') outside.pressure = row['pressure-sealevel'];
  if (typeof row['fraction-of-cloud-cover'] === 'number') outside.cloudCover = pctToRatio(row['fraction-of-cloud-cover']);
  if (typeof row['visibility'] === 'number') outside.horizontalVisibility = row['visibility'];
  if (typeof row['total-precipitation'] === 'number') outside.precipitationVolume = row['total-precipitation'];
  if (typeof row['wind-speed-10m'] === 'number') wind.speedTrue = row['wind-speed-10m'];
  if (typeof row['gust-wind-speed-10m'] === 'number') wind.gust = row['gust-wind-speed-10m'];
  if (typeof row['wind-dir-10m'] === 'number') wind.directionTrue = degToRad(row['wind-dir-10m']);
  return { outside, wind };
}

// Build the `water` block from WAM (waves) and/or DKSS (ocean) rows.
function waterFromMarine(wam, dkss) {
  const water = {};
  if (wam) {
    if (typeof wam['significant-wave-height'] === 'number') water.waveSignificantHeight = wam['significant-wave-height'];
    if (typeof wam['mean-wave-period'] === 'number') water.wavePeriod = wam['mean-wave-period'];
    if (typeof wam['mean-wave-dir'] === 'number') water.waveDirection = degToRad(wam['mean-wave-dir']);
    if (typeof wam['significant-totalswell-height'] === 'number') water.swellHeight = wam['significant-totalswell-height'];
    if (typeof wam['mean-totalswell-period'] === 'number') water.swellPeriod = wam['mean-totalswell-period'];
    if (typeof wam['mean-totalswell-dir'] === 'number') water.swellDirection = degToRad(wam['mean-totalswell-dir']);
  }
  if (dkss) {
    if (typeof dkss['water-temperature'] === 'number') water.temperature = cToK(dkss['water-temperature']);
    if (typeof dkss['sea-mean-deviation'] === 'number') water.level = dkss['sea-mean-deviation'];
    if (typeof dkss.salinity === 'number') water.salinity = dkss.salinity;
    const cur = uvToCurrent(dkss['current-u'], dkss['current-v']);
    if (cur) {
      water.surfaceCurrentSpeed = cur.drift;
      water.surfaceCurrentDirection = cur.setTrue;
    }
  }
  return water;
}

// Merge time-aligned HARMONIE/WAM/DKSS rows into WeatherData[] (type 'point'),
// ascending time. Marine blocks join by exact ISO step (all models are hourly).
function buildForecast(harmonie, wam, dkss, type) {
  const wamByTime = new Map((wam || []).map((r) => [r.time, r]));
  const dkssByTime = new Map((dkss || []).map((r) => [r.time, r]));
  return harmonie.map((row) => {
    const { outside, wind } = outsideFromHarmonie(row);
    const water = waterFromMarine(wamByTime.get(row.time), dkssByTime.get(row.time));
    const wd = { date: row.time, type: type || 'point', outside, wind };
    if (Object.keys(water).length) wd.water = water;
    return wd;
  });
}

// Aggregate point rows into daily WeatherData (min/max temp, peak wind).
function toDaily(points) {
  const byDay = new Map();
  for (const p of points) {
    const day = (p.date || '').slice(0, 10);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(p);
  }
  const out = [];
  for (const [day, rows] of byDay) {
    const temps = rows.map((r) => r.outside?.temperature).filter((n) => typeof n === 'number');
    const gusts = rows.map((r) => r.wind?.gust).filter((n) => typeof n === 'number');
    const speeds = rows.map((r) => r.wind?.speedTrue).filter((n) => typeof n === 'number');
    const outside = {};
    if (temps.length) { outside.minTemperature = Math.min(...temps); outside.maxTemperature = Math.max(...temps); }
    const wind = {};
    if (gusts.length) wind.gust = Math.max(...gusts);
    if (speeds.length) wind.speedTrue = Math.max(...speeds);
    out.push({ date: `${day}T12:00:00Z`, type: 'daily', outside, wind });
  }
  out.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return out;
}

module.exports = {
  cToK, hPaToPa, pctToRatio, degToRad, cmToM, mm10ToMps, uvToCurrent,
  HARMONIE_PARAMS, WAM_PARAMS, DKSS_PARAMS,
  outsideFromHarmonie, waterFromMarine, buildForecast, toDaily,
};