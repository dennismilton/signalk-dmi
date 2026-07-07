# signalk-dmi — Phase 1 Research

**Goal of this document:** determine whether a DMI (Danish Meteorological
Institute) → SignalK plugin already exists, catalog DMI's free data relevant to
a boat, map the useful datasets to SignalK paths, and give a build-vs-adopt
recommendation with a proposed Phase-2 scope.

_Research date: 2026-07-07. Every factual claim is cited with a live URL. Claims
verified against the running DMI API are marked **[live-verified]** with the
exact request used._

---

## 1. Existing-plugin check (Dennis's explicit ask FIRST)

**Verdict: No DMI / Danish-met SignalK plugin exists. → BUILD.**

### 1a. npm
- `signalk-dmi` is **not published** on npm. **[live-verified]** —
  `npm view signalk-dmi` returns `404 Not Found - GET
  https://registry.npmjs.org/signalk-dmi`.
- Searching the `signalk-node-server-plugin` keyword and "dmi"/"denmark" surfaces
  no Danish-provider plugin. npm plugin index:
  <https://www.npmjs.com/search?q=signalk-node-server-plugin>

### 1b. GitHub / SignalK ecosystem weather plugins (all NON-DMI)
| Plugin | Source(s) | Provider | Marine? |
|---|---|---|---|
| signalk-openweather-plugin | <https://github.com/inspired-technologies/signalk-openweather-plugin> | OpenWeather | No |
| signalk-openweather-provider | <https://github.com/panaaj/signalk-openweather-provider> | OpenWeather (v2 Weather API) | No |
| openmeteo-provider-plugin (SignalK org) | <https://github.com/SignalK/openmeteo-provider-plugin> | Open-Meteo (v2 Weather API) | No |
| signalk-noaa-weather | <https://github.com/sbender9/signalk-noaa-weather> | NOAA (US) | No |
| signalk-virtual-weather-sensors | <https://github.com/NearlCrews/signalk-virtual-weather-sensors> | Open-Meteo / Met.no / AccuWeather; warnings for US (NWS) + Norway (Met.no MetAlerts) | Partial (no Danish source) |
| signalk-weatherflow | <https://github.com/motamman/signalk-weatherflow> | WeatherFlow Tempest hardware | No |

None use DMI. The closest region-aware plugin (`signalk-virtual-weather-sensors`)
covers Norwegian MetAlerts but **not Danish** DMI data.

### 1c. Non-SignalK DMI wrappers that could inform a build (not usable as-is)
- `rugaard/dmi` — PHP, **scrapes the DMI website** (predates the open API):
  <https://github.com/rugaard/dmi>
- `LasseRegin/dmi-open-data` — Python client for the DMI Open Data API:
  <https://github.com/LasseRegin/dmi-open-data> · PyPI <https://pypi.org/project/dmi-open-data/>
- `1oly/dmi-forecast-edr` — Python client specifically for the Forecast EDR API:
  <https://github.com/1oly/dmi-forecast-edr>
- Tutorial (useful reference for request patterns):
  <https://predictablysunny.com/posts/dmi_data/>

**Conclusion:** the DMI Open Data API is well-documented and has client libraries
in other languages, but there is **no Node/SignalK integration**. This is a clean
greenfield build.

---

## 2. DMI Open Data platform — access model

Sources: DMI free-data landing <https://www.dmi.dk/frie-data> · docs index
<https://www.dmi.dk/friedata/dokumentation/basics> · getting-started/tutorial
<https://predictablysunny.com/posts/dmi_data/>

- **Base host: `https://opendataapi.dmi.dk`** — new endpoint live since
  **2025-12-02**. Per DMI, "The APIs no longer require authentication" on this
  host. <https://www.dmi.dk/friedata/dokumentation/basics>
- **No API key required** on `opendataapi.dmi.dk`. **[live-verified]** — all
  requests in this report ran with no key/header.
