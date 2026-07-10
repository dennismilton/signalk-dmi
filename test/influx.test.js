'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const influx = require('../lib/influx');

const META = [
  'environment.outside.temperature',
  'environment.outside.horizontalVisibility',
  'environment.water.temperature',
  'environment.water.waves.significantHeight',
  'environment.tide.heightNow',
  'environment.current.drift',
  'environment.water.waves.nearbyDistance', // marker — must be ignored in coverage
];

function tmpConfig() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skdmi-test-'));
  fs.mkdirSync(path.join(d, 'plugin-config-data'), { recursive: true });
  return d;
}
function installInflux(d) {
  fs.mkdirSync(path.join(d, 'node_modules', influx.INFLUX_ID), { recursive: true });
  fs.writeFileSync(path.join(d, 'node_modules', influx.INFLUX_ID, 'package.json'), '{}');
}
function writeInfluxCfg(d, cfg) {
  fs.writeFileSync(path.join(d, 'plugin-config-data', `${influx.INFLUX_ID}.json`), JSON.stringify(cfg));
}

test('dmiPathPrefixes derives one prefix per environment.<group> from published paths', () => {
  assert.deepStrictEqual(
    influx.dmiPathPrefixes(META),
    ['environment.current.', 'environment.outside.', 'environment.tide.', 'environment.water.']
  );
});

test('filteringRulesSnippet allows every DMI path and denies non-DMI', () => {
  const rules = JSON.parse(influx.filteringRulesSnippet(influx.dmiPathPrefixes(META))).filteringRules;
  for (const p of META) assert.strictEqual(influx.pathAllowed(rules, p), true, p);
  assert.strictEqual(influx.pathAllowed(rules, 'navigation.position'), false);
  assert.strictEqual(rules[rules.length - 1].allow, false); // deny-all last
});

test('detect: unknown when server exposes no config path', () => {
  assert.strictEqual(influx.detect({}, META).state, 'unknown');
});

test('detect: not-installed when signalk-to-influxdb2 absent', () => {
  const d = tmpConfig();
  assert.strictEqual(influx.detect({ config: { configPath: d } }, META).state, 'not-installed');
});

test('detect: installed-config-unreadable when installed but no config file', () => {
  const d = tmpConfig();
  installInflux(d);
  assert.strictEqual(influx.detect({ config: { configPath: d } }, META).state, 'installed-config-unreadable');
});

test('detect: installed-uncovered when DMI paths not in allow-list', () => {
  const d = tmpConfig();
  installInflux(d);
  writeInfluxCfg(d, { enabled: true, configuration: { influxes: [{ filteringRules: [
    { allow: true, path: 'navigation\\.position' }, { allow: false, path: '.*' },
  ] }] } });
  assert.strictEqual(influx.detect({ config: { configPath: d } }, META).state, 'installed-uncovered');
});

test('detect: covered when DMI prefixes are allow-listed', () => {
  const d = tmpConfig();
  installInflux(d);
  const rules = JSON.parse(influx.filteringRulesSnippet(influx.dmiPathPrefixes(META))).filteringRules;
  writeInfluxCfg(d, { enabled: true, configuration: { influxes: [{ filteringRules: rules }] } });
  const r = influx.detect({ config: { configPath: d } }, META);
  assert.strictEqual(r.state, 'covered');
});

test('detect: an influx with no filteringRules stores everything -> covered', () => {
  const d = tmpConfig();
  installInflux(d);
  writeInfluxCfg(d, { enabled: true, configuration: { influxes: [{ filteringRules: [] }] } });
  assert.strictEqual(influx.detect({ config: { configPath: d } }, META).state, 'covered');
});

test('detect: disabled influx is flagged in the summary', () => {
  const d = tmpConfig();
  installInflux(d);
  const rules = JSON.parse(influx.filteringRulesSnippet(influx.dmiPathPrefixes(META))).filteringRules;
  writeInfluxCfg(d, { enabled: false, configuration: { influxes: [{ filteringRules: rules }] } });
  const r = influx.detect({ config: { configPath: d } }, META);
  assert.match(r.summary, /DISABLED/);
});
