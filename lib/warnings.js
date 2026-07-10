// DMI weather/marine warnings via the MeteoAlarm CAP feed.
//
// WHY MeteoAlarm and not the DMI Open Data API: the key-free DMI Open Data API
// (opendataapi.dmi.dk) has NO warnings collection — it serves forecasts (HARMONIE/
// WAM/DKSS), observations (metObs/oceanObs), climate, radar and lightning only.
// DMI issues its official public weather warnings through EUMETNET / MeteoAlarm,
// which republishes them as a per-country CAP 1.2 Atom feed. That feed is public,
// key-free, CC BY 4.0, and carries the same DMI warnings (incl. coastal/wind/flood
// events relevant to a boat) with machine-readable severity, timing and area.
// See RESEARCH.md §3.7. Source label credits both DMI and MeteoAlarm.
//
//   https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-<country>
//
// The feed is one flat Atom document, one <entry> per (warning × area). We parse
// it without an XML dependency: the MeteoAlarm producer emits a stable, regular
// shape (verified live 2026-07-08), so scoped regex extraction is reliable. Each
// entry carries cap:* fields (event, severity, certainty, urgency, onset, expires,
// sent, status, msgType, areaDesc, geocode) plus <title> and a cap+xml link.
'use strict';

const { getText } = require('./dmi');

const FEED_BASE = 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-';

// MeteoAlarm cap:severity → Signal K notification state (ascending urgency:
// nominal < normal < alert < warn < alarm < emergency).
const SEVERITY_STATE = { Minor: 'alert', Moderate: 'warn', Severe: 'alarm', Extreme: 'emergency' };

const decodeXml = (s) => (s || '')
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&').trim();

// First captured group of a scoped regex, XML-decoded, or undefined.
function pick(block, re) {
  const m = block.match(re);
  return m ? decodeXml(m[1]) : undefined;
}

// Parse one <entry>…</entry> block into a normalized warning record.
function parseEntry(block) {
  const w = {
    event: pick(block, /<cap:event>([\s\S]*?)<\/cap:event>/),
    areaDesc: pick(block, /<cap:areaDesc>([\s\S]*?)<\/cap:areaDesc>/),
    severity: pick(block, /<cap:severity>([\s\S]*?)<\/cap:severity>/),
    certainty: pick(block, /<cap:certainty>([\s\S]*?)<\/cap:certainty>/),
    urgency: pick(block, /<cap:urgency>([\s\S]*?)<\/cap:urgency>/),
    onset: pick(block, /<cap:onset>([\s\S]*?)<\/cap:onset>/),
    expires: pick(block, /<cap:expires>([\s\S]*?)<\/cap:expires>/),
    sent: pick(block, /<cap:sent>([\s\S]*?)<\/cap:sent>/),
    status: pick(block, /<cap:status>([\s\S]*?)<\/cap:status>/),
    msgType: pick(block, /<cap:message_type>([\s\S]*?)<\/cap:message_type>/),
    identifier: pick(block, /<cap:identifier>([\s\S]*?)<\/cap:identifier>/),
    title: pick(block, /<title>([\s\S]*?)<\/title>/),
    geocode: pick(block, /<cap:geocode>[\s\S]*?<value>([\s\S]*?)<\/value>[\s\S]*?<\/cap:geocode>/),
    capUrl: pick(block, /<link[^>]*type="application\/cap\+xml"[^>]*href="([^"]+)"/),
  };
  return w;
}

// Parse a MeteoAlarm Atom document → normalized warning records (one per area).
function parseFeed(xml) {
  const out = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(parseEntry(m[1]));
  return out;
}

// Keep only currently-relevant public alerts: status Actual (when present),
// message_type not Cancel, and not already expired at `now` (ms epoch).
function isActive(w, now) {
  if (w.status && w.status !== 'Actual') return false;
  if (w.msgType && /cancel/i.test(w.msgType)) return false;
  if (w.expires) {
    const exp = Date.parse(w.expires);
    if (!Number.isNaN(exp) && exp < now) return false;
  }
  return true;
}

// Collapse per-area entries that belong to the same warning (same identifier, or
// same event+onset+expires) into one grouped warning listing all its areas.
function groupWarnings(list) {
  const byKey = new Map();
  for (const w of list) {
    const key = w.identifier || `${w.event}|${w.onset}|${w.expires}`;
    const g = byKey.get(key);
    if (g) {
      if (w.areaDesc && !g.areas.includes(w.areaDesc)) g.areas.push(w.areaDesc);
      if (w.geocode && !g.geocodes.includes(w.geocode)) g.geocodes.push(w.geocode);
    } else {
      byKey.set(key, {
        key,
        event: w.event, severity: w.severity, certainty: w.certainty, urgency: w.urgency,
        onset: w.onset, expires: w.expires, sent: w.sent, title: w.title, capUrl: w.capUrl,
        areas: w.areaDesc ? [w.areaDesc] : [],
        geocodes: w.geocode ? [w.geocode] : [],
      });
    }
  }
  return [...byKey.values()];
}

// Fetch + parse the active grouped warnings for one country (lowercase English
// name as used in the feed URL, e.g. 'denmark'). Bounded via reqOpts.
async function fetchCountry(country, now, reqOpts) {
  const xml = await getText(`${FEED_BASE}${country}`, reqOpts);
  const active = parseFeed(xml).filter((w) => isActive(w, now));
  return groupWarnings(active).map((g) => ({ ...g, country }));
}

// Fetch active warnings across one or more countries (comma/space separated).
// Never throws for a single bad country — logs via onError and skips it.
async function getActiveWarnings(countries, now, reqOpts, onError) {
  const names = String(countries || 'denmark')
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const all = [];
  for (const c of names) {
    try {
      const ws = await fetchCountry(c, now, reqOpts);
      all.push(...ws);
    } catch (e) {
      if (onError) onError(c, e);
    }
  }
  return all;
}

// Grouped warning → Signal K Weather API WeatherWarning
// { startTime, endTime, details, source, type }.
function toWeatherWarning(g) {
  const area = g.areas.length ? ` — ${g.areas.join(', ')}` : '';
  const sev = g.severity ? `${g.severity}: ` : '';
  return {
    startTime: g.onset || g.sent || new Date().toISOString(),
    endTime: g.expires || '',
    details: (g.title || `${sev}${g.event || 'Weather warning'}`) + area,
    source: 'DMI / MeteoAlarm',
    type: g.event || 'warning',
  };
}

// Stable, filesystem/path-safe id for a grouped warning (for the notification path).
function warningSlug(g) {
  const base = `${g.event || 'warning'} ${g.geocodes.join('-') || g.areas.join('-')} ${g.onset || ''}`;
  let hash = 0;
  for (let i = 0; i < base.length; i++) hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
  const kebab = (g.event || 'warning').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `${kebab || 'warning'}-${hash.toString(36)}`;
}

// Grouped warning → Signal K notification value.
function toNotification(g) {
  const state = SEVERITY_STATE[g.severity] || 'alert';
  const area = g.areas.length ? ` (${g.areas.join(', ')})` : '';
  return {
    state,
    method: state === 'alarm' || state === 'emergency' ? ['visual', 'sound'] : ['visual'],
    message: `DMI ${g.severity || ''} ${g.event || 'warning'}${area}`.replace(/\s+/g, ' ').trim(),
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  FEED_BASE, SEVERITY_STATE,
  decodeXml, parseEntry, parseFeed, isActive, groupWarnings,
  fetchCountry, getActiveWarnings, toWeatherWarning, toNotification, warningSlug,
};
