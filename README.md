# signalk-dmi

A [Signal K](https://signalk.org) server plugin that ingests **DMI (Danish
Meteorological Institute) free open data** — authoritative Danish met/ocean data —
into Signal K, richer than the generic OpenWeather provider for Danish, Baltic and
North Sea waters.

It uses DMI's [Open Data API](https://www.dmi.dk/frie-data) (host
`opendataapi.dmi.dk`, **no API key required**, licensed CC BY 4.0).

## Requirements

- **Signal K server** — the Node.js `signalk-server`. The `environment.*` deltas
  work on any recent version; the v2 **Weather API provider** feature needs a
  **v2-capable** server (Signal K server ≥ 2.x).
- **Node.js 18 or newer** (whatever your Signal K server runs on).
- **Platforms** — anything that runs Signal K server: Linux (incl. Raspberry Pi
  ARM), macOS, Windows, and Docker. No native/compiled dependencies (this plugin
  has **zero runtime dependencies**), so no build tools are needed.
- **Outbound internet** to `https://opendataapi.dmi.dk`.
- **No DMI API key, no account, no registration.** DMI's Open Data API is free and
  key-free ([DMI Open Data — Authentication](https://opendatadocs.dmi.govcloud.dk/en/Authentication)).
- A **vessel position** — either live `navigation.position` (GPS) or a configured
  **fixed latitude/longitude** (dock/shore install or testing).
- **Coverage** — Danish, North Sea and Baltic waters (DMI's model domains).
  Outside those areas the plugin simply publishes nothing.

**No database is required** (see *History and trends* below). **Data licence:**
DMI data is **CC BY 4.0** (attribution required — see [Attribution / licence](#attribution--licence)).
**Not for navigation** — informational only (see the [Disclaimer](#disclaimer--informational-only-not-for-navigation)).

Install steps for a fresh server are in **[INSTALL.md](INSTALL.md)**.

## History and trends (optional)

The DMI paths publish **live** into Signal K with **no extra setup** — no database,
no InfluxDB, nothing else to install. This plugin does **not** require InfluxDB.

If you want **historical data or trend graphs** (sparklines, forecast-vs-actual),
install the separate
[`signalk-to-influxdb2`](https://www.npmjs.com/package/signalk-to-influxdb2) plugin,
point it at an InfluxDB 2.x bucket, and **allow-list the DMI paths** in its
`filteringRules` (keep the deny-all `.*` last):

```json
"filteringRules": [
  { "allow": true,  "path": "environment\\.outside\\." },
  { "allow": true,  "path": "environment\\.water\\." },
  { "allow": true,  "path": "environment\\.tide\\." },
  { "allow": true,  "path": "environment\\.current\\." },
  { "allow": false, "path": ".*" }
]
```

These are exactly the `environment.*` groups signalk-dmi publishes; the plugin
shows this same list (and detects whether it's already applied) in its own config
UI — see *History & trends* status there. Then verify with the Signal K v2
**History API**
(`/signalk/v2/api/history/values?paths=environment.water.temperature&from=…&to=…`).
Full step-by-step in **[INSTALL.md → history & trends](INSTALL.md#optional--history--trends-influxdb)**.
This is **entirely optional** and a feature of that plugin, not a requirement of
signalk-dmi.

## What it publishes

The plugin feeds Signal K on **two surfaces**:

### 1. Signal K v2 Weather API provider
Registers `DMI` as a weather provider under `/signalk/v2/api/weather`:
- **Forecasts** (`/forecasts/point`, `/forecasts/daily`) from HARMONIE
  (`harmonie_dini_sf`), merged with WAM waves and DKSS ocean into each forecast
  step's `water.*` block.
- **Observations** (`/observations`) from the nearest metObs land/coastal station,
  plus nearest oceanObs sea level / water temperature.
- **Warnings** (`/warnings`) — official DMI weather/marine warnings sourced from the
  EUMETNET/MeteoAlarm CAP feed (the DMI Open Data API has no warnings collection).
  Also raised as `notifications.environment.warnings.dmi.*`.

### 2. `environment.*` deltas
Current conditions + marine, so any consumer reading `environment.outside.wind.*`
(a drop-in for the OpenWeather provider) gets live data:

| Path | Source | Unit |
|---|---|---|
| `environment.outside.temperature` | metObs | K |
| `environment.outside.dewPointTemperature` | metObs | K |
| `environment.outside.pressure` | metObs | Pa |
| `environment.outside.humidity` | metObs | ratio |
| `environment.outside.wind.speed` | metObs | m/s |
| `environment.outside.wind.gust` | metObs | m/s |
| `environment.outside.wind.direction` | metObs | rad |
| `environment.outside.horizontalVisibility` | metObs | m |
| `environment.outside.cloudCover` | metObs | ratio |
| `environment.outside.precipitationRate` | metObs | m/s |
| `environment.water.temperature` | oceanObs → DKSS | K |
| `environment.water.level` / `environment.tide.heightNow` | oceanObs → DKSS | m |
| `environment.water.waves.significantHeight` / `.period` / `.direction` | WAM | m / s / rad |
| `environment.water.swell.height` / `.period` / `.direction` | WAM | m / s / rad |
| `environment.current.drift` / `environment.current.setTrue` | DKSS | m/s / rad |
| `environment.water.waves.nearbyDistance` / `.nearbyBearing` | WAM (surrounding-area marker) | m / rad |
| `environment.current.nearbyDistance` / `environment.current.nearbyBearing` | DKSS (surrounding-area marker) | m / rad |

All values are converted to Signal K SI units (K, Pa, m/s, rad, ratio); ocean
current is derived from the model's u/v components (set = direction flowing toward).

### Marine surrounding-area sourcing (grid gaps)

DMI's marine models (WAM waves/swell, DKSS ocean/current) are gridded, and the
boat's **exact** position is frequently a gap — a coastal or land cell, an interior
hole, or a spot just outside the model domain — so a point query returns nothing even
though the water a mile away is fully modelled. To avoid empty wave/swell/current
fields in that common case, the **fetch layer** samples the surrounding area:

1. query the exact point first (preferred whenever it has data);
2. if a WAM or DKSS collection has **no usable numeric data** at the point, probe a small
   **capped** set of nearby offset points (2 rings, **≤ 8 points** — the cardinals at
   ~0.05° / ~3 nm and the diagonals at ~0.10° / ~6 nm, all within the ~15 nm reach),
   nearest first, **spaced** by a short delay, and use the **first grid point with numeric
   data as-is** (no interpolation, no fabrication) — stopping immediately on that hit;
3. only report empty when the whole capped area has no data.

The probe is deliberately gentle on DMI, which HTTP-**429 rate-limits** the marine EDR:

- **A 429 is backoff, not data.** If any call returns 429, the plugin stops probing for
  that poll and relies on the next one — a 429 is never mistaken for an empty cell that
  would fuel more probing (the failure mode that made an earlier build amplify the 429).
- **Cooldown.** When a collection's capped probe comes back with nothing — genuinely empty
  or 429-aborted — the plugin remembers that for ~2 poll cycles and, meanwhile, only tries
  the single exact point (no ring), so it does not re-run the whole probe every 30-minute
  poll and re-trigger the limit. A numeric hit clears the cooldown at once; otherwise it
  expires and the area is probed again. Last-good values keep publishing across the window.

> **Null-masked cells (why this keys on numeric presence, not row count).** A masked
> DMI grid cell — land, out of the wet domain, or otherwise no-data — does **not**
> return an empty response; it returns a **full-length time series whose parameter
> values are all `null`** (common at coastal/inner-bay points). "Has data" is therefore
> judged by the presence of a numeric value for a requested parameter, never by the
> row count, or a null-masked cell would be mistaken for a valid reading and the ring
> would never fire. A cell with a real number in **any** requested parameter (e.g. DKSS
> `water-temperature` present while `current-u/v` are null) counts as present, so working
> ocean temp/level/tide are never ringed away.

When a value comes from an offset point, the plugin publishes a small honest-display
marker — `…nearbyDistance` (m) and `…nearbyBearing` (rad) — so a display can label the
reading "nearby ~X nm" rather than presenting it as measured at the boat. The marker is
cleared (null) as soon as the exact point returns data again. This is a fetch-layer
resilience feature only: the requested parameters, the SI mapping, and the marine value
paths are unchanged.

## Install

### From the Signal K Appstore (recommended)

1. Open your Signal K server admin UI → **Appstore → Available**.
2. Search for **signalk-dmi** (category **Weather**) and click **Install**.
3. **Restart** the server when prompted.

The Appstore lists this plugin because it is published to npm with the
`signalk-node-server-plugin` keyword; installs and updates are handled for you
from the admin UI.

### From npm (manual)

```bash
npm install signalk-dmi
```
run in your Signal K config directory (`~/.signalk`), then restart the server.

### From a local tarball (development / offline)

Install the **registered-tarball** way so it shows in the admin UI and survives
`node_modules` rebuilds — see **[INSTALL.md](INSTALL.md)** for the full standard.
In short: `npm pack` → copy the `.tgz` into the server config dir →
`npm install ./signalk-dmi-<version>.tgz` there → restart. Do **not** hand-copy
files into `node_modules`.

### Enable

Enable **DMI (Danish Meteorological Institute) free data** in
_Server → Plugin Config_, and (optionally) select it as the Weather API provider.

## Configuration

Every field has in-UI help text (its `description`). Full reference:

| Field (title) | Key | Type | Default | What it does |
|---|---|---|---|---|
| Position source | `positionSource` | enum: Vessel GPS / Fixed | `vessel` | Where DMI is queried. Vessel GPS follows `navigation.position` (use underway); Fixed uses the lat/lon below (dock/shore install). |
| Fixed latitude | `fixedLatitude` | number (deg) | — | Decimal degrees WGS84, N+. Used **only** when Position source = Fixed. |
| Fixed longitude | `fixedLongitude` | number (deg) | — | Decimal degrees WGS84, E+. Used **only** when Position source = Fixed. |
| Poll interval | `pollIntervalMinutes` | number (min, ≥5) | `30` | Refresh cadence for observations + marine deltas. Lower = fresher, more API calls. Does not affect the on-demand forecast. |
| Forecast window | `forecastHours` | number (h, 1–120) | `48` | Look-ahead horizon of the v2 Weather API forecast. Length only, not refresh rate. |
| Register as Weather API provider | `weatherProvider` | boolean | `true` | ON = serve `/signalk/v2/api/weather`. Set **OFF** to run additively beside OpenWeather (deltas still publish). |
| Publish current conditions | `observations` | boolean | `true` | Nearest-station metObs → `environment.outside.*` (temp, pressure, humidity, dew point, wind/gust/dir). |
| Publish extended conditions | `tier1` | boolean | `true` | Adds `environment.outside.horizontalVisibility`, `cloudCover`, `precipitationRate` (HARMONIE surface). |
| Fetch weather warnings | `warnings` | boolean | `true` | Official warnings from the EUMETNET/MeteoAlarm CAP feed → Weather API `getWarnings`. |
| Raise warnings as notifications | `warningNotifications` | boolean | `true` | Active warnings → `notifications.environment.warnings.dmi.*`. No effect unless Fetch warnings is ON. |
| Warning countries | `warningCountries` | multi-select enum (38 MeteoAlarm countries) | `[denmark]` | Which national MeteoAlarm feeds to pull. Add neighbours when crossing borders. Only used when Fetch warnings is ON. |
| Publish wave data | `waves` | boolean | `true` | WAM model → `environment.water.waves.*` + `.swell.*` (height, period, direction). |
| Publish ocean data | `ocean` | boolean | `true` | DKSS model → `environment.water.temperature`, `water.level`, `tide.heightNow`, `current.drift/setTrue`. |
| HARMONIE forecast model | `harmonieCollection` | enum | `harmonie_dini_sf` | Surface (SF) model for atmospheric data. **DINI** = DK/NL/IE/IS (keep for Danish waters); **IG** = Iceland/Greenland. |
| WAM wave model | `wamCollection` | enum | `wam_dw` | Wave domain: **Danish Waters** (best near DK), **North Sea & Baltic** (wider), **North Atlantic** (offshore). |
| DKSS ocean model | `dkssCollection` | enum | `dkss_nsbs` | Ocean domain: **North Sea–Baltic** (widest), **Inner Danish Waters**, **Wadden Sea**, **Limfjord**, **Little Belt**, **Roskilde/Isefjord**. Smallest domain covering your position = best resolution. |

**MeteoAlarm country values** (`warningCountries`, lowercase feed slugs):
`austria`, `belgium`, `bosnia-herzegovina`, `bulgaria`, `croatia`, `cyprus`,
`czechia`, `denmark`, `estonia`, `finland`, `france`, `germany`, `greece`,
`hungary`, `iceland`, `ireland`, `israel`, `italy`, `latvia`, `lithuania`,
`luxembourg`, `malta`, `moldova`, `montenegro`, `netherlands`, `norway`,
`poland`, `portugal`, `republic-of-north-macedonia`, `romania`, `serbia`,
`slovakia`, `slovenia`, `spain`, `sweden`, `switzerland`, `ukraine`,
`united-kingdom`.

**Collection ids** are DMI Open Data `forecastedr` collection identifiers
(source of truth: <https://opendataapi.dmi.dk/v1/forecastedr/collections>). Only
the values in the enums above are valid for this plugin.

## Coverage

- **HARMONIE DINI**: Denmark + surrounding NE Europe.
- **WAM `wam_dw`**: Danish waters (7–16°E, 53–60°N); `wam_nsb` / `wam_natlant`
  extend to North Sea/Baltic / North Atlantic.
- **DKSS `dkss_nsbs`**: entire North Sea + Baltic (−4.1–30.3°E, 48.5–65.9°N).

Outside these boxes DMI returns no data and the plugin simply publishes nothing.

## Development

```bash
npm test        # unit tests for unit conversions + mapping (node:test, no deps)
```

## Attribution / licence

Weather and ocean data © **DMI (Danish Meteorological Institute)**, licensed under
[**Creative Commons CC BY 4.0**](https://www.dmi.dk/friedata/dokumentation/terms-of-use).
When using this data you must credit DMI, link the licence, and indicate changes.

Warnings are sourced from **[MeteoAlarm](https://meteoalarm.org)** (EUMETNET), which
republishes DMI's official warnings under CC BY 4.0 with additional redistribution
terms; the plugin labels the warning source **"DMI / MeteoAlarm"**.

Plugin code: **MIT** — see [LICENSE](LICENSE).

## Disclaimer — informational only, NOT for navigation

This plugin and the data it publishes are provided for **general information
only** and are **NOT** a substitute for official nautical charts, notices to
mariners, or an official marine forecast. **Do not rely on it for navigation or
for safety-of-life decisions.** Weather, wave, ocean, and warning data may be
delayed, incomplete, wrong, or unavailable, and the plugin may fail silently.

The software is provided **"AS IS", WITHOUT WARRANTY OF ANY KIND**, express or
implied (see [LICENSE](LICENSE)). Neither the author nor DMI nor MeteoAlarm is
liable for any loss or damage arising from its use. You are responsible for
verifying all data against authoritative sources before acting on it.