- The **old host `dmigw.govcloud.dk` still requires an API key and retires
  2026-06-30** (already past as of this research date, 2026-07-07). Do **not**
  target it. <https://opendatadocs.dmi.govcloud.dk/> (search snapshot) and
  <https://www.dmi.dk/friedata/dokumentation/basics>
- **Rate limit / fair use: 500 requests per 5 seconds; exceeding returns HTTP
  429.** <https://www.dmi.dk/friedata/dokumentation/basics>
- **Response formats:** OGC-Features and OGC-EDR services return **GeoJSON** by
  default; EDR also supports **CoverageJSON** (default there) and **NetCDF** via
  `f=`. <https://www.dmi.dk/friedata/dokumentation/basics> ·
  <https://www.dmi.dk/friedata/dokumentation/forecast-data-edr-api>
- **Licence: Creative Commons CC BY 4.0** — free, commercial use permitted,
  **attribution required** (credit DMI, link the licence, note changes). Licence
  link is returned in every collection response as
  `https://www.dmi.dk/friedata/dokumentation/terms-of-use`. **[live-verified]**
  in the `links[]` of `/collections` responses. Terms:
  <https://www.dmi.dk/friedata/dokumentation/terms-of-use>

### API families
- **OGC API – Features** (GeoJSON items): Meteorological Observation (metObs),
  Oceanographic Observation (oceanObs), Lightning, Climate.
- **OGC API – EDR** (point/cube subsetting): Forecast Data EDR.
- **STAC API** (returns download links to model files): Radar, Forecast STAC.

Source: <https://www.dmi.dk/friedata/dokumentation/basics>

---

## 3. DMI free-data catalog (boat-relevant)

### 3.1 Forecast — EDR API `https://opendataapi.dmi.dk/v1/forecastedr`
Docs: <https://www.dmi.dk/friedata/dokumentation/forecast-data-edr-api> · Swagger
`https://opendataapi.dmi.dk/v1/forecastedr/swagger-ui/index.html`
- Query by position: `/collections/{id}/position?coords=POINT(lon lat)&crs=crs84&parameter-name={p}&f=GeoJSON`
  (also `/cube` for a bounding box). Example from docs:
  `.../collections/harmonie_dini_sf/position?coords=POINT(12.561 55.715)&crs=crs84&parameter-name=temperature-0m`
- **[live-verified]** `GET /v1/forecastedr/collections` returns the collection
  list with `extent` (bbox + hourly `temporal.values`) for each.

**Collections (verified live):**

**HARMONIE (atmospheric weather model):**
- `harmonie_dini_sf` (surface), `harmonie_dini_pl` (pressure levels),
  `harmonie_dini_eps_means`, `_eps_percentiles`, `_eps_probabilities` — North
  Eastern area (Denmark + surrounding).
- `harmonie_ig_sf`, `harmonie_ig_pl` — Greenland.
- **Params [live-verified]** on `harmonie_dini_sf` include `temperature-0m`,
  `10-metre-eastward-wind-gust-since-previous-post-processing` and
  `10-metre-northward-wind-gust...` (gust as u/v components), plus pressure,
  humidity, cloud-base/top, isotherm levels, CAPE, etc. Wind/gust arrive as
  eastward/northward components → convert to speed+direction on ingest.

**WAM (wave model):**
- `wam_dw` — Danish Waters, bbox **[7.0, 53.0, 16.0, 60.0]** (crs84). **[live-verified]**
- `wam_nsb` (North Sea/Baltic), `wam_natlant` (North Atlantic).
- **Params [live-verified]** on `wam_dw`: `significant-wave-height`,
  `dominant-wave-period`, `mean-wave-period`, `mean-wave-dir`,
  `significant-windwave-height`, `significant-totalswell-height`,
  `mean-totalswell-dir`, `mean-totalswell-period`, `benjamin-feir-index`.
  Hourly resolution out to ~7 days.

**DKSS (3-D ocean / storm-surge model):**
- `dkss_nsbs` — North Sea + Baltic Sea, bbox **[-4.125, 48.525, 30.292, 65.875]**
  (crs84). **[live-verified]** Also `dkss_idw`, `dkss_ws`, `dkss_lf`, `dkss_lb`,
  `dkss_if` (sub-domains, higher-res).
