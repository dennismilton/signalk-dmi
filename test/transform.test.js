'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const t = require('../lib/transform');
const obs = require('../lib/observe');

test('unit conversions to SI', () => {
  assert.strictEqual(t.cToK(0), 273.15);
  assert.strictEqual(t.hPaToPa(1013.25), 101325);
  assert.strictEqual(t.pctToRatio(50), 0.5);
  assert.strictEqual(t.cmToM(29), 0.29);
  assert.ok(Math.abs(t.degToRad(180) - Math.PI) < 1e-9);
});

test('current u/v → drift + set (toward, true, rad)', () => {
  // Pure eastward flow → set points east (90° = PI/2), drift = magnitude.
  const c = t.uvToCurrent(2, 0);
  assert.ok(Math.abs(c.drift - 2) < 1e-9);
  assert.ok(Math.abs(c.setTrue - Math.PI / 2) < 1e-9);
  // Pure northward → set = 0 (north).
  const n = t.uvToCurrent(0, 3);
  assert.ok(Math.abs(n.setTrue - 0) < 1e-9);
  assert.strictEqual(t.uvToCurrent(undefined, 1), null);
});

test('outsideFromHarmonie maps + converts (K/Pa SI passthrough, %→ratio, deg→rad)', () => {
  const row = {
    'temperature-2m': 290.52, 'relative-humidity-2m': 58.6,
    'pressure-sealevel': 99974.3, 'wind-speed-10m': 8.27,
    'gust-wind-speed-10m': 17.0, 'wind-dir-10m': 295.3,
  };
  const { outside, wind } = t.outsideFromHarmonie(row);
  assert.strictEqual(outside.temperature, 290.52); // already Kelvin
  assert.strictEqual(outside.pressure, 99974.3);   // already Pa
  assert.ok(Math.abs(outside.relativeHumidity - 0.586) < 1e-9);
  assert.strictEqual(wind.speedTrue, 8.27);
  assert.strictEqual(wind.gust, 17.0);
  assert.ok(Math.abs(wind.directionTrue - t.degToRad(295.3)) < 1e-9);
});

test('waterFromMarine: DKSS °C→K, m passthrough, current from u/v', () => {
  const dkss = { 'water-temperature': 16.26, 'sea-mean-deviation': 0.435, 'current-u': 0.04, 'current-v': -0.08 };
  const wam = { 'significant-wave-height': 1.22, 'mean-wave-period': 3.9, 'mean-wave-dir': 309 };
  const water = t.waterFromMarine(wam, dkss);
  assert.ok(Math.abs(water.temperature - t.cToK(16.26)) < 1e-9);
  assert.strictEqual(water.level, 0.435);
  assert.strictEqual(water.waveSignificantHeight, 1.22);
  assert.ok(Math.abs(water.waveDirection - t.degToRad(309)) < 1e-9);
  assert.ok(typeof water.surfaceCurrentSpeed === 'number');
});

test('buildForecast joins marine to atmospheric by exact time step', () => {
  const harmonie = [{ time: '2026-07-07T12:00:00Z', 'temperature-2m': 290 }];
  const wam = [{ time: '2026-07-07T12:00:00Z', 'significant-wave-height': 1.2 }];
  const dkss = [{ time: '2026-07-07T12:00:00Z', 'water-temperature': 16 }];
  const [wd] = t.buildForecast(harmonie, wam, dkss, 'point');
  assert.strictEqual(wd.type, 'point');
  assert.strictEqual(wd.date, '2026-07-07T12:00:00Z');
  assert.strictEqual(wd.outside.temperature, 290);
  assert.strictEqual(wd.water.waveSignificantHeight, 1.2);
  assert.ok(Math.abs(wd.water.temperature - t.cToK(16)) < 1e-9);
});

test('nearestParams picks nearest station per param + newest reading', () => {
  const features = [
    // far station
    { geometry: { coordinates: [8.0, 55.0] }, properties: { stationId: 'far', parameterId: 'temp_dry', value: 10, observed: '2026-07-07T17:00:00Z' } },
    // near station, two readings — newest wins
    { geometry: { coordinates: [12.6, 55.7] }, properties: { stationId: 'near', parameterId: 'temp_dry', value: 15, observed: '2026-07-07T17:00:00Z' } },
    { geometry: { coordinates: [12.6, 55.7] }, properties: { stationId: 'near', parameterId: 'temp_dry', value: 16, observed: '2026-07-07T17:50:00Z' } },
  ];
  const r = obs.nearestParams(features, 55.7, 12.6);
  assert.strictEqual(r.params.temp_dry, 16);
  assert.strictEqual(r.sources.temp_dry, 'near');
});

// Regression for the real bug: a precip-only gauge is nearest, but temp/wind come
// from a full station slightly farther. Per-parameter resolution must still yield temp+wind.
test('nearestParams resolves each param from nearest station reporting it (specialized stations)', () => {
  const features = [
    // very near, but only precipitation
    { geometry: { coordinates: [11.0, 57.0] }, properties: { stationId: 'rain', parameterId: 'precip_past10min', value: 0, observed: '2026-07-07T18:00:00Z' } },
    // farther, full synop station with temp + wind
    { geometry: { coordinates: [11.3, 57.2] }, properties: { stationId: 'synop', parameterId: 'temp_dry', value: 15.7, observed: '2026-07-07T18:00:00Z' } },
    { geometry: { coordinates: [11.3, 57.2] }, properties: { stationId: 'synop', parameterId: 'wind_speed', value: 8.2, observed: '2026-07-07T18:00:00Z' } },
  ];
  const r = obs.nearestParams(features, 57.0, 11.0);
  assert.strictEqual(r.params.temp_dry, 15.7);   // not dropped just because rain gauge is closer
  assert.strictEqual(r.params.wind_speed, 8.2);
  assert.strictEqual(r.sources.temp_dry, 'synop');
  const { outside, wind } = obs.outsideFromMetObs(r.params);
  assert.ok(Math.abs(outside.temperature - t.cToK(15.7)) < 1e-9);
  assert.strictEqual(wind.speedTrue, 8.2);
});

test('outsideFromMetObs: °C→K, hPa→Pa (prefers pressure_at_sea), gust=wind_max', () => {
  const { outside, wind } = obs.outsideFromMetObs({
    temp_dry: 16.9, humidity: 51.4, pressure: 1001.6, pressure_at_sea: 1002.2,
    wind_speed: 10.29, wind_max: 14.4, wind_dir: 291,
  });
  assert.ok(Math.abs(outside.temperature - t.cToK(16.9)) < 1e-9);
  assert.strictEqual(outside.pressure, t.hPaToPa(1002.2));
  assert.strictEqual(wind.gust, 14.4);
  assert.ok(Math.abs(wind.directionTrue - t.degToRad(291)) < 1e-9);
});

test('waterFromOceanObs: sealev cm→m, tw °C→K', () => {
  const water = obs.waterFromOceanObs({ tw: 16.2, sealev_dvr: 6 });
  assert.strictEqual(water.level, 0.06);
  assert.ok(Math.abs(water.temperature - t.cToK(16.2)) < 1e-9);
});