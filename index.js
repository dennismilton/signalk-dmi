// signalk-dmi — ingest DMI (Danish Meteorological Institute) free open data into
// Signal K. Two surfaces (see RESEARCH.md §4):
//   1. Signal K v2 Weather API provider — atmospheric forecasts (HARMONIE) +
//      observations (metObs), now also carrying marine `water.*` (WAM/DKSS).
//   2. environment.* deltas — current conditions + marine (waves, sea level,
//      current, water temp), so non-Weather-API consumers reading
//      environment.outside.wind.* work as a drop-in for the OpenWeather provider.
// DMI Open Data is CC BY 4.0 and key-free on opendataapi.dmi.dk.
'use strict';

const {
  edrPosition, edrPositionNearby, marineCooldownActive, noteMarineProbeResult, obsItems,
} = require('./lib/dmi');
const t = require('./lib/transform');
const obs = require('./lib/observe');
const warn = require('./lib/warnings');
const influx = require('./lib/influx');

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
  'environment.outside.horizontalVisibility': 'm',
  'environment.outside.cloudCover': 'ratio',
  'environment.outside.precipitationRate': 'm/s',
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
  // Honest-display markers: when a marine value was sourced from a nearby grid
  // point (surrounding-area fallback, not the boat's exact position), these carry
  // how far off (m) and in which direction (rad) the sample was taken, so the
  // display can label it "nearby ~X nm". Null/absent means the value is at-point.
  'environment.water.waves.nearbyDistance': 'm',
  'environment.water.waves.nearbyBearing': 'rad',
  'environment.current.nearbyDistance': 'm',
  'environment.current.nearbyBearing': 'rad',
};