- **Params [live-verified]** on `dkss_nsbs`: `water-temperature`, `salinity`,
  `current-u`, `current-v`, `sea-mean-deviation` (sea-surface height/level),
  `ice-thickness`, `ice-concentration`, `wind-u`, `wind-v`. Currents as u/v
  components → convert to speed+direction (set/drift).

Model coverage summary (AWS registry, DMI operational):
<https://registry.opendata.aws/dmi-opendata/> — HARMONIE (weather), WAM (waves),
DKSS (ocean); refreshed hourly / 3-hourly / 6-hourly by model.

### 3.2 Observations — Meteorological (metObs) `https://opendataapi.dmi.dk/v2/metObs`
Collections `observation`, `station`. Items are GeoJSON.
- **[live-verified]** `GET /v2/metObs/collections/observation/items?limit=1`
  returns `{parameterId, value, observed, stationId, coordinates}`, e.g.
  `parameterId:"wind_speed"`.
- Params include `wind_speed`, `wind_dir`, `wind_gust`, `temp_dry`, `temp_dew`,
  `humidity`, `pressure`, `cloud_cover`, `precip_past10min`, `visibility`,
  `radia_glob`. (Tutorial + docs.) <https://predictablysunny.com/posts/dmi_data/>
- Coverage: DMI land/coastal stations in **Denmark + Greenland**.
  <https://www.dmi.dk/frie-data>

### 3.3 Observations — Oceanographic (oceanObs) `https://opendataapi.dmi.dk/v2/oceanObs`
Docs: <https://www.dmi.dk/friedata/dokumentation/oceanographic-observations-data>
Collections `observation`, `station`. **[live-verified]** collection list.
- **Params:** `sealev_dvr` (sea level rel. DVR90, cm), `sealev_ln` (sea level
  rel. local zero, cm), `sea_reg` (Coastal Authority registration, cm), `tw`
  (water temperature, °C, measured in-harbour ~2 m depth).
- **No waves / currents / salinity in observations** — those exist only as
  *forecasts* (WAM / DKSS above). Wave/current obs are a genuine gap.
- Also provides **tide / water-level predictions** (min/max/10-min) ~2 years
  ahead for select DK/Greenland/Faroe points.
- Coverage: Danish tide-gauge network (DMI + Danish Coastal Authority).

### 3.4 Lightning `https://opendataapi.dmi.dk/v1/lightningdata` (OGC Features)
Real-time strike detections over and near Danish territory. Docs referenced from
the API index; snapshot: DMI Open Data "Lightning Data API".
<https://www.dmi.dk/friedata/dokumentation/basics> ·
<https://opendatadocs.dmi.govcloud.dk/> (Lightning Data API)

### 3.5 Radar (STAC — download links to composite files) · 3.6 Climate (Features)
Radar composites over Denmark and quality-controlled climate observations
(DK+Greenland). Both lower priority for live boat use.
<https://www.dmi.dk/frie-data> · <https://www.dmi.dk/friedata/dokumentation/basics>

### Coverage / offshore reach (summary)
- **HARMONIE DINI:** NE Europe (Denmark + surrounding seas + into the Baltic/
  North Sea).
- **WAM `wam_dw`:** Danish waters 7–16°E, 53–60°N; `wam_nsb` / `wam_natlant`
  extend to North Sea/Baltic and North Atlantic.
- **DKSS `dkss_nsbs`:** −4.1–30.3°E, 48.5–65.9°N — all of the North Sea and
  Baltic, i.e. excellent for Danish/German/Swedish/Polish coastal + offshore
  waters. Not open-Atlantic (use `wam_natlant` for waves there).

---

## 4. Mapping DMI → SignalK

