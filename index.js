// signalk-dmi — ingest DMI (Danish Meteorological Institute) free open data into
// Signal K. Two surfaces (see RESEARCH.md §4):
//   1. Signal K v2 Weather API provider — atmospheric forecasts (HARMONIE) +
//      observations (metObs), now also carrying marine `water.*` (WAM/DKSS).
//   2. environment.* deltas — current conditions + marine (waves, sea level,
//      current, water temp), so non-Weather-API consumers and the maracaibo
//      dashboard's environment.outside.wind.* checks work as a drop-in for OWM.
// DMI Open Data is CC BY 4.0 and key-free on opendataapi.dmi.dk.
'use strict';

const { edrPosition, obsItems } = require('./lib/dmi');
const t = require('./lib/transform');
const obs = require('./lib/observe');

const ISO = (d) => new Date(d).toISOString();

// Units for the Signal K paths we publish (emitted once as delta meta).
const META = {
  'environment.outside.temperature': 'K',
  'environment.outside.dewPointTemperature': 'K',
  'environment.outside.pressure': 'Pa',
  'environment.outside.humidity': 'ratio',
  'environment.outside.wind.speed': 'm/s',
  'environment.outside.wind.gust': 'm/s',
  'environment.outside.wind.direction': 'rad',
  'environment.water.temperature': 'K',
  'environment.water.level': 'm',
  'environment.tide.heightNow': 'm',
  'environment.water.waves.significantHeight': 'm',
  'environment.water.waves.period': 's',
  'environment.water.waves.direction': 'rad',
  'environment.water.swell.height': 'm',
  'environment.water.swell.period': 's',
  'environment.water.swell.direction': 'rad',
  'environment.current.drift': 'm/s',
  'environment.current.setTrue': 'rad',
};

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'signalk-dmi';
  plugin.name = 'DMI (Danish Meteorological Institute) free data';
  plugin.description =
    'Danish met/ocean data from DMI Open Data — HARMONIE forecasts, met observations, ' +
    'WAM waves and DKSS ocean — into Signal K paths and the v2 Weather API. Data: DMI, CC BY 4.0.';

  let timer = null;
  let options = {};
  // Last-good value per path, so a poll where a DMI source 429s re-publishes the
  // previous value (with a fresh timestamp) instead of dropping the path.
  const lastGood = {};

  plugin.schema = {
    type: 'object',
    properties: {
      positionSource: {
        type: 'string', enum: ['vessel', 'fixed'], default: 'vessel',
        title: 'Position source (vessel uses navigation.position; fixed uses the lat/lon below)',
      },
      fixedLatitude: { type: 'number', title: 'Fixed latitude (used when position source = fixed)' },
      fixedLongitude: { type: 'number', title: 'Fixed longitude (used when position source = fixed)' },
      pollIntervalMinutes: {
        type: 'number', default: 30, minimum: 5,
        title: 'Poll interval for observations + marine deltas (minutes)',
      },
      forecastHours: {
        type: 'number', default: 48, minimum: 1, maximum: 120,
        title: 'Forecast look-ahead window (hours)',
      },
      weatherProvider: {
        type: 'boolean', default: true,
        title: 'Register DMI as a Signal K v2 Weather API provider (forecasts + observations)',
      },
      observations: {
        type: 'boolean', default: true,
        title: 'Publish current conditions as environment.outside.* deltas (nearest metObs station)',
      },
      waves: {
        type: 'boolean', default: true,
        title: 'Publish WAM waves as environment.water.waves/swell.* deltas',
      },
      ocean: {
        type: 'boolean', default: true,
        title: 'Publish DKSS ocean (water temp, sea level, current) as environment.* deltas',
      },
      harmonieCollection: { type: 'string', default: 'harmonie_dini_sf', title: 'HARMONIE forecast collection' },
      wamCollection: {
        type: 'string', default: 'wam_dw',
        title: 'WAM wave collection (wam_dw Danish waters · wam_nsb North Sea/Baltic · wam_natlant N. Atlantic)',
      },
      dkssCollection: { type: 'string', default: 'dkss_nsbs', title: 'DKSS ocean collection' },
    },
  };

  // ---- position -----------------------------------------------------------
  function getPosition() {
    if (options.positionSource === 'fixed') {
      const { fixedLatitude: lat, fixedLongitude: lon } = options;
      if (typeof lat === 'number' && typeof lon === 'number') return { latitude: lat, longitude: lon };
      return null;
    }
    const node = app.getSelfPath('navigation.position');
    const v = node && (node.value || node);
    if (v && typeof v.latitude === 'number' && typeof v.longitude === 'number') {
      return { latitude: v.latitude, longitude: v.longitude };
    }
    return null;
  }

  // ---- forecast fetch (shared by provider + delta poll) -------------------
  const gap = (ms) => new Promise((r) => setTimeout(r, ms));

  // One EDR collection, resilient: on failure (429, land/out-of-grid, timeout)
  // log and return [] so a single source never sinks the whole forecast.
  async function tryEdr(collection, lon, lat, params, range, req) {
    try {
      return await edrPosition(collection, lon, lat, params, range, req);
    } catch (e) {
      app.error(`forecast source ${collection} skipped: ${e.message}`);
      return [];
    }
  }

  // For the on-demand Weather API path: fetch the 3 collections in PARALLEL with a
  // bounded per-request budget (2 tries, 8s timeout) so the HTTP call returns
  // promptly even when DMI is slow — never hangs.
  const FORECAST_REQ = { tries: 2, timeoutMs: 6000 };
  async function fetchForecast(pos, range) {
    const { latitude: lat, longitude: lon } = pos;
    const [harmonie, wam, dkss] = await Promise.all([
      tryEdr(options.harmonieCollection, lon, lat, t.HARMONIE_PARAMS, range, FORECAST_REQ),
      options.waves ? tryEdr(options.wamCollection, lon, lat, t.WAM_PARAMS, range, FORECAST_REQ) : Promise.resolve([]),
      options.ocean ? tryEdr(options.dkssCollection, lon, lat, t.DKSS_PARAMS, range, FORECAST_REQ) : Promise.resolve([]),
    ]);
    return { harmonie, wam, dkss };
  }

  // ---- Weather API provider methods ---------------------------------------
  let lastForecast = null; // last non-empty point set, so a DMI-busy request still answers fast
  async function getForecasts(position, type, opts) {
    const now = Date.now();
    const range = { from: ISO(now), to: ISO(now + options.forecastHours * 3600000) };
    // Fetch runs in the background and refreshes the cache; it never blocks the
    // response for more than the deadline below.
    const fetchP = fetchForecast(position, range)
      .then(({ harmonie, wam, dkss }) => {
        const pts = t.buildForecast(harmonie, wam, dkss, 'point');
        if (pts.length) lastForecast = pts;
        return pts;
      })
      .catch(() => []);

    let points;
    if (lastForecast) {
      // Warm: answer within the deadline using cache if the fresh fetch is slow.
      points = await Promise.race([fetchP, gap(2500).then(() => null)]);
      if (!points || !points.length) points = lastForecast;
    } else {
      // Cold (no cache yet): wait for the bounded fetch.
      points = await fetchP;
    }
    if (type === 'daily') points = t.toDaily(points);
    const max = opts && opts.maxCount ? opts.maxCount : points.length;
    return points.slice(0, max);
  }

  // One observation service, resilient — returns [] on failure.
  async function tryObs(service, params) {
    try {
      return await obsItems(service, params);
    } catch (e) {
      app.error(`observation source ${service} skipped: ${e.message}`);
      return [];
    }
  }

  async function getObservations(position, opts) {
    const { latitude: lat, longitude: lon } = position;
    const bbox = [lon - 0.7, lat - 0.7, lon + 0.7, lat + 0.7];
    const now = Date.now();
    const metRange = `${ISO(now - 2 * 3600000)}/${ISO(now)}`;
    const met = await tryObs('metObs', { bbox, datetime: metRange, limit: 1000 });
    const metStation = obs.nearestParams(met, lat, lon);
    const wd = { date: (metStation && metStation.observed) || ISO(now), type: 'observation', outside: {}, wind: {} };
    if (metStation) Object.assign(wd, obs.outsideFromMetObs(metStation.params));

    const oceanRange = `${ISO(now - 3 * 3600000)}/${ISO(now)}`;
    const ocean = await tryObs('oceanObs', { bbox, datetime: oceanRange, limit: 1000 });
    const oceanStation = obs.nearestParams(ocean, lat, lon);
    if (oceanStation) {
      const water = obs.waterFromOceanObs(oceanStation.params);
      if (Object.keys(water).length) wd.water = water;
    }
    const max = opts && opts.maxCount ? opts.maxCount : 1;
    return [wd].slice(0, max);
  }

  // DMI has no confirmed open-data marine/land warnings endpoint (RESEARCH.md
  // §3.5). Return empty until one is verified, so consumers stay valid.
  async function getWarnings() {
    return [];
  }

  const provider = {
    name: 'DMI',
    methods: { getObservations, getForecasts, getWarnings },
  };

  // ---- environment.* delta publishing -------------------------------------
  function emitMeta() {
    const meta = Object.entries(META).map(([path, units]) => ({ path, value: { units } }));
    app.handleMessage(plugin.id, { updates: [{ meta }] });
  }

  function publish(values) {
    if (!values.length) return;
    app.handleMessage(plugin.id, {
      updates: [{ $source: 'signalk-dmi', timestamp: ISO(Date.now()), values }],
    });
  }

  // Pick the forecast row whose time is closest to now (marine has no obs feed).
  function rowNearestNow(rows) {
    const now = Date.now();
    let best = null;
    for (const r of rows) {
      const d = Math.abs(Date.parse(r.time) - now);
      if (!best || d < best.d) best = { r, d };
    }
    return best ? best.r : null;
  }

  async function pollDeltas() {
    const pos = getPosition();
    if (!pos) {
      // Position may not be in the SignalK model yet right after (re)start.
      // Retry soon instead of waiting the full poll interval (boot-timing fix):
      // at boot+5s the vessel GPS often hasn't populated navigation.position, so
      // a single skip would leave the plugin silent until the next 30-min tick.
      app.debug('No position yet — retrying DMI poll in 30s');
      setTimeout(pollDeltas, 30000);
      return;
    }
    const { latitude: lat, longitude: lon } = pos;
    const values = [];
    const now = Date.now();

    // Current conditions (metObs) → environment.outside.* (OWM-parity paths).
    if (options.observations) {
      try {
        const bbox = [lon - 0.7, lat - 0.7, lon + 0.7, lat + 0.7];
        const met = await tryObs('metObs', { bbox, datetime: `${ISO(now - 2 * 3600000)}/${ISO(now)}`, limit: 1000 });
        const st = obs.nearestParams(met, lat, lon);
        if (st) {
          const { outside, wind } = obs.outsideFromMetObs(st.params);
          if (typeof outside.temperature === 'number') values.push({ path: 'environment.outside.temperature', value: outside.temperature });
          if (typeof outside.dewPointTemperature === 'number') values.push({ path: 'environment.outside.dewPointTemperature', value: outside.dewPointTemperature });
          if (typeof outside.pressure === 'number') values.push({ path: 'environment.outside.pressure', value: outside.pressure });
          if (typeof outside.relativeHumidity === 'number') values.push({ path: 'environment.outside.humidity', value: outside.relativeHumidity });
          if (typeof wind.speedTrue === 'number') values.push({ path: 'environment.outside.wind.speed', value: wind.speedTrue });
          if (typeof wind.gust === 'number') values.push({ path: 'environment.outside.wind.gust', value: wind.gust });
          if (typeof wind.directionTrue === 'number') values.push({ path: 'environment.outside.wind.direction', value: wind.directionTrue });
        }
      } catch (e) { app.error(`metObs poll failed: ${e.message}`); }
    }

    // Marine now-slice: WAM waves + DKSS ocean forecast at the current hour.
    if (options.waves || options.ocean) {
      try {
        const range = { from: ISO(now - 3600000), to: ISO(now + 3 * 3600000) };
        let wam = [];
        let dkss = [];
        if (options.waves) { wam = await tryEdr(options.wamCollection, lon, lat, t.WAM_PARAMS, range); }
        if (options.ocean) { await gap(300); dkss = await tryEdr(options.dkssCollection, lon, lat, t.DKSS_PARAMS, range); }
        const wamRow = rowNearestNow(wam);
        const dkssRow = rowNearestNow(dkss);
        const water = t.waterFromMarine(wamRow, dkssRow);
        if (typeof water.waveSignificantHeight === 'number') values.push({ path: 'environment.water.waves.significantHeight', value: water.waveSignificantHeight });
        if (typeof water.wavePeriod === 'number') values.push({ path: 'environment.water.waves.period', value: water.wavePeriod });
        if (typeof water.waveDirection === 'number') values.push({ path: 'environment.water.waves.direction', value: water.waveDirection });
        if (typeof water.swellHeight === 'number') values.push({ path: 'environment.water.swell.height', value: water.swellHeight });
        if (typeof water.swellPeriod === 'number') values.push({ path: 'environment.water.swell.period', value: water.swellPeriod });
        if (typeof water.swellDirection === 'number') values.push({ path: 'environment.water.swell.direction', value: water.swellDirection });
        if (typeof water.surfaceCurrentSpeed === 'number') values.push({ path: 'environment.current.drift', value: water.surfaceCurrentSpeed });
        if (typeof water.surfaceCurrentDirection === 'number') values.push({ path: 'environment.current.setTrue', value: water.surfaceCurrentDirection });
        // Water temperature + sea level: prefer observed oceanObs, fall back to DKSS forecast.
        let waterTemp = water.temperature;
        let level = water.level;
        if (options.ocean) {
          const bbox = [lon - 0.7, lat - 0.7, lon + 0.7, lat + 0.7];
          const ocean = await tryObs('oceanObs', { bbox, datetime: `${ISO(now - 3 * 3600000)}/${ISO(now)}`, limit: 1000 });
          const st = obs.nearestParams(ocean, lat, lon);
          if (st) {
            const w = obs.waterFromOceanObs(st.params);
            if (typeof w.temperature === 'number') waterTemp = w.temperature;
            if (typeof w.level === 'number') level = w.level;
          }
        }
        if (typeof waterTemp === 'number') values.push({ path: 'environment.water.temperature', value: waterTemp });
        if (typeof level === 'number') {
          values.push({ path: 'environment.water.level', value: level });
          values.push({ path: 'environment.tide.heightNow', value: level });
        }
      } catch (e) { app.error(`marine poll failed: ${e.message}`); }
    }

    // Merge in last-good for any path this poll didn't produce (source 429'd),
    // and record fresh values as the new last-good.
    const freshPaths = new Set(values.map((v) => v.path));
    for (const v of values) lastGood[v.path] = v.value;
    for (const p of Object.keys(lastGood)) {
      if (!freshPaths.has(p)) values.push({ path: p, value: lastGood[p] });
    }

    publish(values);
    app.debug(`DMI poll published ${values.length} values (${freshPaths.size} fresh)`);
  }

  // ---- lifecycle ----------------------------------------------------------
  plugin.start = function (opts) {
    options = Object.assign(
      {
        positionSource: 'vessel', pollIntervalMinutes: 30, forecastHours: 48,
        weatherProvider: true, observations: true, waves: true, ocean: true,
        harmonieCollection: 'harmonie_dini_sf', wamCollection: 'wam_dw', dkssCollection: 'dkss_nsbs',
      },
      opts || {}
    );

    if (options.weatherProvider) {
      if (typeof app.registerWeatherProvider === 'function') {
        app.registerWeatherProvider(provider);
        app.setPluginStatus('DMI weather provider registered');
      } else {
        app.error('Signal K server has no Weather API (registerWeatherProvider missing) — deltas only');
      }
    }

    emitMeta();
    const period = Math.max(5, options.pollIntervalMinutes) * 60000;
    if (options.observations || options.waves || options.ocean) {
      // Small delay so the position snapshot has arrived after (re)start.
      setTimeout(pollDeltas, 5000);
      timer = setInterval(pollDeltas, period);
    }
    app.setPluginStatus(`DMI running (poll every ${options.pollIntervalMinutes} min)`);
  };

  plugin.stop = function () {
    if (timer) clearInterval(timer);
    timer = null;
    if (typeof app.unRegisterWeatherProvider === 'function') {
      try { app.unRegisterWeatherProvider(plugin.id); } catch (e) { /* ignore */ }
    }
    app.setPluginStatus('Stopped');
  };

  return plugin;
};