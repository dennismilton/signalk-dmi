// Nearest-station selection + observation mapping for metObs / oceanObs.
// DMI observation items return every station in the bbox, and DMI stations are
// SPECIALIZED — a nearby gauge may report only precipitation, while temperature
// or wind come from a different station. So we resolve each parameter from the
// nearest station that actually reports it (newest reading), not from one single
// "nearest station" (which could be a rain-only gauge with no temp/wind).
'use strict';

const { cToK, hPaToPa, pctToRatio, degToRad, cmToM } = require('./transform');

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// From raw GeoJSON observation features, for EACH parameterId pick the value from
// the nearest station reporting it (newest reading if a station has several).
// Returns { params:{pid:value}, sources:{pid:stationId}, observed, count }.
function nearestParams(features, lat, lon) {
  const byParam = new Map(); // pid -> { dist, observed, value, stationId }
  for (const f of features) {
    const p = f.properties || {};
    const coord = (f.geometry && f.geometry.coordinates) || null;
    if (!p.parameterId || !coord || typeof p.value !== 'number') continue;
    const dist = haversine(lat, lon, coord[1], coord[0]);
    const cur = byParam.get(p.parameterId);
    // Prefer a strictly nearer station; for the same station (≈equal dist) keep the newest reading.
    const nearer = !cur || dist < cur.dist - 1;
    const sameStationNewer = cur && Math.abs(dist - cur.dist) <= 1 &&
      Date.parse(p.observed) > Date.parse(cur.observed);
    if (nearer || sameStationNewer) {
      byParam.set(p.parameterId, { dist, observed: p.observed, value: p.value, stationId: p.stationId });
    }
  }
  if (!byParam.size) return null;
  const params = {};
  const sources = {};
  let observed = null;
  for (const [pid, rec] of byParam) {
    params[pid] = rec.value;
    sources[pid] = rec.stationId;
    if (!observed || Date.parse(rec.observed) > Date.parse(observed)) observed = rec.observed;
  }
  return { params, sources, observed, count: byParam.size };
}

// metObs station params → WeatherData outside/wind blocks.
function outsideFromMetObs(params) {
  const outside = {};
  const wind = {};
  if (typeof params.temp_dry === 'number') outside.temperature = cToK(params.temp_dry);
  if (typeof params.temp_dew === 'number') outside.dewPointTemperature = cToK(params.temp_dew);
  if (typeof params.humidity === 'number') outside.relativeHumidity = pctToRatio(params.humidity);
  const pres = typeof params.pressure_at_sea === 'number' ? params.pressure_at_sea : params.pressure;
  if (typeof pres === 'number') outside.pressure = hPaToPa(pres);
  if (typeof params.cloud_cover === 'number') outside.cloudCover = pctToRatio(params.cloud_cover);
  if (typeof params.visibility === 'number') outside.horizontalVisibility = params.visibility;
  if (typeof params.precip_past10min === 'number') outside.precipitationVolume = params.precip_past10min;
  if (typeof params.wind_speed === 'number') wind.speedTrue = params.wind_speed;
  if (typeof params.wind_max === 'number') wind.gust = params.wind_max;
  if (typeof params.wind_dir === 'number') wind.directionTrue = degToRad(params.wind_dir);
  return { outside, wind };
}

// oceanObs station params → WeatherData water block.
function waterFromOceanObs(params) {
  const water = {};
  if (typeof params.tw === 'number') water.temperature = cToK(params.tw);
  if (typeof params.sealev_dvr === 'number') water.level = cmToM(params.sealev_dvr);
  else if (typeof params.sealev_ln === 'number') water.level = cmToM(params.sealev_ln);
  return water;
}

module.exports = { haversine, nearestParams, outsideFromMetObs, waterFromOceanObs };