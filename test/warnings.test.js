'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const w = require('../lib/warnings');
const t = require('../lib/transform');

// A real MeteoAlarm legacy-atom entry shape (captured live 2026-07-08 from the
// germany feed, area names anonymised). Two areas of the SAME warning + one
// separate, expired warning that must be filtered out.
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <entry>
    <cap:geocode><valueName>EMMA_ID</valueName><value>DK005</value></cap:geocode>
    <cap:areaDesc>Nordjylland - K&#252;ste</cap:areaDesc>
    <cap:event>wind gusts</cap:event>
    <cap:sent>2026-07-08T04:49:00+00:00</cap:sent>
    <cap:expires>2099-07-08T22:00:00+00:00</cap:expires>
    <cap:onset>2026-07-08T10:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Immediate</cap:urgency>
    <cap:status>Actual</cap:status>
    <cap:message_type>Alert</cap:message_type>
    <cap:identifier>2.49.0.0.208.0.DMI.ABC</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/x"/>
    <title>Orange Wind Warning issued for Denmark - Nordjylland</title>
  </entry>
  <entry>
    <cap:geocode><valueName>EMMA_ID</valueName><value>DK006</value></cap:geocode>
    <cap:areaDesc>Midtjylland - K&#252;ste</cap:areaDesc>
    <cap:event>wind gusts</cap:event>
    <cap:sent>2026-07-08T04:49:00+00:00</cap:sent>
    <cap:expires>2099-07-08T22:00:00+00:00</cap:expires>
    <cap:onset>2026-07-08T10:00:00+00:00</cap:onset>
    <cap:severity>Moderate</cap:severity>
    <cap:status>Actual</cap:status>
    <cap:message_type>Alert</cap:message_type>
    <cap:identifier>2.49.0.0.208.0.DMI.ABC</cap:identifier>
    <title>Orange Wind Warning issued for Denmark - Midtjylland</title>
  </entry>
  <entry>
    <cap:areaDesc>Bornholm</cap:areaDesc>
    <cap:event>coastal event</cap:event>
    <cap:expires>2000-01-01T00:00:00+00:00</cap:expires>
    <cap:severity>Severe</cap:severity>
    <cap:status>Actual</cap:status>
    <cap:message_type>Alert</cap:message_type>
    <cap:identifier>2.49.0.0.208.0.DMI.OLD</cap:identifier>
    <title>Red Coastal Warning (expired)</title>
  </entry>
</feed>`;

test('parseFeed extracts every entry with decoded cap fields', () => {
  const rows = w.parseFeed(SAMPLE);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].event, 'wind gusts');
  assert.strictEqual(rows[0].severity, 'Moderate');
  assert.strictEqual(rows[0].geocode, 'DK005');
  assert.strictEqual(rows[0].areaDesc, 'Nordjylland - Küste'); // &#252; → ü decoded
  assert.strictEqual(rows[0].capUrl, 'https://feeds.meteoalarm.org/api/v1/warnings/x');
});

test('isActive filters expired + non-Actual', () => {
  const now = Date.parse('2026-07-08T12:00:00Z');
  const rows = w.parseFeed(SAMPLE).filter((r) => w.isActive(r, now));
  assert.strictEqual(rows.length, 2); // the expired coastal event is dropped
  assert.ok(rows.every((r) => r.event === 'wind gusts'));
});

test('groupWarnings collapses per-area entries by identifier', () => {
  const now = Date.parse('2026-07-08T12:00:00Z');
  const groups = w.groupWarnings(w.parseFeed(SAMPLE).filter((r) => w.isActive(r, now)));
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].areas, ['Nordjylland - Küste', 'Midtjylland - Küste']);
  assert.deepStrictEqual(groups[0].geocodes, ['DK005', 'DK006']);
});

test('toWeatherWarning matches the Signal K WeatherWarning shape', () => {
  const now = Date.parse('2026-07-08T12:00:00Z');
  const [g] = w.groupWarnings(w.parseFeed(SAMPLE).filter((r) => w.isActive(r, now)));
  const ww = w.toWeatherWarning(g);
  assert.strictEqual(ww.startTime, '2026-07-08T10:00:00+00:00');
  assert.strictEqual(ww.endTime, '2099-07-08T22:00:00+00:00');
  assert.strictEqual(ww.source, 'DMI / MeteoAlarm');
  assert.strictEqual(ww.type, 'wind gusts');
  assert.match(ww.details, /Nordjylland/);
  assert.deepStrictEqual(Object.keys(ww).sort(), ['details', 'endTime', 'source', 'startTime', 'type']);
});

test('toNotification maps severity → state and sets method', () => {
  const now = Date.parse('2026-07-08T12:00:00Z');
  const [g] = w.groupWarnings(w.parseFeed(SAMPLE).filter((r) => w.isActive(r, now)));
  const n = w.toNotification(g);
  assert.strictEqual(n.state, 'warn'); // Moderate → warn
  assert.deepStrictEqual(n.method, ['visual']);
  assert.match(n.message, /DMI Moderate wind gusts/);
  // Severe/Extreme escalate to sound.
  assert.deepStrictEqual(w.toNotification({ severity: 'Severe', event: 'x', areas: [] }).method, ['visual', 'sound']);
  assert.strictEqual(w.toNotification({ severity: 'Extreme', event: 'x', areas: [] }).state, 'emergency');
});

test('warningSlug is deterministic + path-safe', () => {
  const g = { event: 'wind gusts', geocodes: ['DK005'], areas: [], onset: '2026-07-08T10:00:00+00:00' };
  const slug = w.warningSlug(g);
  assert.match(slug, /^[a-z0-9-]+$/);
  assert.strictEqual(slug, w.warningSlug({ ...g })); // stable
});

test('mm10ToMps converts mm/10min → m/s (SI)', () => {
  assert.ok(Math.abs(t.mm10ToMps(6) - (6 / 1000 / 600)) < 1e-12); // 6 mm/10min = 1e-5 m/s
  assert.strictEqual(t.mm10ToMps(0), 0);
});
