'use strict';

// InfluxDB history "detect + guide" — read-only awareness of the separate
// signalk-to-influxdb2 persistence plugin so signalk-dmi can tell the user, in its
// own config UI / status, whether DMI paths will be trended and, if not, exactly
// what to add. HARD BOUNDARY: this module NEVER writes another plugin's config. It
// only reads (the server's own config dir, located via the supported
// app.config.configPath) to report state. The allow-list edit stays in the plugin
// that owns it.

const fs = require('fs');
const path = require('path');

const INFLUX_ID = 'signalk-to-influxdb2';

// Derive the DMI persistence path prefixes from the plugin's OWN published paths
// (the META keys passed in) so the allow-list guidance can never drift from what
// the plugin actually publishes. environment.outside.temperature ->
// "environment.outside." etc. — one prefix per environment.<group>.
function dmiPathPrefixes(metaKeys) {
  const set = new Set();
  for (const p of metaKeys) {
    const seg = String(p).split('.');
    if (seg.length >= 3 && seg[0] === 'environment') set.add(`${seg[0]}.${seg[1]}.`);
  }
  return [...set].sort();
}

// Ready-to-paste signalk-to-influxdb2 filteringRules JSON (allow the DMI prefixes,
// deny-all last). Dots escaped for the regex `path` field.
function filteringRulesSnippet(prefixes) {
  const rules = prefixes.map((p) => ({ allow: true, path: p.replace(/\./g, '\\.') }));
  rules.push({ allow: false, path: '.*' });
  return JSON.stringify({ filteringRules: rules }, null, 2);
}

// Would an ordered filteringRules array persist `testPath`? First matching rule
// wins (the allow-list-then-deny-all pattern signalk-to-influxdb2 uses). A bad
// regex is skipped. No match -> not persisted (conservative; leans to "add these").
function pathAllowed(rules, testPath) {
  for (const r of rules) {
    let re;
    try { re = new RegExp(r.path); } catch (e) { continue; }
    if (re.test(testPath)) return r.allow === true;
  }
  return false;
}

// Supported way to find the server config dir — app.config.configPath. No
// hard-coded paths; returns null if the server doesn't expose it.
function configDir(app) {
  try {
    if (app && app.config && typeof app.config.configPath === 'string' && app.config.configPath) {
      return app.config.configPath;
    }
  } catch (e) { /* fall through */ }
  return null;
}

// Read-only detection. Returns { state, summary, prefixes, snippet, enabled? }.
// state ∈ unknown | not-installed | installed-config-unreadable |
//         installed-uncovered | covered
function detect(app, metaKeys) {
  const prefixes = dmiPathPrefixes(metaKeys);
  const snippet = filteringRulesSnippet(prefixes);
  const addList = prefixes.join(', ');
  const dir = configDir(app);

  if (!dir) {
    return {
      state: 'unknown', prefixes, snippet,
      summary: `History & trends: could not determine whether ${INFLUX_ID} is installed `
        + `(the server did not expose its config path). Live DMI data works regardless. `
        + `To trend DMI data, install ${INFLUX_ID} and allow-list: ${addList}`,
    };
  }

  const installed = fs.existsSync(path.join(dir, 'node_modules', INFLUX_ID, 'package.json'));
  if (!installed) {
    return {
      state: 'not-installed', prefixes, snippet,
      summary: `History & trends unavailable — live DMI data works, but no InfluxDB `
        + `persistence found. Install ${INFLUX_ID} to trend DMI data.`,
    };
  }

  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(dir, 'plugin-config-data', `${INFLUX_ID}.json`), 'utf8'));
  } catch (e) { cfg = null; }

  if (!cfg) {
    return {
      state: 'installed-config-unreadable', prefixes, snippet,
      summary: `${INFLUX_ID} is installed but its configuration could not be read, so `
        + `DMI-path coverage is unknown. If DMI trends are missing, add these paths to `
        + `its allow-list: ${addList}`,
    };
  }

  const enabled = cfg.enabled === true;
  const enabledNote = enabled ? '' : ` — note: ${INFLUX_ID} is currently DISABLED, enable it too`;
  const influxes = (cfg.configuration && Array.isArray(cfg.configuration.influxes))
    ? cfg.configuration.influxes : [];

  // A DMI path is covered if ANY configured influx persists it. An influx with no
  // filteringRules stores everything (influxdb2 default) -> covered.
  const coveredByAny = (testPath) => influxes.some((inf) => {
    const rules = inf && inf.filteringRules;
    if (!Array.isArray(rules) || rules.length === 0) return true;
    return pathAllowed(rules, testPath);
  });

  // Test real data paths (skip the nearby-marker display paths).
  const samples = metaKeys.filter((p) => !String(p).toLowerCase().includes('nearby'));

  if (influxes.length === 0) {
    return {
      state: 'installed-uncovered', prefixes, snippet, enabled,
      summary: `${INFLUX_ID} found${enabledNote}, but no InfluxDB output is configured `
        + `yet. Configure it, then allow-list these DMI paths: ${addList}`,
    };
  }

  const missing = samples.filter((p) => !coveredByAny(p));
  if (missing.length === 0) {
    return {
      state: 'covered', prefixes, snippet, enabled,
      summary: `DMI paths already persisted — trends enabled${enabledNote}.`,
    };
  }

  return {
    state: 'installed-uncovered', prefixes, snippet, enabled,
    summary: `${INFLUX_ID} found${enabledNote}, but the DMI paths are not in its allow-list `
      + `yet — add these to enable trends: ${addList}`,
  };
}

module.exports = { detect, dmiPathPrefixes, filteringRulesSnippet, pathAllowed, configDir, INFLUX_ID };