### 4.1 Two delivery surfaces (important architecture finding)
The **SignalK v2 Weather API** (`/signalk/v2/api/weather`, provider-plugin model:
`registerWeatherProvider` + `getObservations`/`getForecasts`/`getWarnings`) is
**atmospheric-only**. The canonical `WeatherData` object (from the SignalK
openmeteo provider, verified in source) carries: `temperature`, `dewPoint`,
`humidity`, `pressure`, `precipitation`, `cloudCover`, `uvIndex`, `weather`, and
`wind: { speed, gust, direction }`. **It has no wave / sea-level / current
fields.**
Sources: <https://demo.signalk.org/documentation/Developing/REST_APIs/Weather_API.html>
· <https://demo.signalk.org/documentation/Developing/Plugins/Weather_Providers.html>
· <https://github.com/SignalK/openmeteo-provider-plugin> (src/weather/*)

**Therefore the plugin needs two output paths:**
1. **Atmospheric → SignalK v2 Weather API provider** (HARMONIE forecast +
   metObs observations). Slots straight into the same surface the maracaibo
   dashboard's weather view already consumes; can complement/replace OWM.
2. **Marine → SignalK deltas on `environment.*` paths** (WAM waves, DKSS
   sea-level/current/water-temp, oceanObs sea-level/water-temp). These are not
   expressible via the Weather API, so publish them as standard SignalK data
   deltas.

### 4.2 Proposed path mapping
| DMI source | DMI param | SignalK target |
|---|---|---|
| metObs / HARMONIE | temp_dry / `temperature-0m` | `environment.outside.temperature` (K) |
| metObs / HARMONIE | pressure | `environment.outside.pressure` (Pa) |
| metObs / HARMONIE | humidity | `environment.outside.humidity` (ratio 0–1) |
| metObs / HARMONIE | temp_dew | `environment.outside.dewPointTemperature` |
| metObs / HARMONIE | wind_speed / wind u+v | `environment.wind.speedOverGround` / Weather API `wind.speed` |
| metObs / HARMONIE | wind_dir / from u+v | `environment.wind.directionTrue` / Weather API `wind.direction` |
| metObs / HARMONIE | wind_gust | Weather API `wind.gust` |
| WAM `wam_dw` | `significant-wave-height` | `environment.outside.waves.significantHeight` (or `environment.water.waves.*`) |
| WAM `wam_dw` | `mean-wave-period` / `dominant-wave-period` | `environment.outside.waves.period` |
| WAM `wam_dw` | `mean-wave-dir` | `environment.outside.waves.direction` |
| WAM `wam_dw` | swell height/dir/period | `environment.outside.waves.swell.*` |
| DKSS `dkss_nsbs` | `water-temperature` | `environment.water.temperature` (K) |
| DKSS `dkss_nsbs` / oceanObs | `sea-mean-deviation` / `sealev_dvr` | `environment.tide.heightNow` / `environment.water.level` |
| DKSS `dkss_nsbs` | `current-u`+`current-v` → speed/dir | `environment.current.{drift,setTrue}` |
| oceanObs | `tw` | `environment.water.temperature` (observed) |
| Lightning | strike events | `environment.outside.lightning.*` (custom) or notifications |

> Note: exact SignalK marine wave/current path spelling should be pinned against
> the SignalK schema in Phase 2 (the wave sub-tree is partly convention). Weather
> forecasts/warnings modelling ref: SignalK spec issue #643
> <https://github.com/SignalK/specification/issues/643>.

### 4.3 Alignment gap to close in Phase 2
`maracaibo-dashboard/src/weather.js` **could not be read this run** — it lives
outside this worker's allowed directories. Phase 2 must inspect exactly which
`environment.outside.*` / Weather-API fields that view consumes and match them,
so DMI is a drop-in for/alongside the OWM provider. **Flagged below.**

---

## 5. RECOMMENDATION

**BUILD.** No DMI or Danish-met SignalK plugin exists; the DMI Open Data API is
now key-free (`opendataapi.dmi.dk`), CC BY 4.0, generous rate limits (500/5s),
and covers exactly the authoritative Danish met + ocean data the boat wants —
richer than generic OWM for Danish/Baltic/North-Sea waters.