// Marine surrounding-area marker paths — EXCLUDED from the last-good re-publish
// mechanism so a stale "nearby" tag can never survive a later exact-point poll.
const NEARBY_PATHS = new Set([
  'environment.water.waves.nearbyDistance', 'environment.water.waves.nearbyBearing',
  'environment.current.nearbyDistance', 'environment.current.nearbyBearing',
]);

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'signalk-dmi';
  plugin.name = 'DMI (Danish Meteorological Institute) free data';
  plugin.description =
    'Danish met/ocean data from DMI Open Data — HARMONIE forecasts, met observations, ' +
    'WAM waves and DKSS ocean — into Signal K paths and the v2 Weather API. Data: DMI, CC BY 4.0.';

  let timer = null;
  let warnTimer = null;
  let options = {};
  // Last-good value per path, so a poll where a DMI source 429s re-publishes the
  // previous value (with a fresh timestamp) instead of dropping the path.
  const lastGood = {};
  // Per-collection ring-probe cooldown (expiry epoch ms). Set when a marine collection's
  // capped surrounding-area probe comes back empty or 429-rate-limited, so the plugin
  // doesn't re-run the whole ring every poll and re-trigger the DMI 429. Cleared on any
  // numeric hit; expires after ~2 poll cycles so the area is re-probed later.
  const marineProbeCooldown = {};
  // Notification paths currently raised for active warnings, so lapsed ones clear.
  const activeWarnPaths = new Set();

  // Schema is a FUNCTION so the InfluxDB history status is detected fresh each time
  // the admin opens Plugin Config, and shown inline. Detection is read-only (never
  // writes signalk-to-influxdb2's config).
  plugin.schema = function () {
    let historyInfo;
    try { historyInfo = influx.detect(app, Object.keys(META)); }
    catch (e) { historyInfo = { summary: `History & trends: detection error (${e.message}). Live DMI data is unaffected.`, snippet: '' }; }
    return {
    type: 'object',
    properties: {
      historyGuidance: {
        type: 'boolean', default: true,
        title: 'Show history & trends (InfluxDB) guidance',
        description:
          'STATUS — ' + historyInfo.summary
          + (historyInfo.snippet && historyInfo.state !== 'covered'
            ? '  Ready-to-paste signalk-to-influxdb2 filteringRules:  ' + historyInfo.snippet
            : '')
          + '  (Informational only — signalk-dmi never edits another plugin\'s config; '
          + 'add the paths yourself in signalk-to-influxdb2. Untick to silence the '
          + 'startup history hint in the plugin status/log.)',
      },
      positionSource: {
        type: 'string', enum: ['vessel', 'fixed'], default: 'vessel',
        enumNames: ['Vessel GPS (navigation.position)', 'Fixed coordinates'],
        title: 'Position source',
        description:
          'Where DMI data is queried for. "Vessel GPS" follows the boat live from '
          + 'navigation.position — use this underway. "Fixed coordinates" always uses '
          + 'the latitude/longitude below — use it for a dock/shore install or when no '
          + 'GPS is available. Default: Vessel GPS.',
      },
      fixedLatitude: {
        type: 'number', title: 'Fixed latitude',
        description:
          'Latitude in decimal degrees (WGS84), e.g. 56.15. Used ONLY when Position '
          + 'source = Fixed coordinates; ignored otherwise. North positive.',
      },
      fixedLongitude: {
        type: 'number', title: 'Fixed longitude',
        description:
          'Longitude in decimal degrees (WGS84), e.g. 10.22. Used ONLY when Position '
          + 'source = Fixed coordinates; ignored otherwise. East positive.',
      },
      pollIntervalMinutes: {
        type: 'number', default: 30, minimum: 5,
        title: 'Poll interval (minutes)',
        description:
          'How often DMI observations and marine (waves/ocean) deltas are refreshed, '
          + 'in minutes (minimum 5). Lower = fresher data but more API calls; DMI is '
          + 'free but shared-rate-limited, so 30 is a good boat default. Does not affect '
          + 'the on-demand Weather API forecast. Default: 30.',
      },
      forecastHours: {
        type: 'number', default: 48, minimum: 1, maximum: 120,
        title: 'Forecast window (hours)',
        description:
          'Look-ahead horizon for the v2 Weather API forecast, in hours (1–120). Only '
          + 'changes how far ahead forecast steps are returned; it does not change the '
          + 'refresh rate or the environment.* deltas. Default: 48.',
      },
      weatherProvider: {
        type: 'boolean', default: true,
        title: 'Register as Weather API provider',
        description:
          'When ON, DMI serves the Signal K v2 Weather API (/signalk/v2/api/weather '
          + 'forecasts + observations). Turn OFF to run additively ALONGSIDE another '
          + 'provider (e.g. OpenWeather) without competing to be the default provider — '
          + 'the environment.* deltas below still publish either way. Default: ON '
          + '(set OFF on the boat where OpenWeather stays the default).',
      },
      observations: {
        type: 'boolean', default: true,
        title: 'Publish current conditions',
        description:
          'Publish nearest-station DMI met observations as environment.outside.* deltas '
          + '(temperature, pressure, humidity, dew point, wind speed/gust/direction). '
          + 'These are the OpenWeather-parity paths the dashboard reads. Turn OFF to stop '
          + 'publishing them. Default: ON.',
      },
      tier1: {
        type: 'boolean', default: true,
        title: 'Publish extended conditions',
        description:
          'Add three more current-condition deltas from the HARMONIE surface model: '
          + 'environment.outside.horizontalVisibility (m), cloudCover (ratio 0–1) and '
          + 'precipitationRate (m/s). Turn OFF for a leaner path set. Default: ON.',
      },
      warnings: {
        type: 'boolean', default: true,
        title: 'Fetch weather warnings',
        description:
          'Fetch official government weather/marine warnings from the EUMETNET MeteoAlarm '
          + 'CAP feed for the countries selected below, and expose them via the Weather '
          + 'API getWarnings. Turn OFF to skip warnings entirely. Default: ON.',
      },
      warningNotifications: {
        type: 'boolean', default: true,
        title: 'Raise warnings as notifications',
        description:
          'Also surface each active warning as a Signal K notification under '
          + 'notifications.environment.warnings.dmi.* so alarms/displays can react. '
          + 'Has no effect unless "Fetch weather warnings" is ON. Default: ON.',
      },
      warningCountries: {
        type: 'array', default: ['denmark'],
        title: 'Warning countries',
        description:
          'Which MeteoAlarm national feeds to pull warnings from. Denmark covers Danish '
          + 'waters; add neighbours (Germany, Sweden, Norway, Netherlands, Poland) when '
          + 'sailing across borders. Only used when "Fetch weather warnings" is ON. '
          + 'Default: Denmark.',
        items: {
          type: 'string',
          enum: [
            'austria', 'belgium', 'bosnia-herzegovina', 'bulgaria', 'croatia', 'cyprus',
            'czechia', 'denmark', 'estonia', 'finland', 'france', 'germany', 'greece',
            'hungary', 'iceland', 'ireland', 'israel', 'italy', 'latvia', 'lithuania',
            'luxembourg', 'malta', 'moldova', 'montenegro', 'netherlands', 'norway',
            'poland', 'portugal', 'republic-of-north-macedonia', 'romania', 'serbia',
            'slovakia', 'slovenia', 'spain', 'sweden', 'switzerland', 'ukraine',
            'united-kingdom',
          ],
          enumNames: [
            'Austria', 'Belgium', 'Bosnia and Herzegovina', 'Bulgaria', 'Croatia', 'Cyprus',
            'Czechia', 'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece',
            'Hungary', 'Iceland', 'Ireland', 'Israel', 'Italy', 'Latvia', 'Lithuania',
            'Luxembourg', 'Malta', 'Moldova', 'Montenegro', 'Netherlands', 'Norway',
            'Poland', 'Portugal', 'North Macedonia', 'Romania', 'Serbia',
            'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland', 'Ukraine',
            'United Kingdom',
          ],
        },
        uniqueItems: true,
      },
      waves: {
        type: 'boolean', default: true,
        title: 'Publish wave data',
        description:
          'Publish WAM wave-model data as environment.water.waves.* and .swell.* deltas '
          + '(significant height, mean period, mean direction). Uses the WAM model chosen '
          + 'below. Turn OFF to skip waves. Default: ON.',
      },
      ocean: {
        type: 'boolean', default: true,
        title: 'Publish ocean data',
        description:
          'Publish DKSS ocean-model data as environment.water.temperature, water.level, '
          + 'tide.heightNow and current.drift/setTrue deltas. Uses the DKSS model chosen '
          + 'below. Turn OFF to skip ocean/current. Default: ON.',
      },
      harmonieCollection: {
        type: 'string', default: 'harmonie_dini_sf',
        enum: ['harmonie_dini_sf', 'harmonie_ig_sf'],
        enumNames: [
          'DINI — Denmark / Netherlands / Ireland / Iceland (recommended)',
          'IG — Iceland / Greenland',
        ],
        title: 'HARMONIE forecast model',
        description:
          'DMI HARMONIE high-resolution surface (SF) model used for the atmospheric '
          + 'forecast and observations. DINI covers Danish/North-Sea waters — keep this '
          + 'unless your position is outside the DINI domain (e.g. around Iceland/'
          + 'Greenland, where IG applies). Only surface models are offered; pressure-level '
          + 'and ensemble collections carry different parameters and are not compatible. '
          + 'Default: DINI.',
      },
      wamCollection: {
        type: 'string', default: 'wam_dw',
        enum: ['wam_dw', 'wam_nsb', 'wam_natlant'],
        enumNames: [
          'Danish Waters (highest resolution near DK, recommended)',
          'North Sea & Baltic (wider coverage)',
          'North Atlantic (offshore/ocean)',
        ],
        title: 'WAM wave model',
        description:
          'DMI WAM wave-model domain used for the wave/swell deltas. Pick the smallest '
          + 'domain that contains your position for best resolution: Danish Waters for '
          + 'coastal DK, North Sea & Baltic for wider passages, North Atlantic for '
          + 'offshore. Default: Danish Waters.',
      },
      dkssCollection: {
        type: 'string', default: 'dkss_nsbs',
        enum: ['dkss_nsbs', 'dkss_idw', 'dkss_ws', 'dkss_lf', 'dkss_lb', 'dkss_if'],
        enumNames: [
          'North Sea – Baltic Sea (widest, recommended)',
          'Inner Danish Waters (higher resolution around DK)',
          'Wadden Sea',
          'Limfjord',
          'Little Belt',
          'Roskilde / Isefjord',
        ],
        title: 'DKSS ocean model',
        description:
          'DMI DKSS storm-surge/ocean-model domain used for water level, water '
          + 'temperature, tide and current deltas. Choose the smallest domain that '
          + 'contains your position for best resolution; North Sea – Baltic Sea is the '
          + 'broad default that covers most of Danish waters. Default: North Sea – Baltic.',
      },
    },
    };
  };

  // ---- position -----------------------------------------------------------
  const isNum = (n) => typeof n === 'number' && !Number.isNaN(n);
  const asLatLon = (v) => (v && isNum(v.latitude) && isNum(v.longitude)
    ? { latitude: v.latitude, longitude: v.longitude } : null);

  // Read the vessel position robustly — different signalk-server versions return
  // getSelfPath('navigation.position') either as {latitude,longitude} directly or
  // wrapped as {value:{...}}; '...position.value' returns the bare value. Try all.
  function vesselPosition() {
    const attempts = [
      () => app.getSelfPath('navigation.position.value'),
      () => app.getSelfPath('navigation.position'),
    ];
    for (const get of attempts) {
      try {
        const raw = get();
        const pos = asLatLon(raw) || asLatLon(raw && raw.value);
        if (pos) return pos;
      } catch (e) { /* keep trying */ }
    }
    return null;
  }

  function getPosition() {
    const fixed = asLatLon({ latitude: options.fixedLatitude, longitude: options.fixedLongitude });
    if (options.positionSource === 'fixed') return fixed;
    // vessel: prefer the live GPS, fall back to a configured fixed position if set.
    const pos = vesselPosition();
    if (pos) return pos;
    if (fixed) app.debug('vessel position not in model yet — using fixed fallback');
    return fixed;
  }

  // ---- forecast fetch (shared by provider + delta poll) -------------------
  const gap = (ms) => new Promise((r) => setTimeout(r, ms));

  // One EDR collection, resilient: on failure (429, land/out-of-grid, timeout)
  // log and return [] so a single source never sinks the whole forecast.
  // When opts.nearby is set (marine collections), the exact point is tried first
  // and, if it is empty, the surrounding area is sampled (see edrPositionNearby);
  // the returned rows array carries a `.nearby` marker ({ distanceM, bearingRad }
  // or null) so the caller can surface a "nearby ~X nm" indicator.
  async function tryEdr(collection, lon, lat, params, range, req, opts = {}) {
    try {
      if (opts.nearby) {
        const now = Date.now();
        // While cooling down, skip the ring entirely — just try the cheap exact point.
        const cooling = marineCooldownActive(marineProbeCooldown, collection, now);
        const res = await edrPositionNearby(collection, lon, lat, params, range, req, { probe: !cooling });
        const period = Math.max(5, options.pollIntervalMinutes || 30) * 60000;
        const cooled = noteMarineProbeResult(marineProbeCooldown, collection, now, res, 2 * period);
        if (cooled) {
          app.debug(`marine ${collection}: no nearby data (${res.rateLimited ? 'DMI 429 — backing off' : 'area empty'}) — ring probe cooldown ~${Math.round((2 * period) / 60000)} min`);
        } else if (res.offset) {
          app.debug(`marine ${collection}: no data at point — using nearby grid ~${(res.offset.distanceM / 1852).toFixed(1)} nm off`);
        } else if (cooling) {
          app.debug(`marine ${collection}: ring probe cooling down — exact-point only this poll`);
        }
        const rows = res.rows;
        rows.nearby = res.offset;
        return rows;
      }
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
    // Marine collections (WAM/DKSS) use the surrounding-area fallback so the
    // forecast track still populates when the boat's exact point is a grid gap.
    const [harmonie, wam, dkss] = await Promise.all([
      tryEdr(options.harmonieCollection, lon, lat, t.HARMONIE_PARAMS, range, FORECAST_REQ),
      options.waves ? tryEdr(options.wamCollection, lon, lat, t.WAM_PARAMS, range, FORECAST_REQ, { nearby: true }) : Promise.resolve([]),
      options.ocean ? tryEdr(options.dkssCollection, lon, lat, t.DKSS_PARAMS, range, FORECAST_REQ, { nearby: true }) : Promise.resolve([]),
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

  // ---- warnings (MeteoAlarm CAP feed) -------------------------------------
  // The DMI Open Data API has no warnings collection; DMI issues its official
  // public warnings via EUMETNET/MeteoAlarm, whose per-country CAP/Atom feed is
  // public + key-free + CC BY 4.0 (RESEARCH.md §3.7). Bounded req budget so the
  // on-demand getWarnings path never hangs.
  const WARN_REQ = { tries: 2, timeoutMs: 6000 };
  const WARN_NS = 'notifications.environment.warnings.dmi.';
  let lastWarnings = null; // grouped-warning cache (last successful fetch)

  async function fetchWarnings() {
    const groups = await warn.getActiveWarnings(
      options.warningCountries, Date.now(), WARN_REQ,
      (c, e) => app.error(`warnings feed ${c} skipped: ${e.message}`)
    );
    lastWarnings = groups;
    return groups;
  }

  // Signal K Weather API provider method — active warnings for the position.
  // (MeteoAlarm warnings are region-coded per country, not point queries, so we
  // surface all active warnings for the configured country feed(s).)
  async function getWarnings() {
    if (!options.warnings) return [];
    const groups = await fetchWarnings().catch((e) => {
      app.error(`getWarnings failed: ${e.message}`);
      return lastWarnings || [];
    });
    return groups.map(warn.toWeatherWarning);
  }

  // Raise active warnings as Signal K notifications and clear ones that lapsed.
  async function pollWarnings() {
    if (!options.warnings) return;
    try {
      const groups = await fetchWarnings();
      const values = [];
      if (options.warningNotifications) {
        const seen = new Set();
        for (const g of groups) {
          const path = WARN_NS + warn.warningSlug(g);
          seen.add(path);
          values.push({ path, value: warn.toNotification(g) });
        }
        for (const path of activeWarnPaths) {
          if (!seen.has(path)) values.push({ path, value: null }); // clear lapsed
        }
        activeWarnPaths.clear();
        for (const p of seen) activeWarnPaths.add(p);
      }
      publish(values);
      app.debug(`DMI warnings: ${groups.length} active`);
    } catch (e) {
      app.error(`warnings poll failed: ${e.message}`);
    }
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
          // Tier-1 extras: visibility (m), cloud cover (ratio), precipitation rate (m/s).
          if (options.tier1) {
            if (typeof outside.horizontalVisibility === 'number') values.push({ path: 'environment.outside.horizontalVisibility', value: outside.horizontalVisibility });
            if (typeof outside.cloudCover === 'number') values.push({ path: 'environment.outside.cloudCover', value: outside.cloudCover });
            // outside.precipitationVolume carries metObs precip_past10min (mm/10min) → SI rate.
            if (typeof outside.precipitationVolume === 'number') values.push({ path: 'environment.outside.precipitationRate', value: t.mm10ToMps(outside.precipitationVolume) });
          }
        }
      } catch (e) { app.error(`metObs poll failed: ${e.message}`); }
    }

    // Marine now-slice: WAM waves + DKSS ocean forecast at the current hour.
    if (options.waves || options.ocean) {
      try {
        const range = { from: ISO(now - 3600000), to: ISO(now + 3 * 3600000) };
        // Bounded budget for the exact-point call so the poll never stalls; the
        // surrounding-area probes ring out with their own fast, no-retry budget.
        const MARINE_REQ = { tries: 2, timeoutMs: 8000 };
        let wam = [];
        let dkss = [];
        if (options.waves) { wam = await tryEdr(options.wamCollection, lon, lat, t.WAM_PARAMS, range, MARINE_REQ, { nearby: true }); }
        if (options.ocean) { await gap(300); dkss = await tryEdr(options.dkssCollection, lon, lat, t.DKSS_PARAMS, range, MARINE_REQ, { nearby: true }); }
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
        // Honest-display markers: tag waves/swell (WAM) and current (DKSS) with the
        // offset when the data came from a nearby grid point; publish null to CLEAR
        // the tag once the exact point returns data again. Only emitted when the
        // source produced rows at all (empty area → no marker, card shows "—").
        if (wam.length) {
          values.push({ path: 'environment.water.waves.nearbyDistance', value: wam.nearby ? wam.nearby.distanceM : null });
          values.push({ path: 'environment.water.waves.nearbyBearing', value: wam.nearby ? wam.nearby.bearingRad : null });
        }
        if (dkss.length) {
          values.push({ path: 'environment.current.nearbyDistance', value: dkss.nearby ? dkss.nearby.distanceM : null });
          values.push({ path: 'environment.current.nearbyBearing', value: dkss.nearby ? dkss.nearby.bearingRad : null });
        }
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
    // Record last-good for stable value paths only — never the nearby markers, so a
    // stale "nearby ~X nm" tag can't be re-published over a later exact-point poll.
    for (const v of values) if (!NEARBY_PATHS.has(v.path)) lastGood[v.path] = v.value;
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
        weatherProvider: true, observations: true, tier1: true, waves: true, ocean: true,
        warnings: true, warningNotifications: true, warningCountries: ['denmark'],
        harmonieCollection: 'harmonie_dini_sf', wamCollection: 'wam_dw', dkssCollection: 'dkss_nsbs',
        historyGuidance: true,
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
    if (options.warnings) {
      // Warnings are position-independent (region-coded per country feed) — poll
      // on their own timer so a missing GPS fix never blocks them.
      setTimeout(pollWarnings, 6000);
      warnTimer = setInterval(pollWarnings, period);
    }
    // History / trends (InfluxDB) — detect + guide (read-only; never writes the
    // other plugin's config). Always logged; a compact hint is appended to the
    // plugin status only when guidance is on and DMI isn't being persisted yet.
    let historyHint = '';
    try {
      const info = influx.detect(app, Object.keys(META));
      app.debug(`InfluxDB history: ${info.summary}`);
      if (options.historyGuidance !== false) {
        if (info.state === 'not-installed') historyHint = ' · history: install signalk-to-influxdb2 to trend DMI';
        else if (info.state === 'installed-uncovered') historyHint = ' · history: DMI paths not persisted yet (see config)';
      }
    } catch (e) { app.debug(`InfluxDB history detection error: ${e.message}`); }

    app.setPluginStatus(`DMI running (poll every ${options.pollIntervalMinutes} min)${historyHint}`);
  };

  plugin.stop = function () {
    if (timer) clearInterval(timer);
    timer = null;
    if (warnTimer) clearInterval(warnTimer);
    warnTimer = null;
    if (typeof app.unRegisterWeatherProvider === 'function') {
      try { app.unRegisterWeatherProvider(plugin.id); } catch (e) { /* ignore */ }
    }
    app.setPluginStatus('Stopped');
  };

  return plugin;
};