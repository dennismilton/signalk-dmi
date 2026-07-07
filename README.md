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
- **Warnings** — returns empty (DMI has no confirmed open-data warnings endpoint
  yet; see `RESEARCH.md` §3.5).

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
| `environment.water.temperature` | oceanObs → DKSS | K |
| `environment.water.level` / `environment.tide.heightNow` | oceanObs → DKSS | m |
| `environment.water.waves.significantHeight` / `.period` / `.direction` | WAM | m / s / rad |
| `environment.water.swell.height` / `.period` / `.direction` | WAM | m / s / rad |
| `environment.current.drift` / `environment.current.setTrue` | DKSS | m/s / rad |

All values are converted to Signal K SI units (K, Pa, m/s, rad, ratio); ocean
current is derived from the model's u/v components (set = direction flowing toward).

## Install

Not yet on npm. Install from a local checkout on the Signal K server:

```bash
cd ~/.signalk/node_modules
git clone <repo-url> signalk-dmi
cd signalk-dmi && npm install
```

Then restart Signal K, enable **DMI (Danish Meteorological Institute) free data**
in _Server → Plugin Config_, and (optionally) select it as the Weather API
provider.

## Configuration

| Option | Default | Notes |
|---|---|---|
| Position source | `vessel` | `vessel` uses `navigation.position`; `fixed` uses the lat/lon below |
| Fixed latitude / longitude | — | used when position source = `fixed` |
| Poll interval (min) | `30` | observations + marine deltas |
| Forecast look-ahead (h) | `48` | 1–120 |
| Register weather provider | `true` | atmospheric forecasts + observations via v2 Weather API |
| Publish outside deltas | `true` | current conditions → `environment.outside.*` |
| Publish WAM waves | `true` | → `environment.water.waves/swell.*` |
| Publish DKSS ocean | `true` | water temp, sea level, current |
| HARMONIE / WAM / DKSS collection | `harmonie_dini_sf` / `wam_dw` / `dkss_nsbs` | swap `wam_nsb`/`wam_natlant` etc. for wider areas |

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

Plugin code: MIT.