### Proposed Phase-2 scope (in build order)
1. **Plugin skeleton** — standard SignalK plugin (`signalk-node-server-plugin`
   keyword, config schema: position source = vessel or manual lat/lon, poll
   interval, dataset toggles, units). No secrets needed (no API key), but keep a
   `.env.example` per fleet rule in case future auth returns.
2. **Weather API provider (atmospheric)** — register via
   `registerWeatherProvider`; `getObservations` from **metObs**, `getForecasts`
   from **HARMONIE `harmonie_dini_sf`** EDR position query. This is the OWM
   complement/replacement.
3. **Marine deltas** — WAM `wam_dw` (waves) + DKSS `dkss_nsbs` (water temp, sea
   level, current) → `environment.*` deltas. Convert u/v components → speed/dir;
   Kelvin/Pa/ratio unit conversions.
4. **oceanObs** — observed sea level + water temperature (`sealev_dvr`, `tw`)
   from the nearest tide-gauge station.
5. **(Stretch)** Lightning proximity + DMI met warnings.
6. **README** — setup, path list, CC BY 4.0 attribution ("Data: DMI, CC BY 4.0").
7. **Align** with `maracaibo-dashboard/src/weather.js` field expectations.

### Decision gate for Dennis (flagged)
- **Build vs adopt → BUILD** (nothing to adopt). Confirm.
- **Which datasets first?** Recommend **atmospheric (HARMONIE + metObs) via the
  Weather API provider FIRST** (direct OWM parity/replacement), then marine
  (WAM + DKSS). Confirm priority.
- **Marine path spelling** (`environment.outside.waves.*` vs `environment.water.*`)
  and the dashboard-field alignment need a quick decision once `weather.js` is
  readable.

---

## Sources
- DMI free data: <https://www.dmi.dk/frie-data>
- DMI docs — basics: <https://www.dmi.dk/friedata/dokumentation/basics>
- DMI docs — Forecast EDR API: <https://www.dmi.dk/friedata/dokumentation/forecast-data-edr-api>
- DMI docs — Forecast Data: <https://www.dmi.dk/friedata/dokumentation/forecast-data>
- DMI docs — Oceanographic Observations: <https://www.dmi.dk/friedata/dokumentation/oceanographic-observations-data>
- DMI docs — Terms of use (CC BY 4.0): <https://www.dmi.dk/friedata/dokumentation/terms-of-use>
- DMI Open Data (legacy docs host): <https://opendatadocs.dmi.govcloud.dk/>
- DMI live API root used: `https://opendataapi.dmi.dk/v1/forecastedr/collections`, `/v2/metObs/collections`, `/v2/oceanObs/collections`
- AWS Open Data registry (models): <https://registry.opendata.aws/dmi-opendata/>
- DMI API tutorial: <https://predictablysunny.com/posts/dmi_data/>
- SignalK Weather API: <https://demo.signalk.org/documentation/Developing/REST_APIs/Weather_API.html>
- SignalK Weather Providers: <https://demo.signalk.org/documentation/Developing/Plugins/Weather_Providers.html>
- SignalK openmeteo provider (WeatherData shape): <https://github.com/SignalK/openmeteo-provider-plugin>
- SignalK spec issue #643 (forecasts/warnings): <https://github.com/SignalK/specification/issues/643>
- Non-SignalK DMI clients: <https://github.com/LasseRegin/dmi-open-data>, <https://github.com/1oly/dmi-forecast-edr>, <https://github.com/rugaard/dmi>
- Ecosystem plugins checked: signalk-openweather (<https://github.com/inspired-technologies/signalk-openweather-plugin>, <https://github.com/panaaj/signalk-openweather-provider>), signalk-noaa-weather (<https://github.com/sbender9/signalk-noaa-weather>), signalk-virtual-weather-sensors (<https://github.com/NearlCrews/signalk-virtual-weather-sensors>), signalk-weatherflow (<https://github.com/motamman/signalk-weatherflow>)