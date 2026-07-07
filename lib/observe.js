// Nearest-station selection + observation mapping for metObs / oceanObs.
// DMI observation items return every station in the bbox; a boat wants the
// closest one, so we group by station and take the geographically nearest, using
// the newest reading per parameter.
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

// From raw GeoJSON observation features, return the nearest station's latest
// value per parameter: { stationId, distance, coord:[lon,lat], params:{pid:value} }.
function nearestStation(features, lat, lon) {
  const stations = new Map();
  for (const f of features) {
    const p = f.properties || {};
    const coord = (f.geometry && f.geometry.coordinates) || null;
    if (!p.stationId || !coord) continue;
    let st = stations.get(p.stationId);
    if (!st) {
      st = { stationId: p.stationId, coord, latest: new Map() };
      stations.set(p.stationId, st);
    }
    const prev = st.latest.get(p.parameterId);
    if (!prev || Date.parse(p.observed) > Date.parse(prev.observed)) {
      st.latest.set(p.parameterId, { value: p.value, observed: p.observed });
    }
  }
  let best = null;
  for (const st of stations.values()) {
    const d = haversine(lat, lon, st.coord[1], st.coord[0]);
    if (!best || d < best.distance) best = { ...st, distance: d };
  }
  if (!best) return null;
  const params = {};
  let observed = null;
  for (const [pid, rec] of best.latest) {
    params[pid] = rec.value;
    if (!observed || Date.parse(rec.observed) > Date.parse(observed)) observed = rec.observed;
  }
  return { stationId: best.stationId, distance: best.distance, coord: best.coord, params, observed };
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

module.exports = { haversine, nearestStation, outsideFromMetObs, waterFromOceanObs };