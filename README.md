# signalk-dmi

A [Signal K](https://signalk.org) server plugin that ingests **DMI (Danish
Meteorological Institute) free open data** — authoritative Danish met/ocean data —
into Signal K, richer than the generic OpenWeather provider for Danish, Baltic and
North Sea waters.

It uses DMI's [Open Data API](https://www.dmi.dk/frie-data) (host
`opendataapi.dmi.dk`, **no API key required**, licensed CC BY 4.0). See
[`RESEARCH.md`](./RESEARCH.md) for the full dataset catalog and provenance (every
endpoint live-verified).

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
  EUMETNET/MeteoAlarm CAP feed (the DMI Open Data API has no warnings collection; see
  `RESEARCH.md` §3.7). Also raised as `notifications.environment.warnings.dmi.*`.

### 2. `environment.*` deltas
Current conditions + marine, so any consumer (and the maracaibo dashboard's
`environment.outside.wind.*` checks — a drop-in for the OWM provider) gets live data:

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

All values are converted to Signal K SI units (K, Pa, m/s, rad, ratio); ocean
current is derived from the model's u/v components (set = direction flowing toward).

## Install

Not on npm. Install the **supported way** (registered tarball, so it shows in the
admin UI and survives `node_modules` rebuilds) — see **[INSTALL.md](INSTALL.md)**
for the full standard. In short: `npm pack` → copy the `.tgz` into the server
config dir → `npm install ./signalk-dmi-<version>.tgz` there → restart. Do **not**
hand-copy files into `node_modules`.

Then enable **DMI (Danish Meteorological Institute) free data** in
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

Plugin code: MIT.
